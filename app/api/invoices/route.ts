import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { invoiceExtractionSchema } from "@/lib/anthropic/invoice-schema";
import { z } from "zod";

const saveRequestSchema = z.object({
  extraction: invoiceExtractionSchema,
  file_path: z.string(),
  site_id: z.string().uuid(),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = saveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Données invalides.", details: parsed.error.format() },
      { status: 400 },
    );
  }

  const { extraction, file_path, site_id } = parsed.data;

  const { data: site, error: siteError } = await supabase
    .from("sites")
    .select("id, commune_id, categorie")
    .eq("id", site_id)
    .single();

  if (siteError || !site) {
    return NextResponse.json({ error: "Site introuvable ou inaccessible." }, { status: 400 });
  }

  // 1. Upsert client, rattaché à la commune du site.
  const clientLookup = extraction.client.reference_compte
    ? supabase.from("clients").select("id").eq("reference_compte", extraction.client.reference_compte)
    : supabase.from("clients").select("id").eq("nom", extraction.client.nom);
  const { data: existingClient } = await clientLookup.limit(1).maybeSingle();

  let clientId = existingClient?.id as string | undefined;
  if (!clientId) {
    const { data: newClient, error: clientError } = await supabase
      .from("clients")
      .insert({
        nom: extraction.client.nom,
        reference_client: extraction.client.reference_client,
        reference_compte: extraction.client.reference_compte,
        adresse: extraction.client.adresse,
        commune_id: site.commune_id,
        created_by: authData.user.id,
      })
      .select("id")
      .single();

    if (clientError) {
      return NextResponse.json({ error: `Client: ${clientError.message}` }, { status: 500 });
    }
    clientId = newClient.id;
  }

  // 2. Upsert contract (unique on contract_number), rattaché au site choisi.
  const { data: existingContract } = await supabase
    .from("contracts")
    .select("id")
    .eq("contract_number", extraction.contract.contract_number)
    .maybeSingle();

  let contractId = existingContract?.id as string | undefined;
  if (!contractId) {
    const { data: newContract, error: contractError } = await supabase
      .from("contracts")
      .insert({
        ...extraction.contract,
        pdl: extraction.contract.pdl ?? null,
        tarif_type: extraction.contract.tarif_type ?? null,
        client_id: clientId,
        site_id,
        created_by: authData.user.id,
      })
      .select("id")
      .single();

    if (contractError) {
      return NextResponse.json({ error: `Contrat: ${contractError.message}` }, { status: 500 });
    }
    contractId = newContract.id;
  } else {
    await supabase
      .from("contracts")
      .update({
        site_id,
        ...(extraction.contract.pdl ? { pdl: extraction.contract.pdl } : {}),
        ...(extraction.contract.tarif_type ? { tarif_type: extraction.contract.tarif_type } : {}),
      })
      .eq("id", contractId);
  }

  // 3. Insert invoice header.
  const { data: existingInvoice } = await supabase
    .from("invoices")
    .select("id")
    .eq("facture_number", extraction.invoice.facture_number)
    .maybeSingle();

  if (existingInvoice) {
    return NextResponse.json(
      { error: `Facture ${extraction.invoice.facture_number} déjà enregistrée.` },
      { status: 409 },
    );
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .insert({
      ...extraction.invoice,
      contract_id: contractId,
      client_id: clientId,
      commune_id: site.commune_id,
      site_id,
      categorie: site.categorie,
      file_path,
      status: "reviewed",
      created_by: authData.user.id,
      raw_ocr_json: extraction,
      precision: extraction.precision ?? null,
    })
    .select("id")
    .single();

  if (invoiceError) {
    return NextResponse.json({ error: `Facture: ${invoiceError.message}` }, { status: 500 });
  }

  const invoiceId = invoice.id;

  // 4. Insert child rows (schéma consolidé : consumption_periods + invoice_charges).
  const childInserts = await Promise.all([
    extraction.consumption_lines.length
      ? supabase.from("consumption_periods").insert(
          extraction.consumption_lines.map((row) => ({
            invoice_id: invoiceId,
            contract_id: contractId,
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
        )
      : Promise.resolve({ error: null }),
    extraction.fixed_charges.length
      ? supabase.from("invoice_charges").insert(
          extraction.fixed_charges.map((row) => ({
            invoice_id: invoiceId,
            category: "fixed" as const,
            libelle: row.libelle,
            period_start: row.date_debut,
            period_end: row.date_fin,
            tarif_kva_an: row.tarif_kva_an,
            montant_eur: row.montant_eur,
          })),
        )
      : Promise.resolve({ error: null }),
    extraction.taxes.length
      ? supabase.from("invoice_charges").insert(
          extraction.taxes.map((row) => ({
            invoice_id: invoiceId,
            category: "tax" as const,
            libelle: row.libelle,
            period_start: row.date_debut,
            period_end: row.date_fin,
            assiette: row.assiette,
            taux: row.taux,
            taux_numeric: row.taux_numeric,
            taux_unit: row.taux_unit,
            montant_eur: row.montant_eur,
          })),
        )
      : Promise.resolve({ error: null }),
  ]);

  const childError = childInserts.find((r) => r.error)?.error;
  if (childError) {
    await supabase.from("invoices").delete().eq("id", invoiceId);
    return NextResponse.json({ error: `Détails facture: ${childError.message}` }, { status: 500 });
  }

  // 5. Tag par défaut "À vérifier".
  const { data: defaultTag } = await supabase
    .from("tags")
    .select("id")
    .eq("label", "À vérifier")
    .maybeSingle();
  if (defaultTag) {
    await supabase.from("invoice_tags").insert({ invoice_id: invoiceId, tag_id: defaultTag.id });
  }

  // 6. Détection simple d'anomalie : écart de consommation > 40% vs historique du site.
  const newTotalKwh = extraction.consumption_lines.reduce((s, l) => s + l.consommation_kwh, 0);
  const { data: pastInvoices } = await supabase
    .from("invoices")
    .select("id")
    .eq("site_id", site_id)
    .neq("id", invoiceId);

  if (pastInvoices && pastInvoices.length >= 2 && newTotalKwh > 0) {
    const { data: pastConsumption } = await supabase
      .from("consumption_periods")
      .select("invoice_id, consommation_kwh")
      .in("invoice_id", pastInvoices.map((p) => p.id));

    const byInvoice = new Map<string, number>();
    for (const row of pastConsumption ?? []) {
      byInvoice.set(row.invoice_id, (byInvoice.get(row.invoice_id) ?? 0) + (row.consommation_kwh ?? 0));
    }
    const values = Array.from(byInvoice.values()).filter((v) => v > 0);
    if (values.length >= 2) {
      const avg = values.reduce((s, v) => s + v, 0) / values.length;
      const deviation = avg ? (newTotalKwh - avg) / avg : 0;
      if (Math.abs(deviation) > 0.4) {
        await supabase.from("anomalies").insert({
          invoice_id: invoiceId,
          contract_id: contractId,
          type: "consumption_spike",
          severity: Math.abs(deviation) > 0.8 ? "high" : "medium",
          description: `Consommation ${deviation > 0 ? "en hausse" : "en baisse"} de ${Math.round(Math.abs(deviation) * 100)}% par rapport à la moyenne historique du site.`,
          detected_value: newTotalKwh,
          expected_range_min: avg * 0.6,
          expected_range_max: avg * 1.4,
        });
        await supabase.from("invoices").update({ status: "anomaly_flagged" }).eq("id", invoiceId);
        const { data: anomalyTag } = await supabase
          .from("tags")
          .select("id")
          .eq("label", "Anomalie")
          .maybeSingle();
        if (anomalyTag) {
          await supabase.from("invoice_tags").insert({ invoice_id: invoiceId, tag_id: anomalyTag.id });
        }
      }
    }
  }

  return NextResponse.json({ invoice_id: invoiceId });
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const communeId = searchParams.get("commune_id");
  const categorie = searchParams.get("categorie");
  const siteId = searchParams.get("site_id");

  let query = supabase
    .from("invoices")
    .select(
      "*, sites(nom, categorie, commune_id), communes(nom), invoice_tags(tags(id, label, color))",
    )
    .order("facture_date", { ascending: false });

  if (communeId) query = query.eq("commune_id", communeId);
  if (categorie) query = query.eq("categorie", categorie);
  if (siteId) query = query.eq("site_id", siteId);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ invoices: data });
}
