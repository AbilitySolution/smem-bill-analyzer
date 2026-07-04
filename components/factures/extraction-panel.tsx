"use client";

import { useState } from "react";
import { EditField, type FieldKind } from "./edit-field";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

const CAT_OPTS = [
  { value: "batiment", label: "Bâtiment" },
  { value: "eclairage_public", label: "Éclairage public" },
];
const TARIF_TYPE_OPTS = [
  { value: "BASE", label: "BASE" },
  { value: "HPHC", label: "HPHC" },
  { value: "TEMPO", label: "TEMPO" },
  { value: "EJP", label: "EJP" },
];

const CHARGE_OPTS = [
  { value: "fixed", label: "Part fixe" },
  { value: "tax", label: "Taxe" },
];
const TAUX_UNIT_OPTS = [
  { value: "eur_per_kwh", label: "€/kWh" },
  { value: "percent", label: "%" },
];

type Row = Record<string, string | number | boolean | null>;

export interface ExtractionData {
  invoice: Row & { id: string; precision: Record<string, number> | null };
  client: (Row & { id: string }) | null;
  contract: (Row & { id: string }) | null;
  site: (Row & { id: string }) | null;
  consumption: (Row & { id: string })[];
  charges: (Row & { id: string })[];
}

export function ExtractionPanel({ data }: { data: ExtractionData }) {
  const inv = data.invoice;
  const prec = inv.precision ?? {};
  const tabs = [
    { id: "facture", label: "Facture", count: 11 },
    { id: "client", label: "Client & contrat", count: 17 },
    { id: "conso", label: "Consommation", count: data.consumption.length },
    { id: "taxes", label: "Taxes & part fixe", count: data.charges.length },
  ] as const;
  const [tab, setTab] = useState<(typeof tabs)[number]["id"]>("facture");

  const f = (field: string, label: string, kind: FieldKind = "text", options?: { value: string; label: string }[]) => (
    <EditField key={field} invoiceId={inv.id} table="invoices" rowId={inv.id}
      field={field} label={label} value={inv[field] ?? null} kind={kind} options={options} precision={prec[field]} />
  );

  return (
    <div className="flex h-full flex-col rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)]">
      {/* Onglets */}
      <div className="flex shrink-0 items-center gap-4 overflow-x-auto border-b border-[var(--kn-border)] px-4 text-[13px]">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={cx("relative flex h-11 shrink-0 items-center gap-1.5 font-medium transition-colors", tab === t.id ? "text-[var(--kn-text)]" : "text-[var(--kn-text-muted)] hover:text-[var(--kn-text)]")}>
            {t.label}
            <span className={cx("flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px]", tab === t.id ? "bg-[#f97316] text-white" : "bg-[var(--kn-value-box)] text-[var(--kn-text-muted)]")}>{t.count}</span>
            {tab === t.id && <span className="absolute -bottom-px left-0 h-0.5 w-full bg-[#f97316]" />}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tab === "facture" && (
          <div>
            <div className="flex items-center justify-between px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">
              <span>Champ</span><span>Précision</span>
            </div>
            {f("facture_number", "N° de facture")}
            {f("facture_date", "Date de facture", "date")}
            {f("date_limite_paiement", "Échéance", "date")}
            {f("date_prochain_releve", "Prochain relevé", "date")}
            {f("date_prochaine_facture", "Prochaine facture", "date")}
            {f("total_ht", "Total HT", "number")}
            {f("tva", "TVA", "number")}
            {f("autres_taxes", "Autres taxes", "number")}
            {f("total_ttc", "Total TTC", "number")}
            {f("categorie", "Catégorie", "select", CAT_OPTS)}
            {f("is_duplicata", "Duplicata", "boolean")}
          </div>
        )}

        {tab === "client" && (
          <div className="space-y-3">
            <Section title="Client">
              {data.client ? <>
                <Edit invoiceId={inv.id} table="clients" row={data.client} field="nom" label="Nom" />
                <Edit invoiceId={inv.id} table="clients" row={data.client} field="reference_client" label="Réf. client" />
                <Edit invoiceId={inv.id} table="clients" row={data.client} field="reference_compte" label="Réf. compte" />
                <Edit invoiceId={inv.id} table="clients" row={data.client} field="adresse" label="Adresse" />
              </> : <Empty />}
            </Section>
            <Section title="Contrat">
              {data.contract ? <>
                <Edit invoiceId={inv.id} table="contracts" row={data.contract} field="contract_number" label="N° de contrat" />
                <Edit invoiceId={inv.id} table="contracts" row={data.contract} field="pdl" label="PDL (14 chiffres)" />
                <Edit invoiceId={inv.id} table="contracts" row={data.contract} field="tarif_type" label="Type tarifaire" kind="select" options={TARIF_TYPE_OPTS} />
                <Edit invoiceId={inv.id} table="contracts" row={data.contract} field="offre" label="Offre" />
                <Edit invoiceId={inv.id} table="contracts" row={data.contract} field="service" label="Service" />
                <Edit invoiceId={inv.id} table="contracts" row={data.contract} field="espace_livraison" label="Espace livraison" />
                <Edit invoiceId={inv.id} table="contracts" row={data.contract} field="puissance_souscrite_kva" label="Puissance (kVA)" kind="number" />
                <Edit invoiceId={inv.id} table="contracts" row={data.contract} field="reglage_protection_a" label="Protection (A)" kind="number" />
                <Edit invoiceId={inv.id} table="contracts" row={data.contract} field="type_compteur" label="Type compteur" />
                <Edit invoiceId={inv.id} table="contracts" row={data.contract} field="numero_compteur" label="N° compteur" />
              </> : <Empty />}
            </Section>
            <Section title="Site / point de livraison">
              {data.site ? <>
                <Edit invoiceId={inv.id} table="sites" row={data.site} field="nom" label="Nom du site" />
                <Edit invoiceId={inv.id} table="sites" row={data.site} field="pdl" label="PDL" />
                <Edit invoiceId={inv.id} table="sites" row={data.site} field="kva" label="kVA" kind="number" />
                <Edit invoiceId={inv.id} table="sites" row={data.site} field="ampere" label="Ampère" kind="number" />
                <Edit invoiceId={inv.id} table="sites" row={data.site} field="categorie" label="Catégorie" kind="select" options={CAT_OPTS} />
              </> : <Empty />}
            </Section>
          </div>
        )}

        {tab === "conso" && (
          <div className="space-y-2">
            {data.consumption.length === 0 && <Empty />}
            {data.consumption.map((l, i) => (
              <LineCard key={l.id} title={`Ligne ${i + 1}`}>
                <Edit invoiceId={inv.id} table="consumption_periods" row={l} field="poste_tarifaire" label="Poste tarifaire" compact />
                <Edit invoiceId={inv.id} table="consumption_periods" row={l} field="period_start" label="Début" kind="date" compact />
                <Edit invoiceId={inv.id} table="consumption_periods" row={l} field="period_end" label="Fin" kind="date" compact />
                <Edit invoiceId={inv.id} table="consumption_periods" row={l} field="numero_compteur" label="N° compteur" compact />
                <Edit invoiceId={inv.id} table="consumption_periods" row={l} field="ancien_index" label="Ancien index" kind="number" compact />
                <Edit invoiceId={inv.id} table="consumption_periods" row={l} field="nouveau_index" label="Nouvel index" kind="number" compact />
                <Edit invoiceId={inv.id} table="consumption_periods" row={l} field="consommation_kwh" label="Conso (kWh)" kind="number" compact />
                <Edit invoiceId={inv.id} table="consumption_periods" row={l} field="prix_unitaire_ckwh" label="Prix (c€/kWh)" kind="number" compact />
                <Edit invoiceId={inv.id} table="consumption_periods" row={l} field="montant_eur" label="Montant (€)" kind="number" compact />
                <Edit invoiceId={inv.id} table="consumption_periods" row={l} field="index_estime" label="Estimé" kind="boolean" compact />
              </LineCard>
            ))}
          </div>
        )}

        {tab === "taxes" && (
          <div className="space-y-2">
            {data.charges.length === 0 && <Empty />}
            {data.charges.map((c, i) => (
              <LineCard key={c.id} title={`${c.category === "fixed" ? "Part fixe" : "Taxe"} ${i + 1}`}>
                <Edit invoiceId={inv.id} table="invoice_charges" row={c} field="libelle" label="Libellé" compact />
                <Edit invoiceId={inv.id} table="invoice_charges" row={c} field="category" label="Type" kind="select" options={CHARGE_OPTS} compact />
                <Edit invoiceId={inv.id} table="invoice_charges" row={c} field="period_start" label="Début" kind="date" compact />
                <Edit invoiceId={inv.id} table="invoice_charges" row={c} field="period_end" label="Fin" kind="date" compact />
                <Edit invoiceId={inv.id} table="invoice_charges" row={c} field="assiette" label="Assiette" kind="number" compact />
                <Edit invoiceId={inv.id} table="invoice_charges" row={c} field="taux" label="Taux" compact />
                <Edit invoiceId={inv.id} table="invoice_charges" row={c} field="taux_unit" label="Unité taux" kind="select" options={TAUX_UNIT_OPTS} compact />
                <Edit invoiceId={inv.id} table="invoice_charges" row={c} field="tarif_kva_an" label="Tarif kVA/an" kind="number" compact />
                <Edit invoiceId={inv.id} table="invoice_charges" row={c} field="montant_eur" label="Montant (€)" kind="number" compact />
              </LineCard>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Edit({ invoiceId, table, row, field, label, kind = "text", options, compact }: {
  invoiceId: string; table: string; row: Row & { id: string }; field: string; label: string;
  kind?: FieldKind; options?: { value: string; label: string }[]; compact?: boolean;
}) {
  return <EditField invoiceId={invoiceId} table={table} rowId={row.id} field={field} label={label} value={row[field] ?? null} kind={kind} options={options} compact={compact} />;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--kn-border)]">
      <div className="border-b border-[var(--kn-border)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">{title}</div>
      <div className="p-1">{children}</div>
    </div>
  );
}

function LineCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--kn-border)]">
      <div className="border-b border-[var(--kn-border)] bg-[var(--kn-panel)] px-3 py-1.5 text-[12px] font-semibold text-[var(--kn-text)]">{title}</div>
      <div className="p-1">{children}</div>
    </div>
  );
}

function Empty() {
  return <p className="px-3 py-4 text-center text-[12px] text-[var(--kn-text-muted)]">Aucune donnée extraite.</p>;
}
