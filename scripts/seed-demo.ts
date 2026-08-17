/**
 * Seed démo SMEM — factures simulées réalistes (sans pipeline OCR).
 *
 * - 8 communes (2 existantes + 6 nouvelles), sites EP + bâtiments par commune.
 * - Factures SEMESTRIELLES (façon EDF : facture de février couvrant août→février,
 *   facture d'août couvrant février→août) de 2019 à aujourd'hui, dates jitterées
 *   pour exercer la normalisation des périodes dans les rapports.
 * - Réalisme calé sur Fonds-Saint-Denis (spreadsheets SMEM) : courbe tarifaire Base
 *   c€HT/kWh 2019→2026, HP/HC sur les gros contrats, part fixe (abonnement kVA),
 *   taxes (accise + octroi de mer), fenêtre de rénovation EP par commune (−55 % kWh).
 * - Zéro artefact OCR : raw_ocr_json / precision NULL ; file_path sentinelle `seed-sim/…`
 *   (colonne NOT NULL) ne pointant vers aucun fichier.
 * - Idempotent : ne crée jamais deux factures pour le même site × semestre
 *   (les factures réelles comptent comme couverture). `--reset-sim` supprime
 *   uniquement les factures SIM- ; `--dry` affiche les volumes sans écrire.
 *
 * Usage : npx tsx scripts/seed-demo.ts [--dry] [--reset-sim]
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ws from "ws";
import { rapprocherCommune } from "../lib/communes/rapprochement";
import { normalizeComm } from "../lib/extraction/matching";

// ── Env (.env.local) ────────────────────────────────────────────────────────
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const env = loadEnv();
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws as never },
});

const DRY = process.argv.includes("--dry");
const RESET = process.argv.includes("--reset-sim");

// ── PRNG déterministe (reproductible) ───────────────────────────────────────
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

// ── Modèle économique (calé sur les spreadsheets Fonds-Saint-Denis) ─────────
// Tarif Base en c€ HT/kWh par année (réel FSD : 6.43→6.90 (2019) … 14.62 (2024)).
// Tarif énergie c€HT/kWh — hausse RÉELLE atténuée pour la démo : la crise 2022-2024
// (prix ×2) écraserait la baisse de dépense post-travaux. On garde une hausse nette mais
// modérée (~+30 % sur 2019→2025) afin que la dépense (€) décroisse avec la consommation,
// plus lentement qu'elle.
const BASE_CKWH: Record<number, number> = {
  2017: 6.81, 2018: 6.5, 2019: 6.65, 2020: 6.9, 2021: 7.15, 2022: 7.6, 2023: 8.1, 2024: 8.4, 2025: 8.5, 2026: 8.5,
};
const HP_RATIO = 1.45; // ≈ 9.85/6.81
const HC_RATIO = 1.10; // ≈ 7.52/6.81
const KVA_AN: Record<number, number> = { // €/kVA/an (part fixe)
  2017: 11.0, 2018: 11.3, 2019: 11.6, 2020: 12.0, 2021: 12.4, 2022: 13.8, 2023: 15.2, 2024: 16.0, 2025: 16.4, 2026: 16.8,
};
const ACCISE_EUR_KWH: Record<number, number> = { // accise (ex-CSPE) €/kWh — lissée (les à-coups
  // réels 2022-2025 provoquaient une remontée de la dépense incohérente avec la baisse de conso)
  2017: 0.021, 2018: 0.021, 2019: 0.021, 2020: 0.021, 2021: 0.0215, 2022: 0.0215, 2023: 0.022, 2024: 0.022, 2025: 0.0225, 2026: 0.0225,
};
const OCTROI_PCT = 0.025; // octroi de mer ≈ 2.5 % du HT
const TVA_PCT = 0.054;    // ≈ TVA constatée sur la vraie facture (9.14/168.99)

interface SiteDef { nom: string; categorie: "batiment" | "eclairage_public"; kva: number; ampere: number }
interface CommuneDef {
  nom: string;
  scale: number; // taille du parc
  renovation: { start: string; end: string }; // fenêtre travaux EP (yyyy-mm)
  sites?: SiteDef[]; // si absent → sites générés d'après les gabarits
}

const EP = (nom: string, kva = 6, ampere = 30): SiteDef => ({ nom, categorie: "eclairage_public", kva, ampere });
const BAT = (nom: string, kva = 9, ampere = 30): SiteDef => ({ nom, categorie: "batiment", kva, ampere });

const COMMUNES: CommuneDef[] = [
  // Existantes : on ne crée pas de sites (FSD complet), on complète juste les factures.
  { nom: "Fonds-Saint-Denis", scale: 1.0, renovation: { start: "2020-06", end: "2022-06" } },
  {
    nom: "Grand'Rivière", scale: 0.8, renovation: { start: "2020-06", end: "2022-03" },
    sites: [EP("EP Pointe Lamare", 6, 30), EP("EP Route de la Falaise", 9, 45), BAT("Bibliothèque", 6, 30)],
  },
  {
    nom: "Morne-Rouge", scale: 1.6, renovation: { start: "2020-06", end: "2022-06" },
    sites: [
      EP("EP Bourg", 12, 60), EP("EP Champflore", 9, 45), EP("EP Savane Petit", 6, 30), EP("EP Route de la Trace", 12, 60),
      BAT("Mairie", 18, 30), BAT("Groupe scolaire", 18, 30), BAT("Salle polyvalente", 12, 30), BAT("Dispensaire", 6, 30),
    ],
  },
  {
    nom: "Le Lamentin", scale: 4.0, renovation: { start: "2021-03", end: "2022-09" },
    sites: [
      EP("EP Centre-bourg", 36, 60), EP("EP Place d'Armes", 24, 60), EP("EP Californie", 18, 60),
      EP("EP Longvilliers", 18, 60), EP("EP Bois d'Inde", 12, 45),
      BAT("Hôtel de Ville", 36, 60), BAT("Groupe scolaire Sarrault", 24, 40), BAT("Cantine centrale", 18, 60),
      BAT("Complexe sportif", 36, 60), BAT("Médiathèque", 18, 30),
    ],
  },
  {
    nom: "Le Lorrain", scale: 1.4, renovation: { start: "2021-02", end: "2022-06" },
    sites: [
      EP("EP Bourg", 12, 60), EP("EP Séguineau", 9, 45), EP("EP Carabin", 6, 30),
      BAT("Mairie", 18, 30), BAT("École des Filles", 12, 30), BAT("Salle des fêtes", 12, 30), BAT("Stade municipal", 9, 45),
    ],
  },
  {
    nom: "Macouba", scale: 0.6, renovation: { start: "2020-06", end: "2022-05" },
    sites: [
      EP("EP Bourg", 6, 30), EP("EP Bellevue", 6, 30), EP("EP Nord-Plage", 6, 30),
      BAT("Mairie", 9, 30), BAT("École du bourg", 9, 30), BAT("Maison des associations", 6, 30),
    ],
  },
  {
    nom: "Sainte-Anne", scale: 1.8, renovation: { start: "2021-03", end: "2022-07" },
    sites: [
      EP("EP Bourg", 18, 60), EP("EP Pointe Marin", 12, 60), EP("EP Anse Caritan", 9, 45), EP("EP Val d'Or", 6, 30),
      BAT("Mairie", 18, 30), BAT("Groupe scolaire", 18, 30), BAT("Marché couvert", 12, 30), BAT("Office de tourisme", 6, 30),
    ],
  },
  {
    nom: "Les Anses-d'Arlet", scale: 1.2, renovation: { start: "2021-03", end: "2022-07" },
    sites: [
      EP("EP Bourg", 12, 60), EP("EP Grande Anse", 9, 45), EP("EP Petite Anse", 6, 30),
      BAT("Mairie", 12, 30), BAT("École du bourg", 12, 30), BAT("Salle polyvalente", 9, 30), BAT("Poste de secours", 6, 30),
    ],
  },
];

// ── Semestres facturés (convention EDF/spreadsheets) ────────────────────────
// S1 année Y : facture ~février Y, période ~5 août Y-1 → 4 février Y.
// S2 année Y : facture ~août Y, période ~5 février Y → 4 août Y.
interface Semester { year: number; half: 1 | 2 }
function semesters(): Semester[] {
  const out: Semester[] = [];
  // Plage 2017-S1 → 2025-S2 : couvre pleinement les semestres calendaires 2017-S1 → 2025-S1
  // une fois les bords partiels rognés côté rapport. On ne génère plus 2026 (chute de bord).
  for (let y = 2017; y <= 2025; y++) {
    out.push({ year: y, half: 1 });
    out.push({ year: y, half: 2 });
  }
  return out;
}
const fmt = (d: Date) => d.toISOString().slice(0, 10);
function addDays(d: Date, n: number) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }

function semesterDates(s: Semester, rnd: () => number) {
  const jitter = Math.floor(rnd() * 30 - 15); // ±15 jours → périodes hétérogènes
  const anchor = s.half === 1 ? new Date(Date.UTC(s.year, 1, 5)) : new Date(Date.UTC(s.year, 7, 5));
  const periodEnd = addDays(anchor, jitter - 1);
  const periodStart = addDays(periodEnd, -181);
  const factureDate = addDays(periodEnd, 8 + Math.floor(rnd() * 10));
  const dateLimite = addDays(factureDate, 15);
  return { periodStart, periodEnd, factureDate, dateLimite };
}

// ── Conso & montants ─────────────────────────────────────────────────────────
function isAfterRenovation(c: CommuneDef, s: Semester): boolean {
  const end = c.renovation.end; // yyyy-mm
  const semStart = s.half === 1 ? `${s.year - 1}-08` : `${s.year}-02`;
  return semStart >= end;
}
function isDuringRenovation(c: CommuneDef, s: Semester): boolean {
  const semStart = s.half === 1 ? `${s.year - 1}-08` : `${s.year}-02`;
  const semEnd = s.half === 1 ? `${s.year}-02` : `${s.year}-08`;
  return semStart < c.renovation.end && semEnd > c.renovation.start;
}

/** Fraction d'année depuis l'achèvement des travaux (0 avant/au moment de l'achèvement). */
function yearsSinceRenovation(commune: CommuneDef, s: Semester): number {
  const end = commune.renovation.end; // yyyy-mm
  const endY = Number(end.slice(0, 4)) + (Number(end.slice(5, 7)) - 1) / 12;
  const semY = s.year + (s.half === 2 ? 0.5 : 0.0);
  return Math.max(0, semY - endY);
}

function semesterKwh(site: SiteDef, commune: CommuneDef, s: Semester, rnd: () => number, siteFactor: number): number {
  // EP ≈ kVA × 330 kWh/sem (Bel Oncle 6 kVA ≈ 2 000) ; bâtiment ≈ kVA × 190.
  const base = site.categorie === "eclairage_public" ? site.kva * 330 : site.kva * 190;
  let kwh = base * siteFactor;
  // Plateau haut avant travaux : saisonnalité douce ±3 % + bruit réduit ±6 % (courbes lisses, sans aberration).
  kwh *= 1 + (s.half === 2 ? 0.03 : -0.03) + (rnd() - 0.5) * 0.06;
  if (site.categorie === "eclairage_public") {
    if (isAfterRenovation(commune, s)) {
      // Baisse ~ −30 % au passage des travaux, puis décroissance continue visible (plancher ≈ 0,58).
      const decay = Math.max(0.58, 1 - 0.03 * yearsSinceRenovation(commune, s));
      kwh *= (0.70 + (rnd() - 0.5) * 0.04) * decay;
    } else if (isDuringRenovation(commune, s)) {
      kwh *= 0.85 + (rnd() - 0.5) * 0.06; // transition pendant travaux
    }
  }
  return Math.max(30, Math.round(kwh));
}

interface Money { lines: { poste: string; kwh: number; prix: number; montant: number }[]; fixe: number; accise: number; octroi: number; ht: number; tva: number; autresTaxes: number; ttc: number }
function computeMoney(site: SiteDef, kwh: number, year: number, rnd: () => number): Money {
  const base = BASE_CKWH[year] ?? 12;
  const hpHc = site.kva >= 12; // gros contrats en HP/HC
  const lines: Money["lines"] = [];
  if (hpHc) {
    const hcShare = site.categorie === "eclairage_public" ? 0.68 : 0.36; // EP consomme la nuit
    const hpK = Math.round(kwh * (1 - hcShare)), hcK = kwh - hpK;
    const hpP = +(base * HP_RATIO * (1 + (rnd() - 0.5) * 0.04)).toFixed(4);
    const hcP = +(base * HC_RATIO * (1 + (rnd() - 0.5) * 0.04)).toFixed(4);
    lines.push({ poste: "heures pleines", kwh: hpK, prix: hpP, montant: +((hpK * hpP) / 100).toFixed(2) });
    lines.push({ poste: "heures creuses", kwh: hcK, prix: hcP, montant: +((hcK * hcP) / 100).toFixed(2) });
  } else {
    const p = +(base * (1 + (rnd() - 0.5) * 0.05)).toFixed(4);
    lines.push({ poste: "base", kwh, prix: p, montant: +((kwh * p) / 100).toFixed(2) });
  }
  const variable = lines.reduce((s, l) => s + l.montant, 0);
  const fixe = +((site.kva * (KVA_AN[year] ?? 15)) / 2).toFixed(2); // abonnement semestriel
  const ht = +(variable + fixe).toFixed(2);
  const accise = +(kwh * (ACCISE_EUR_KWH[year] ?? 0.02)).toFixed(2);
  const octroi = +(ht * OCTROI_PCT).toFixed(2);
  const tva = +(ht * TVA_PCT).toFixed(2);
  const autresTaxes = +(accise + octroi).toFixed(2);
  const ttc = +(ht + tva + autresTaxes).toFixed(2);
  return { lines, fixe, accise, octroi, ht, tva, autresTaxes, ttc };
}

// ── Seed ─────────────────────────────────────────────────────────────────────
/** SELECT paginé (Supabase limite à 1000 lignes par requête). */
async function selectAll<T>(table: string, columns: string, like?: { col: string; pattern: string }): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(columns).range(from, from + 999);
    if (like) q = q.like(like.col, like.pattern);
    const { data, error } = await q;
    if (error) throw new Error(`select ${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function chunkInsert(table: string, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 400) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + 400));
    if (error) throw new Error(`insert ${table}: ${error.message}`);
  }
}

async function main() {
  const { data: org, error: orgErr } = await supabase.from("organizations").select("id").eq("nom", "SMEM").maybeSingle();
  if (orgErr || !org) throw new Error(`Organisation SMEM introuvable (${orgErr?.message ?? "aucune ligne"}) — exécuter la migration multi-tenant avant de seeder.`);
  const orgId = org.id as string;

  if (RESET && !DRY) {
    console.log("— Reset des factures SIM- …");
    const sims = await selectAll<{ id: string }>("invoices", "id", { col: "facture_number", pattern: "SIM-%" });
    const ids = sims.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 200) {
      const slice = ids.slice(i, i + 200);
      await supabase.from("anomalies").delete().in("invoice_id", slice);
      const { error } = await supabase.from("invoices").delete().in("id", slice);
      if (error) throw new Error(`reset: ${error.message}`);
    }
    console.log(`  ${ids.length} factures SIM supprimées.`);
  }

  // 1. Communes — rapprochement PAR CODE INSEE (SCRUM-14)
  //
  //    Les noms de COMMUNES suivent l'orthographe officielle ("Fonds-Saint-Denis",
  //    "Grand'Rivière") alors que la base porte l'orthographe historique
  //    ("Fonds Saint Denis", "Grand Rivière"). Un rapprochement par nom brut créait
  //    donc un doublon pour 5 des 8 communes du seed — que `UNIQUE (org_id, slug)`
  //    rejetterait désormais. On passe par le référentiel : nom, code_insee, latitude
  //    et longitude en sortent, jamais du seed.
  const { data: existingCommunes } = await supabase.from("communes").select("id, nom, code_insee");
  const idParCode = new Map(
    (existingCommunes ?? [])
      .filter((c) => c.code_insee)
      .map((c) => [c.code_insee as string, c.id as string]),
  );

  const communeIds = new Map<string, string>();
  const aCreer: Record<string, unknown>[] = [];
  const codeParNomSeed = new Map<string, string>();

  for (const c of COMMUNES) {
    const resolu = rapprocherCommune(c.nom);
    if (!resolu) {
      throw new Error(
        `Commune « ${c.nom} » absente du référentiel Martinique — corriger COMMUNES dans ce script.`,
      );
    }
    const { codeInsee, nom, latitude, longitude } = resolu.entree;
    codeParNomSeed.set(c.nom, codeInsee);

    const existant = idParCode.get(codeInsee);
    if (existant) communeIds.set(c.nom, existant);
    else if (!aCreer.some((x) => x.code_insee === codeInsee)) {
      aCreer.push({ nom, code_insee: codeInsee, slug: normalizeComm(nom), latitude, longitude, org_id: orgId });
    }
  }

  if (aCreer.length && !DRY) {
    const { data, error } = await supabase.from("communes").insert(aCreer).select("id, code_insee");
    if (error) throw new Error(error.message);
    for (const c of data ?? []) idParCode.set(c.code_insee as string, c.id as string);
    for (const c of COMMUNES) {
      const id = idParCode.get(codeParNomSeed.get(c.nom)!);
      if (id) communeIds.set(c.nom, id);
    }
  }
  console.log(`Communes : ${communeIds.size} rattachées (+${aCreer.length} créées)`);

  // 2. Clients (1 par commune)
  const { data: existingClients } = await supabase.from("clients").select("id, nom, commune_id");
  const clientByCommune = new Map<string, string>();
  for (const cl of existingClients ?? []) if (cl.commune_id) clientByCommune.set(cl.commune_id, cl.id);
  for (const c of COMMUNES) {
    const cid = communeIds.get(c.nom);
    if (!cid || clientByCommune.has(cid)) continue;
    if (DRY) { clientByCommune.set(cid, "dry"); continue; }
    const { data, error } = await supabase.from("clients")
      .insert({ nom: `Commune de ${c.nom}`, commune_id: cid, adresse: `Hôtel de ville, ${c.nom}, Martinique`, org_id: orgId })
      .select("id").single();
    if (error) throw new Error(error.message);
    clientByCommune.set(cid, data.id);
  }

  // 3. Sites (upsert par commune+nom)
  const { data: existingSites } = await supabase.from("sites").select("id, nom, commune_id, categorie, pdl, kva, ampere");
  const siteKey = (communeId: string, nom: string) => `${communeId}::${nom}`;
  const siteMap = new Map((existingSites ?? []).map((s) => [siteKey(s.commune_id, s.nom), s]));
  const pdlSeq = 610000;
  const newSites: Record<string, unknown>[] = [];
  for (const c of COMMUNES) {
    const cid = communeIds.get(c.nom); if (!cid) continue;
    for (const s of c.sites ?? []) {
      if (siteMap.has(siteKey(cid, s.nom))) continue;
      newSites.push({ org_id: orgId, commune_id: cid, nom: s.nom, categorie: s.categorie, kva: s.kva, ampere: s.ampere, pdl: String(pdlSeq + Math.abs(hash(c.nom + s.nom)) % 80000) });
    }
  }
  if (newSites.length && !DRY) {
    const { data, error } = await supabase.from("sites").insert(newSites).select("id, nom, commune_id, categorie, pdl, kva, ampere");
    if (error) throw new Error(error.message);
    for (const s of data ?? []) siteMap.set(siteKey(s.commune_id, s.nom), s);
  }
  console.log(`Sites : ${newSites.length} créés (total visé ~${(existingSites?.length ?? 0) + newSites.length})`);

  // 4. Contrats (1 par site) — contract_number est UNIQUE : on réutilise l'existant le cas échéant
  const { data: existingContracts } = await supabase.from("contracts").select("id, site_id, contract_number");
  const contractBySite = new Map((existingContracts ?? []).filter((c) => c.site_id).map((c) => [c.site_id, c.id]));
  const contractByNumber = new Map((existingContracts ?? []).map((c) => [c.contract_number, c.id]));

  // 5. Couverture existante : site × semestre déjà facturé
  const existingInvoices = await selectAll<{ site_id: string | null; facture_date: string | null }>("invoices", "site_id, facture_date");
  const covered = new Set<string>();
  for (const inv of existingInvoices) {
    if (!inv.site_id || !inv.facture_date) continue;
    const d = new Date(inv.facture_date);
    const half = d.getUTCMonth() + 1 <= 5 ? 1 : 2; // facture jan-mai → S1 ; juin-déc → S2
    covered.add(`${inv.site_id}::${d.getUTCFullYear()}-${half}`);
  }

  // 6. Génération
  const sems = semesters();
  const invoices: Record<string, unknown>[] = [];
  const periodsByNumber = new Map<string, Record<string, unknown>[]>();
  const chargesByNumber = new Map<string, Record<string, unknown>[]>();
  const contractsToCreate: { site: typeof newSites[number] & { id: string }; clientId: string }[] = [];

  for (const c of COMMUNES) {
    const cid = communeIds.get(c.nom); if (!cid) continue;
    const clientId = clientByCommune.get(cid); if (!clientId) continue;
    const communeSites = [...siteMap.values()].filter((s) => s.commune_id === cid);
    for (const site of communeSites) {
      const def: SiteDef = { nom: site.nom, categorie: site.categorie, kva: Number(site.kva ?? 9), ampere: Number(site.ampere ?? 30) };
      const siteFactor = 0.75 + (Math.abs(hash(site.pdl ?? site.nom)) % 1000) / 1000 * 0.6; // 0.75–1.35 stable
      if (!contractBySite.has(site.id) && !DRY) contractsToCreate.push({ site, clientId });
      for (const s of sems) {
        if (covered.has(`${site.id}::${s.year}-${s.half}`)) continue;
        const rnd = mulberry32(hash(`${site.pdl}-${s.year}-${s.half}`));
        const { periodStart, periodEnd, factureDate, dateLimite } = semesterDates(s, rnd);
        if (factureDate > new Date()) continue; // pas de facture future
        const kwh = semesterKwh(def, c, s, rnd, siteFactor);
        const m = computeMoney(def, kwh, s.year, rnd);
        const num = `SIM-${site.pdl}-${fmt(factureDate).replace(/-/g, "")}`;
        invoices.push({
          org_id: orgId,
          facture_number: num, facture_date: fmt(factureDate), date_limite_paiement: fmt(dateLimite),
          total_ht: m.ht, tva: m.tva, autres_taxes: m.autresTaxes, total_ttc: m.ttc,
          is_duplicata: false, raw_ocr_json: null, precision: null,
          file_path: `seed-sim/${num}.pdf`, status: "reviewed",
          commune_id: cid, site_id: site.id, categorie: site.categorie, client_id: clientId,
          __site: site.id, // retiré avant insert (sert au mapping contrat)
        });
        periodsByNumber.set(num, m.lines.map((l) => ({
          poste_tarifaire: l.poste, period_start: fmt(periodStart), period_end: fmt(periodEnd),
          numero_compteur: site.pdl, consommation_kwh: l.kwh, prix_unitaire_ckwh: l.prix, montant_eur: l.montant,
          index_estime: rnd() < 0.12,
        })));
        chargesByNumber.set(num, [
          { category: "fixed", libelle: "Abonnement (part fixe)", period_start: fmt(periodStart), period_end: fmt(periodEnd), tarif_kva_an: KVA_AN[s.year] ?? 15, montant_eur: m.fixe },
          { category: "tax", libelle: "Accise sur l'électricité", period_start: fmt(periodStart), period_end: fmt(periodEnd), assiette: kwh, taux: `${ACCISE_EUR_KWH[s.year] ?? 0.02} €/kWh`, taux_numeric: ACCISE_EUR_KWH[s.year] ?? 0.02, taux_unit: "eur_per_kwh", montant_eur: m.accise },
          { category: "tax", libelle: "Octroi de mer", period_start: fmt(periodStart), period_end: fmt(periodEnd), assiette: m.ht, taux: "2.5 %", taux_numeric: 2.5, taux_unit: "percent", montant_eur: m.octroi },
        ]);
      }
    }
  }

  console.log(`Factures à créer : ${invoices.length} (périodes ${[...periodsByNumber.values()].flat().length}, charges ${[...chargesByNumber.values()].flat().length})`);
  if (DRY) { console.log("--dry : aucune écriture."); return; }

  // 7. Contrats manquants (réutilise un contrat existant si le numéro est déjà pris)
  const trulyNew = contractsToCreate.filter(({ site }) => {
    const num = String(site.pdl ?? "");
    if (contractByNumber.has(num)) { contractBySite.set(site.id, contractByNumber.get(num)!); return false; }
    return true;
  });
  if (trulyNew.length) {
    const rows = trulyNew.map(({ site, clientId }) => ({
      org_id: orgId, client_id: clientId, site_id: site.id, contract_number: String(site.pdl ?? ""),
      espace_livraison: site.nom, offre: "Tarif Bleu Collectivités", service: site.categorie === "eclairage_public" ? "Éclairage public" : "Bâtiment communal",
      puissance_souscrite_kva: site.kva, reglage_protection_a: site.ampere,
      type_compteur: "Électronique", numero_compteur: String(site.pdl ?? ""),
    }));
    const { data, error } = await supabase.from("contracts").insert(rows).select("id, site_id");
    if (error) throw new Error(`contracts: ${error.message}`);
    for (const c of data ?? []) contractBySite.set(c.site_id, c.id);
    console.log(`Contrats créés : ${rows.length}`);
  }

  // 8. Factures (avec contract_id), puis lignes rattachées par facture_number
  const invoiceRows = invoices.map((inv) => {
    const { __site, ...row } = inv as Record<string, unknown> & { __site: string };
    return { ...row, contract_id: contractBySite.get(__site) ?? null };
  });
  await chunkInsert("invoices", invoiceRows);
  console.log(`Factures insérées : ${invoiceRows.length}`);

  const inserted = await selectAll<{ id: string; facture_number: string; contract_id: string | null }>(
    "invoices", "id, facture_number, contract_id", { col: "facture_number", pattern: "SIM-%" },
  );
  const idByNumber = new Map(inserted.map((r) => [r.facture_number, r]));
  const periodRows: Record<string, unknown>[] = [];
  const chargeRows: Record<string, unknown>[] = [];
  for (const [num, rows] of periodsByNumber) {
    const inv = idByNumber.get(num); if (!inv) continue;
    for (const r of rows) periodRows.push({ ...r, invoice_id: inv.id, contract_id: inv.contract_id });
  }
  for (const [num, rows] of chargesByNumber) {
    const inv = idByNumber.get(num); if (!inv) continue;
    for (const r of rows) chargeRows.push({ ...r, invoice_id: inv.id });
  }
  await chunkInsert("consumption_periods", periodRows);
  await chunkInsert("invoice_charges", chargeRows);
  console.log(`Périodes de conso : ${periodRows.length} · Charges/taxes : ${chargeRows.length}`);
  console.log("✔ Seed terminé.");
}

main().catch((e) => { console.error("✖ Échec du seed :", e.message ?? e); process.exit(1); });
