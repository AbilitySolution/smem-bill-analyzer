// Seed script: OCR-ingest the real EDF invoice PDFs from ../../test-factures
// using the live Claude extraction pipeline + service-role Supabase client.
// Run with: node --env-file=.env.local scripts/seed-real.mjs
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const TEST_FACTURES_DIR = path.resolve(import.meta.dirname, "../../test-factures");
const COMMUNE_NOM = "Fonds-Saint-Denis";

const FILENAME_TO_SITE = {
  PlaceJulesPain: "Place Jules Pain",
  EPBelOncle: "Bel Oncle",
  Observatoire: "Route de l'Observatoire",
  EPLaCroix: "La Croix",
  EPFdsMascret: "Fonds Mascret",
  EPMDC: "Morne des Cadets",
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const TOOL_SCHEMA = {
  name: "extract_edf_invoice",
  description: "Extrait les données structurées d'une facture EDF.",
  input_schema: {
    type: "object",
    properties: {
      client: {
        type: "object",
        properties: {
          nom: { type: "string" },
          reference_client: { type: ["string", "null"] },
          reference_compte: { type: ["string", "null"] },
          adresse: { type: ["string", "null"] },
        },
        required: ["nom", "reference_client", "reference_compte", "adresse"],
      },
      contract: {
        type: "object",
        properties: {
          contract_number: { type: "string" },
          espace_livraison: { type: ["string", "null"] },
          offre: { type: ["string", "null"] },
          service: { type: ["string", "null"] },
          puissance_souscrite_kva: { type: ["number", "null"] },
          reglage_protection_a: { type: ["number", "null"] },
          type_compteur: { type: ["string", "null"] },
          numero_compteur: { type: ["string", "null"] },
        },
        required: ["contract_number", "espace_livraison", "offre", "service", "puissance_souscrite_kva", "reglage_protection_a", "type_compteur", "numero_compteur"],
      },
      invoice: {
        type: "object",
        properties: {
          facture_number: { type: "string" },
          facture_date: { type: "string" },
          date_limite_paiement: { type: ["string", "null"] },
          date_prochain_releve: { type: ["string", "null"] },
          date_prochaine_facture: { type: ["string", "null"] },
          total_ht: { type: "number" },
          tva: { type: ["number", "null"] },
          autres_taxes: { type: ["number", "null"] },
          total_ttc: { type: "number" },
          is_duplicata: { type: "boolean" },
        },
        required: ["facture_number", "facture_date", "date_limite_paiement", "date_prochain_releve", "date_prochaine_facture", "total_ht", "tva", "autres_taxes", "total_ttc", "is_duplicata"],
      },
      consumption_history: {
        type: "array",
        items: {
          type: "object",
          properties: {
            periode_label: { type: "string" },
            periode_date: { type: ["string", "null"] },
            poste_tarifaire: { type: "string" },
            valeur_kwh: { type: ["number", "null"] },
            is_estime: { type: "boolean" },
          },
          required: ["periode_label", "periode_date", "poste_tarifaire", "valeur_kwh", "is_estime"],
        },
      },
      fixed_charges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            libelle: { type: "string" },
            date_debut: { type: ["string", "null"] },
            date_fin: { type: ["string", "null"] },
            tarif_kva_an: { type: ["number", "null"] },
            montant_eur: { type: "number" },
          },
          required: ["libelle", "date_debut", "date_fin", "tarif_kva_an", "montant_eur"],
        },
      },
      consumption_lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            poste_tarifaire: { type: "string" },
            date_debut: { type: ["string", "null"] },
            date_fin: { type: ["string", "null"] },
            numero_compteur: { type: ["string", "null"] },
            ancien_index: { type: ["number", "null"] },
            nouveau_index: { type: ["number", "null"] },
            coefficient: { type: "number" },
            consommation_kwh: { type: "number" },
            prix_unitaire_ckwh: { type: ["number", "null"] },
            montant_eur: { type: "number" },
            index_estime: { type: "boolean" },
          },
          required: ["poste_tarifaire", "date_debut", "date_fin", "numero_compteur", "ancien_index", "nouveau_index", "coefficient", "consommation_kwh", "prix_unitaire_ckwh", "montant_eur", "index_estime"],
        },
      },
      taxes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            libelle: { type: "string" },
            date_debut: { type: ["string", "null"] },
            date_fin: { type: ["string", "null"] },
            assiette: { type: ["number", "null"] },
            taux: { type: ["string", "null"] },
            taux_numeric: { type: ["number", "null"] },
            taux_unit: { type: ["string", "null"], enum: ["eur_per_kwh", "percent", null] },
            montant_eur: { type: "number" },
          },
          required: ["libelle", "date_debut", "date_fin", "assiette", "taux", "taux_numeric", "taux_unit", "montant_eur"],
        },
      },
    },
    required: ["client", "contract", "invoice", "consumption_history", "fixed_charges", "consumption_lines", "taxes"],
  },
};

const EXTRACTION_PROMPT = `Tu analyses une facture EDF (électricité). Extrait toutes les données structurées de cette facture en utilisant l'outil extract_edf_invoice.

Règles importantes :
- Toutes les dates au format ISO 8601 (YYYY-MM-DD).
- Les montants en nombres (pas de texte, pas de symbole €), avec le point comme séparateur décimal.
- Les lignes "part fixe / abonnement" vont dans fixed_charges.
- Les lignes "part variable" avec index ancien/nouveau de compteur vont dans consumption_lines.
- Toutes les lignes de la section "Taxes et contributions" vont dans taxes.
- Si une valeur n'est pas présente sur la facture, mets null (jamais d'invention de données).
- is_duplicata = true si le mot "DUPLICATA" apparaît sur le document.`;

async function getSiteId(filename) {
  const key = Object.keys(FILENAME_TO_SITE).find((k) => filename.includes(k));
  if (!key) throw new Error(`Pas de mapping de site pour ${filename}`);
  const siteName = FILENAME_TO_SITE[key];

  const { data: commune } = await supabase.from("communes").select("id").eq("nom", COMMUNE_NOM).single();
  const { data: site } = await supabase
    .from("sites")
    .select("id, commune_id, categorie")
    .eq("commune_id", commune.id)
    .eq("nom", siteName)
    .single();
  if (!site) throw new Error(`Site introuvable: ${siteName}`);
  return site;
}

async function processFile(filename) {
  console.log(`\n--- ${filename} ---`);
  const filePath = path.join(TEST_FACTURES_DIR, filename);
  const buffer = await readFile(filePath);
  const base64 = buffer.toString("base64");

  const site = await getSiteId(filename);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    tools: [TOOL_SCHEMA],
    tool_choice: { type: "tool", name: "extract_edf_invoice" },
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    console.error("Pas d'extraction retournée pour", filename);
    return;
  }
  const extraction = toolUse.input;
  console.log("Extrait:", extraction.invoice.facture_number, extraction.invoice.facture_date, extraction.invoice.total_ttc, "€");

  const { data: existingInvoice } = await supabase
    .from("invoices")
    .select("id")
    .eq("facture_number", extraction.invoice.facture_number)
    .maybeSingle();
  if (existingInvoice) {
    console.log("Déjà en base, on passe.");
    return;
  }

  const storagePath = `seed/${Date.now()}-${filename}`;
  const { error: uploadError } = await supabase.storage
    .from("invoice-files")
    .upload(storagePath, buffer, { contentType: "application/pdf" });
  if (uploadError) throw new Error(`Upload: ${uploadError.message}`);

  let { data: client } = await supabase
    .from("clients")
    .select("id")
    .eq("nom", extraction.client.nom)
    .maybeSingle();
  if (!client) {
    const { data: newClient, error } = await supabase
      .from("clients")
      .insert({ ...extraction.client, commune_id: site.commune_id })
      .select("id")
      .single();
    if (error) throw new Error(`Client: ${error.message}`);
    client = newClient;
  }

  let { data: contract } = await supabase
    .from("contracts")
    .select("id")
    .eq("contract_number", extraction.contract.contract_number)
    .maybeSingle();
  if (!contract) {
    const { data: newContract, error } = await supabase
      .from("contracts")
      .insert({ ...extraction.contract, client_id: client.id, site_id: site.id })
      .select("id")
      .single();
    if (error) throw new Error(`Contrat: ${error.message}`);
    contract = newContract;
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .insert({
      ...extraction.invoice,
      contract_id: contract.id,
      client_id: client.id,
      commune_id: site.commune_id,
      site_id: site.id,
      categorie: site.categorie,
      file_path: storagePath,
      status: "reviewed",
      raw_ocr_json: extraction,
    })
    .select("id")
    .single();
  if (invoiceError) throw new Error(`Facture: ${invoiceError.message}`);

  if (extraction.consumption_lines.length) {
    await supabase.from("consumption_periods").insert(
      extraction.consumption_lines.map((row) => ({
        invoice_id: invoice.id,
        contract_id: contract.id,
        poste_tarifaire: row.poste_tarifaire,
        period_start: row.date_debut,
        period_end: row.date_fin,
        numero_compteur: row.numero_compteur,
        ancien_index: row.ancien_index,
        nouveau_index: row.nouveau_index,
        coefficient: row.coefficient,
        consommation_kwh: row.consommation_kwh,
        prix_unitaire_ckwh: row.prix_unitaire_ckwh,
        montant_eur: row.montant_eur,
        index_estime: row.index_estime,
      })),
    );
  }
  if (extraction.fixed_charges.length) {
    await supabase.from("invoice_charges").insert(
      extraction.fixed_charges.map((row) => ({
        invoice_id: invoice.id,
        category: "fixed",
        libelle: row.libelle,
        period_start: row.date_debut,
        period_end: row.date_fin,
        tarif_kva_an: row.tarif_kva_an,
        montant_eur: row.montant_eur,
      })),
    );
  }
  if (extraction.taxes.length) {
    await supabase.from("invoice_charges").insert(
      extraction.taxes.map((row) => ({
        invoice_id: invoice.id,
        category: "tax",
        libelle: row.libelle,
        period_start: row.date_debut,
        period_end: row.date_fin,
        assiette: row.assiette,
        taux: row.taux,
        taux_numeric: row.taux_numeric,
        taux_unit: row.taux_unit,
        montant_eur: row.montant_eur,
      })),
    );
  }

  const { data: tag } = await supabase.from("tags").select("id").eq("label", "Validée").maybeSingle();
  if (tag) await supabase.from("invoice_tags").insert({ invoice_id: invoice.id, tag_id: tag.id });

  console.log("OK — facture insérée:", invoice.id);
}

const files = (await readdir(TEST_FACTURES_DIR)).filter((f) => f.endsWith(".pdf"));
for (const file of files) {
  try {
    await processFile(file);
  } catch (err) {
    console.error(`Erreur sur ${file}:`, err.message);
  }
}
console.log("\nTerminé.");
