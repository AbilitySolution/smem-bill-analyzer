/**
 * Lance `next dev` contre le stack Supabase LOCAL.
 *
 * Next.js charge `.env.local` d'office, et `.env.local` pointe sur la PRODUCTION. Il n'y a
 * pas de moyen de lui faire préférer un autre fichier — mais les variables déjà présentes
 * dans l'environnement du processus, elles, ne sont jamais écrasées. C'est ce que fait ce
 * script : il lit `.env.local.stack`, l'injecte, puis passe la main à `next dev`.
 *
 * Sans ça, la seule façon de développer contre le local serait d'écraser `.env.local` —
 * c'est-à-dire de risquer, à la première distraction, de le laisser écrasé et de travailler
 * en prod en croyant l'inverse.
 *
 *   npm run dev        -> production   (inchangé)
 *   npm run dev:local  -> stack local
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const FICHIER = process.env.SMEM_ENV_FILE ?? ".env.local.stack";

if (!existsSync(FICHIER)) {
  console.error(`${FICHIER} est absent — il n'est pas versionné (.gitignore exclut .env*).`);
  console.error("");
  console.error("Démarrez le stack, puis créez-le à partir de `npx supabase status` :");
  console.error("  npx supabase start");
  console.error("  npx supabase status            # API URL, anon key, service_role key");
  console.error("");
  console.error("Le fichier attend les noms utilisés par l'application, pas ceux de la CLI :");
  console.error("  NEXT_PUBLIC_SUPABASE_URL       <- API URL        (http://127.0.0.1:54321)");
  console.error("  NEXT_PUBLIC_SUPABASE_ANON_KEY  <- anon key");
  console.error("  SUPABASE_SERVICE_ROLE_KEY      <- service_role key");
  console.error("  ANTHROPIC_API_KEY              <- à recopier de .env.local si besoin");
  process.exit(1);
}

const env = { ...process.env };
for (const ligne of readFileSync(FICHIER, "utf8").split("\n")) {
  const m = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "(URL absente)";
if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
  console.error(`${FICHIER} ne pointe pas sur un stack local : ${url}`);
  console.error("dev:local refuse de démarrer sur une base distante — utilisez `npm run dev`.");
  process.exit(1);
}
console.error(`→ base visée : LOCAL  (${FICHIER})`);

// Appel direct du binaire Next via Node : `shell: true` concatènerait les arguments sans
// les échapper, et le chemin du projet contient des espaces.
const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
spawn(process.execPath, [next, "dev", ...process.argv.slice(2)], { env, stdio: "inherit" })
  .on("exit", (code) => process.exit(code ?? 0));
