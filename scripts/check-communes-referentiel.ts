/**
 * SCRUM-14 (lot 1b) — Rapproche les communes d'une organisation avec le référentiel
 * Martinique, et échoue bruyamment si le rapprochement n'est pas parfait.
 *
 * C'est le préalable au backfill du lot 1c : on ne backfille pas 20 lignes sur un
 * rapprochement qu'on n'a pas relu.
 *
 * ⚠️ Ce que le rapprochement apporte, c'est le `code_insee` et les COORDONNÉES. Il ne
 * cherche pas à aligner l'orthographe : les communes gardent leur nom historique en base,
 * l'outil n'en a que faire, et les renommer changerait le rattachement des factures.
 *
 * Usage : npx tsx scripts/check-communes-referentiel.ts [--org "SMEM"] [--env .env.local]
 *
 * Codes de sortie :
 *   0 — les N communes sont appariées, sans doublon.
 *   1 — au moins une commune non appariée, ou une entrée du référentiel appariée deux fois.
 *
 * Le rapprochement se fait par le NOM, via `normalizeComm` importée de
 * `lib/extraction/matching.ts` — jamais réimplémentée, pour que le script mesure
 * exactement le comportement utilisé par le matching des factures. Une fois le backfill
 * fait, ce rapprochement par nom n'a plus lieu d'être : c'est `code_insee` qui sert de clé.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  indexerReferentiel,
  rapprocherCommune,
  type PasseRapprochement,
} from "../lib/communes/rapprochement";
import { type CommuneReferentiel } from "../lib/communes/referentiel-martinique";

function loadEnv(fichier: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(join(process.cwd(), fichier), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Distance haversine en km — sert à mesurer la dérive des coordonnées déjà en base. */
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

type Ligne = {
  id: string;
  nomEnBase: string;
  entree: CommuneReferentiel | null;
  passe: PasseRapprochement | "—";
  derive: number | null;
};

function formater(lignes: Ligne[]): string {
  const col = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].length));
  const enTete =
    col("Nom en base", 22) +
    "| " + col("INSEE", 7) +
    "| " + col("Nom officiel", 20) +
    "| " + col("Passe", 15) +
    "| Dérive coord.";
  const corps = lignes.map((l) => {
    const derive =
      l.derive === null ? "—" : `${l.derive.toFixed(1)} km${l.derive > 3 ? "  <-- à corriger" : ""}`;
    return (
      col(l.nomEnBase, 22) +
      "| " + col(l.entree?.codeInsee ?? "AUCUN", 7) +
      "| " + col(l.entree?.nom ?? "NON APPARIÉE", 20) +
      "| " + col(l.passe, 15) +
      "| " + derive
    );
  });
  return [enTete, "-".repeat(88), ...corps].join("\n");
}

async function main() {
  const orgName = arg("--org") ?? "SMEM";
  const fichierEnv = arg("--env") ?? ".env.local";
  const env = loadEnv(fichierEnv);

  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  console.log(`Projet   : ${env.NEXT_PUBLIC_SUPABASE_URL}  (${fichierEnv})`);
  console.log(`Org      : ${orgName}\n`);

  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("id")
    .eq("nom", orgName)
    .maybeSingle();
  if (orgErr || !org) {
    throw new Error(`Organisation « ${orgName} » introuvable : ${orgErr?.message ?? "aucune ligne"}`);
  }

  const { data: communes, error: commErr } = await supabase
    .from("communes")
    .select("id, nom, latitude, longitude")
    .eq("org_id", org.id)
    .order("nom");
  if (commErr) throw new Error(`Lecture des communes impossible : ${commErr.message}`);
  if (!communes?.length) throw new Error(`Aucune commune dans l'org « ${orgName} ».`);

  const index = indexerReferentiel();

  const lignes: Ligne[] = [];
  const nonAppariees: string[] = [];
  /** codeInsee -> noms en base qui l'ont réclamé. Plus d'un = ambiguïté. */
  const reclamations = new Map<string, string[]>();

  for (const commune of communes as Array<{
    id: string;
    nom: string;
    latitude: number | null;
    longitude: number | null;
  }>) {
    const resultat = rapprocherCommune(commune.nom, index);
    const entree = resultat?.entree ?? null;

    if (!entree) nonAppariees.push(commune.nom);
    else {
      const deja = reclamations.get(entree.codeInsee) ?? [];
      deja.push(commune.nom);
      reclamations.set(entree.codeInsee, deja);
    }

    const derive =
      entree && commune.latitude !== null && commune.longitude !== null
        ? distanceKm(
            Number(commune.latitude),
            Number(commune.longitude),
            entree.latitude,
            entree.longitude,
          )
        : null;

    lignes.push({
      id: commune.id,
      nomEnBase: commune.nom,
      entree,
      passe: resultat?.passe ?? "—",
      derive,
    });
  }

  console.log(formater(lignes));

  const doublons = [...reclamations.entries()].filter(([, noms]) => noms.length > 1);
  const derivees = lignes.filter((l) => l.derive !== null && l.derive > 3);

  console.log(
    `\nAppariées : ${communes.length - nonAppariees.length}/${communes.length}` +
      ` (passe stricte : ${lignes.filter((l) => l.passe === "stricte").length},` +
      ` repli sans articles : ${lignes.filter((l) => l.passe === "sans articles").length})`,
  );

  if (derivees.length) {
    console.log(`\n⚠️  ${derivees.length} commune(s) ont des coordonnées en base à plus de 3 km du centroïde officiel.`);
    console.log("   Non bloquant ici : la migration du lot 1c les réaligne sur le référentiel.");
  }

  let echec = false;
  if (nonAppariees.length) {
    echec = true;
    console.error(`\n❌ ${nonAppariees.length} commune(s) non appariée(s) : ${nonAppariees.join(", ")}`);
    console.error("   Ajouter la commune au référentiel ou corriger son nom en base avant tout backfill.");
  }
  if (doublons.length) {
    echec = true;
    for (const [code, noms] of doublons) {
      console.error(`\n❌ Le code INSEE ${code} est réclamé par ${noms.length} communes : ${noms.join(", ")}`);
    }
    console.error("   UNIQUE (org_id, code_insee) échouerait au lot 1c. Trancher manuellement avant de continuer.");
  }

  if (echec) {
    console.error("\nRapprochement INVALIDE — ne pas lancer la migration du lot 1c.");
    process.exit(1);
  }

  console.log("\n✅ Rapprochement valide : chaque commune a une entrée du référentiel, aucune n'est réclamée deux fois.");
}

main().catch((e) => {
  console.error(`\n❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
