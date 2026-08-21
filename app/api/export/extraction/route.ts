import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserContextWithRole } from "@/lib/auth";
import { toCsv } from "@/lib/csv";

export async function GET() {
  // Revérification côté handler : le middleware n'est qu'un filet, il ne protège pas
  // d'un appel qui l'aurait contourné (rewrite, appel serveur à serveur).
  if (!(await getUserContextWithRole("org_supervisor"))) {
    return NextResponse.json({ error: "Non autorisé." }, { status: 403 });
  }

  const supabase = await createClient();

  const { data: invoices } = await supabase
    .from("invoices")
    .select(
      "id, facture_number, facture_date, categorie, communes(nom), sites(nom), contracts(contract_number)",
    );

  const invoiceMap = new Map(
    (invoices ?? []).map((inv) => {
      const i = inv as unknown as {
        id: string;
        facture_number: string;
        facture_date: string;
        categorie: string | null;
        communes: { nom: string } | null;
        sites: { nom: string } | null;
        contracts: { contract_number: string } | null;
      };
      return [i.id, i];
    }),
  );

  const { data: consumption } = await supabase
    .from("consumption_periods")
    .select(
      "invoice_id, poste_tarifaire, period_start, period_end, numero_compteur, ancien_index, nouveau_index, coefficient, consommation_kwh, prix_unitaire_ckwh, montant_eur, index_estime",
    );

  const { data: charges } = await supabase
    .from("invoice_charges")
    .select(
      "invoice_id, category, libelle, period_start, period_end, assiette, taux, taux_numeric, taux_unit, tarif_kva_an, montant_eur",
    );

  const header = [
    "commune",
    "site",
    "contrat",
    "facture_number",
    "facture_date",
    "categorie_facture",
    "type_ligne",
    "libelle_ou_poste",
    "periode_debut",
    "periode_fin",
    "numero_compteur",
    "ancien_index",
    "nouveau_index",
    "coefficient",
    "consommation_kwh",
    "prix_unitaire_ckwh",
    "assiette",
    "taux",
    "tarif_kva_an",
    "montant_eur",
    "estime",
  ];

  const rows: (string | number | null)[][] = [];

  for (const c of consumption ?? []) {
    const inv = invoiceMap.get(c.invoice_id);
    if (!inv) continue;
    rows.push([
      inv.communes?.nom ?? "",
      inv.sites?.nom ?? "",
      inv.contracts?.contract_number ?? "",
      inv.facture_number,
      inv.facture_date,
      inv.categorie,
      "consommation",
      c.poste_tarifaire,
      c.period_start,
      c.period_end,
      c.numero_compteur,
      c.ancien_index,
      c.nouveau_index,
      c.coefficient,
      c.consommation_kwh,
      c.prix_unitaire_ckwh,
      null,
      null,
      null,
      c.montant_eur,
      c.index_estime ? "oui" : "non",
    ]);
  }

  for (const c of charges ?? []) {
    const inv = invoiceMap.get(c.invoice_id);
    if (!inv) continue;
    rows.push([
      inv.communes?.nom ?? "",
      inv.sites?.nom ?? "",
      inv.contracts?.contract_number ?? "",
      inv.facture_number,
      inv.facture_date,
      inv.categorie,
      c.category === "fixed" ? "part_fixe" : "taxe",
      c.libelle,
      c.period_start,
      c.period_end,
      null,
      null,
      null,
      null,
      null,
      null,
      c.assiette,
      c.taux,
      c.tarif_kva_an,
      c.montant_eur,
      "",
    ]);
  }

  const csv = "﻿" + toCsv([header, ...rows]);

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="extraction-ocr-${Date.now()}.csv"`,
    },
  });
}
