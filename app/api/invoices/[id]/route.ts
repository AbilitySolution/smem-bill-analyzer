import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";
import { z } from "zod";

const n = z.number().nullable();

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

const updateSchema = z.object({
  commune_id: z.string().uuid(),
  categorie: z.enum(["batiment", "eclairage_public"]),
  client_id: z.string().uuid(),
  contract_id: z.string().uuid(),
  invoice: z.object({
    facture_number: z.string(),
    facture_date: z.string(),
    date_limite_paiement: z.string().nullable(),
    total_ht: z.number(),
    tva: n,
    autres_taxes: n,
    total_ttc: z.number(),
    is_duplicata: z.boolean(),
  }),
  client: z.object({
    nom: z.string(),
    reference_client: z.string().nullable(),
    reference_compte: z.string().nullable(),
    adresse: z.string().nullable(),
  }),
  contract: z.object({
    contract_number: z.string(),
    pdl: z.string().nullable(),
    tarif_type: z.enum(["BASE", "HPHC", "TEMPO", "EJP"]).nullable(),
    espace_livraison: z.string().nullable(),
    offre: z.string().nullable(),
    service: z.string().nullable(),
    puissance_souscrite_kva: n,
    reglage_protection_a: n,
    type_compteur: z.string().nullable(),
    numero_compteur: z.string().nullable(),
  }),
  consumption_lines: z.array(z.object({
    poste_tarifaire: z.string(),
    period_start: z.string().nullable(),
    period_end: z.string().nullable(),
    numero_compteur: z.string().nullable(),
    ancien_index: n,
    nouveau_index: n,
    coefficient: z.number(),
    consommation_kwh: z.number(),
    prix_unitaire_ckwh: n,
    montant_eur: z.number(),
    index_estime: z.boolean(),
  })),
  charges: z.array(z.object({
    category: z.enum(["fixed", "tax"]),
    libelle: z.string(),
    period_start: z.string().nullable(),
    period_end: z.string().nullable(),
    assiette: n,
    taux: z.string().nullable(),
    taux_numeric: n,
    taux_unit: z.string().nullable(),
    tarif_kva_an: n,
    montant_eur: z.number(),
  })),
  custom_fields: z.array(customFieldEntrySchema).optional().default([]),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  // getUserContext plutôt que getUser seul : la création d'une définition de champ
  // personnalisé a besoin de l'org (colonne NOT NULL, et exigée par la policy RLS).
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Données invalides.", details: parsed.error.format() }, { status: 400 });
  }

  const { commune_id, categorie, client_id, contract_id, invoice, client, contract, consumption_lines, charges, custom_fields } = parsed.data;

  const { data: existing } = await supabase
    .from("invoices")
    .select("id, client_id, contract_id")
    .eq("id", id)
    .single();
  if (!existing) return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });

  // Prevent IDOR: reject if body references different client/contract than the one linked to this invoice.
  if (client_id !== existing.client_id || contract_id !== existing.contract_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [invUpd, cliUpd, conUpd] = await Promise.all([
    supabase.from("invoices").update({ ...invoice, commune_id, categorie, status: "reviewed" }).eq("id", id),
    supabase.from("clients").update(client).eq("id", client_id),
    supabase.from("contracts").update(contract).eq("id", contract_id),
  ]);

  const headerErr = invUpd.error ?? cliUpd.error ?? conUpd.error;
  if (headerErr) return NextResponse.json({ error: headerErr.message }, { status: 500 });

  await Promise.all([
    supabase.from("consumption_periods").delete().eq("invoice_id", id),
    supabase.from("invoice_charges").delete().eq("invoice_id", id),
  ]);

  const childInserts = await Promise.all([
    consumption_lines.length
      ? supabase.from("consumption_periods").insert(
          consumption_lines.map((l) => ({ ...l, invoice_id: id, contract_id })),
        )
      : Promise.resolve({ error: null }),
    charges.length
      ? supabase.from("invoice_charges").insert(
          charges.map((c) => ({ ...c, invoice_id: id })),
        )
      : Promise.resolve({ error: null }),
  ]);

  const childErr = childInserts.find((r) => r.error)?.error;
  if (childErr) return NextResponse.json({ error: childErr.message }, { status: 500 });

  // Résoudre/créer les définitions de champs personnalisés puis remplacer les valeurs (delete-puis-réinsère,
  // même convention que consumption_periods/invoice_charges ci-dessus).
  await supabase.from("invoice_custom_field_values").delete().eq("invoice_id", id);

  if (custom_fields.length > 0) {
    const resolvedIds = new Map<number, string>();

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
          // "org_create_custom_field_definitions" — en omettre un fait échouer
          // l'insert avec une violation de politique de sécurité.
          org_id: ctx.orgId,
          section: cf.section,
          label,
          field_type: cf.new_definition!.field_type,
          created_by: ctx.userId,
        })
        .select("id")
        .single();

      if (defErr) {
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
        return NextResponse.json({ error: `Champ personnalisé: ${defErr.message}` }, { status: 500 });
      }
      resolvedIds.set(i, inserted.id);
    }

    const byDefinition = new Map<string, string>();
    custom_fields.forEach((cf, i) => {
      const defId = resolvedIds.get(i);
      if (defId) byDefinition.set(defId, cf.value.trim());
    });

    const valueRows = Array.from(byDefinition.entries())
      .filter(([, value]) => value.length > 0)
      .map(([definition_id, value]) => ({ invoice_id: id, definition_id, value }));

    if (valueRows.length > 0) {
      const { error: valuesErr } = await supabase.from("invoice_custom_field_values").insert(valueRows);
      if (valuesErr) return NextResponse.json({ error: `Valeurs champs personnalisés: ${valuesErr.message}` }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}
