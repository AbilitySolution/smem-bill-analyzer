/**
 * Chargement du fichier d'environnement des scripts — et surtout, choix explicite
 * de la base visée.
 *
 * Huit scripts de `scripts/` lisaient `.env.local` en dur. `.env.local` pointe sur la
 * PRODUCTION. Autrement dit `npx tsx scripts/purge-invoice-data.ts --yes` ou
 * `scripts/seed-demo.ts`, lancés en croyant travailler « sur le dev », écrivaient en prod.
 * Aucun garde-fou, aucun message : le script affichait juste son résultat.
 *
 * Ici le fichier se choisit, et la cible s'annonce avant toute écriture :
 *
 *   npx tsx scripts/seed-demo.ts                      -> .env.local        (prod)
 *   npx tsx scripts/seed-demo.ts --env .env.local.dev -> projet de dev
 *   SMEM_ENV_FILE=.env.local.dev npx tsx scripts/seed-demo.ts
 *
 * La ligne « base visée » part sur stderr : elle reste visible même quand la sortie
 * standard du script est redirigée.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Valeur d'un argument nommé : `--env fichier`. */
export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Réf du projet Supabase, extraite de l'URL — `https://<ref>.supabase.co`. */
function refProjet(url: string | undefined): string {
  if (!url) return "(URL absente)";
  if (url.includes("127.0.0.1") || url.includes("localhost")) return "LOCAL";
  return url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? url;
}

/**
 * Lit le fichier d'environnement et annonce la base visée.
 *
 * @param options.silencieux — n'affiche rien (scripts en lecture seule appelés en boucle).
 */
export function loadEnv(options: { silencieux?: boolean } = {}): Record<string, string> {
  const fichier = arg("--env") ?? process.env.SMEM_ENV_FILE ?? ".env.local";
  const out: Record<string, string> = {};
  const raw = readFileSync(join(process.cwd(), fichier), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }

  if (!options.silencieux) {
    const ref = refProjet(out.NEXT_PUBLIC_SUPABASE_URL);
    process.stderr.write(`→ base visée : ${ref}  (${fichier})\n`);
  }

  return out;
}
