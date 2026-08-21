/**
 * Ajoute 10 factures fictives (mais réalistes) par commune SMEM existante, pour
 * tester l'algorithme de prévision sur un historique plus riche que les vraies
 * données actuelles (très éparses). Ne crée AUCUNE nouvelle commune — réutilise
 * les 20 communes réelles et, si besoin, un site existant (ou en crée un seul
 * nouveau par commune si elle n'en a encore aucun).
 *
 * Factures préfixées "SIMTEST-" pour rester identifiables/nettoyables
 * (idempotent : si une commune a déjà ≥10 factures SIMTEST-, elle est ignorée).
 *
 * Usage : npx tsx scripts/seed-test-invoices.ts [--dry]
 */
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

import { loadEnv } from "./_env";
const env = loadEnv();
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws as never },
});

const DRY = process.argv.includes("--dry");
const INVOICES_PER_COMMUNE = 10;
const PREFIX = "SIMTEST-";

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

// Même courbe tarifaire réaliste que scripts/seed-demo.ts (calée sur les
// spreadsheets réels Fonds-Saint-Denis) — cohérence avec les vraies données.
const BASE_CKWH: Record<number, number> = {
  2021: 7.15, 2022: 7.6, 2023: 8.1, 2024: 8.4, 2025: 8.5, 2026: 8.5,
};
const KVA_AN: Record<number, number> = {
  2021: 12.4, 2022: 13.8, 2023: 15.2, 2024: 16.0, 2025: 16.4, 2026: 16.8,
};
const ACCISE_EUR_KWH: Record<number, number> = {
  2021: 0.0215, 2022: 0.0215, 2023: 0.022, 2024: 0.022, 2025: 0.0225, 2026: 0.0225,
};
const OCTROI_PCT = 0.025;
const TVA_PCT = 0.054;

const fmt = (d: Date) => d.toISOString().slice(0, 10);
function addDays(d: Date, n: number) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }

async function main() {
  const { data: org, error: orgErr } = await supabase.from("organizations").select("id").eq("nom", "SMEM").maybeSingle();
  if (orgErr || !org) throw new Error(`Organisation SMEM introuvable: ${orgErr?.message ?? "aucune ligne"}`);
  const orgId = org.id as string;

  const { data: communes, error: communesErr } = await supabase
    .from("communes").select("id, nom").eq("org_id", orgId).order("nom");
  if (communesErr || !communes) throw new Error(`select communes: ${communesErr?.message}`);

  let totalInvoices = 0;
  let totalSitesCreated = 0;

  for (let ci = 0; ci < communes.length; ci++) {
    const commune = communes[ci];

    // Ignorer si déjà assez de factures de test pour cette commune (idempotence).
    const { count: existingSimCount } = await supabase
      .from("invoices").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("commune_id", commune.id).like("facture_number", `${PREFIX}%`);
    if ((existingSimCount ?? 0) >= INVOICES_PER_COMMUNE) {
      console.log(`- ${commune.nom} : déjà ${existingSimCount} factures de test, ignorée.`);
      continue;
    }

    // Réutiliser un site existant de la commune, sinon en créer un seul.
    const { data: existingSites } = await supabase
      .from("sites").select("id, nom, categorie, kva, ampere, pdl").eq("org_id", orgId).eq("commune_id", commune.id).limit(1);
    let site = existingSites?.[0] as { id: string; nom: string; categorie: "batiment" | "eclairage_public"; kva: number | null; ampere: number | null; pdl: string | null } | undefined;

    if (!site) {
      const categorie: "batiment" | "eclairage_public" = ci % 2 === 0 ? "eclairage_public" : "batiment";
      const kva = categorie === "eclairage_public" ? 6 : 9;
      const pdl = String(600000 + (Math.abs(hash(commune.nom)) % 90000));
      if (DRY) {
        console.log(`  [dry] créerait site "${categorie === "eclairage_public" ? "EP" : "Bâtiment"} ${commune.nom}" (${categorie}, ${kva} kVA)`);
        site = { id: "dry", nom: "dry", categorie, kva, ampere: 30, pdl };
      } else {
        const { data: newSite, error: siteErr } = await supabase.from("sites").insert({
          org_id: orgId, commune_id: commune.id, nom: `${categorie === "eclairage_public" ? "EP" : "Bâtiment"} ${commune.nom}`,
          categorie, kva, ampere: 30, pdl,
        }).select("id, nom, categorie, kva, ampere, pdl").single();
        if (siteErr || !newSite) throw new Error(`site ${commune.nom}: ${siteErr?.message}`);
        site = newSite;
        totalSitesCreated++;
      }
    }

    // Repli si le site existant n'a pas de PDL (numéro de compteur) — évite des
    // numéros de facture/contrat "…-null" pour les sites réels sans PDL renseigné.
    const pdlLabel = site.pdl ?? site.id.slice(0, 8);

    // Client (1 par commune, réutilisé s'il existe déjà).
    const { data: existingClient } = await supabase
      .from("clients").select("id").eq("org_id", orgId).eq("commune_id", commune.id).limit(1).maybeSingle();
    let clientId = existingClient?.id as string | undefined;
    if (!clientId && !DRY) {
      const { data: newClient, error: clientErr } = await supabase.from("clients")
        .insert({ org_id: orgId, nom: `Commune de ${commune.nom}`, commune_id: commune.id, adresse: `Hôtel de ville, ${commune.nom}, Martinique` })
        .select("id").single();
      if (clientErr || !newClient) throw new Error(`client ${commune.nom}: ${clientErr?.message}`);
      clientId = newClient.id;
    }

    // Contrat (1 par site, réutilisé s'il existe déjà).
    const { data: existingContract } = await supabase
      .from("contracts").select("id").eq("org_id", orgId).eq("site_id", site.id).limit(1).maybeSingle();
    let contractId = existingContract?.id as string | undefined;
    if (!contractId && !DRY) {
      const { data: newContract, error: contractErr } = await supabase.from("contracts").insert({
        org_id: orgId, client_id: clientId, site_id: site.id, contract_number: `TEST-${pdlLabel}`,
        espace_livraison: site.nom, offre: "Tarif Bleu Collectivités",
        service: site.categorie === "eclairage_public" ? "Éclairage public" : "Bâtiment communal",
        puissance_souscrite_kva: site.kva, type_compteur: "Électronique", numero_compteur: site.pdl,
      }).select("id").single();
      if (contractErr || !newContract) throw new Error(`contrat ${commune.nom}: ${contractErr?.message}`);
      contractId = newContract.id;
    }

    // 10 factures trimestrielles fictives, étalées sur les ~2.5 dernières années.
    const rnd = mulberry32(hash(commune.nom + site.nom));
    const now = new Date();
    const toCreate = INVOICES_PER_COMMUNE - (existingSimCount ?? 0);

    for (let i = 0; i < toCreate; i++) {
      const quartersAgo = toCreate - i; // la plus ancienne en premier
      const periodEnd = addDays(now, -quartersAgo * 91 + Math.floor(rnd() * 10 - 5));
      const periodStart = addDays(periodEnd, -90);
      const factureDate = addDays(periodEnd, 6 + Math.floor(rnd() * 6));
      if (factureDate > now) continue;

      const year = Math.min(2026, Math.max(2021, periodEnd.getUTCFullYear()));
      const baseRate = BASE_CKWH[year];
      const kva = site.kva ?? 9;

      // Saisonnalité : EP dépend surtout de la longueur de nuit (pic hiver austral
      // = été boréal en Martinique tropicale, variation faible mais réelle) ;
      // bâtiment légèrement plus élevé en saison chaude (climatisation).
      const month = periodEnd.getUTCMonth();
      const seasonal = site.categorie === "eclairage_public"
        ? 1 + 0.06 * Math.cos((month / 12) * 2 * Math.PI)
        : 1 + 0.08 * Math.sin((month / 12) * 2 * Math.PI);
      const baseKwh = site.categorie === "eclairage_public" ? kva * 330 * 3 : kva * 190 * 3; // ~trimestre
      const kwh = Math.max(30, Math.round(baseKwh * seasonal * (0.92 + rnd() * 0.16)));

      const prix = +(baseRate * (1 + (rnd() - 0.5) * 0.05)).toFixed(4);
      const montantConso = +((kwh * prix) / 100).toFixed(2);
      const fixe = +((kva * (KVA_AN[year] ?? 15)) / 4).toFixed(2); // abonnement trimestriel
      const ht = +(montantConso + fixe).toFixed(2);
      const accise = +(kwh * (ACCISE_EUR_KWH[year] ?? 0.022)).toFixed(2);
      const octroi = +(ht * OCTROI_PCT).toFixed(2);
      const autresTaxes = +(accise + octroi).toFixed(2);
      const tva = +(ht * TVA_PCT).toFixed(2);
      const ttc = +(ht + tva + autresTaxes).toFixed(2);
      const num = `${PREFIX}${pdlLabel}-${fmt(factureDate).replace(/-/g, "")}`;

      if (DRY) {
        console.log(`  [dry] ${commune.nom} / ${site.nom} : ${num} — ${kwh} kWh, ${ttc}€ TTC (${fmt(periodStart)} → ${fmt(periodEnd)})`);
        totalInvoices++;
        continue;
      }

      const { data: invoice, error: invErr } = await supabase.from("invoices").insert({
        org_id: orgId, contract_id: contractId, client_id: clientId, commune_id: commune.id, site_id: site.id,
        categorie: site.categorie, facture_number: num, facture_date: fmt(factureDate),
        date_limite_paiement: fmt(addDays(factureDate, 15)),
        total_ht: ht, tva, autres_taxes: autresTaxes, total_ttc: ttc,
        is_duplicata: false, raw_ocr_json: null, precision: null,
        file_path: `seed-test/${num}.pdf`, status: "reviewed",
      }).select("id").single();
      if (invErr || !invoice) { console.error(`  ✖ facture ${num}: ${invErr?.message}`); continue; }

      await supabase.from("consumption_periods").insert({
        invoice_id: invoice.id, contract_id: contractId, poste_tarifaire: "BASE",
        period_start: fmt(periodStart), period_end: fmt(periodEnd),
        numero_compteur: site.pdl, coefficient: 1, consommation_kwh: kwh,
        prix_unitaire_ckwh: prix, montant_eur: montantConso, index_estime: false,
      });
      await supabase.from("invoice_charges").insert([
        { invoice_id: invoice.id, category: "fixed", libelle: "Abonnement (part fixe)", period_start: fmt(periodStart), period_end: fmt(periodEnd), tarif_kva_an: KVA_AN[year] ?? 15, montant_eur: fixe },
        { invoice_id: invoice.id, category: "tax", libelle: "Accise sur l'électricité", period_start: fmt(periodStart), period_end: fmt(periodEnd), assiette: kwh, taux_numeric: ACCISE_EUR_KWH[year] ?? 0.022, taux_unit: "eur_per_kwh", montant_eur: accise },
        { invoice_id: invoice.id, category: "tax", libelle: "Octroi de mer", period_start: fmt(periodStart), period_end: fmt(periodEnd), assiette: ht, taux_numeric: 2.5, taux_unit: "percent", montant_eur: octroi },
      ]);
      totalInvoices++;
    }
    console.log(`✔ ${commune.nom} (${site.nom}) : ${toCreate} facture(s) ajoutée(s).`);
  }

  console.log(`\n${DRY ? "[dry] " : ""}${totalInvoices} facture(s) au total sur ${communes.length} communes, ${totalSitesCreated} nouveau(x) site(s) créé(s).`);
  if (DRY) console.log("--dry : aucune écriture effectuée.");
}

main().catch((e) => { console.error("✖ Échec :", e.message ?? e); process.exit(1); });
