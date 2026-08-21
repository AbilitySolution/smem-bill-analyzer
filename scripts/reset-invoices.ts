/**
 * Remise à zéro des données de facturation d'une organisation.
 *
 * ⚠️ DESTRUCTIF ET IRRÉVERSIBLE. Il n'y a pas de corbeille : ce qui est supprimé l'est.
 *
 * Conçu pour repartir d'un parc vide et réimporter — pas pour du ménage courant.
 *
 * Usage :
 *   pnpm reset:invoices --org "SMEM"                                  # compte, ne supprime rien
 *   pnpm reset:invoices --org "SMEM" --confirm "SMEM"                 # supprime les factures
 *   pnpm reset:invoices --org "SMEM" --confirm "SMEM" --scope referentiel --storage
 *
 * Trois garde-fous, dans cet ordre :
 *   1. `--org` est obligatoire. Il n'existe aucune forme « tout supprimer » : une base
 *      multi-tenant n'a pas de raison légitime d'être vidée d'un bloc.
 *   2. Sans `--confirm`, le script ne fait que compter. C'est le mode par défaut, y compris
 *      quand on se trompe de commande.
 *   3. `--confirm` doit reprendre le nom exact de l'organisation. Un `--force` booléen se
 *      tape sans réfléchir ; un nom à recopier oblige à lire ce qu'on vise.
 *
 * CE QUI N'EST JAMAIS SUPPRIMÉ, quelle que soit la portée :
 *   - `communes` — référentiel curé (34 communes de Martinique, codes INSEE du COG 2026,
 *     centroïdes officiels vérifiés par `scripts/check-communes-referentiel.ts`). Réimporter
 *     des factures ne le reconstruit PAS. Le perdre coûterait un travail manuel réel.
 *   - `organizations`, `user_roles`, `tags`, `custom_field_definitions` — configuration du
 *     compte, sans rapport avec les factures.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { join } from "node:path";

import { loadEnv } from "./_env";
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const BUCKET = "invoice-files";

/**
 * Tables org-scopées, supprimées dans cet ordre, après les filles (voir `CHILD_TABLES`).
 *
 * `invoices` vient en dernier : rien ne doit plus la référencer quand son tour arrive.
 */
const SCOPES = {
  /** Factures et file de traitement. `contracts`/`clients`/`sites` survivent. */
  factures: [
    "document_jobs",
    "document_batches",
    "document_dispatch_cursor",
    "pending_uploads",
    "file_request_links",
    "invoices",
  ],
  /**
   * Ajoute les entités dérivées de l'extraction. Elles se reconstruisent seules au
   * réimport — mais `sites` peut porter des choix humains (catégorie bâtiment / éclairage
   * public tranchée en relecture), d'où le fait qu'elle ne soit pas dans la portée par défaut.
   */
  referentiel: [
    "document_jobs",
    "document_batches",
    "document_dispatch_cursor",
    "pending_uploads",
    "file_request_links",
    "invoices",
    "contracts",
    "clients",
    "sites",
  ],
} as const;

/**
 * Tables filles, supprimées explicitement AVANT `invoices`.
 *
 * Elles déclarent toutes `ON DELETE CASCADE` dans les migrations — et s'appuyer là-dessus
 * a échoué en production :
 *
 *   ÉCHEC invoices — update or delete on table "invoices" violates foreign key
 *   constraint "anomalies_invoice_id_fkey" on table "anomalies"
 *
 * `20260704050000_squash.sql` est une reconstruction d'un schéma préexistant : son
 * `CREATE TABLE IF NOT EXISTS anomalies (...)` n'a rien fait contre la table déjà en place,
 * qui a conservé sa contrainte d'origine, sans cascade. Les migrations décrivent donc un
 * schéma que la base n'a pas.
 *
 * D'où la règle ici : ne rien déduire des cascades déclarées, supprimer soi-même. Plus
 * verbeux, mais insensible à l'écart entre les migrations et la réalité.
 */
const CHILD_TABLES = [
  "consumption_periods",
  "invoice_charges",
  "corrections_log",
  "anomalies",
  "invoice_tags",
  "invoice_custom_field_values",
] as const;

/**
 * Les filtres `.in(...)` partent dans l'URL : au-delà de quelques centaines
 * d'identifiants, PostgREST rejette la requête sur la longueur.
 */
const CHUNK = 100;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function countByOrg(db: SupabaseClient, table: string, orgId: string): Promise<number | null> {
  const { count, error } = await db
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId);
  return error ? null : (count ?? 0);
}

/** Les tables filles n'ont pas d'`org_id` : elles se comptent par rattachement à la facture. */
async function countByInvoice(db: SupabaseClient, table: string, invoiceIds: string[]): Promise<number | null> {
  if (invoiceIds.length === 0) return 0;
  const { count, error } = await db
    .from(table)
    .select("*", { count: "exact", head: true })
    .in("invoice_id", invoiceIds);
  return error ? null : (count ?? 0);
}

async function main() {
  const orgName = arg("org");
  const confirm = arg("confirm");
  const scopeName = (arg("scope") ?? "factures") as keyof typeof SCOPES;
  const withStorage = flag("storage");

  if (!orgName) throw new Error('--org est obligatoire. Exemple : --org "SMEM"');
  if (!(scopeName in SCOPES)) throw new Error(`--scope doit valoir ${Object.keys(SCOPES).join(" ou ")}`);

  const env = loadEnv();
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: org, error: orgError } = await db
    .from("organizations")
    .select("id, nom")
    .eq("nom", orgName)
    .maybeSingle();
  if (orgError) throw new Error(orgError.message);
  if (!org) throw new Error(`Organisation introuvable : ${orgName}`);

  const orgId = org.id as string;
  const tables = SCOPES[scopeName];

  // --- État des lieux ---------------------------------------------------------
  const { data: invoiceRows } = await db.from("invoices").select("id, file_path").eq("org_id", orgId);
  const invoiceIds = (invoiceRows ?? []).map((r) => r.id as string);

  const { data: jobRows } = await db.from("document_jobs").select("file_path").eq("org_id", orgId);

  console.log(`Organisation  ${org.nom}  (${orgId})`);
  console.log(`Portée        ${scopeName}\n`);

  console.log("Supprimé directement :");
  for (const t of tables) {
    const n = await countByOrg(db, t, orgId);
    console.log(`  ${String(n ?? "—").padStart(7)}  ${t}${n === null ? "  (table absente ou inaccessible)" : ""}`);
  }

  console.log("\nTables filles, supprimées explicitement avant invoices :");
  for (const t of CHILD_TABLES) {
    const n = await countByInvoice(db, t, invoiceIds);
    console.log(`  ${String(n ?? "—").padStart(7)}  ${t}`);
  }

  const filePaths = [
    ...new Set([
      ...(invoiceRows ?? []).map((r) => r.file_path as string),
      ...(jobRows ?? []).map((r) => r.file_path as string),
    ]),
  ].filter(Boolean);

  console.log(
    `\nFichiers du bucket ${BUCKET} : ${filePaths.length}` +
      (withStorage ? "  → seront supprimés" : "  → CONSERVÉS (ajouter --storage pour les supprimer)"),
  );

  console.log("\nJamais touché : communes, organizations, user_roles, tags, custom_field_definitions");

  // --- Garde-fou --------------------------------------------------------------
  if (confirm !== org.nom) {
    console.log(
      `\n── SIMULATION — rien n'a été supprimé ──\n` +
        `Pour exécuter réellement :\n` +
        `  pnpm reset:invoices --org "${org.nom}" --confirm "${org.nom}"` +
        `${scopeName !== "factures" ? ` --scope ${scopeName}` : ""}${withStorage ? " --storage" : ""}`,
    );
    if (confirm !== undefined) console.log(`\n(--confirm "${confirm}" ne correspond pas à "${org.nom}")`);
    return;
  }

  // --- Suppression ------------------------------------------------------------
  console.log("\n── SUPPRESSION ──");

  // Les filles d'abord, par lots : elles n'ont pas d'`org_id` et se rattachent par facture.
  for (const t of CHILD_TABLES) {
    let failed = "";
    for (const batch of chunked(invoiceIds, CHUNK)) {
      const { error } = await db.from(t).delete().in("invoice_id", batch);
      if (error) failed = error.message;
    }
    console.log(`  ${failed ? `ÉCHEC  ${t} — ${failed}` : `ok     ${t}`}`);
    // On continue malgré une erreur : un arrêt à mi-parcours laisserait un état plus
    // incohérent que d'aller au bout et de signaler ce qui a échoué.
  }

  for (const t of tables) {
    // Filtre sur `org_id` et non sur une liste d'identifiants : une facture créée entre
    // l'état des lieux et maintenant serait sinon laissée derrière.
    const { error } = await db.from(t).delete().eq("org_id", orgId);
    console.log(`  ${error ? `ÉCHEC  ${t} — ${error.message}` : `ok     ${t}`}`);
  }

  if (withStorage && filePaths.length > 0) {
    // L'API storage plafonne la suppression par lot ; on découpe.
    let removed = 0;
    for (let i = 0; i < filePaths.length; i += 100) {
      const chunk = filePaths.slice(i, i + 100);
      const { error } = await db.storage.from(BUCKET).remove(chunk);
      if (error) console.log(`  ÉCHEC  storage (lot ${i / 100 + 1}) — ${error.message}`);
      else removed += chunk.length;
    }
    console.log(`  ok     storage — ${removed}/${filePaths.length} fichiers supprimés`);
  }

  // --- Vérification -----------------------------------------------------------
  console.log("\n── APRÈS ──");
  let remaining = 0;
  for (const t of CHILD_TABLES) {
    const n = await countByInvoice(db, t, invoiceIds);
    remaining += n ?? 0;
    console.log(`  ${String(n ?? "—").padStart(7)}  ${t}`);
  }
  for (const t of tables) {
    const n = await countByOrg(db, t, orgId);
    remaining += n ?? 0;
    console.log(`  ${String(n ?? "—").padStart(7)}  ${t}`);
  }
  console.log(
    remaining === 0
      ? "\nParc vide. Prêt pour un réimport."
      : `\n⚠ ${remaining} ligne(s) subsistent — voir les échecs ci-dessus.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
