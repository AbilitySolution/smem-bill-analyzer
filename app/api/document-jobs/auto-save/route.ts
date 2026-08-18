import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { matchesCronSecret } from "@/lib/ops/cron-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserContext } from "@/lib/auth";
import { invoiceExtractionSchema } from "@/lib/anthropic/invoice-schema";
import { validateInvoiceInContext } from "@/lib/invoices/contextual-validation";
import { matchCommuneScored, matchSiteByContract } from "@/lib/extraction/matching";
import { saveInvoice, escalateHighAnomalies } from "@/lib/invoices/save";
import { CORRECTION_CONFIDENCE_THRESHOLD as REVIEW_CONFIDENCE_THRESHOLD } from "@/lib/data/corrections";
import { recomputeAndPersistAnomalies } from "@/lib/anomalies/persist";

export const runtime = "nodejs";
// Un lot de jobs peut enchaîner plusieurs dizaines d'enregistrements.
export const maxDuration = 300;

/**
 * Enregistrement automatique des documents extraits.
 *
 * Seul un blocage dur empêche l'enregistrement : aucune commune identifiable (même à
 * faible confiance) pour rattacher client/contrat/site. Dans tous les autres cas, la
 * facture est enregistrée — la confiance basse (commune incertaine ou extraction
 * incertaine, sous `AUTO_THRESHOLD`) devient un **signalement après coup**
 * (anomalie + tag "Anomalie", `lib/invoices/save.ts`) plutôt qu'un blocage avant coup.
 * Avant, sous le seuil, le document restait indéfiniment hors base tant que personne
 * ne le relisait à la main — un dépôt de 200 factures pouvait en laisser des dizaines
 * bloquées, invisibles ailleurs que dans la file de traitement.
 *
 * Trois issues par job :
 *   - autoSaved  : facture créée avec `auto_saved = true`. Son statut porte le verdict
 *                  de lecture — `reviewed` si les seuils sont tenus, `pending_review`
 *                  sinon, auquel cas elle remonte dans l'écran « À vérifier » ;
 *   - duplicates : facture déjà en base, le job est clos en pointant l'existante ;
 *   - toReview   : blocage dur uniquement (pas de commune détectée, extraction
 *                  invalide, ou échec d'enregistrement) — révision manuelle requise.
 *
 * ── Deux appelants ───────────────────────────────────────────────────────────────
 *
 * 1. La page d'import, avec la session de l'utilisateur : retour immédiat après un
 *    dépôt, bornée aux documents qu'elle vient de suivre.
 *
 * 2. Un Cron, avec `Authorization: Bearer $CRON_SECRET` : balaie toutes les
 *    organisations. C'est LUI qui rend l'enregistrement automatique fiable — en mode
 *    `batch` les résultats reviennent après des minutes ou des heures, l'onglet est
 *    fermé depuis longtemps, et sans ce chemin les documents restaient en
 *    `needs_review` indéfiniment.
 *
 *    Sur Vercel, la planification vit dans `vercel.json` (`crons`) et la plateforme
 *    injecte elle-même l'en-tête depuis la variable `CRON_SECRET`. Tout ordonnanceur
 *    externe envoyant le même en-tête convient également — par exemple `pg_cron` +
 *    `pg_net` côté Supabase, utile si le plan Vercel ne descend pas sous le tick
 *    quotidien.
 */
const AUTO_THRESHOLD = 0.96;
/**
 * Documents traités par appel. Chaque enregistrement fait une dizaine d'allers-retours
 * en base ; au-delà, la route dépasse `maxDuration` et **tout** le travail de la requête
 * est perdu. Le client rappelle la route par tranches.
 */
const MAX_JOBS_PER_CALL = 25;
/** Organisations servies par tick de Cron, la plus anciennement en attente d'abord. */
const CRON_MAX_ORGS = 3;
/** Documents par organisation et par tick. */
const CRON_MAX_JOBS_PER_ORG = 15;
/**
 * Marge sous `maxDuration`. Dépasser signifie perdre la réponse ET tout le travail non
 * encore écrit ; on préfère s'arrêter net et laisser le tick suivant continuer.
 */
const TIME_BUDGET_MS = 240_000;

interface AutoSavedEntry { jobId: string; invoiceId: string; factureNumber: string; lowConfidence: boolean }
interface DuplicateEntry { jobId: string; existingInvoiceId: string; factureNumber: string }
interface ToReviewEntry { jobId: string; factureNumber: string; reason: string }

interface PendingJob {
  id: string;
  file_path: string;
  created_by: string;
  extraction_json: unknown;
  extractor_version: string | null;
}

interface OrgOutcome {
  autoSaved: AutoSavedEntry[];
  duplicates: DuplicateEntry[];
  toReview: ToReviewEntry[];
  createdInvoiceIds: string[];
}

/**
 * Examine des documents d'UNE organisation.
 *
 * `created_by` est repris de chaque job, pas de l'appelant : le Cron n'a pas de session,
 * et même en mode utilisateur c'est plus juste — la facture est créditée à celui qui a
 * déposé le document, pas à celui qui a déclenché l'enregistrement.
 */
async function autoSaveOrgJobs(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  orgId: string,
  jobs: PendingJob[],
  deadline: number,
): Promise<OrgOutcome> {
  const autoSaved: AutoSavedEntry[] = [];
  const duplicates: DuplicateEntry[] = [];
  const toReview: ToReviewEntry[] = [];
  const createdInvoiceIds: string[] = [];
  const examinedJobIds: string[] = [];

  const markCompleted = (jobId: string, invoiceId: string) =>
    admin.from("document_jobs")
      .update({ status: "completed", processed_invoice_id: invoiceId, updated_at: new Date().toISOString() })
      .eq("id", jobId);

  for (const job of jobs) {
    if (Date.now() > deadline) break;
    examinedJobIds.push(job.id);

    const parsed = invoiceExtractionSchema.safeParse(job.extraction_json);
    if (!parsed.success) {
      toReview.push({ jobId: job.id, factureNumber: "—", reason: "extraction incomplète" });
      continue;
    }
    const extraction = parsed.data;
    const factureNumber = extraction.invoice.facture_number ?? "—";

    const validation = await validateInvoiceInContext(supabase, extraction, { orgId });
    const commune = await matchCommuneScored(supabase, orgId, extraction);
    const site = commune
      ? await matchSiteByContract(supabase, orgId, commune.id, extraction.contract.contract_number)
      : null;

    if (commune) {
      await admin.from("document_jobs")
        .update({ suggested_commune_id: commune.id, suggested_site_id: site?.id ?? null })
        .eq("id", job.id);
    }

    // Seul blocage dur : aucune commune à laquelle rattacher client/contrat/site.
    // `saveInvoice` refuserait de toute façon (`site_id`/`commune_id` requis) — le
    // vérifier ici évite un aller-retour pour rien et donne un motif plus parlant que
    // l'erreur générique de `saveInvoice`.
    if (!commune) {
      toReview.push({ jobId: job.id, factureNumber, reason: "commune non détectée" });
      continue;
    }

    // En dessous du seuil, on enregistre quand même — la meilleure commune trouvée,
    // même incertaine — mais on le signale après coup plutôt que de laisser le document
    // hors base indéfiniment. `lowConfidenceReason` fait poser l'anomalie + le tag
    // "Anomalie" par `saveInvoice`, qui centralise déjà ce genre de signalement.
    //
    // Deux seuils distincts, parce que les deux risques ne se valent pas :
    //   - la COMMUNE reste jugée à `AUTO_THRESHOLD` (96 %). Un mauvais rattachement
    //     fausse les analyses de deux sites à la fois et se corrige mal une fois la
    //     facture noyée dans le portefeuille : on veut le savoir dès 4 % de doute.
    //   - l'EXTRACTION est jugée à `REVIEW_CONFIDENCE_THRESHOLD` (85 %). Entre 85 et
    //     96 % elle est presque toujours juste ; signaler à 96 % remonterait 12 % du
    //     volume au lieu de 5 %, et une liste qu'on n'ouvre plus ne protège de rien.
    //   - une ANOMALIE STRUCTURELLE (gravité `error`) route la facture quelle que soit la
    //     confiance. Ces contrôles ne portent pas un jugement mais un constat : deux
    //     valeurs du document se contredisent. La moyenne pondérée ne peut pas les
    //     rattraper — un champ faux parmi neuf justes laisse le score au-dessus du seuil,
    //     et c'est précisément ce qui s'est produit : des factures dont l'index recule
    //     alors que la consommation est positive étaient enregistrées comme validées à
    //     96 % de confiance. L'anomalie était détectée, écrite en base, puis ignorée ici.
    const lowConfidenceReasons: string[] = [];
    if (commune.score < AUTO_THRESHOLD) lowConfidenceReasons.push(`commune associée à ${Math.round(commune.score * 100)} % de confiance`);
    if (validation.confidence < REVIEW_CONFIDENCE_THRESHOLD) lowConfidenceReasons.push(`extraction évaluée à ${Math.round(validation.confidence * 100)} % de confiance`);
    const blockingIssues = validation.issues.filter((issue) => issue.severity === "error");
    if (blockingIssues.length > 0) {
      lowConfidenceReasons.push(
        `${blockingIssues.length} anomalie${blockingIssues.length > 1 ? "s" : ""} structurelle${blockingIssues.length > 1 ? "s" : ""} (${[...new Set(blockingIssues.map((i) => i.code))].join(", ")})`,
      );
    }
    const lowConfidence = lowConfidenceReasons.length > 0;

    // Appel direct plutôt qu'un aller-retour HTTP interne vers /api/invoices : même
    // logique d'enregistrement, sans dépendre de l'origine de la requête ni payer un
    // aller-retour réseau par facture.
    const saved = await saveInvoice(
      supabase,
      { orgId, userId: job.created_by },
      {
        extraction,
        // Provenance réelle de l'extraction : celle du job, pas la version courante de
        // l'application — le job a pu être extrait par une version antérieure.
        ...(job.extractor_version ? { extractor_version: job.extractor_version } : {}),
        file_path: job.file_path,
        commune_id: commune.id,
        ...(site ? { site_id: site.id } : {}),
        custom_fields: [],
      },
      // Le statut porte le VERDICT DE LECTURE, pas le mode d'enregistrement.
      //
      // Auparavant, toute facture enregistrée automatiquement arrivait en
      // `pending_review` — ce qui revenait à marquer « à contrôler » 193 factures sur
      // 248 pour 3 réellement contrôlées. Un statut porté par 78 % du portefeuille
      // n'attire plus l'attention de personne, et l'écran de vérification bâti dessus
      // devenait inutilisable.
      //
      // Désormais : une lecture au-dessus des seuils est acceptée telle quelle
      // (`reviewed`), et `pending_review` ne désigne QUE ce qui mérite un œil humain —
      // environ 5 % du volume. `auto_saved` reste vrai dans les deux cas et garde la
      // trace du mode d'enregistrement, qui est une information distincte.
      {
        status: lowConfidence ? "pending_review" : "reviewed",
        autoSaved: true,
        skipPortfolioRecompute: true,
        ...(lowConfidence ? { lowConfidenceReason: `Enregistrement automatique à confiance réduite : ${lowConfidenceReasons.join(" · ")}.` } : {}),
      },
    );

    if (saved.ok) {
      await markCompleted(job.id, saved.invoiceId);
      createdInvoiceIds.push(saved.invoiceId);
      autoSaved.push({ jobId: job.id, invoiceId: saved.invoiceId, factureNumber, lowConfidence });
      continue;
    }

    if (saved.status === 409 && saved.existingInvoiceId) {
      // Doublon : rien n'est créé, le job sort de la file en pointant l'existante.
      await markCompleted(job.id, saved.existingInvoiceId);
      duplicates.push({ jobId: job.id, existingInvoiceId: saved.existingInvoiceId, factureNumber });
      continue;
    }

    toReview.push({ jobId: job.id, factureNumber, reason: saved.error });
  }

  // Marqueur d'examen, y compris pour les documents partis en révision manuelle : ils
  // restent `needs_review` par construction, et sans ça le Cron les réexaminerait à
  // chaque tick, pour toujours. Écrit à la fin : une requête interrompue ne marque rien
  // et le tick suivant reprend le travail.
  if (examinedJobIds.length) {
    await admin.from("document_jobs")
      .update({ auto_save_attempted_at: new Date().toISOString() })
      .in("id", examinedJobIds);
  }

  return { autoSaved, duplicates, toReview, createdInvoiceIds };
}

/** Recalcul portefeuille + escalade, une seule fois par organisation. */
async function finalizeOrg(supabase: SupabaseClient, orgId: string, invoiceIds: string[]) {
  if (!invoiceIds.length) return false;
  const { computed } = await recomputeAndPersistAnomalies(supabase, orgId);
  await escalateHighAnomalies(supabase, orgId, invoiceIds, computed);
  return true;
}

/** Balayage multi-organisations déclenché par le Cron. */
async function runCronSweep(deadline: number) {
  const admin = createAdminClient();
  const { data: orgs, error } = await admin.rpc("list_orgs_pending_auto_save", { org_limit: CRON_MAX_ORGS });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const pendingOrgs = (orgs ?? []) as Array<{ org_id: string; pending_count: number }>;
  const summary: Array<{ orgId: string; examined: number; autoSaved: number; toReview: number; duplicates: number }> = [];

  for (const org of pendingOrgs) {
    if (Date.now() > deadline) break;
    const { data: jobs } = await admin
      .from("document_jobs")
      .select("id, file_path, created_by, extraction_json, extractor_version")
      .eq("org_id", org.org_id)
      .eq("status", "needs_review")
      .is("auto_save_attempted_at", null)
      .order("result_available_at", { ascending: true })
      .limit(CRON_MAX_JOBS_PER_ORG);
    if (!jobs?.length) continue;

    // Client admin de bout en bout : le Cron n'a aucune session, donc aucune RLS à
    // laquelle s'adosser. L'isolation vient du filtre `org_id` ci-dessus, et chaque
    // organisation est traitée dans son propre passage — jamais deux mélangées.
    const outcome = await autoSaveOrgJobs(admin, admin, org.org_id, jobs as PendingJob[], deadline);
    await finalizeOrg(admin, org.org_id, outcome.createdInvoiceIds);
    summary.push({
      orgId: org.org_id,
      examined: jobs.length,
      autoSaved: outcome.autoSaved.length,
      toReview: outcome.toReview.length,
      duplicates: outcome.duplicates.length,
    });
  }

  return NextResponse.json({ mode: "cron", organizations: summary });
}

/**
 * Point d'entrée du Cron.
 *
 * Vercel invoque les tâches planifiées en **GET**, pas en POST. Le verbe n'est pas
 * idempotent ici — c'est la contrainte de la plateforme, pas un choix — d'où l'accès
 * strictement réservé au porteur de `CRON_SECRET`. `matchesCronSecret` renvoie `false`
 * quand la variable n'est pas définie : la route échoue fermée.
 */
export async function GET(request: Request) {
  if (!matchesCronSecret(request.headers.get("authorization") ?? "")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runCronSweep(Date.now() + TIME_BUDGET_MS);
}

export async function POST(request: Request) {
  const deadline = Date.now() + TIME_BUDGET_MS;

  // Le Cron est vérifié en premier : il n'a pas de session, `getUserContext` renverrait
  // 401 avant d'avoir la moindre chance de tourner. Accepté en POST aussi, pour un
  // ordonnanceur externe (pg_cron + pg_net) qui préférerait ce verbe.
  if (matchesCronSecret(request.headers.get("authorization") ?? "")) {
    return runCronSweep(deadline);
  }

  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createClient();
  const body = await request.json().catch(() => ({}));
  const jobIds: string[] | null = Array.isArray(body?.job_ids)
    ? body.job_ids.filter((value: unknown): value is string => typeof value === "string")
    : null;
  // Le recalcul d'anomalies portefeuille balaie TOUTE l'organisation (toutes les
  // factures, toutes les périodes de consommation, suppression puis réinsertion des
  // anomalies). Il coûte O(taille de l'organisation), pas O(factures ajoutées) — le
  // faire à chaque tranche de 25 revenait à balayer 8 fois l'organisation pour un dépôt
  // de 200 factures. L'appelant signale donc sa dernière tranche.
  //
  // Défaut `true` : un appel qui ne dit rien garde l'ancien comportement.
  const finalize = body?.finalize !== false;
  // Factures créées par les tranches PRÉCÉDENTES du même dépôt : sans elles, seule la
  // dernière tranche serait escaladée en `anomaly_flagged`.
  const previousInvoiceIds: string[] = Array.isArray(body?.escalate_invoice_ids)
    ? body.escalate_invoice_ids.filter((value: unknown): value is string => typeof value === "string").slice(0, 500)
    : [];

  let query = supabase
    .from("document_jobs")
    .select("id, file_path, created_by, extraction_json, extractor_version")
    .eq("org_id", ctx.orgId)
    .eq("created_by", ctx.userId)
    .eq("status", "needs_review")
    .is("auto_save_attempted_at", null)
    .order("created_at", { ascending: true })
    .limit(MAX_JOBS_PER_CALL);
  if (jobIds && jobIds.length) query = query.in("id", jobIds.slice(0, MAX_JOBS_PER_CALL));
  const { data: jobs, error: jobsError } = await query;

  if (jobsError) return NextResponse.json({ error: jobsError.message }, { status: 500 });
  if (!jobs || jobs.length === 0) {
    return NextResponse.json({ autoSaved: [], toReview: [], duplicates: [] });
  }

  const admin = createAdminClient();
  const outcome = await autoSaveOrgJobs(supabase, admin, ctx.orgId, jobs as PendingJob[], deadline);

  const invoicesToEscalate = [...new Set([...previousInvoiceIds, ...outcome.createdInvoiceIds])];
  const recomputed = finalize ? await finalizeOrg(supabase, ctx.orgId, invoicesToEscalate) : false;

  return NextResponse.json({
    autoSaved: outcome.autoSaved,
    toReview: outcome.toReview,
    duplicates: outcome.duplicates,
    recomputed,
  });
}
