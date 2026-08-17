import { NextResponse, after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserContext } from "@/lib/auth";
import {
  MAX_FILE_SIZE,
  MAX_FILES,
  MAX_FILES_PER_REQUEST,
  detectDocumentType,
  isAcceptedMimeType,
} from "@/lib/documents/queue";
import {
  fallbackEstimateStats,
  type ProcessingEstimateStats,
} from "@/lib/documents/processing-estimate";

export const runtime = "nodejs";
// Chaque entrée retélécharge son fichier depuis le bucket pour revalider les magic
// bytes — un aller-retour réseau par document, jusqu'à MAX_FILES_PER_REQUEST d'affilée.
export const maxDuration = 60;

/**
 * Entrée de la file de traitement.
 *
 * Les octets ne transitent plus par cette route : le navigateur les dépose directement
 * dans le bucket Supabase Storage (policy RLS `org_upload_invoice_files`), puis
 * n'envoie ici qu'un lot de métadonnées (chemins déjà déposés). Avant cette route
 * recevait le multipart complet — cassé par le plafond de corps de requête FIXE et non
 * configurable des Vercel Functions (4,5 Mo, `FUNCTION_PAYLOAD_TOO_LARGE`), qu'aucun
 * réglage `next.config.ts` ne peut dépasser puisqu'il s'agit d'une couche en dessous.
 *
 * La vérification des **magic bytes** reste ici, pas seulement côté navigateur (un
 * client peut mentir) : chaque fichier référencé est retéléchargé depuis le bucket et
 * son contenu réel comparé au type annoncé avant de créer la ligne `document_jobs`.
 * Défense en profondeur supplémentaire : le chemin fourni doit commencer par
 * `{org_id}/{user_id}/` de l'appelant — la policy RLS l'a déjà garanti à l'écriture,
 * mais rien n'empêche un client de référencer ici un chemin qu'il n'a pas déposé
 * lui-même sans cette revérification.
 */

async function mapWithConcurrency<T, R>(values: T[], limit: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => run()));
  return results;
}

function percentile(sortedValues: number[], ratio: number) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * ratio) - 1);
  return Math.round(sortedValues[index]);
}

/**
 * Percentiles de durée des lots terminés **de l'organisation appelante**.
 *
 * Auparavant lu en service-role sur tous les lots, toutes organisations confondues. Un
 * lot étant désormais mono-organisation (`20260806000001_fair_dispatch.sql`), la lecture
 * passe par le client de session et la policy `org_read_document_batches` : plus aucun
 * agrégat inter-clients ne traverse cette route.
 *
 * Contrepartie assumée : un nouveau client n'a pas d'historique et reste sur les
 * constantes de repli jusqu'à ses 5 premiers lots terminés — estimation plus prudente,
 * mais calculée sur ses propres documents.
 *
 * Mémorisé une minute **par organisation** : la page d'import interroge cette route à
 * chaque retour d'onglet et toutes les 60 s en repli, alors que ces percentiles bougent
 * à l'échelle du jour.
 */
const ESTIMATE_CACHE_MS = 60_000;
const estimateCache = new Map<string, { value: ProcessingEstimateStats; expiresAt: number }>();

async function processingEstimateStats(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
): Promise<ProcessingEstimateStats> {
  const cached = estimateCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const fallback = fallbackEstimateStats();
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from("document_batches")
    .select("created_at, completed_at")
    .eq("org_id", orgId)
    .eq("status", "ended")
    .not("completed_at", "is", null)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error || !data) return fallback;
  const durations = data
    .map((batch) => (new Date(batch.completed_at!).getTime() - new Date(batch.created_at).getTime()) / 1000)
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0 && seconds <= 24 * 60 * 60)
    .sort((a, b) => a - b);

  const stats: ProcessingEstimateStats = durations.length < 5
    ? { ...fallback, sampleCount: durations.length }
    : {
        sampleCount: durations.length,
        p50BatchSeconds: percentile(durations, 0.5),
        p80BatchSeconds: percentile(durations, 0.8),
        source: "historical",
        generatedAt: new Date().toISOString(),
      };
  estimateCache.set(orgId, { value: stats, expiresAt: Date.now() + ESTIMATE_CACHE_MS });
  return stats;
}

interface IncomingFile {
  id: string;
  file_path: string;
  original_name: string;
  mime_type: string;
  file_size: number;
}

function parseIncomingFiles(value: unknown): IncomingFile[] | null {
  if (!Array.isArray(value)) return null;
  const out: IncomingFile[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "object" || entry === null
      || typeof (entry as Record<string, unknown>).id !== "string"
      || typeof (entry as Record<string, unknown>).file_path !== "string"
      || typeof (entry as Record<string, unknown>).original_name !== "string"
      || typeof (entry as Record<string, unknown>).mime_type !== "string"
      || typeof (entry as Record<string, unknown>).file_size !== "number"
    ) return null;
    out.push(entry as IncomingFile);
  }
  return out;
}

export async function POST(request: Request) {
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const requestedMode = body?.processing_mode;
  const processingMode = requestedMode === "direct" ? "direct" : requestedMode === "batch" ? "batch" : null;
  if (!processingMode) {
    return NextResponse.json({ error: "Mode de traitement manquant ou invalide." }, { status: 400 });
  }

  const files = parseIncomingFiles(body?.files);
  if (!files) return NextResponse.json({ error: "Métadonnées de fichiers invalides." }, { status: 400 });
  if (!files.length) return NextResponse.json({ error: "Aucun fichier fourni." }, { status: 400 });
  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json({ error: `Maximum ${MAX_FILES_PER_REQUEST} fichiers par envoi.` }, { status: 400 });
  }

  // Chemin attendu : `{org_id}/{user_id}/…` — la policy RLS `org_upload_invoice_files`
  // l'a déjà garanti au dépôt (aucun autre chemin n'aurait pu être écrit), mais un
  // client pourrait référencer ICI un chemin qu'il n'a pas déposé lui-même sans cette
  // revérification — l'écriture est passée, la lecture doit l'être aussi.
  const ownPrefix = `${ctx.orgId}/${ctx.userId}/`;
  const outsideOwnPrefix = files.find((file) => !file.file_path.startsWith(ownPrefix));
  if (outsideOwnPrefix) {
    return NextResponse.json({ error: `${outsideOwnPrefix.original_name} : chemin de dépôt invalide.` }, { status: 403 });
  }

  // Client admin : `document_jobs` n'a aucune policy d'écriture, c'est le serveur qui
  // est propriétaire des transitions d'état. Nécessaire aussi pour retélécharger les
  // fichiers depuis le bucket : la policy RLS de lecture ne s'applique qu'au client de
  // session, pas à cette revalidation serveur.
  const admin = createAdminClient();
  const jobs: Array<{ id: string; original_name: string; status: string }> = [];
  // Un fichier qui échoue ne fait plus avorter l'envoi : les autres sont mis en file et
  // le client apprend précisément lesquels reprendre. Avant, une erreur au 7e fichier
  // laissait 6 jobs créés dont le navigateur ignorait tout — il les re-téléversait.
  const errors: Array<{ id: string; name: string; message: string }> = [];

  // Chaque entrée retélécharge son fichier (magic bytes) — un aller-retour réseau par
  // document. Concurrence bornée pour rester large sous `maxDuration` sans saturer
  // l'API Storage : même valeur que `FILE_UPLOAD_CONCURRENCY` côté Edge Functions.
  const outcomes = await mapWithConcurrency(files, 5, async (file) => {
    if (!isAcceptedMimeType(file.mime_type)) {
      return { ok: false as const, id: file.id, name: file.original_name, message: "format non supporté." };
    }
    if (!file.file_size || file.file_size > MAX_FILE_SIZE) {
      return { ok: false as const, id: file.id, name: file.original_name, message: "taille invalide ou supérieure à 20 Mo." };
    }

    const { data: blob, error: downloadError } = await admin.storage.from("invoice-files").download(file.file_path);
    if (downloadError || !blob) {
      return { ok: false as const, id: file.id, name: file.original_name, message: "fichier introuvable dans le dépôt — réessayez." };
    }
    // Revalidation réelle : la taille et le type annoncés ci-dessus viennent du
    // navigateur, celle-ci vient du contenu effectivement déposé.
    if (blob.size > MAX_FILE_SIZE) {
      await admin.storage.from("invoice-files").remove([file.file_path]);
      return { ok: false as const, id: file.id, name: file.original_name, message: "taille supérieure à 20 Mo." };
    }
    if (await detectDocumentType(blob) !== file.mime_type) {
      await admin.storage.from("invoice-files").remove([file.file_path]);
      return { ok: false as const, id: file.id, name: file.original_name, message: "le contenu ne correspond pas au format annoncé." };
    }

    const { data: job, error: insertError } = await admin.from("document_jobs").insert({
      id: file.id,
      org_id: ctx.orgId,
      created_by: ctx.userId,
      file_path: file.file_path,
      original_name: file.original_name,
      mime_type: file.mime_type,
      file_size: blob.size,
      processing_mode: processingMode,
      status: processingMode === "direct" ? "direct_queued" : "queued",
    }).select("id, original_name, status").single();

    if (insertError || !job) {
      // Pas d'orphelin : le fichier déjà écrit est retiré.
      await admin.storage.from("invoice-files").remove([file.file_path]);
      return { ok: false as const, id: file.id, name: file.original_name, message: insertError?.message ?? "création du job impossible" };
    }

    return { ok: true as const, job };
  });

  // Plus de mise en file séparée : `status = 'queued'` EST la mise en file. La file
  // pgmq a été retirée (voir `20260806000001_fair_dispatch.sql`) — elle formait une
  // seconde source de vérité à synchroniser, et sa nature FIFO globale empêchait
  // l'ordonnancement équitable entre clients.
  for (const outcome of outcomes) {
    if (outcome.ok) jobs.push(outcome.job);
    else errors.push({ id: outcome.id, name: outcome.name, message: outcome.message });
  }

  if (!jobs.length) {
    return NextResponse.json(
      { error: errors[0] ? `${errors[0].name} : ${errors[0].message}` : "Mise en file impossible.", errors, jobs: [] },
      { status: 500 },
    );
  }

  // Réveil immédiat du worker, après l'envoi de la réponse.
  //
  // Les crons pg_cron tournent à la minute : sans ce réveil, une file venait d'être
  // remplie attendait en moyenne 46 s (mesuré sur 260 documents) que le prochain tick
  // la remarque — du temps mort, aucun travail en cours. Le cron reste en place et
  // garde son rôle : reprise des tâches qu'un réveil raté aurait laissées en plan.
  after(() => wakeWorker(processingMode));

  return NextResponse.json({ jobs, errors, processing_mode: processingMode }, { status: 202 });
}

/**
 * Invoque la fonction Edge qui traite le mode concerné, sans attendre son issue.
 *
 * Volontairement silencieuse en cas d'échec : ce n'est qu'une accélération. Si l'appel
 * n'aboutit pas, le cron reprendra la file au tick suivant — l'utilisateur attend plus
 * longtemps, il ne perd rien.
 */
async function wakeWorker(mode: "direct" | "batch") {
  const fn = mode === "direct" ? "process-direct-documents" : "process-document-queue";
  try {
    const { error } = await createAdminClient().functions.invoke(fn, { body: {} });
    if (error) console.warn(`[document-jobs] réveil ${fn} sans effet`, { error: error.message });
  } catch (err) {
    console.warn(`[document-jobs] réveil ${fn} impossible`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function GET() {
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createClient();
  const [{ data, error }, estimation] = await Promise.all([
    supabase.from("document_jobs")
      .select("id, original_name, mime_type, file_size, status, processing_mode, attempt_count, last_error, created_at, updated_at, queued_at, dispatch_started_at, claude_file_uploaded_at, batch_created_at, result_available_at, started_at, completed_at, processed_invoice_id, anthropic_batch_id, prefilter_type")
      .eq("org_id", ctx.orgId)
      .order("created_at", { ascending: false })
      .limit(MAX_FILES),
    processingEstimateStats(supabase, ctx.orgId),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ jobs: data, estimation });
}
