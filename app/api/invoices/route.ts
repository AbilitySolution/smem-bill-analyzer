import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";
import { invoiceExtractionSchema } from "@/lib/anthropic/invoice-schema";
import { validateInvoice, normalizePosteTarifaire } from "@/lib/anthropic/invoice-validation";
import { recomputeAndPersistAnomalies } from "@/lib/anomalies/persist";
import { z } from "zod";

const customFieldEntrySchema = z.object({
  section: z.enum(["localisation", "invoice", "client", "contract"]),
  value: z.string().min(1),
  definition_id: z.string().uuid().optional(),
  new_definition: z.object({
    label: z.string().min(1),
    field_type: z.enum(["text", "number", "date"]),
  }).optional(),
}).refine(
  (v) => Boolean(v.definition_id) !== Boolean(v.new_definition),
  { message: "Fournir soit definition_id, soit new_definition, pas les deux." },
);

const saveRequestSchema = z.object({
  extraction: invoiceExtractionSchema,
  file_path: z.string(),
  site_id: z.string().uuid().optional(),
  commune_id: z.string().uuid().optional(),
  new_site_categorie: z.enum(["batiment", "eclairage_public"]).optional(),
  override_comment: z.string().min(1).optional(),
  override_flag_anomaly: z.boolean().optional(),
  custom_fields: z.array(customFieldEntrySchema).optional().default([]),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const ctx = await getUserContext();
  if (!ctx) {
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

  const { extraction, file_path, site_id, commune_id, new_site_categorie, override_comment, override_flag_anomaly, custom_fields } = parsed.data;

  if (!site_id && !commune_id) {
    return NextResponse.json({ error: "Commune non détectée — sélectionnez-la manuellement." }, { status: 400 });
  }

  // Resolve site: existing by id, or by PDL in commune, or auto-create
  let site: { id: string; commune_id: string; categorie: string };

  if (site_id) {
    const { data, error } = await supabase.from("sites").select("id, commune_id, categorie").eq("id", site_id).eq("org_id", ctx.orgId).single();
    if (error || !data) return NextResponse.json({ error: "Site introuvable." }, { status: 400 });
    site = data;
  } else {
    {
      // Fuzzy match against existing sites in the commune by normalized meaningful keywords
      const categorie = (new_site_categorie ?? extraction.categorie_hint ?? "batiment") as "batiment" | "eclairage_public";
      const nom = extraction.contract.espace_livraison?.trim() || extraction.client.nom || "Nouveau site";

      // Words that appear in almost every site name — useless for deduplication
      const SITE_STOP = new Set([
        "eclairage", "public", "ep", "armoire", "candelabre", "luminaire", "voirie",
        "route", "rue", "impasse", "chemin", "allee", "boulevard", "avenue", "rte", "av",
        "quartier", "qtr", "section", "lot", "lotissement", "residence", "cite",
        "de", "du", "la", "le", "les", "des", "l", "d", "en", "et", "a", "au", "aux",
        "par", "sur", "sous", "chez",
      ]);

      const normalizeSite = (s: string) =>
        s.toLowerCase()
          .normalize("NFD").replace(/\p{Mn}/gu, "")
          .replace(/\bste\b/g, "saint")
          .replace(/\bst\b/g, "saint")
          .replace(/\bsainte\b/g, "saint")
          .replace(/\bgde?\b/g, "grand")
          .replace(/[^a-z0-9 ]/g, " ")
          .replace(/\s+/g, " ").trim();

      const siteKeywords = (s: string) =>
        normalizeSite(s).split(" ").filter((w) => w.length > 2 && !SITE_STOP.has(w));

      const { data: sitesInCommune } = await supabase.from("sites").select("id, nom, commune_id, categorie")
        .eq("commune_id", commune_id!).eq("org_id", ctx.orgId);

      const nkw = siteKeywords(nom);
      const matched = nkw.length > 0
        ? (sitesInCommune ?? []).find((s) => {
            const skw = siteKeywords(s.nom);
            if (skw.length === 0) return false;
            // exact normalized match
            if (normalizeSite(s.nom) === normalizeSite(nom)) return true;
            // keyword overlap: ≥50% of the shorter keyword list found in the other
            const overlap = nkw.filter((w) => skw.includes(w)).length;
            return overlap / Math.min(nkw.length, skw.length) >= 0.5;
          })
        : undefined;

      if (matched) {
        site = matched;
      } else {
        const { data: newSite, error: siteErr } = await supabase.from("sites")
          .insert({ org_id: ctx.orgId, commune_id: commune_id!, categorie, nom, pdl: null })
          .select("id, commune_id, categorie").single();
        if (siteErr || !newSite) return NextResponse.json({ error: `Création site: ${siteErr?.message}` }, { status: 500 });
        site = newSite;
      }
    }
  }

  // 1. Upsert client, rattaché à la commune du site.
  const clientLookup = extraction.client.reference_compte
    ? supabase.from("clients").select("id").eq("reference_compte", extraction.client.reference_compte)
    : supabase.from("clients").select("id").eq("nom", extraction.client.nom);
  const { data: existingClient } = await clientLookup.eq("org_id", ctx.orgId).limit(1).maybeSingle();

  let clientId = existingClient?.id as string | undefined;
  if (!clientId) {
    const { data: newClient, error: clientError } = await supabase
      .from("clients")
      .insert({
        org_id: ctx.orgId,
        nom: extraction.client.nom,
        reference_client: extraction.client.reference_client,
        reference_compte: extraction.client.reference_compte,
        adresse: extraction.client.adresse,
        commune_id: site.commune_id,
        created_by: ctx.userId,
      })
      .select("id")
      .single();

    if (clientError) {
      return NextResponse.json({ error: `Client: ${clientError.message}` }, { status: 500 });
    }
    clientId = newClient.id;
  }

  // 2. Upsert contract (unique on org_id+contract_number), rattaché au site choisi.
  const { data: existingContract } = await supabase
    .from("contracts")
    .select("id")
    .eq("contract_number", extraction.contract.contract_number)
    .eq("org_id", ctx.orgId)
    .maybeSingle();

  let contractId = existingContract?.id as string | undefined;
  if (!contractId) {
    const { data: newContract, error: contractError } = await supabase
      .from("contracts")
      .insert({
        ...extraction.contract,
        org_id: ctx.orgId,
        pdl: null,
        tarif_type: extraction.contract.tarif_type ?? null,
        client_id: clientId,
        site_id: site.id,
        created_by: ctx.userId,
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
    .eq("org_id", ctx.orgId)
    .maybeSingle();

  if (existingInvoice) {
    return NextResponse.json(
      { error: `Facture ${extraction.invoice.facture_number} déjà enregistrée.` },
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
      org_id: ctx.orgId,
      contract_id: contractId,
      client_id: clientId,
      commune_id: site.commune_id,
      site_id: site.id,
      categorie: site.categorie,
      file_path,
      status: initialStatus,
      created_by: ctx.userId,
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

  // 4.5. Résoudre/créer les définitions de champs personnalisés puis insérer les valeurs.
  if (custom_fields.length > 0) {
    const resolvedIds = new Map<number, string>(); // index dans custom_fields -> definition_id

    for (let i = 0; i < custom_fields.length; i++) {
      const cf = custom_fields[i];
      if (cf.definition_id) {
        resolvedIds.set(i, cf.definition_id);
        continue;
      }
      const label = cf.new_definition!.label.trim();
      const { data: inserted, error: defErr } = await supabase
        .from("custom_field_definitions")
        .insert({
          org_id: ctx.orgId,
          section: cf.section,
          label,
          field_type: cf.new_definition!.field_type,
          created_by: ctx.userId,
        })
        .select("id")
        .single();

      if (defErr) {
        // 23505 = unique_violation → un autre utilisateur a créé le même libellé
        // entre-temps (ou double-clic) : réutiliser la définition existante.
        if (defErr.code === "23505") {
          const { data: existingDef } = await supabase
            .from("custom_field_definitions")
            .select("id")
            .eq("org_id", ctx.orgId)
            .eq("section", cf.section)
            .ilike("label", label)
            .maybeSingle();
          if (existingDef) {
            resolvedIds.set(i, existingDef.id);
            continue;
          }
        }
        await supabase.from("invoices").delete().eq("id", invoiceId);
        return NextResponse.json({ error: `Champ personnalisé: ${defErr.message}` }, { status: 500 });
      }
      resolvedIds.set(i, inserted.id);
    }

    // Dédupliquer par definition_id (dernier gagne) pour éviter les conflits (invoice_id, definition_id).
    const byDefinition = new Map<string, string>();
    custom_fields.forEach((cf, i) => {
      const defId = resolvedIds.get(i);
      if (defId) byDefinition.set(defId, cf.value.trim());
    });

    const valueRows = Array.from(byDefinition.entries())
      .filter(([, value]) => value.length > 0)
      .map(([definition_id, value]) => ({ invoice_id: invoiceId, definition_id, value }));

    if (valueRows.length > 0) {
      const { error: valuesErr } = await supabase.from("invoice_custom_field_values").insert(valueRows);
      if (valuesErr) {
        await supabase.from("invoices").delete().eq("id", invoiceId);
        return NextResponse.json({ error: `Valeurs champs personnalisés: ${valuesErr.message}` }, { status: 500 });
      }
    }
  }

  // 5. Tag par défaut "À vérifier".
  const { data: defaultTag } = await supabase
    .from("tags")
    .select("id")
    .eq("org_id", ctx.orgId)
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
        detected_value: iss.delta ?? null,
        expected_range_min: iss.expected ?? null,
        expected_range_max: iss.actual ?? null,
      })),
    );
    // Taguer "Anomalie" si erreur bloquante
    if (idpIssues.some((i) => i.severity === "error")) {
      const { data: anomalyTag } = await supabase.from("tags").select("id").eq("org_id", ctx.orgId).eq("label", "Anomalie").maybeSingle();
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
    const { data: anomalyTag } = await supabase.from("tags").select("id").eq("org_id", ctx.orgId).eq("label", "Anomalie").maybeSingle();
    if (anomalyTag) {
      await supabase.from("invoice_tags").insert({ invoice_id: invoiceId, tag_id: anomalyTag.id });
    }
  }

  // 6. Anomalies "portefeuille" (coût kWh vs médiane catégorie/année, pic de
  // consommation saisonnier vs historique du site, conso manquante) — recalculées
  // sur TOUTE l'org à chaque facture ajoutée, pas seulement estimées sur celle-ci :
  // une nouvelle facture change aussi le contexte (médiane, historique) des autres.
  const { computed: portfolioAnomalies } = await recomputeAndPersistAnomalies(supabase, ctx.orgId);
  const thisInvoiceAnomalies = portfolioAnomalies.filter((a) => a.invoiceId === invoiceId);
  if (thisInvoiceAnomalies.some((a) => a.severity === "high")) {
    await supabase.from("invoices").update({ status: "anomaly_flagged" }).eq("id", invoiceId);
    const { data: anomalyTag } = await supabase
      .from("tags")
      .select("id")
      .eq("org_id", ctx.orgId)
      .eq("label", "Anomalie")
      .maybeSingle();
    if (anomalyTag) {
      await supabase.from("invoice_tags").insert({ invoice_id: invoiceId, tag_id: anomalyTag.id });
    }
  }

  return NextResponse.json({ invoice_id: invoiceId });
}

export async function GET(request: Request) {
  const ctx = await getUserContext();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const communeId = searchParams.get("commune_id");
  const categorie = searchParams.get("categorie");
  const siteId = searchParams.get("site_id");

  let query = supabase
    .from("invoices")
    .select(
      "*, sites(nom, categorie, commune_id), communes(nom), invoice_tags(tags(id, label, color))",
    )
    .eq("org_id", ctx.orgId)
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
