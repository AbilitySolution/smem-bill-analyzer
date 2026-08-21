"use client";

import { useState } from "react";
import { Loader2, AlertCircle, Save, CheckCircle2 } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

interface Commune { id: string; nom: string }

type CustomFieldSection = "localisation" | "invoice" | "client" | "contract";
type CustomFieldType = "text" | "number" | "date";
type CustomFieldDef = { id: string; section: CustomFieldSection; label: string; field_type: CustomFieldType };
type CustomFieldValue = { definition_id: string; value: string };
type CustomFieldEntry = {
  key: string;
  section: CustomFieldSection;
  definition_id: string | null;
  new_label: string | null;
  new_field_type: CustomFieldType;
  value: string;
};

type ConsumptionRow = {
  poste_tarifaire: string;
  period_start: string | null;
  period_end: string | null;
  numero_compteur: string | null;
  ancien_index: number | null;
  nouveau_index: number | null;
  coefficient: number;
  consommation_kwh: number;
  prix_unitaire_ckwh: number | null;
  montant_eur: number;
  index_estime: boolean;
};

type ChargeRow = {
  category: "fixed" | "tax";
  libelle: string;
  period_start: string | null;
  period_end: string | null;
  assiette: number | null;
  taux: string | null;
  taux_numeric: number | null;
  taux_unit: string | null;
  tarif_kva_an: number | null;
  montant_eur: number;
};

export interface InvoiceEditData {
  invoiceId: string;
  communeId: string;
  categorie: "batiment" | "eclairage_public";
  clientId: string;
  contractId: string;
  override?: { comment: string; flag_anomaly: boolean };
  tags?: { id: string; label: string; color: string }[];
  invoice: {
    facture_number: string;
    facture_date: string;
    date_limite_paiement: string | null;
    total_ht: number;
    tva: number | null;
    autres_taxes: number | null;
    total_ttc: number;
    is_duplicata: boolean;
  };
  client: {
    nom: string;
    reference_client: string | null;
    reference_compte: string | null;
    adresse: string | null;
  };
  contract: {
    contract_number: string;
    tarif_type: string | null;
    espace_livraison: string | null;
    offre: string | null;
    service: string | null;
    puissance_souscrite_kva: number | null;
    reglage_protection_a: number | null;
    type_compteur: string | null;
    numero_compteur: string | null;
  };
  consumption: ConsumptionRow[];
  charges: ChargeRow[];
  communes: Commune[];
  customFieldDefs: CustomFieldDef[];
  customFieldValues: CustomFieldValue[];
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-[11px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">{label}</label>
      {children}
    </div>
  );
}

const inputCls =
  "rounded-lg border border-[var(--kn-border)] bg-[var(--kn-panel)] px-2 py-1 text-[13px] text-[var(--kn-text)] outline-none focus:border-[#f97316] transition-colors";

function CustomFieldsBlock({
  section, defs, entries, onChange,
}: {
  section: CustomFieldSection;
  defs: CustomFieldDef[];
  entries: CustomFieldEntry[];
  onChange: (next: CustomFieldEntry[]) => void;
}) {
  const sectionDefs = defs.filter((d) => d.section === section);
  const usedIds = new Set(entries.filter((e) => e.definition_id).map((e) => e.definition_id));
  const available = sectionDefs.filter((d) => !usedIds.has(d.id));

  function addExisting(def: CustomFieldDef) {
    onChange([...entries, {
      key: crypto.randomUUID(), section, definition_id: def.id,
      new_label: null, new_field_type: def.field_type, value: "",
    }]);
  }
  function addNew() {
    onChange([...entries, {
      key: crypto.randomUUID(), section, definition_id: null,
      new_label: "", new_field_type: "text", value: "",
    }]);
  }

  return (
    <div className="col-span-2 mt-2 flex flex-col gap-2">
      {entries.map((e) => {
        const def = e.definition_id ? sectionDefs.find((d) => d.id === e.definition_id) : null;
        const fieldType = def?.field_type ?? e.new_field_type;
        const inputType = fieldType === "number" ? "number" : fieldType === "date" ? "date" : "text";
        const valueId = `${e.key}-value`;
        const removeLabel = `Retirer le champ ${def?.label || e.new_label || "personnalisé"}`;
        return (
          <div key={e.key} className="flex items-end gap-2">
            {def ? (
              <Field label={def.label} htmlFor={valueId}>
                <input
                  id={valueId}
                  className={inputCls}
                  type={inputType}
                  value={e.value}
                  onChange={(ev) => onChange(entries.map((x) => x.key === e.key ? { ...x, value: ev.target.value } : x))}
                />
              </Field>
            ) : (
              <>
                <Field label="Nom du champ" htmlFor={`${e.key}-label`}>
                  <input id={`${e.key}-label`} className={inputCls} value={e.new_label ?? ""}
                    onChange={(ev) => onChange(entries.map((x) => x.key === e.key ? { ...x, new_label: ev.target.value } : x))} />
                </Field>
                <Field label="Type">
                  <Select value={e.new_field_type} onValueChange={(v) => onChange(entries.map((x) => x.key === e.key ? { ...x, new_field_type: v as CustomFieldType } : x))}>
                    <SelectTrigger className="h-8 cursor-pointer text-[13px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text" className="cursor-pointer">Texte</SelectItem>
                      <SelectItem value="number" className="cursor-pointer">Nombre</SelectItem>
                      <SelectItem value="date" className="cursor-pointer">Date</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Valeur" htmlFor={valueId}>
                  <input id={valueId} className={inputCls} type={inputType} value={e.value}
                    onChange={(ev) => onChange(entries.map((x) => x.key === e.key ? { ...x, value: ev.target.value } : x))} />
                </Field>
              </>
            )}
            <button
              type="button"
              onClick={() => onChange(entries.filter((x) => x.key !== e.key))}
              aria-label={removeLabel}
              title={removeLabel}
              className="mb-0.5 flex h-8 shrink-0 cursor-pointer items-center rounded-lg px-2 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-50"
            >
              Retirer
            </button>
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={addNew}
          className="flex h-8 cursor-pointer items-center rounded-lg px-2 text-[12px] font-medium text-[#f97316] transition-colors hover:bg-orange-50"
        >
          + Ajouter un champ
        </button>
        {available.length > 0 && (
          <select
            aria-label="Réutiliser un champ personnalisé existant"
            className="h-8 cursor-pointer rounded-lg border border-[var(--kn-border)] bg-[var(--kn-panel)] px-2 text-[13px] text-[var(--kn-text)] outline-none focus:border-[#f97316]"
            onChange={(ev) => { const def = available.find((d) => d.id === ev.target.value); if (def) addExisting(def); }}
            value=""
          >
            <option value="" disabled>Réutiliser un champ existant…</option>
            {available.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <div className="mb-2 text-[11px] font-bold uppercase tracking-widest text-[var(--kn-text-muted)]">{title}</div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-3">
      {children}
    </div>
  );
}

export function InvoiceEditPanel({ data }: { data: InvoiceEditData }) {
  const [communeId, setCommuneId] = useState(data.communeId);
  const [categorie, setCategorie] = useState(data.categorie);
  const [inv, setInv] = useState(data.invoice);
  const [cli, setCli] = useState(data.client);
  const [con, setCon] = useState(data.contract);
  const [consumption, setConsumption] = useState<ConsumptionRow[]>(data.consumption);
  const [charges, setCharges] = useState<ChargeRow[]>(data.charges);
  const [customFieldEntries, setCustomFieldEntries] = useState<CustomFieldEntry[]>(() =>
    data.customFieldValues.map((v) => {
      const def = data.customFieldDefs.find((d) => d.id === v.definition_id);
      return {
        key: v.definition_id,
        section: def?.section ?? "invoice",
        definition_id: v.definition_id,
        new_label: null,
        new_field_type: def?.field_type ?? "text",
        value: v.value,
      };
    }),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const customFieldsPayload = customFieldEntries
        .filter((e) => e.value.trim().length > 0 && (e.definition_id || (e.new_label ?? "").trim().length > 0))
        .map((e) => e.definition_id
          ? { section: e.section, definition_id: e.definition_id, value: e.value.trim() }
          : { section: e.section, value: e.value.trim(), new_definition: { label: e.new_label!.trim(), field_type: e.new_field_type } },
        );
      const res = await fetch(`/api/invoices/${data.invoiceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commune_id: communeId,
          categorie,
          client_id: data.clientId,
          contract_id: data.contractId,
          invoice: inv,
          client: cli,
          contract: con,
          consumption_lines: consumption,
          charges,
          custom_fields: customFieldsPayload,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        setError(json.error ?? "Erreur mise à jour.");
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch {
      setError("Erreur réseau.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)]">
      {/* Header sticky */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--kn-border)] px-4 py-2.5">
        <span className="text-[13px] font-semibold text-[var(--kn-text)]">Données extraites</span>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="flex items-center gap-1 text-[12px] text-green-600">
              <CheckCircle2 className="size-3.5" /> Enregistré
            </span>
          )}
          {error && (
            <span className="flex items-center gap-1 text-[12px] text-red-600">
              <AlertCircle className="size-3.5 shrink-0" /> {error}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--kn-solid)] px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            Enregistrer
          </button>
        </div>
      </div>

      {/* Scrollable form */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">

        {/* Tags */}
        {data.tags && data.tags.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {data.tags.map((tag) => (
              <span
                key={tag.id}
                style={{ backgroundColor: tag.color + "22", color: tag.color, borderColor: tag.color + "55" }}
                className="rounded-full border px-2.5 py-0.5 text-[11px] font-semibold"
              >
                {tag.label}
              </span>
            ))}
          </div>
        )}

        {/* Override justification */}
        {data.override && (
          <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2.5 text-[12px]">
            <p className="mb-1 font-semibold text-orange-800">
              Validation ignorée manuellement —{" "}
              {data.override.flag_anomaly ? "détectée comme anomalie" : "acceptée sans détection"}
            </p>
            <p className="text-orange-700 whitespace-pre-wrap">{data.override.comment}</p>
          </div>
        )}

        {/* Localisation */}
        <SectionTitle title="Localisation" />
        <Card>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Commune *">
              <select
                value={communeId}
                onChange={(e) => setCommuneId(e.target.value)}
                className={inputCls}
              >
                <option value="">Choisir…</option>
                {data.communes.map((c) => (
                  <option key={c.id} value={c.id}>{c.nom}</option>
                ))}
              </select>
            </Field>
            <Field label="Catégorie">
              <select
                value={categorie}
                onChange={(e) => setCategorie(e.target.value as "batiment" | "eclairage_public")}
                className={inputCls}
              >
                <option value="batiment">Bâtiment</option>
                <option value="eclairage_public">Éclairage public</option>
              </select>
            </Field>
            <CustomFieldsBlock
              section="localisation"
              defs={data.customFieldDefs}
              entries={customFieldEntries.filter((e) => e.section === "localisation")}
              onChange={(next) => setCustomFieldEntries((all) => [...all.filter((e) => e.section !== "localisation"), ...next])}
            />
          </div>
        </Card>

        {/* Facture */}
        <SectionTitle title="En-tête de facture" />
        <Card>
          <div className="grid grid-cols-2 gap-3">
            <Field label="N° Facture">
              <input className={inputCls} value={inv.facture_number} onChange={(e) => setInv((v) => ({ ...v, facture_number: e.target.value }))} />
            </Field>
            <Field label="Date facture">
              <input className={inputCls} type="date" value={inv.facture_date} onChange={(e) => setInv((v) => ({ ...v, facture_date: e.target.value }))} />
            </Field>
            <Field label="Total HT (€)">
              <input className={inputCls} type="number" step="0.01" value={inv.total_ht} onChange={(e) => setInv((v) => ({ ...v, total_ht: parseFloat(e.target.value) || 0 }))} />
            </Field>
            <Field label="TVA (€)">
              <input className={inputCls} type="number" step="0.01" value={inv.tva ?? ""} onChange={(e) => setInv((v) => ({ ...v, tva: e.target.value ? parseFloat(e.target.value) : null }))} />
            </Field>
            <Field label="Autres taxes (€)">
              <input className={inputCls} type="number" step="0.01" value={inv.autres_taxes ?? ""} onChange={(e) => setInv((v) => ({ ...v, autres_taxes: e.target.value ? parseFloat(e.target.value) : null }))} />
            </Field>
            <Field label="Total TTC (€)">
              <input className={inputCls} type="number" step="0.01" value={inv.total_ttc} onChange={(e) => setInv((v) => ({ ...v, total_ttc: parseFloat(e.target.value) || 0 }))} />
            </Field>
            <Field label="Date limite paiement">
              <input className={inputCls} type="date" value={inv.date_limite_paiement ?? ""} onChange={(e) => setInv((v) => ({ ...v, date_limite_paiement: e.target.value || null }))} />
            </Field>
            <Field label="Duplicata">
              <div className="flex items-center gap-2 pt-1.5">
                <input type="checkbox" checked={inv.is_duplicata} onChange={(e) => setInv((v) => ({ ...v, is_duplicata: e.target.checked }))} className="size-4 accent-[#f97316]" />
                <span className="text-[13px] text-[var(--kn-text)]">Duplicata</span>
              </div>
            </Field>
            <CustomFieldsBlock
              section="invoice"
              defs={data.customFieldDefs}
              entries={customFieldEntries.filter((e) => e.section === "invoice")}
              onChange={(next) => setCustomFieldEntries((all) => [...all.filter((e) => e.section !== "invoice"), ...next])}
            />
          </div>
        </Card>

        {/* Client */}
        <SectionTitle title="Client" />
        <Card>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nom">
              <input className={inputCls} value={cli.nom} onChange={(e) => setCli((v) => ({ ...v, nom: e.target.value }))} />
            </Field>
            <Field label="Réf. client">
              <input className={inputCls} value={cli.reference_client ?? ""} onChange={(e) => setCli((v) => ({ ...v, reference_client: e.target.value || null }))} />
            </Field>
            <Field label="Réf. compte">
              <input className={inputCls} value={cli.reference_compte ?? ""} onChange={(e) => setCli((v) => ({ ...v, reference_compte: e.target.value || null }))} />
            </Field>
            <Field label="Adresse">
              <input className={inputCls} value={cli.adresse ?? ""} onChange={(e) => setCli((v) => ({ ...v, adresse: e.target.value || null }))} />
            </Field>
            <CustomFieldsBlock
              section="client"
              defs={data.customFieldDefs}
              entries={customFieldEntries.filter((e) => e.section === "client")}
              onChange={(next) => setCustomFieldEntries((all) => [...all.filter((e) => e.section !== "client"), ...next])}
            />
          </div>
        </Card>

        {/* Contrat */}
        <SectionTitle title="Contrat" />
        <Card>
          <div className="grid grid-cols-2 gap-3">
            <Field label="N° Contrat">
              <input className={inputCls} value={con.contract_number} onChange={(e) => setCon((v) => ({ ...v, contract_number: e.target.value }))} />
            </Field>
            <Field label="Type tarifaire">
              <select value={con.tarif_type ?? ""} onChange={(e) => setCon((v) => ({ ...v, tarif_type: e.target.value || null }))} className={inputCls}>
                <option value="">—</option>
                <option value="BASE">BASE</option>
                <option value="HPHC">HPHC</option>
                <option value="TEMPO">TEMPO</option>
                <option value="EJP">EJP</option>
              </select>
            </Field>
            <Field label="Puissance souscrite (kVA)">
              <input className={inputCls} type="number" step="0.5" value={con.puissance_souscrite_kva ?? ""} onChange={(e) => setCon((v) => ({ ...v, puissance_souscrite_kva: e.target.value ? parseFloat(e.target.value) : null }))} />
            </Field>
            <Field label="Espace de livraison">
              <input className={inputCls} value={con.espace_livraison ?? ""} onChange={(e) => setCon((v) => ({ ...v, espace_livraison: e.target.value || null }))} />
            </Field>
            <Field label="Offre">
              <input className={inputCls} value={con.offre ?? ""} onChange={(e) => setCon((v) => ({ ...v, offre: e.target.value || null }))} />
            </Field>
            <Field label="N° Compteur">
              <input className={inputCls} value={con.numero_compteur ?? ""} onChange={(e) => setCon((v) => ({ ...v, numero_compteur: e.target.value || null }))} />
            </Field>
            <Field label="Type compteur">
              <input className={inputCls} value={con.type_compteur ?? ""} onChange={(e) => setCon((v) => ({ ...v, type_compteur: e.target.value || null }))} />
            </Field>
            <CustomFieldsBlock
              section="contract"
              defs={data.customFieldDefs}
              entries={customFieldEntries.filter((e) => e.section === "contract")}
              onChange={(next) => setCustomFieldEntries((all) => [...all.filter((e) => e.section !== "contract"), ...next])}
            />
          </div>
        </Card>

        {/* Consommation */}
        {consumption.length > 0 && (
          <>
            <SectionTitle title={`Consommation (${consumption.length} ligne${consumption.length > 1 ? "s" : ""})`} />
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-[var(--kn-border)] text-left text-[var(--kn-text-muted)]">
                      <th className="pb-2 pr-2 font-semibold">Poste</th>
                      <th className="pb-2 pr-2 font-semibold">Début</th>
                      <th className="pb-2 pr-2 font-semibold">Fin</th>
                      <th className="pb-2 pr-2 font-semibold text-right">kWh</th>
                      <th className="pb-2 pr-2 font-semibold text-right">c€/kWh</th>
                      <th className="pb-2 font-semibold text-right">Montant €</th>
                    </tr>
                  </thead>
                  <tbody>
                    {consumption.map((row, i) => (
                      <tr key={i} className="border-b border-[var(--kn-border)] last:border-0">
                        <td className="py-1 pr-2">
                          <input className={`${inputCls} w-16`} value={row.poste_tarifaire}
                            onChange={(e) => setConsumption((arr) => arr.map((r, j) => j === i ? { ...r, poste_tarifaire: e.target.value } : r))} />
                        </td>
                        <td className="py-1 pr-2">
                          <input className={`${inputCls} w-28`} type="date" value={row.period_start ?? ""}
                            onChange={(e) => setConsumption((arr) => arr.map((r, j) => j === i ? { ...r, period_start: e.target.value || null } : r))} />
                        </td>
                        <td className="py-1 pr-2">
                          <input className={`${inputCls} w-28`} type="date" value={row.period_end ?? ""}
                            onChange={(e) => setConsumption((arr) => arr.map((r, j) => j === i ? { ...r, period_end: e.target.value || null } : r))} />
                        </td>
                        <td className="py-1 pr-2 text-right">
                          <input className={`${inputCls} w-20 text-right`} type="number" value={row.consommation_kwh}
                            onChange={(e) => setConsumption((arr) => arr.map((r, j) => j === i ? { ...r, consommation_kwh: parseFloat(e.target.value) || 0 } : r))} />
                        </td>
                        <td className="py-1 pr-2 text-right">
                          <input className={`${inputCls} w-20 text-right`} type="number" step="0.0001" value={row.prix_unitaire_ckwh ?? ""}
                            onChange={(e) => setConsumption((arr) => arr.map((r, j) => j === i ? { ...r, prix_unitaire_ckwh: e.target.value ? parseFloat(e.target.value) : null } : r))} />
                        </td>
                        <td className="py-1 text-right">
                          <input className={`${inputCls} w-20 text-right`} type="number" step="0.01" value={row.montant_eur}
                            onChange={(e) => setConsumption((arr) => arr.map((r, j) => j === i ? { ...r, montant_eur: parseFloat(e.target.value) || 0 } : r))} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}

        {/* Charges fixes */}
        {charges.filter((c) => c.category === "fixed").length > 0 && (
          <>
            <SectionTitle title={`Charges fixes (${charges.filter((c) => c.category === "fixed").length})`} />
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-[var(--kn-border)] text-left text-[var(--kn-text-muted)]">
                      <th className="pb-2 pr-2 font-semibold">Libellé</th>
                      <th className="pb-2 pr-2 font-semibold">Début</th>
                      <th className="pb-2 pr-2 font-semibold">Fin</th>
                      <th className="pb-2 font-semibold text-right">Montant €</th>
                    </tr>
                  </thead>
                  <tbody>
                    {charges.map((row, i) => row.category !== "fixed" ? null : (
                      <tr key={i} className="border-b border-[var(--kn-border)] last:border-0">
                        <td className="py-1 pr-2">
                          <input className={`${inputCls} w-full min-w-[140px]`} value={row.libelle}
                            onChange={(e) => setCharges((arr) => arr.map((r, j) => j === i ? { ...r, libelle: e.target.value } : r))} />
                        </td>
                        <td className="py-1 pr-2">
                          <input className={`${inputCls} w-28`} type="date" value={row.period_start ?? ""}
                            onChange={(e) => setCharges((arr) => arr.map((r, j) => j === i ? { ...r, period_start: e.target.value || null } : r))} />
                        </td>
                        <td className="py-1 pr-2">
                          <input className={`${inputCls} w-28`} type="date" value={row.period_end ?? ""}
                            onChange={(e) => setCharges((arr) => arr.map((r, j) => j === i ? { ...r, period_end: e.target.value || null } : r))} />
                        </td>
                        <td className="py-1 text-right">
                          <input className={`${inputCls} w-20 text-right`} type="number" step="0.01" value={row.montant_eur}
                            onChange={(e) => setCharges((arr) => arr.map((r, j) => j === i ? { ...r, montant_eur: parseFloat(e.target.value) || 0 } : r))} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}

        {/* Taxes */}
        {charges.filter((c) => c.category === "tax").length > 0 && (
          <>
            <SectionTitle title={`Taxes (${charges.filter((c) => c.category === "tax").length})`} />
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-[var(--kn-border)] text-left text-[var(--kn-text-muted)]">
                      <th className="pb-2 pr-2 font-semibold">Libellé</th>
                      <th className="pb-2 pr-2 font-semibold">Taux</th>
                      <th className="pb-2 font-semibold text-right">Montant €</th>
                    </tr>
                  </thead>
                  <tbody>
                    {charges.map((row, i) => row.category !== "tax" ? null : (
                      <tr key={i} className="border-b border-[var(--kn-border)] last:border-0">
                        <td className="py-1 pr-2">
                          <input className={`${inputCls} w-full min-w-[140px]`} value={row.libelle}
                            onChange={(e) => setCharges((arr) => arr.map((r, j) => j === i ? { ...r, libelle: e.target.value } : r))} />
                        </td>
                        <td className="py-1 pr-2 text-[var(--kn-text-muted)]">{row.taux ?? "—"}</td>
                        <td className="py-1 text-right">
                          <input className={`${inputCls} w-20 text-right`} type="number" step="0.01" value={row.montant_eur}
                            onChange={(e) => setCharges((arr) => arr.map((r, j) => j === i ? { ...r, montant_eur: parseFloat(e.target.value) || 0 } : r))} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}

        <div className="h-4" />
      </div>
    </div>
  );
}
