/**
 * Banc de mesure de l'extraction.
 *
 * Le dépôt ne contenait aucun document de test : chaque modification de prompt partait en
 * production sans qu'on puisse dire si elle améliorait ou dégradait quoi que ce soit. La
 * réponse existait, mais seulement des semaines plus tard, dans les corrections humaines.
 *
 * Ce script ferme la boucle. La vérité terrain n'est pas à produire : ce sont les factures
 * déjà validées et corrigées par les utilisateurs, dont `raw_ocr_json` porte la version
 * approuvée. Il suffisait de les figer.
 *
 * Usage :
 *   pnpm eval:build [--org "Nom Org"] [--limit 100]
 *   pnpm eval:run   [--concurrency 4]
 *   pnpm eval:compare <rapport-avant.json> <rapport-après.json>
 *   pnpm eval:inspect <numéro de facture>
 *
 * `build` fige le jeu de référence, `run` rejoue l'extraction dessus et écrit un rapport
 * horodaté, `compare` met deux rapports en regard. C'est `compare` qui décide d'un
 * déploiement : ce n'est pas la précision absolue qui compte, c'est son mouvement.
 *
 * Le jeu de référence est écrit hors du dépôt (`.extraction-eval/`) : il contient des
 * données client et n'a rien à faire dans git.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildExtractionParams, isExtractionMediaType, parseExtractionResponse } from "../lib/anthropic/extraction-request";
import { EXTRACTOR_VERSION } from "../lib/anthropic/extractor-version";
import { invoiceExtractionSchema } from "../lib/anthropic/invoice-schema";
import { aggregate, compareReports, scoreCase, type CaseResult, type EvalReport, type GoldenCase } from "../lib/extraction/eval";

import { loadEnv } from "./_env";
const OUT_DIR = join(process.cwd(), ".extraction-eval");
const GOLDEN_PATH = join(OUT_DIR, "golden.json");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

let cachedEnv: Record<string, string> | undefined;
function env(): Record<string, string> {
  cachedEnv ??= loadEnv();
  return cachedEnv;
}

/**
 * Client construit à la demande : `compare` ne lit que des fichiers, et une invocation
 * sans commande doit afficher l'usage plutôt qu'une pile d'erreurs sur `.env.local`.
 */
let cachedSupabase: SupabaseClient | undefined;
function db(): SupabaseClient {
  cachedSupabase ??= createClient(
    env().NEXT_PUBLIC_SUPABASE_URL,
    env().SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
  return cachedSupabase;
}

/**
 * Fige le jeu de référence.
 *
 * Deux filtres portent tout le sens de la mesure :
 *   - `auto_saved = false` : une facture enregistrée sans relecture n'a été vérifiée par
 *     personne. La retenir reviendrait à mesurer le modèle contre lui-même.
 *   - `archived = false` : une facture archivée l'a souvent été parce qu'elle était fausse.
 */
async function build() {
  const orgName = arg("org");
  const limit = Number(arg("limit", "100"));

  let orgId: string | undefined;
  if (orgName) {
    const { data } = await db().from("organizations").select("id").eq("nom", orgName).maybeSingle();
    if (!data) throw new Error(`Organisation introuvable : ${orgName}`);
    orgId = data.id;
  }

  let query = db()
    .from("invoices")
    .select("id, facture_number, file_path, raw_ocr_json")
    .eq("auto_saved", false)
    .eq("archived", false)
    .not("raw_ocr_json", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (orgId) query = query.eq("org_id", orgId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const cases: GoldenCase[] = [];
  let rejected = 0;
  for (const row of data ?? []) {
    // `raw_ocr_json` porte parfois un `_override` ajouté à l'enregistrement : le schéma
    // strict le tolère (clé en trop), mais une extraction incomplète doit être écartée —
    // elle ferait une référence fausse.
    const parsed = invoiceExtractionSchema.safeParse(row.raw_ocr_json);
    if (!parsed.success) {
      rejected++;
      continue;
    }
    cases.push({
      invoiceId: row.id,
      factureNumber: row.facture_number,
      filePath: row.file_path,
      expected: parsed.data,
    });
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(GOLDEN_PATH, JSON.stringify(cases, null, 2));
  console.log(`Jeu de référence : ${cases.length} factures → ${GOLDEN_PATH}`);
  if (rejected > 0) console.log(`  (${rejected} écartées : extraction incomplète en base)`);
  if (cases.length < 30) {
    console.log(`  ⚠ En dessous de ~30 factures, un écart de précision n'est pas distinguable du bruit.`);
  }
}

async function extractOne(anthropic: Anthropic, filePath: string) {
  const { data, error } = await db().storage.from("invoice-files").download(filePath);
  if (error || !data) throw new Error(`Téléchargement impossible : ${error?.message ?? "fichier absent"}`);

  const mediaType = data.type || "application/pdf";
  if (!isExtractionMediaType(mediaType)) throw new Error(`Type non supporté : ${mediaType}`);

  const base64 = Buffer.from(await data.arrayBuffer()).toString("base64");
  const response = await anthropic.messages.create(buildExtractionParams(base64, mediaType));
  const parsed = parseExtractionResponse(response.content);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.data;
}

async function run() {
  const concurrency = Number(arg("concurrency", "4"));
  const cases: GoldenCase[] = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
  const anthropic = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });

  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= cases.length) return;
      const c = cases[i];
      try {
        const actual = await extractOne(anthropic, c.filePath);
        const { comparedFields, wrongFields, divergences } = scoreCase(c.expected, actual);
        results[i] = { factureNumber: c.factureNumber, comparedFields, wrongFields, divergences };
      } catch (err) {
        results[i] = {
          factureNumber: c.factureNumber,
          comparedFields: [],
          wrongFields: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
      done++;
      process.stdout.write(`\r  ${done}/${cases.length}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  process.stdout.write("\n");

  const report = aggregate(results);
  const path = join(OUT_DIR, `report-${EXTRACTOR_VERSION}-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify({ extractorVersion: EXTRACTOR_VERSION, report, results }, null, 2));

  console.log(`\nExtracteur    ${EXTRACTOR_VERSION}`);
  console.log(`Factures      ${report.caseCount} (${report.failedCount} en échec)`);
  console.log(`Sans écart    ${report.exactCount}/${report.caseCount - report.failedCount}`);
  console.log(`Précision     ${report.overallPrecision == null ? "—" : `${(report.overallPrecision * 100).toFixed(1)} %`}`);
  console.log(`\nChamps les moins fiables :`);
  for (const f of report.fields.filter((f) => f.precision != null).slice(0, 12)) {
    console.log(`  ${(f.precision! * 100).toFixed(1).padStart(6)} %  ${f.key}  (${f.compared} factures)`);
  }
  console.log(`\nRapport → ${path}`);
}

function compare() {
  const [beforePath, afterPath] = process.argv.slice(3);
  if (!beforePath || !afterPath) throw new Error("Usage : compare <avant.json> <après.json>");

  const before: { report: EvalReport } = JSON.parse(readFileSync(beforePath, "utf8"));
  const after: { report: EvalReport } = JSON.parse(readFileSync(afterPath, "utf8"));
  const deltas = compareReports(before.report, after.report);

  const regressions = deltas.filter((d) => d.delta < -0.01);
  const gains = deltas.filter((d) => d.delta > 0.01).reverse();

  console.log(`Précision globale  ${fmtPct(before.report.overallPrecision)} → ${fmtPct(after.report.overallPrecision)}`);
  console.log(`Factures exactes   ${before.report.exactCount} → ${after.report.exactCount}`);

  if (regressions.length > 0) {
    console.log(`\nRÉGRESSIONS :`);
    for (const d of regressions) {
      console.log(`  ${(d.delta * 100).toFixed(1).padStart(6)} pt  ${d.key}  (${fmtPct(d.before)} → ${fmtPct(d.after)})`);
    }
  }
  if (gains.length > 0) {
    console.log(`\nGains :`);
    for (const d of gains) {
      console.log(`  +${(d.delta * 100).toFixed(1).padStart(5)} pt  ${d.key}  (${fmtPct(d.before)} → ${fmtPct(d.after)})`);
    }
  }
  if (regressions.length === 0 && gains.length === 0) console.log(`\nAucun mouvement au-delà d'un point.`);

  // Code de sortie exploitable en CI : une régression fait échouer la commande.
  if (regressions.length > 0) process.exitCode = 1;
}

/**
 * Rejoue UNE facture et affiche les écarts avec leurs valeurs.
 *
 * Sert à contredire le banc. Un rapport agrégé qui signale un champ faux sans montrer les
 * deux valeurs ne peut être ni confirmé ni réfuté — et une mesure qu'on ne peut pas
 * contredire ne vaut rien.
 *
 * Affiche aussi les corrections post-enregistrement portant sur les champs en cause. La
 * référence (`raw_ocr_json`) est un instantané pris à l'enregistrement : si la facture a
 * été retouchée ensuite, la ligne en base est juste et la référence périmée. C'est
 * l'explication à écarter en premier quand un écart semble faux.
 */
async function inspect() {
  const target = process.argv[3];
  if (!target) throw new Error("Usage : pnpm eval:inspect <numéro de facture>");

  const cases: GoldenCase[] = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
  const c = cases.find((x) => x.factureNumber === target);
  if (!c) throw new Error(`Facture absente du jeu de référence : ${target}`);

  const anthropic = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  console.log(`Réextraction de ${c.factureNumber} (${c.filePath})...`);
  const actual = await extractOne(anthropic, c.filePath);
  const { divergences, comparedFields } = scoreCase(c.expected, actual);

  if (divergences.length === 0) {
    console.log(`\nAucun écart sur ${comparedFields.length} champs comparés.`);
    return;
  }

  console.log(`\n${divergences.length} écart(s) sur ${comparedFields.length} champs comparés :\n`);
  for (const d of divergences) {
    const line = d.lineIndex !== undefined ? ` [ligne ${d.lineIndex + 1}]` : "";
    console.log(`  ${d.key}${line}`);
    console.log(`    référence   ${d.expected ?? "∅"}`);
    console.log(`    réextrait   ${d.actual ?? "∅"}`);
  }

  // La référence est-elle simplement périmée ?
  const { data: corrections } = await db()
    .from("corrections_log")
    .select("table_name, field_name, old_value, new_value, source, corrected_at")
    .eq("invoice_id", c.invoiceId)
    .order("corrected_at", { ascending: true });

  const postSave = (corrections ?? []).filter((x) => x.source === "post_save");
  if (postSave.length > 0) {
    console.log(`\n⚠ ${postSave.length} correction(s) APRÈS enregistrement sur cette facture.`);
    console.log(`  La référence est figée à l'enregistrement : ces champs y sont périmés,`);
    console.log(`  et l'écart mesuré ne dit rien sur la qualité de l'extraction.\n`);
    for (const x of postSave) {
      console.log(`  ${x.table_name}.${x.field_name} : "${x.old_value ?? "∅"}" → "${x.new_value ?? "∅"}"`);
    }
  } else {
    console.log(`\nAucune correction post-enregistrement : la référence est bien celle validée à la relecture.`);
  }
}

function fmtPct(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)} %`;
}

const commands: Record<string, () => void | Promise<void>> = { build, run, compare, inspect };

async function main() {
  const command = process.argv[2];
  if (!command || !(command in commands)) {
    console.error("Usage : pnpm eval:build | pnpm eval:run | pnpm eval:compare <avant.json> <après.json> | pnpm eval:inspect <n° facture>");
    process.exit(1);
  }
  await commands[command]();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
