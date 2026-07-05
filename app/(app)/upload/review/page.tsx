"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertCircle, Save } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

interface Commune { id: string; nom: string }

type ConsumptionLine = {
  poste_tarifaire: string; date_debut: string | null; date_fin: string | null;
  numero_compteur: string | null; ancien_index: number | null; nouveau_index: number | null;
  coefficient: number; consommation_kwh: number; prix_unitaire_ckwh: number | null;
  montant_eur: number; index_estime: boolean;
};
type FixedCharge = {
  libelle: string; date_debut: string | null; date_fin: string | null;
  tarif_kva_an: number | null; montant_eur: number;
};
type TaxItem = {
  libelle: string; date_debut: string | null; date_fin: string | null;
  assiette: number | null; taux: string | null; taux_numeric: number | null;
  taux_unit: string | null; montant_eur: number;
};

type Extraction = {
  client: { nom: string; reference_client: string | null; reference_compte: string | null; adresse: string | null };
  contract: {
    contract_number: string; pdl: string | null; tarif_type: string | null;
    espace_livraison: string | null; offre: string | null; service: string | null;
    puissance_souscrite_kva: number | null; reglage_protection_a: number | null;
    type_compteur: string | null; numero_compteur: string | null;
  };
  invoice: {
    facture_number: string; facture_date: string; date_limite_paiement: string | null;
    date_prochain_releve: string | null; date_prochaine_facture: string | null;
    total_ht: number; tva: number | null; autres_taxes: number | null; total_ttc: number;
    is_duplicata: boolean;
  };
  commune_hint: string | null;
  categorie_hint: string | null;
  fixed_charges: FixedCharge[];
  consumption_lines: ConsumptionLine[];
  taxes: TaxItem[];
  precision?: Record<string, number> | null;
};

type OcrResult = {
  extraction: Extraction;
  file_path: string;
  suggested_commune_id: string | null;
  suggested_site_id: string | null;
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">{label}</label>
      {children}
    </div>
  );
}

const inputCls = "rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-3 py-1.5 text-[13px] text-[var(--kn-text)] outline-none focus:border-[#f97316] transition-colors";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="mb-3 text-[11px] font-bold uppercase tracking-widest text-[var(--kn-text-muted)]">{title}</h2>
      <div className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
        {children}
      </div>
    </div>
  );
}

export default function ReviewPage() {
  const router = useRouter();
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  const [ext, setExt] = useState<Extraction | null>(null);
  const [communeId, setCommuneId] = useState("");
  const [categorie, setCategorie] = useState<"batiment" | "eclairage_public">("batiment");
  const [communes, setCommunes] = useState<Commune[]>([]);
  const [communesLoading, setCommunesLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem("upload_ocr_result");
    if (!raw) { router.replace("/upload"); return; }
    const result: OcrResult = JSON.parse(raw);
    setOcr(result);
    setExt(result.extraction);
    if (result.suggested_commune_id) setCommuneId(result.suggested_commune_id);
    setCategorie((result.extraction.categorie_hint as "batiment" | "eclairage_public") ?? "batiment");
    fetch("/api/communes")
      .then((r) => r.json())
      .then((j) => { setCommunes(j.communes ?? []); setCommunesLoading(false); })
      .catch(() => setCommunesLoading(false));
  }, [router]);

  async function handleSave() {
    if (!ext || !ocr) return;
    if (!communeId) { setError("Sélectionnez une commune."); return; }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        extraction: ext,
        file_path: ocr.file_path,
        commune_id: communeId,
        new_site_categorie: categorie,
      };
      if (ocr.suggested_site_id) body.site_id = ocr.suggested_site_id;
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || json.error) { setError(json.error ?? "Erreur enregistrement."); setSaving(false); return; }
      sessionStorage.removeItem("upload_ocr_result");
      router.push("/documents");
    } catch {
      setError("Erreur réseau.");
      setSaving(false);
    }
  }

  // Helpers for updating nested state
  function setClient(k: keyof Extraction["client"], v: string) {
    setExt((e) => e ? { ...e, client: { ...e.client, [k]: v || null } } : e);
  }
  function setContract(k: keyof Extraction["contract"], v: string | number | null) {
    setExt((e) => e ? { ...e, contract: { ...e.contract, [k]: v } } : e);
  }
  function setInvoice(k: keyof Extraction["invoice"], v: string | number | boolean | null) {
    setExt((e) => e ? { ...e, invoice: { ...e.invoice, [k]: v } } : e);
  }

  if (!ext) return null;

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Vérification de la facture</h1>
          <p className="mt-1 text-[13px] text-[var(--kn-text-muted)]">Vérifiez et corrigez les données extraites par l'OCR avant d'enregistrer.</p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex shrink-0 items-center gap-2 rounded-xl bg-[var(--kn-solid)] px-5 py-2.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Enregistrer
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="size-4 shrink-0" /> {error}
        </div>
      )}

      {/* Commune + Catégorie */}
      <Section title="Localisation">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Commune *">
            {communesLoading ? (
              <div className="flex h-8 items-center gap-2 text-[12px] text-[var(--kn-text-muted)]">
                <Loader2 className="size-3.5 animate-spin" /> Chargement…
              </div>
            ) : communes.length === 0 ? (
              <div className="flex h-8 items-center gap-1 text-[12px] text-red-600">
                <AlertCircle className="size-3.5 shrink-0" /> Aucune commune en base
              </div>
            ) : (
              <select
                value={communeId}
                onChange={(e) => setCommuneId(e.target.value)}
                className="h-8 w-full rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] text-[var(--kn-text)] outline-none focus:border-[#f97316]"
              >
                <option value="">Choisir une commune…</option>
                {communes.map((c) => (
                  <option key={c.id} value={c.id}>{c.nom}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Catégorie">
            <Select value={categorie} onValueChange={(v) => setCategorie(v as "batiment" | "eclairage_public")}>
              <SelectTrigger className="h-8 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="batiment">Bâtiment</SelectItem>
                <SelectItem value="eclairage_public">Éclairage public</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </Section>

      {/* Facture */}
      <Section title="En-tête de facture">
        <div className="grid grid-cols-2 gap-4">
          <Field label="N° Facture">
            <input className={inputCls} value={ext.invoice.facture_number} onChange={(e) => setInvoice("facture_number", e.target.value)} />
          </Field>
          <Field label="Date facture">
            <input className={inputCls} type="date" value={ext.invoice.facture_date} onChange={(e) => setInvoice("facture_date", e.target.value)} />
          </Field>
          <Field label="Total HT (€)">
            <input className={inputCls} type="number" step="0.01" value={ext.invoice.total_ht} onChange={(e) => setInvoice("total_ht", parseFloat(e.target.value))} />
          </Field>
          <Field label="TVA (€)">
            <input className={inputCls} type="number" step="0.01" value={ext.invoice.tva ?? ""} onChange={(e) => setInvoice("tva", e.target.value ? parseFloat(e.target.value) : null)} />
          </Field>
          <Field label="Autres taxes (€)">
            <input className={inputCls} type="number" step="0.01" value={ext.invoice.autres_taxes ?? ""} onChange={(e) => setInvoice("autres_taxes", e.target.value ? parseFloat(e.target.value) : null)} />
          </Field>
          <Field label="Total TTC (€)">
            <input className={inputCls} type="number" step="0.01" value={ext.invoice.total_ttc} onChange={(e) => setInvoice("total_ttc", parseFloat(e.target.value))} />
          </Field>
          <Field label="Date limite paiement">
            <input className={inputCls} type="date" value={ext.invoice.date_limite_paiement ?? ""} onChange={(e) => setInvoice("date_limite_paiement", e.target.value || null)} />
          </Field>
          <Field label="Duplicata">
            <div className="flex items-center gap-2 pt-1">
              <input type="checkbox" checked={ext.invoice.is_duplicata} onChange={(e) => setInvoice("is_duplicata", e.target.checked)} className="size-4 accent-[#f97316]" />
              <span className="text-[13px] text-[var(--kn-text)]">Cette facture est un duplicata</span>
            </div>
          </Field>
        </div>
      </Section>

      {/* Client */}
      <Section title="Client">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Nom">
            <input className={inputCls} value={ext.client.nom} onChange={(e) => setClient("nom", e.target.value)} />
          </Field>
          <Field label="Réf. client">
            <input className={inputCls} value={ext.client.reference_client ?? ""} onChange={(e) => setClient("reference_client", e.target.value)} />
          </Field>
          <Field label="Réf. compte">
            <input className={inputCls} value={ext.client.reference_compte ?? ""} onChange={(e) => setClient("reference_compte", e.target.value)} />
          </Field>
          <Field label="Adresse">
            <input className={inputCls} value={ext.client.adresse ?? ""} onChange={(e) => setClient("adresse", e.target.value)} />
          </Field>
        </div>
      </Section>

      {/* Contrat */}
      <Section title="Contrat">
        <div className="grid grid-cols-2 gap-4">
          <Field label="N° Contrat">
            <input className={inputCls} value={ext.contract.contract_number} onChange={(e) => setContract("contract_number", e.target.value)} />
          </Field>
          <Field label="PDL (14 chiffres)">
            <input className={inputCls} value={ext.contract.pdl ?? ""} onChange={(e) => setContract("pdl", e.target.value || null)} />
          </Field>
          <Field label="Type tarifaire">
            <Select value={ext.contract.tarif_type ?? ""} onValueChange={(v) => setContract("tarif_type", v || null)}>
              <SelectTrigger className="h-8 text-[13px]">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BASE">BASE</SelectItem>
                <SelectItem value="HPHC">HPHC</SelectItem>
                <SelectItem value="TEMPO">TEMPO</SelectItem>
                <SelectItem value="EJP">EJP</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Puissance souscrite (kVA)">
            <input className={inputCls} type="number" step="0.5" value={ext.contract.puissance_souscrite_kva ?? ""} onChange={(e) => setContract("puissance_souscrite_kva", e.target.value ? parseFloat(e.target.value) : null)} />
          </Field>
          <Field label="Espace de livraison">
            <input className={inputCls} value={ext.contract.espace_livraison ?? ""} onChange={(e) => setContract("espace_livraison", e.target.value || null)} />
          </Field>
          <Field label="Offre">
            <input className={inputCls} value={ext.contract.offre ?? ""} onChange={(e) => setContract("offre", e.target.value || null)} />
          </Field>
          <Field label="N° Compteur">
            <input className={inputCls} value={ext.contract.numero_compteur ?? ""} onChange={(e) => setContract("numero_compteur", e.target.value || null)} />
          </Field>
          <Field label="Type compteur">
            <input className={inputCls} value={ext.contract.type_compteur ?? ""} onChange={(e) => setContract("type_compteur", e.target.value || null)} />
          </Field>
        </div>
      </Section>

      {/* Consumption lines */}
      {ext.consumption_lines.length > 0 && (
        <Section title={`Consommation (${ext.consumption_lines.length} ligne${ext.consumption_lines.length > 1 ? "s" : ""})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-[var(--kn-border)] text-left text-[var(--kn-text-muted)]">
                  <th className="pb-2 pr-3 font-semibold">Poste</th>
                  <th className="pb-2 pr-3 font-semibold">Début</th>
                  <th className="pb-2 pr-3 font-semibold">Fin</th>
                  <th className="pb-2 pr-3 font-semibold text-right">Conso (kWh)</th>
                  <th className="pb-2 pr-3 font-semibold text-right">Prix (c€/kWh)</th>
                  <th className="pb-2 font-semibold text-right">Montant (€)</th>
                </tr>
              </thead>
              <tbody>
                {ext.consumption_lines.map((row, i) => (
                  <tr key={i} className="border-b border-[var(--kn-border)] last:border-0">
                    <td className="py-1.5 pr-3">
                      <input className={`${inputCls} w-20`} value={row.poste_tarifaire}
                        onChange={(e) => setExt((ex) => ex ? { ...ex, consumption_lines: ex.consumption_lines.map((r, j) => j === i ? { ...r, poste_tarifaire: e.target.value } : r) } : ex)} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input className={`${inputCls} w-28`} type="date" value={row.date_debut ?? ""}
                        onChange={(e) => setExt((ex) => ex ? { ...ex, consumption_lines: ex.consumption_lines.map((r, j) => j === i ? { ...r, date_debut: e.target.value || null } : r) } : ex)} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input className={`${inputCls} w-28`} type="date" value={row.date_fin ?? ""}
                        onChange={(e) => setExt((ex) => ex ? { ...ex, consumption_lines: ex.consumption_lines.map((r, j) => j === i ? { ...r, date_fin: e.target.value || null } : r) } : ex)} />
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      <input className={`${inputCls} w-24 text-right`} type="number" value={row.consommation_kwh}
                        onChange={(e) => setExt((ex) => ex ? { ...ex, consumption_lines: ex.consumption_lines.map((r, j) => j === i ? { ...r, consommation_kwh: parseFloat(e.target.value) || 0 } : r) } : ex)} />
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      <input className={`${inputCls} w-24 text-right`} type="number" step="0.0001" value={row.prix_unitaire_ckwh ?? ""}
                        onChange={(e) => setExt((ex) => ex ? { ...ex, consumption_lines: ex.consumption_lines.map((r, j) => j === i ? { ...r, prix_unitaire_ckwh: e.target.value ? parseFloat(e.target.value) : null } : r) } : ex)} />
                    </td>
                    <td className="py-1.5 text-right">
                      <input className={`${inputCls} w-24 text-right`} type="number" step="0.01" value={row.montant_eur}
                        onChange={(e) => setExt((ex) => ex ? { ...ex, consumption_lines: ex.consumption_lines.map((r, j) => j === i ? { ...r, montant_eur: parseFloat(e.target.value) || 0 } : r) } : ex)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Fixed charges */}
      {ext.fixed_charges.length > 0 && (
        <Section title={`Charges fixes (${ext.fixed_charges.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-[var(--kn-border)] text-left text-[var(--kn-text-muted)]">
                  <th className="pb-2 pr-3 font-semibold">Libellé</th>
                  <th className="pb-2 pr-3 font-semibold">Début</th>
                  <th className="pb-2 pr-3 font-semibold">Fin</th>
                  <th className="pb-2 font-semibold text-right">Montant (€)</th>
                </tr>
              </thead>
              <tbody>
                {ext.fixed_charges.map((row, i) => (
                  <tr key={i} className="border-b border-[var(--kn-border)] last:border-0">
                    <td className="py-1.5 pr-3">
                      <input className={`${inputCls} w-full min-w-[180px]`} value={row.libelle}
                        onChange={(e) => setExt((ex) => ex ? { ...ex, fixed_charges: ex.fixed_charges.map((r, j) => j === i ? { ...r, libelle: e.target.value } : r) } : ex)} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input className={`${inputCls} w-28`} type="date" value={row.date_debut ?? ""}
                        onChange={(e) => setExt((ex) => ex ? { ...ex, fixed_charges: ex.fixed_charges.map((r, j) => j === i ? { ...r, date_debut: e.target.value || null } : r) } : ex)} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input className={`${inputCls} w-28`} type="date" value={row.date_fin ?? ""}
                        onChange={(e) => setExt((ex) => ex ? { ...ex, fixed_charges: ex.fixed_charges.map((r, j) => j === i ? { ...r, date_fin: e.target.value || null } : r) } : ex)} />
                    </td>
                    <td className="py-1.5 text-right">
                      <input className={`${inputCls} w-24 text-right`} type="number" step="0.01" value={row.montant_eur}
                        onChange={(e) => setExt((ex) => ex ? { ...ex, fixed_charges: ex.fixed_charges.map((r, j) => j === i ? { ...r, montant_eur: parseFloat(e.target.value) || 0 } : r) } : ex)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Taxes */}
      {ext.taxes.length > 0 && (
        <Section title={`Taxes (${ext.taxes.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-[var(--kn-border)] text-left text-[var(--kn-text-muted)]">
                  <th className="pb-2 pr-3 font-semibold">Libellé</th>
                  <th className="pb-2 pr-3 font-semibold">Taux</th>
                  <th className="pb-2 font-semibold text-right">Montant (€)</th>
                </tr>
              </thead>
              <tbody>
                {ext.taxes.map((row, i) => (
                  <tr key={i} className="border-b border-[var(--kn-border)] last:border-0">
                    <td className="py-1.5 pr-3">
                      <input className={`${inputCls} w-full min-w-[180px]`} value={row.libelle}
                        onChange={(e) => setExt((ex) => ex ? { ...ex, taxes: ex.taxes.map((r, j) => j === i ? { ...r, libelle: e.target.value } : r) } : ex)} />
                    </td>
                    <td className="py-1.5 pr-3 text-[var(--kn-text-muted)]">{row.taux ?? "—"}</td>
                    <td className="py-1.5 text-right">
                      <input className={`${inputCls} w-24 text-right`} type="number" step="0.01" value={row.montant_eur}
                        onChange={(e) => setExt((ex) => ex ? { ...ex, taxes: ex.taxes.map((r, j) => j === i ? { ...r, montant_eur: parseFloat(e.target.value) || 0 } : r) } : ex)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Bottom save */}
      <div className="flex justify-end gap-3 pb-8">
        <button onClick={() => router.push("/upload")}
          className="rounded-xl border border-[var(--kn-border)] px-5 py-2.5 text-[13px] font-medium text-[var(--kn-text)] hover:bg-[var(--kn-active)]">
          Annuler
        </button>
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 rounded-xl bg-[var(--kn-solid)] px-5 py-2.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Enregistrer
        </button>
      </div>
    </div>
  );
}
