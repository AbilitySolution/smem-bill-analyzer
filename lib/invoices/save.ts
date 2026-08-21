import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { invoiceExtractionSchema, type InvoiceExtraction } from "@/lib/anthropic/invoice-schema";
import { validateInvoice, normalizePosteTarifaire } from "@/lib/anthropic/invoice-validation";
import { recomputeAndPersistAnomalies } from "@/lib/anomalies/persist";
import { diffExtraction } from "@/lib/extraction/diff";
import type { InvoiceStatus } from "@/lib/types/database";

/**
 * Enregistrement d'une facture extraite : site, client, contrat, en-tête, lignes,
 * corrections, champs personnalisés, tags, anomalies.
 *
 * Extrait de `app/api/invoices/route.ts` pour être appelable hors contexte HTTP.
 * L'import en lot enregistre des dizaines de factures d'affilée et a besoin de deux
 * choses que la route ne permettait pas :
 *   - écrire un autre statut que `reviewed` (les factures d'un lot arrivent en
 *     `pending_review`, personne ne les a encore relues) ;
 *   - **sauter le recalcul d'anomalies portefeuille**, qui balaie TOUTE l'organisation.
 *     Le laisser à chaque facture rendrait un import de 200 factures quadratique ;
 *     l'appelant le déclenche une seule fois à la fin du lot.
 *
 * Type de client volontairement générique (comme `lib/anomalies/persist.ts`) : la
 * fonction doit marcher avec le client RLS d'une requête comme avec le service-role
 * d'un cron.
 */
type AnySupabaseClient = SupabaseClient;

export const customFieldEntrySchema = z.object({
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

export const saveRequestSchema = z.object({
  extraction: invoiceExtractionSchema,
  /**
   * Extraction brute de l'IA, avant corrections humaines. Optionnelle (rétro-compat), mais
   * c'est elle qui permet de journaliser les corrections de revue initiale — la vérité
   * terrain sur la précision réelle du modèle.
   */
  original_extraction: invoiceExtractionSchema.optional(),
  /**
   * Empreinte de l'extracteur ayant produit `original_extraction`, reportée telle quelle
   * en base. Absente = provenance inconnue, et la colonne reste NULL : y mettre la version
   * courante serait une affirmation fausse sur une extraction produite ailleurs, peut-être
   * des mois plus tôt.
   */
  extractor_version: z.string().optional(),
  file_path: z.string(),
  site_id: z.string().uuid().optional(),
  commune_id: z.string().uuid().optional(),
  new_site_categorie: z.enum(["batiment", "eclairage_public"]).optional(),
  override_comment: z.string().min(1).optional(),
  override_flag_anomaly: z.boolean().optional(),
  custom_fields: z.array(customFieldEntrySchema).optional().default([]),
});

export type SaveInvoicePayload = z.infer<typeof saveRequestSchema>;

export interface SaveInvoiceContext {
  orgId: string;
  userId: string;
}

export interface SaveInvoiceOptions {
  /** Statut d'arrivée. Défaut `reviewed` — le comportement de l'import unitaire. */
  status?: InvoiceStatus;
  /** Laisser l'appelant déclencher `recomputeAndPersistAnomalies` lui-même (import en lot). */
  skipPortfolioRecompute?: boolean;
  /** Valeur écrite dans `corrections_log.source`. */
  correctionSource?: string;
  /** Facture créée sans relecture humaine par la file de traitement. */
  autoSaved?: boolean;
  /**
   * Motif d'incertitude à signaler APRÈS enregistrement (commune ou extraction sous le
   * seuil de confiance de l'enregistrement automatique) — au lieu de bloquer la facture
   * hors base tant que personne ne l'a relue à la main. Se traduit par une anomalie de
   * sévérité `medium` + le tag "Anomalie", visibles comme n'importe quelle autre
   * facture à contrôler. Le seuil lui-même reste décidé par l'appelant
   * (`app/api/document-jobs/auto-save/route.ts`) — cette fonction ne fait qu'exécuter
   * le signalement demandé.
   */
  lowConfidenceReason?: string;
}

export type SaveInvoiceResult =
  | { ok: true; invoiceId: string }
  /** `existingInvoiceId` n'est renseigné que sur un 409 (facture déjà en base). */
  | { ok: false; status: number; error: string; existingInvoiceId?: string };

/** Pose un tag de l'org sur une facture. Silencieux si le tag n'existe pas. */
async function tagInvoice(
  supabase: AnySupabaseClient,
  orgId: string,
  invoiceId: string,
  label: string,
): Promise<void> {
  const { data: tag } = await supabase
    .from("tags").select("id").eq("org_id", orgId).eq("label", label).maybeSingle();
  if (tag) await supabase.from("invoice_tags").insert({ invoice_id: invoiceId, tag_id: tag.id });
}

/**
 * Passe en `anomaly_flagged` et tague les factures pour lesquelles le recalcul
 * portefeuille a produit une anomalie grave. Extrait de l'étape 6 pour que l'import
 * en lot puisse l'appliquer à tout un lot après un recalcul unique.
 */
export async function escalateHighAnomalies(
  supabase: AnySupabaseClient,
  orgId: string,
  invoiceIds: string[],
  computed: Array<{ invoiceId: string; severity: string }>,
): Promise<void> {
  const concerned = new Set(invoiceIds);
  const high = [...new Set(
    computed.filter((a) => a.severity === "high" && concerned.has(a.invoiceId)).map((a) => a.invoiceId),
  )];
  for (const id of high) {
    await supabase.from("invoices").update({ status: "anomaly_flagged" }).eq("id", id);
    await tagInvoice(supabase, orgId, id, "Anomalie");
  }
}

export async function saveInvoice(
  supabase: AnySupabaseClient,
  ctx: SaveInvoiceContext,
  payload: SaveInvoicePayload,
  opts: SaveInvoiceOptions = {},
): Promise<SaveInvoiceResult> {
  const {
    extraction, original_extraction, file_path, site_id, commune_id,
    new_site_categorie, override_comment, override_flag_anomaly, custom_fields,
  } = payload;

  if (!site_id && !commune_id) {
    return { ok: false, status: 400, error: "Commune non détectée — sélectionnez-la manuellement." };
  }

  // Resolve site: existing by id, or by PDL in commune, or auto-create
  let site: { id: string; commune_id: string; categorie: string };

  if (site_id) {
    const { data, error } = await supabase.from("sites").select("id, commune_id, categorie").eq("id", site_id).eq("org_id", ctx.orgId).single();
    if (error || !data) return { ok: false, status: 400, error: "Site introuvable." };
    site = data;
  } else {
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
        .insert({ org_id: ctx.orgId, commune_id: commune_id!, categorie, nom })
        .select("id, commune_id, categorie").single();
      if (siteErr || !newSite) return { ok: false, status: 500, error: `Création site: ${siteErr?.message}` };
      site = newSite;
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

    if (clientError) return { ok: false, status: 500, error: `Client: ${clientError.message}` };
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
        tarif_type: extraction.contract.tarif_type ?? null,
        client_id: clientId,
        site_id: site.id,
        created_by: ctx.userId,
      })
      .select("id")
      .single();

    if (contractError) return { ok: false, status: 500, error: `Contrat: ${contractError.message}` };
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
    return {
      ok: false,
      status: 409,
      error: `Facture ${extraction.invoice.facture_number} déjà enregistrée.`,
      existingInvoiceId: existingInvoice.id as string,
    };
  }

  const isOverride = !!override_comment;
  // Un override signalé comme anomalie l'emporte sur le statut demandé : c'est une
  // décision explicite de l'utilisateur, pas un défaut.
  const initialStatus: InvoiceStatus = isOverride && override_flag_anomaly
    ? "anomaly_flagged"
    : (opts.status ?? "reviewed");

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
      auto_saved: opts.autoSaved ?? false,
      extractor_version: payload.extractor_version ?? null,
      created_by: ctx.userId,
      raw_ocr_json: isOverride
        ? { ...extraction, _override: { comment: override_comment, flag_anomaly: override_flag_anomaly } }
        : extraction,
      precision: precisionToStore,
    })
    .select("id")
    .single();

  if (invoiceError) return { ok: false, status: 500, error: `Facture: ${invoiceError.message}` };

  const invoiceId = invoice.id as string;

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
    return { ok: false, status: 500, error: `Détails facture: ${childError.message}` };
  }

  // 4.2. Journaliser les corrections faites pendant la revue initiale (avant enregistrement).
  // C'est la vérité terrain qui alimente les métriques de précision d'extraction : sans ça,
  // seules les ré-éditions post-enregistrement seraient mesurées — échantillon biaisé.
  // Non bloquant : un échec ici ne doit pas faire perdre la facture à l'utilisateur.
  if (original_extraction) {
    const corrections = diffExtraction(original_extraction, extraction);
    if (corrections.length > 0) {
      const { error: logError } = await supabase.from("corrections_log").insert(
        corrections.map((c) => ({
          invoice_id: invoiceId,
          table_name: c.table_name,
          field_name: c.field_name,
          old_value: c.old_value,
          new_value: c.new_value,
          corrected_by: ctx.userId,
          source: opts.correctionSource ?? "initial_review",
        })),
      );
      if (logError) {
        console.error("[invoices] journalisation des corrections de revue échouée", {
          invoiceId, orgId: ctx.orgId, count: corrections.length, error: logError.message,
        });
      }
    }
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
          // org_id et created_by sont tous deux exigés par la policy RLS
          // "org_create_custom_field_definitions".
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
        return { ok: false, status: 500, error: `Champ personnalisé: ${defErr.message}` };
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
        return { ok: false, status: 500, error: `Valeurs champs personnalisés: ${valuesErr.message}` };
      }
    }
  }

  // 5. Tag par défaut "À vérifier".
  await tagInvoice(supabase, ctx.orgId, invoiceId, "À vérifier");

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
      await tagInvoice(supabase, ctx.orgId, invoiceId, "Anomalie");
    }
  }

  // 5c. Confiance basse à l'enregistrement automatique — signalée après coup plutôt que
  // bloquée : la facture reste enregistrée, juste marquée à vérifier en priorité.
  if (opts.lowConfidenceReason) {
    await supabase.from("anomalies").insert({
      invoice_id: invoiceId,
      contract_id: contractId,
      type: "low_confidence_auto_save",
      severity: "medium",
      description: opts.lowConfidenceReason,
    });
    await tagInvoice(supabase, ctx.orgId, invoiceId, "Anomalie");
  }

  // 5d. Override validation — créer anomalie manuelle si l'utilisateur a choisi de détecter.
  if (isOverride && override_flag_anomaly) {
    await supabase.from("anomalies").insert({
      invoice_id: invoiceId,
      contract_id: contractId,
      type: "validation_override",
      severity: "medium",
      description: `Validation ignorée manuellement. Justification : ${override_comment}`,
    });
    await tagInvoice(supabase, ctx.orgId, invoiceId, "Anomalie");
  }

  // 6. Anomalies "portefeuille" (coût kWh vs médiane catégorie/année, pic de
  // consommation saisonnier vs historique du site, conso manquante) — recalculées
  // sur TOUTE l'org à chaque facture ajoutée, pas seulement estimées sur celle-ci :
  // une nouvelle facture change aussi le contexte (médiane, historique) des autres.
  // L'import en lot saute cette étape et la déclenche une seule fois pour tout le lot.
  if (!opts.skipPortfolioRecompute) {
    const { computed } = await recomputeAndPersistAnomalies(supabase, ctx.orgId);
    await escalateHighAnomalies(supabase, ctx.orgId, [invoiceId], computed);
  }

  return { ok: true, invoiceId };
}

export type { InvoiceExtraction };
