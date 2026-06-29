// Seed script: generate simulated EDF-style invoices (synthetic but plausible
// data) + a matching one-page PDF, inserted directly via service-role client.
// Run with: node --env-file=.env.local scripts/seed-simulated.mjs
import { createClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

function rand(min, max) {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

async function buildPdf({ commune, site, factureNumber, factureDate, lines, fixed, taxes, totals }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 800;

  const draw = (text, { x = 50, size = 10, f = font, color = rgb(0.1, 0.1, 0.1) } = {}) => {
    page.drawText(text, { x, y, size, font: f, color });
    y -= size + 6;
  };

  draw("EDF — Facture d'électricité (simulation)", { size: 16, f: bold, color: rgb(0.1, 0.25, 0.6) });
  y -= 6;
  draw(`Commune : ${commune}`);
  draw(`Site / PDL : ${site.nom} (${site.pdl ?? "—"})`);
  draw(`Facture n° : ${factureNumber}`);
  draw(`Date de facture : ${factureDate}`);
  y -= 10;
  draw("Détail de consommation", { size: 12, f: bold });
  for (const l of lines) {
    draw(
      `${l.poste_tarifaire.padEnd(8)} ${l.date_debut} -> ${l.date_fin}   ${l.consommation_kwh} kWh   ${l.montant_eur} €`,
      { size: 9 },
    );
  }
  y -= 6;
  draw("Part fixe", { size: 12, f: bold });
  for (const f of fixed) {
    draw(`${f.libelle}   ${f.montant_eur} €`, { size: 9 });
  }
  y -= 6;
  draw("Taxes & contributions", { size: 12, f: bold });
  for (const t of taxes) {
    draw(`${t.libelle}   ${t.montant_eur} €`, { size: 9 });
  }
  y -= 10;
  draw(`Total HT : ${totals.total_ht} €`, { size: 11, f: bold });
  draw(`TVA : ${totals.tva} €`, { size: 11 });
  draw(`Autres taxes : ${totals.autres_taxes} €`, { size: 11 });
  draw(`Total TTC : ${totals.total_ttc} €`, { size: 13, f: bold, color: rgb(0.1, 0.4, 0.2) });
  y -= 10;
  draw("Document généré pour démonstration — données simulées.", { size: 8, color: rgb(0.5, 0.5, 0.5) });

  return await doc.save();
}

async function getOrCreateClient(nom, communeId) {
  let { data } = await supabase.from("clients").select("id").eq("nom", nom).maybeSingle();
  if (data) return data.id;
  const { data: created, error } = await supabase
    .from("clients")
    .insert({ nom, commune_id: communeId })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return created.id;
}

async function getOrCreateContract(contractNumber, clientId, siteId, kva) {
  let { data } = await supabase.from("contracts").select("id").eq("contract_number", contractNumber).maybeSingle();
  if (data) return data.id;
  const { data: created, error } = await supabase
    .from("contracts")
    .insert({
      contract_number: contractNumber,
      client_id: clientId,
      site_id: siteId,
      puissance_souscrite_kva: kva,
      type_compteur: "électronique",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return created.id;
}

async function seedInvoice({ commune, site, periodLabel, factureDate, baseKwh }) {
  const factureNumber = `SIM-${site.pdl ?? site.id.slice(0, 6)}-${factureDate.replaceAll("-", "")}`;
  const { data: existing } = await supabase
    .from("invoices")
    .select("id")
    .eq("facture_number", factureNumber)
    .maybeSingle();
  if (existing) {
    console.log(`Déjà en base: ${factureNumber}`);
    return;
  }

  const clientNom = `Commune de ${commune.nom}`;
  const clientId = await getOrCreateClient(clientNom, commune.id);
  const contractNumber = site.pdl ?? `C-${site.id.slice(0, 8)}`;
  const contractId = await getOrCreateContract(contractNumber, clientId, site.id, site.kva);

  const kwh = Math.round(baseKwh * (0.85 + Math.random() * 0.3));
  const prixUnitaire = rand(13, 16);
  const montantConso = Math.round(((kwh * prixUnitaire) / 100) * 100) / 100;

  const lines = [
    {
      poste_tarifaire: "BASE",
      date_debut: factureDate,
      date_fin: factureDate,
      numero_compteur: site.pdl,
      ancien_index: rand(1000, 5000),
      nouveau_index: null,
      coefficient: 1,
      consommation_kwh: kwh,
      prix_unitaire_ckwh: prixUnitaire,
      montant_eur: montantConso,
      index_estime: false,
    },
  ];
  lines[0].nouveau_index = Math.round((lines[0].ancien_index + kwh) * 100) / 100;

  const abonnement = Math.round(((site.kva ?? 9) * rand(8, 12)) * 100) / 100;
  const fixed = [{ libelle: "Abonnement", date_debut: factureDate, date_fin: factureDate, tarif_kva_an: rand(8, 12), montant_eur: abonnement }];

  const totalHt = Math.round((montantConso + abonnement) * 100) / 100;
  const cspe = Math.round(totalHt * 0.03 * 100) / 100;
  const tcfe = Math.round(kwh * 0.0095 * 100) / 100;
  const taxes = [
    { libelle: "CSPE", date_debut: factureDate, date_fin: factureDate, assiette: totalHt, taux: "3%", taux_numeric: 3, taux_unit: "percent", montant_eur: cspe },
    { libelle: "TCFE", date_debut: factureDate, date_fin: factureDate, assiette: kwh, taux: "0.95 c€/kWh", taux_numeric: 0.95, taux_unit: "eur_per_kwh", montant_eur: tcfe },
  ];
  const autresTaxes = Math.round((cspe + tcfe) * 100) / 100;
  const tva = Math.round(totalHt * 0.085 * 100) / 100;
  const totalTtc = Math.round((totalHt + tva + autresTaxes) * 100) / 100;

  const pdfBytes = await buildPdf({
    commune: commune.nom,
    site,
    factureNumber,
    factureDate,
    lines,
    fixed,
    taxes,
    totals: { total_ht: totalHt, tva, autres_taxes: autresTaxes, total_ttc: totalTtc },
  });

  const storagePath = `seed-sim/${Date.now()}-${factureNumber}.pdf`;
  const { error: uploadError } = await supabase.storage
    .from("invoice-files")
    .upload(storagePath, pdfBytes, { contentType: "application/pdf" });
  if (uploadError) throw new Error(`Upload: ${uploadError.message}`);

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .insert({
      contract_id: contractId,
      client_id: clientId,
      commune_id: commune.id,
      site_id: site.id,
      categorie: site.categorie,
      facture_number: factureNumber,
      facture_date: factureDate,
      total_ht: totalHt,
      tva,
      autres_taxes: autresTaxes,
      total_ttc: totalTtc,
      file_path: storagePath,
      status: "reviewed",
      raw_ocr_json: { simulated: true, periodLabel },
    })
    .select("id")
    .single();
  if (invoiceError) throw new Error(`Facture: ${invoiceError.message}`);

  await supabase.from("consumption_periods").insert(
    lines.map((l) => ({ ...l, invoice_id: invoice.id, contract_id: contractId })),
  );
  await supabase.from("invoice_charges").insert(
    fixed.map((f) => ({ ...f, invoice_id: invoice.id, category: "fixed" })),
  );
  await supabase.from("invoice_charges").insert(
    taxes.map((t) => ({ ...t, invoice_id: invoice.id, category: "tax" })),
  );

  const { data: tag } = await supabase.from("tags").select("id").eq("label", "Validée").maybeSingle();
  if (tag) await supabase.from("invoice_tags").insert({ invoice_id: invoice.id, tag_id: tag.id });

  console.log(`OK — ${factureNumber} (${site.nom}, ${commune.nom}) — ${totalTtc} € / ${kwh} kWh`);
}

async function getSite(communeNom, siteNom) {
  const { data: commune } = await supabase.from("communes").select("*").eq("nom", communeNom).single();
  const { data: site } = await supabase
    .from("sites")
    .select("*")
    .eq("commune_id", commune.id)
    .eq("nom", siteNom)
    .single();
  return { commune, site };
}

const PLAN = [
  // Fonds-Saint-Denis — éclairage public, périodes supplémentaires
  { commune: "Fonds-Saint-Denis", site: "La Croix", date: "2024-02-15", label: "S1 2024", baseKwh: 2000 },
  { commune: "Fonds-Saint-Denis", site: "Place Jules Pain", date: "2024-08-20", label: "S2 2024", baseKwh: 200 },
  { commune: "Fonds-Saint-Denis", site: "Bel Oncle", date: "2024-02-10", label: "S1 2024", baseKwh: 650 },
  { commune: "Fonds-Saint-Denis", site: "Fonds Mascret", date: "2024-08-05", label: "S2 2024", baseKwh: 1000 },
  // Fonds-Saint-Denis — bâtiments
  { commune: "Fonds-Saint-Denis", site: "Hôtel de Ville", date: "2024-02-12", label: "S1 2024", baseKwh: 1300 },
  { commune: "Fonds-Saint-Denis", site: "Écoles", date: "2024-08-12", label: "S2 2024", baseKwh: 1900 },
  { commune: "Fonds-Saint-Denis", site: "Podium", date: "2024-02-18", label: "S1 2024", baseKwh: 2200 },
  // Grand'Rivière — bâtiments
  { commune: "Grand'Rivière", site: "Mairie", date: "2024-02-14", label: "S1 2024", baseKwh: 1100 },
  { commune: "Grand'Rivière", site: "École du bourg", date: "2024-08-14", label: "S2 2024", baseKwh: 900 },
  // Grand'Rivière — éclairage public (avant/après pour comparaison)
  { commune: "Grand'Rivière", site: "Bourg", date: "2022-08-10", label: "S2 2022", baseKwh: 1400 },
  { commune: "Grand'Rivière", site: "Bourg", date: "2023-08-10", label: "S2 2023 (post-travaux)", baseKwh: 700 },
  { commune: "Grand'Rivière", site: "Anse Céron", date: "2023-02-10", label: "S1 2023", baseKwh: 600 },
];

for (const item of PLAN) {
  try {
    const { commune, site } = await getSite(item.commune, item.site);
    await seedInvoice({ commune, site, periodLabel: item.label, factureDate: item.date, baseKwh: item.baseKwh });
  } catch (err) {
    console.error(`Erreur sur ${item.commune}/${item.site}/${item.date}:`, err.message);
  }
}
console.log("\nTerminé.");
