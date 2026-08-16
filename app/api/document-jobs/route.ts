import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserContext } from "@/lib/auth";
import { safeFileName } from "@/lib/extraction/storage-path";
import {
  MAX_FILE_SIZE,
  MAX_FILES,
  MAX_FILES_PER_REQUEST,
  MAX_REQUEST_BYTES,
  detectDocumentType,
  isAcceptedMimeType,
} from "@/lib/documents/queue";
import {
  fallbackEstimateStats,
  type ProcessingEstimateStats,
} from "@/lib/documents/processing-estimate";

export const runtime = "nodejs";

/**
 * Entrée de la file de traitement.
 *
 * Les fichiers transitent par le serveur (et non par un upload navigateur direct)
 * parce que c'est le seul endroit où l'on peut vérifier les **magic bytes** avant
 * d'écrire dans le bucket : un `.pdf` qui n'en est pas un est rejeté ici, pas trois
 * étapes plus loin au moment de payer l'extraction.
 */

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

export async function POST(request: Request) {
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await request.formData();
  const requestedMode = formData.get("processing_mode");
  const processingMode = requestedMode === "direct" ? "direct" : requestedMode === "batch" ? "batch" : null;
  if (!processingMode) {
    return NextResponse.json({ error: "Mode de traitement manquant ou invalide." }, { status: 400 });
  }

  const files = formData.getAll("files").filter((value): value is File => value instanceof File);
  if (!files.length) return NextResponse.json({ error: "Aucun fichier fourni." }, { status: 400 });
  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json({ error: `Maximum ${MAX_FILES_PER_REQUEST} fichiers par envoi.` }, { status: 400 });
  }

  // Second garde-fou, aligné sur le découpage navigateur : au-delà, on s'approche du
  // plafond de corps de requête de la plateforme, qui coupe la connexion sans message
  // exploitable.
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (files.length > 1 && totalBytes > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "Volume trop important pour un seul envoi." }, { status: 413 });
  }

  // Tout valider avant d'écrire quoi que ce soit : un lot partiellement accepté
  // laisserait des fichiers dans le bucket sans job correspondant.
  for (const file of files) {
    if (!isAcceptedMimeType(file.type)) {
      return NextResponse.json({ error: `${file.name} : format non supporté.` }, { status: 415 });
    }
    if (!file.size || file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: `${file.name} : taille invalide ou supérieure à 20 Mo.` }, { status: 413 });
    }
    if (await detectDocumentType(file) !== file.type) {
      return NextResponse.json({ error: `${file.name} : le contenu ne correspond pas au format annoncé.` }, { status: 415 });
    }
  }

  // Client admin : `document_jobs` n'a aucune policy d'écriture, c'est le serveur qui
  // est propriétaire des transitions d'état.
  const admin = createAdminClient();
  const jobs: Array<{ id: string; original_name: string; status: string }> = [];
  // Un fichier qui échoue ne fait plus avorter l'envoi : les autres sont mis en file et
  // le client apprend précisément lesquels reprendre. Avant, une erreur au 7e fichier
  // laissait 6 jobs créés dont le navigateur ignorait tout — il les re-téléversait.
  const errors: Array<{ name: string; message: string }> = [];

  for (const file of files) {
    const jobId = crypto.randomUUID();
    // Convention du bucket : `{org_id}/{user_id}/…` — imposée par la policy RLS
    // (`org_upload_invoice_files`). Le sous-dossier `queue/` isole les documents en
    // cours de traitement de ceux déjà rattachés à une facture.
    const filePath = `${ctx.orgId}/${ctx.userId}/queue/${jobId}-${safeFileName(file.name)}`;
    const { error: uploadError } = await admin.storage.from("invoice-files").upload(
      filePath,
      await file.arrayBuffer(),
      { contentType: file.type, upsert: false },
    );
    if (uploadError) {
      errors.push({ name: file.name, message: uploadError.message });
      continue;
    }

    const { data: job, error: insertError } = await admin.from("document_jobs").insert({
      id: jobId,
      org_id: ctx.orgId,
      created_by: ctx.userId,
      file_path: filePath,
      original_name: file.name,
      mime_type: file.type,
      file_size: file.size,
      processing_mode: processingMode,
      status: processingMode === "direct" ? "direct_queued" : "queued",
    }).select("id, original_name, status").single();

    if (insertError || !job) {
      // Pas d'orphelin : le fichier déjà écrit est retiré.
      await admin.storage.from("invoice-files").remove([filePath]);
      errors.push({ name: file.name, message: insertError?.message ?? "création du job impossible" });
      continue;
    }

    // Plus de mise en file séparée : `status = 'queued'` EST la mise en file. La file
    // pgmq a été retirée (voir `20260806000001_fair_dispatch.sql`) — elle formait une
    // seconde source de vérité à synchroniser, et sa nature FIFO globale empêchait
    // l'ordonnancement équitable entre clients.
    jobs.push(job);
  }

  if (!jobs.length) {
    return NextResponse.json(
      { error: errors[0] ? `${errors[0].name} : ${errors[0].message}` : "Mise en file impossible.", errors, jobs: [] },
      { status: 500 },
    );
  }

  return NextResponse.json({ jobs, errors, processing_mode: processingMode }, { status: 202 });
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
