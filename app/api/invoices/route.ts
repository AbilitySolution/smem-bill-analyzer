import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { invoiceExtractionSchema } from "@/lib/anthropic/invoice-schema";
import { validateInvoice, normalizePosteTarifaire } from "@/lib/anthropic/invoice-validation";
import { z } from "zod";

const saveRequestSchema = z.object({
  extraction: invoiceExtractionSchema,
  file_path: z.string(),
  site_id: z.string().uuid().optional(),
  commune_id: z.string().uuid().optional(),
  new_site_categorie: z.enum(["batiment", "eclairage_public"]).optional(),
  override_comment: z.string().min(1).optional(),
  override_flag_anomaly: z.boolean().optional(),
  auto_saved: z.boolean().optional(),
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

  const { extraction, file_path, site_id, commune_id, new_site_categorie, override_comment, override_flag_anomaly, auto_saved } = parsed.data;

  if (!site_id && !commune_id) {
    return NextResponse.json({ error: "Commune non détectée — sélectionnez-la manuellement." }, { status: 400 });
  }

  // Resolve site: existing by id, or by PDL in commune, or auto-create
  let site: { id: string; commune_id: string; categorie: string };

  if (site_id) {
    const { data, error } = await supabase.from("sites").select("id, commune_id, categorie").eq("id", site_id).single();
    if (error || !data) return NextResponse.json({ error: "Site introuvable." }, { status: 400 });
    site = data;
  } else {
    // Le site d'une facture = son propre espace de livraison extrait. AUCUN matching flou et AUCUN
    // héritage du site du contrat (source des faux sites, ex. contrat couvrant plusieurs points de
    // livraison). Correspondance STRICTE (nom normalisé) avec un site existant de la commune pour
    // éviter les doublons ; sinon création d'un site portant exactement ce nom.
    const categorie = (new_site_categorie ?? extraction.categorie_hint ?? "batiment") as "batiment" | "eclairage_public";
    const nom = extraction.contract.espace_livraison?.trim() || extraction.client.nom || "Nouveau site";

    const normalizeSite = (s: string) =>
      s.toLowerCase()
        .normalize("NFD").replace(/\p{Mn}/gu, "")
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ").trim();

    const { data: sitesInCommune } = await supabase.from("sites").select("id, nom, commune_id, categorie")
      .eq("commune_id", commune_id!);

    const target = normalizeSite(nom);
    const matched = target ? (sitesInCommune ?? []).find((s) => normalizeSite(s.nom) === target) : undefined;

    if (matched) {
      site = matched;
    } else {
      const { data: newSite, error: siteErr } = await supabase.from("sites")
        .insert({ commune_id: commune_id!, categorie, nom, pdl: null })
        .select("id, commune_id, categorie").single();
      if (siteErr || !newSite) return NextResponse.json({ error: `Création site: ${siteErr?.message}` }, { status: 500 });
      site = newSite;
    }
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
        pdl: null,
        tarif_type: extraction.contract.tarif_type ?? null,
        client_id: clientId,
        site_id: site.id,
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
        site_id: site.id,
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
      {
        error: `Facture ${extraction.invoice.facture_number} déjà enregistrée.`,
        duplicate: true,
        existing_invoice_id: existingInvoice.id,
      },
      { status: 409 },
    );
  }

  const isOverride = !!override_comment;
  const initialStatus = isOverride && override_flag_anomaly ? "anomaly_flagged" : "reviewed";

  // Composite confidence — fieldConfidence replaces raw Claude self-scores
  const validation = validateInvoice(extraction);
  const precisionToStore = {
    ...validation.fieldConfidence,
    _global: validation.confidence,
  };

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .insert({
      ...extraction.invoice,
      contract_id: contractId,
      client_id: clientId,
      commune_id: site.commune_id,
      site_id: site.id,
      categorie: site.categorie,
      file_path,
      status: initialStatus,
      auto_saved: auto_saved ?? false,
      created_by: authData.user.id,
      raw_ocr_json: isOverride
        ? { ...extraction, _override: { comment: override_comment, flag_anomaly: override_flag_anomaly } }
        : extraction,
      precision: precisionToStore,
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
            // Normaliser avant save : "Heure P", "H.P.", etc. → "HP"
            poste_tarifaire: normalizePosteTarifaire(row.poste_tarifaire),
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

  // 5b. Persister les issues IDP (erreurs + avertissements structurels) dans anomalies.
  const IDP_SKIP = new Set(["LOW_CONFIDENCE", "LINE_AMOUNT_MISMATCH"]);
  const idpIssues = validation.issues.filter((iss) => !IDP_SKIP.has(iss.code));
  if (idpIssues.length > 0) {
    await supabase.from("anomalies").insert(
      idpIssues.map((iss) => ({
        invoice_id: invoiceId,
        contract_id: contractId,
        type: iss.code.toLowerCase(),
        severity: iss.severity === "error" ? "high" : "medium",
        description: iss.message,
      })),
    );
    // Taguer "Anomalie" si erreur bloquante
    if (idpIssues.some((i) => i.severity === "error")) {
      const { data: anomalyTag } = await supabase.from("tags").select("id").eq("label", "Anomalie").maybeSingle();
      if (anomalyTag) await supabase.from("invoice_tags").insert({ invoice_id: invoiceId, tag_id: anomalyTag.id });
    }
  }

  // 5c. Override validation — créer anomalie manuelle si l'utilisateur a choisi de détecter.
  if (isOverride && override_flag_anomaly) {
    await supabase.from("anomalies").insert({
      invoice_id: invoiceId,
      contract_id: contractId,
      type: "validation_override",
      severity: "medium",
      description: `Validation ignorée manuellement. Justification : ${override_comment}`,
    });
    const { data: anomalyTag } = await supabase.from("tags").select("id").eq("label", "Anomalie").maybeSingle();
    if (anomalyTag) {
      await supabase.from("invoice_tags").insert({ invoice_id: invoiceId, tag_id: anomalyTag.id });
    }
  }

  // 6. Détection d'anomalie de consommation vs historique du site.
  // On compare en kWh/jour plutôt qu'en kWh bruts : une facture multi-périodes couvre plus de jours
  // qu'une facture mensuelle, ce qui provoquerait un faux positif sur les kWh totaux.
  const newTotalKwh = extraction.consumption_lines.reduce((s, l) => s + l.consommation_kwh, 0);

  // Borne min/max des dates de la facture courante pour calculer sa durée
  const newMinStart = extraction.consumption_lines.reduce<string | null>(
    (m, l) => l.date_debut && (!m || l.date_debut < m) ? l.date_debut : m, null,
  );
  const newMaxEnd = extraction.consumption_lines.reduce<string | null>(
    (m, l) => l.date_fin && (!m || l.date_fin > m) ? l.date_fin : m, null,
  );
  const newDays = (newMinStart && newMaxEnd)
    ? (new Date(newMaxEnd).getTime() - new Date(newMinStart).getTime()) / 86_400_000
    : 0;
  // kWh/jour de la facture courante (0 si dates absentes → skip comparaison)
  const newKwhPerDay = newDays > 0 ? newTotalKwh / newDays : 0;

  // Utiliser site.id (résolu) et non site_id du body — site_id peut être undefined si site auto-créé
  const { data: pastInvoices } = await supabase
    .from("invoices")
    .select("id")
    .eq("site_id", site.id)
    .neq("id", invoiceId);

  if (pastInvoices && pastInvoices.length >= 2 && newKwhPerDay > 0) {
    // Récupérer les dates de période pour normaliser l'historique par durée aussi
    const { data: pastConsumption } = await supabase
      .from("consumption_periods")
      .select("invoice_id, consommation_kwh, period_start, period_end")
      .in("invoice_id", pastInvoices.map((p) => p.id));

    // Agréger par facture : kWh total + borne min/max des périodes
    const byInvoice = new Map<string, { kwh: number; start: string | null; end: string | null }>();
    for (const row of pastConsumption ?? []) {
      const cur = byInvoice.get(row.invoice_id) ?? { kwh: 0, start: null, end: null };
      byInvoice.set(row.invoice_id, {
        kwh: cur.kwh + (row.consommation_kwh ?? 0),
        start: !cur.start || (row.period_start && row.period_start < cur.start) ? row.period_start : cur.start,
        end: !cur.end || (row.period_end && row.period_end > cur.end) ? row.period_end : cur.end,
      });
    }

    // Convertir chaque facture historique en kWh/jour
    const historicalRates = Array.from(byInvoice.values())
      .map(({ kwh, start, end }) => {
        const days = (start && end)
          ? (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000
          : 0;
        return days > 0 ? kwh / days : 0;
      })
      .filter((v) => v > 0);

    if (historicalRates.length >= 2) {
      const avgRate = historicalRates.reduce((s, v) => s + v, 0) / historicalRates.length;
      const deviation = avgRate ? (newKwhPerDay - avgRate) / avgRate : 0;
      if (Math.abs(deviation) > 0.4) {
        await supabase.from("anomalies").insert({
          invoice_id: invoiceId,
          contract_id: contractId,
          type: "consumption_spike",
          severity: Math.abs(deviation) > 0.8 ? "high" : "medium",
          description: `Consommation ${deviation > 0 ? "en hausse" : "en baisse"} de ${Math.round(Math.abs(deviation) * 100)}% vs historique du site (${newKwhPerDay.toFixed(1)} kWh/j vs moy. ${avgRate.toFixed(1)} kWh/j).`,
          detected_value: newTotalKwh,
          // expected_range exprimé en kWh absolus pour la durée de cette facture
          expected_range_min: avgRate * 0.6 * newDays,
          expected_range_max: avgRate * 1.4 * newDays,
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
