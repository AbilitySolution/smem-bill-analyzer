/**
 * Vérifie que PostgREST atteint les tables avec la clé anon.
 *
 * Les migrations peuvent toutes passer au vert et laisser les tables sans `GRANT`. PostgREST
 * se connecte alors en `authenticator`, bascule vers `anon`, et se fait refuser AVANT que la
 * RLS soit consultée : 403 sur toute l'API, sans qu'aucune migration ni aucun test
 * applicatif ne signale quoi que ce soit. C'est arrivé sur ce dépôt le 2026-08-16, corrigé
 * par `20260817044616_postgrest_table_grants`.
 *
 * Un 200 ici ne dit rien des lignes renvoyées — la RLS reste seule juge de ce qui est
 * visible. Il dit seulement que la table est atteignable.
 *
 *   npm run check:rest                       # stack local
 *   npm run check:rest -- --env .env.local   # une base distante
 *
 * Sans `--env`, la clé et l'URL viennent de `supabase status`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const TABLES = [
  "communes", "sites", "invoices", "contracts", "anomalies",
  "document_jobs", "consumption_periods", "organizations",
  "pending_uploads", "invoice_analytics",
];

function arg(nom) {
  const i = process.argv.indexOf(nom);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function depuisFichierEnv(fichier) {
  const out = {};
  for (const ligne of readFileSync(fichier, "utf8").split("\n")) {
    const m = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: out.NEXT_PUBLIC_SUPABASE_URL, cle: out.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

/**
 * `supabase` est sur le PATH en CI, appelé via npx en local. Sous Windows, npx et supabase
 * sont des `.cmd` : on les nomme explicitement plutôt que de passer par `shell: true`, qui
 * concatènerait les arguments sans les échapper.
 */
function depuisStatus() {
  const win = process.platform === "win32";
  const candidats = [
    [win ? "supabase.cmd" : "supabase", []],
    [win ? "npx.cmd" : "npx", ["--yes", "supabase@latest"]],
  ];
  for (const [cmd, args] of candidats) {
    try {
      const brut = execFileSync(cmd, [...args, "status", "-o", "json"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      const j = JSON.parse(brut.slice(brut.indexOf("{")));
      return { url: j.API_URL, cle: j.ANON_KEY };
    } catch {
      /* essai suivant */
    }
  }
  return {};
}

// `--env` explicite, sinon `.env.local.stack` s'il existe (le cas courant en local), sinon
// `supabase status` — la seule source disponible en CI, où aucun fichier d'env n'est écrit.
const fichier = arg("--env") ?? (existsSync(".env.local.stack") ? ".env.local.stack" : undefined);
const { url, cle } = fichier && existsSync(fichier) ? depuisFichierEnv(fichier) : depuisStatus();

if (!url || !cle) {
  console.error("URL ou clé anon introuvable. Le stack local tourne-t-il (`npx supabase start`) ?");
  process.exit(2);
}

console.error(`→ base visée : ${url}`);

let echecs = 0;
for (const t of TABLES) {
  let code = "erreur";
  try {
    const r = await fetch(`${url}/rest/v1/${t}?limit=1`, {
      headers: { apikey: cle, Authorization: `Bearer ${cle}` },
    });
    code = String(r.status);
  } catch (e) {
    code = `injoignable (${e.message})`;
  }
  const ok = code === "200";
  if (!ok) echecs++;
  console.log(`${ok ? "  ok  " : "ÉCHEC "} ${t.padEnd(20)} ${code}`);
  if (!ok && process.env.GITHUB_ACTIONS) {
    console.log(`::error::${t} inatteignable depuis PostgREST (${code})`);
  }
}

if (echecs) {
  console.error(`\n${echecs} table(s) inatteignable(s) — cherchez un GRANT manquant.`);
  process.exit(1);
}
console.error(`\n${TABLES.length} tables atteignables.`);
