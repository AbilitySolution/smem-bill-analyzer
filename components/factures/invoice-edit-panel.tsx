"use client";

import { useState } from "react";
import { Loader2, AlertCircle, Save, CheckCircle2 } from "lucide-react";

interface Commune { id: string; nom: string }

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
    pdl: string | null;
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
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">{label}</label>
      {children}
    </div>
  );
}

const inputCls =
  "rounded-lg border border-[var(--kn-border)] bg-[var(--kn-panel)] px-2 py-1 text-[13px] text-[var(--kn-text)] outline-none focus:border-[#f97316] transition-colors";

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
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
          </div>
        </Card>

        {/* Contrat */}
        <SectionTitle title="Contrat" />
        <Card>
          <div className="grid grid-cols-2 gap-3">
            <Field label="N° Contrat">
              <input className={inputCls} value={con.contract_number} onChange={(e) => setCon((v) => ({ ...v, contract_number: e.target.value }))} />
            </Field>
            <Field label="PDL (14 chiffres)">
              <input className={inputCls} value={con.pdl ?? ""} onChange={(e) => setCon((v) => ({ ...v, pdl: e.target.value || null }))} />
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
