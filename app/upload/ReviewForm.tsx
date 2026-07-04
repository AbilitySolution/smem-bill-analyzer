"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";

type Section = keyof Pick<InvoiceExtraction, "consumption_periods" | "charges">;

const inputClass =
  "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-[#1E40AF] focus:outline-none focus:ring-2 focus:ring-[#1E40AF]/30";
const labelClass = "mb-1 block text-xs font-medium text-slate-600";

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string | number | null;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className={labelClass}>{label}</label>
      <input
        type={type}
        className={inputClass}
        value={value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export default function ReviewForm({
  initialExtraction,
  filePath,
}: {
  initialExtraction: InvoiceExtraction;
  filePath: string;
}) {
  const router = useRouter();
  const [extraction, setExtraction] = useState<InvoiceExtraction>(initialExtraction);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateTopLevel<K extends "client" | "contract" | "invoice">(
    section: K,
    field: string,
    value: string,
  ) {
    setExtraction((prev) => ({
      ...prev,
      [section]: { ...prev[section], [field]: castValue(prev[section], field, value) },
    }));
  }

  function castValue(obj: Record<string, unknown>, field: string, value: string) {
    const current = obj[field];
    if (typeof current === "number") return value === "" ? null : Number(value);
    if (typeof current === "boolean") return value === "true";
    return value === "" ? null : value;
  }

  function updateRow(section: Section, index: number, field: string, value: string) {
    setExtraction((prev) => {
      const rows = [...prev[section]] as Record<string, unknown>[];
      const current = rows[index][field];
      const cast =
        typeof current === "number"
          ? value === "" ? null : Number(value)
          : typeof current === "boolean"
            ? value === "true"
            : value === "" ? null : value;
      rows[index] = { ...rows[index], [field]: cast };
      return { ...prev, [section]: rows };
    });
  }

  function removeRow(section: Section, index: number) {
    setExtraction((prev) => {
      const rows = [...prev[section]];
      rows.splice(index, 1);
      return { ...prev, [section]: rows };
    });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extraction, file_path: filePath }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Erreur lors de l'enregistrement.");
        return;
      }
      router.push(`/invoices/${json.invoice_id}`);
    } catch {
      setError("Erreur réseau lors de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="mb-4 text-sm font-semibold text-[#1E3A8A]">Client</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nom" value={extraction.client.nom} onChange={(v) => updateTopLevel("client", "nom", v)} />
          <Field
            label="Référence client"
            value={extraction.client.reference_client}
            onChange={(v) => updateTopLevel("client", "reference_client", v)}
          />
          <Field
            label="Référence compte"
            value={extraction.client.reference_compte}
            onChange={(v) => updateTopLevel("client", "reference_compte", v)}
          />
          <Field
            label="Adresse"
            value={extraction.client.adresse}
            onChange={(v) => updateTopLevel("client", "adresse", v)}
          />
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="mb-4 text-sm font-semibold text-[#1E3A8A]">Contrat</h2>
        <div className="grid grid-cols-3 gap-3">
          <Field
            label="N° contrat"
            value={extraction.contract.contract_number}
            onChange={(v) => updateTopLevel("contract", "contract_number", v)}
          />
          <Field
            label="Espace de livraison"
            value={extraction.contract.espace_livraison}
            onChange={(v) => updateTopLevel("contract", "espace_livraison", v)}
          />
          <Field label="Offre" value={extraction.contract.offre} onChange={(v) => updateTopLevel("contract", "offre", v)} />
          <Field label="Service" value={extraction.contract.service} onChange={(v) => updateTopLevel("contract", "service", v)} />
          <Field
            label="Puissance souscrite (kVA)"
            type="number"
            value={extraction.contract.puissance_souscrite_kva}
            onChange={(v) => updateTopLevel("contract", "puissance_souscrite_kva", v)}
          />
          <Field
            label="Réglage protection (A)"
            type="number"
            value={extraction.contract.reglage_protection_a}
            onChange={(v) => updateTopLevel("contract", "reglage_protection_a", v)}
          />
          <Field
            label="Type compteur"
            value={extraction.contract.type_compteur}
            onChange={(v) => updateTopLevel("contract", "type_compteur", v)}
          />
          <Field
            label="N° compteur"
            value={extraction.contract.numero_compteur}
            onChange={(v) => updateTopLevel("contract", "numero_compteur", v)}
          />
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="mb-4 text-sm font-semibold text-[#1E3A8A]">Facture</h2>
        <div className="grid grid-cols-3 gap-3">
          <Field
            label="N° facture"
            value={extraction.invoice.facture_number}
            onChange={(v) => updateTopLevel("invoice", "facture_number", v)}
          />
          <Field
            label="Date facture"
            type="date"
            value={extraction.invoice.facture_date}
            onChange={(v) => updateTopLevel("invoice", "facture_date", v)}
          />
          <Field
            label="Date limite paiement"
            type="date"
            value={extraction.invoice.date_limite_paiement}
            onChange={(v) => updateTopLevel("invoice", "date_limite_paiement", v)}
          />
          <Field
            label="Total HT (€)"
            type="number"
            value={extraction.invoice.total_ht}
            onChange={(v) => updateTopLevel("invoice", "total_ht", v)}
          />
          <Field label="TVA (€)" type="number" value={extraction.invoice.tva} onChange={(v) => updateTopLevel("invoice", "tva", v)} />
          <Field
            label="Autres taxes (€)"
            type="number"
            value={extraction.invoice.autres_taxes}
            onChange={(v) => updateTopLevel("invoice", "autres_taxes", v)}
          />
          <Field
            label="Total TTC (€)"
            type="number"
            value={extraction.invoice.total_ttc}
            onChange={(v) => updateTopLevel("invoice", "total_ttc", v)}
          />
        </div>
      </section>

      <RowTable
        title="Périodes de consommation facturées (fact table analytics)"
        section="consumption_periods"
        columns={[
          "poste_tarifaire",
          "period_start",
          "period_end",
          "ancien_index",
          "nouveau_index",
          "coefficient",
          "consommation_kwh",
          "prix_unitaire_ckwh",
          "montant_eur",
          "index_estime",
        ]}
        rows={extraction.consumption_periods}
        onUpdate={updateRow}
        onRemove={removeRow}
      />

      <RowTable
        title="Charges (part fixe + taxes)"
        section="charges"
        columns={["category", "libelle", "period_start", "period_end", "assiette", "taux", "montant_eur"]}
        rows={extraction.charges}
        onUpdate={updateRow}
        onRemove={removeRow}
      />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="cursor-pointer rounded-md bg-[#F59E0B] px-5 py-2.5 text-sm font-medium text-white transition-colors duration-200 hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Enregistrement..." : "Valider et enregistrer"}
        </button>
      </div>
    </div>
  );
}

function RowTable({
  title,
  section,
  columns,
  rows,
  onUpdate,
  onRemove,
}: {
  title: string;
  section: Section;
  columns: string[];
  rows: Record<string, unknown>[];
  onUpdate: (section: Section, index: number, field: string, value: string) => void;
  onRemove: (section: Section, index: number) => void;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[#1E3A8A]">{title}</h2>
        <span className="text-xs text-slate-500">{rows.length} ligne(s)</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">Aucune donnée extraite.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                {columns.map((col) => (
                  <th key={col} className="whitespace-nowrap px-2 py-2 font-medium">
                    {col}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={idx} className="border-b border-slate-100">
                  {columns.map((col) => (
                    <td key={col} className="px-2 py-1.5">
                      {typeof row[col] === "boolean" ? (
                        <input
                          type="checkbox"
                          checked={row[col] as boolean}
                          onChange={(e) => onUpdate(section, idx, col, String(e.target.checked))}
                          className="h-4 w-4 cursor-pointer accent-[#1E40AF]"
                        />
                      ) : (
                        <input
                          className={`${inputClass} min-w-[7rem]`}
                          value={row[col] === null || row[col] === undefined ? "" : String(row[col])}
                          onChange={(e) => onUpdate(section, idx, col, e.target.value)}
                        />
                      )}
                    </td>
                  ))}
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => onRemove(section, idx)}
                      className="cursor-pointer text-xs text-red-600 hover:underline"
                      aria-label={`Supprimer la ligne ${idx + 1}`}
                    >
                      Supprimer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
