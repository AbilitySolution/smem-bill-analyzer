"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertCircle, Save, CheckCircle2, AlertTriangle } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { validateInvoice } from "@/lib/anthropic/invoice-validation";
import type { ValidationResult } from "@/lib/anthropic/invoice-validation";
import { createClient } from "@/lib/supabase/client";

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
    contract_number: string; tarif_type: string | null;
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
  validation?: ValidationResult;
};

type CustomFieldSection = "localisation" | "invoice" | "client" | "contract";
type CustomFieldType = "text" | "number" | "date";
type CustomFieldDef = { id: string; section: CustomFieldSection; label: string; field_type: CustomFieldType };
type CustomFieldEntry = {
  key: string;
  section: CustomFieldSection;
  definition_id: string | null;
  new_label: string | null;
  new_field_type: CustomFieldType;
  value: string;
};

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-[11px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">{label}</label>
      {children}
    </div>
  );
}

const inputCls = "rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-3 py-1.5 text-[13px] text-[var(--kn-text)] outline-none focus:border-[#f97316] transition-colors";

// Retourne une classe de bordure selon le score de confiance du champ
function confidenceBorder(score: number | undefined): string {
  if (score == null) return "";
  if (score < 0.6) return "border-red-400";
  if (score < 0.8) return "border-yellow-400";
  return "";
}

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
            className="h-8 cursor-pointer rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] text-[var(--kn-text)] outline-none focus:border-[#f97316]"
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

const FIELD_LABELS: Record<string, string> = {
  facture_number: "N° Facture",
  facture_date: "Date",
  total_ht: "HT",
  tva: "TVA",
  autres_taxes: "Autres taxes",
  total_ttc: "TTC",
  contract_number: "N° Contrat",
  puissance_souscrite_kva: "Puissance",
};

function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const cls =
    score >= 0.8
      ? "bg-green-100 text-green-700 border-green-200"
      : score >= 0.6
        ? "bg-yellow-100 text-yellow-700 border-yellow-200"
        : "bg-red-100 text-red-700 border-red-200";
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${cls}`}>
      {pct}%
    </span>
  );
}

function FieldConfidenceGrid({ fieldConfidence }: { fieldConfidence: Record<string, number> }) {
  const entries = Object.entries(FIELD_LABELS).map(([k, label]) => ({
    key: k,
    label,
    score: fieldConfidence[k] ?? null,
  }));
  return (
    <div className="mt-3 grid grid-cols-4 gap-1.5">
      {entries.map(({ key, label, score }) =>
        score == null ? null : (
          <div key={key} className="flex items-center justify-between gap-1 rounded bg-white/60 px-2 py-1">
            <span className="truncate text-[10px] text-[var(--kn-text-muted)]">{label}</span>
            <ConfidenceBadge score={score} />
          </div>
        ),
      )}
    </div>
  );
}

function ValidationPanel({ result }: { result: ValidationResult }) {
  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  if (result.issues.length === 0 && result.confidence >= 0.8) {
    return (
      <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
        <div className="flex items-center gap-2 font-semibold">
          <CheckCircle2 className="size-4 shrink-0" />
          Données cohérentes — confiance globale {Math.round(result.confidence * 100)}%
        </div>
        {result.fieldConfidence && (
          <FieldConfidenceGrid fieldConfidence={result.fieldConfidence} />
        )}
      </div>
    );
  }

  return (
    <div className={`mb-4 rounded-lg border px-3 py-3 text-[13px] ${errors.length > 0 ? "border-red-200 bg-red-50" : "border-yellow-200 bg-yellow-50"}`}>
      <div className="mb-2 flex items-center gap-2 font-semibold">
        <AlertTriangle className={`size-4 shrink-0 ${errors.length > 0 ? "text-red-600" : "text-yellow-600"}`} />
        <span className={errors.length > 0 ? "text-red-700" : "text-yellow-700"}>
          {errors.length > 0 ? `${errors.length} erreur${errors.length > 1 ? "s" : ""} bloquante${errors.length > 1 ? "s" : ""}` : "Avertissements"}
          {warnings.length > 0 && errors.length > 0 ? `, ${warnings.length} avertissement${warnings.length > 1 ? "s" : ""}` : ""}
          {" — "}confiance globale {Math.round(result.confidence * 100)}%
        </span>
      </div>
      <ul className="space-y-1">
        {errors.map((issue, i) => (
          <li key={i} className="flex items-start gap-2 text-red-700">
            <span className="mt-0.5 shrink-0 rounded bg-red-100 px-1 py-0 text-[10px] font-bold uppercase">ERR</span>
            {issue.message}
          </li>
        ))}
        {warnings.map((issue, i) => (
          <li key={i} className="flex items-start gap-2 text-yellow-700">
            <span className="mt-0.5 shrink-0 rounded bg-yellow-100 px-1 py-0 text-[10px] font-bold uppercase">WARN</span>
            {issue.message}
          </li>
        ))}
      </ul>
      {result.fieldConfidence && (
        <FieldConfidenceGrid fieldConfidence={result.fieldConfidence} />
      )}
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
  const [isDirty, setIsDirty] = useState(false);
  const [savedBanner, setSavedBanner] = useState(false);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileUrlError, setFileUrlError] = useState(false);
  const [overrideComment, setOverrideComment] = useState("");
  const [overrideFlagAnomaly, setOverrideFlagAnomaly] = useState<boolean | null>(null);
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomFieldDef[]>([]);
  const [customFieldEntries, setCustomFieldEntries] = useState<CustomFieldEntry[]>([]);

  // Garde "modifications non sauvegardées" sur navigation navigateur (fermer onglet, recharger)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirty) return;
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

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

    fetch("/api/custom-fields")
      .then((r) => r.json())
      .then((j) => setCustomFieldDefs(j.definitions ?? []))
      .catch(() => {});

    // Fetch signed URL for document preview
    const supabase = createClient();
    supabase.storage
      .from("invoice-files")
      .createSignedUrl(result.file_path, 3600)
      .then(({ data, error }) => {
        if (error || !data?.signedUrl) { setFileUrlError(true); return; }
        setFileUrl(data.signedUrl);
      })
      .catch(() => setFileUrlError(true));
  }, [router]);

  // Real-time validation re-run whenever ext changes
  const validation = useMemo<ValidationResult | null>(() => {
    if (!ext) return null;
    return validateInvoice(ext as Parameters<typeof validateInvoice>[0]);
  }, [ext]);

  const hasErrors = validation != null && !validation.isValid;
  const hasOverrideComment = overrideComment.trim().length > 0;

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
      if (hasOverrideComment) {
        body.override_comment = overrideComment.trim();
        body.override_flag_anomaly = overrideFlagAnomaly ?? false;
      }
      const customFieldsPayload = customFieldEntries
        .filter((e) => e.value.trim().length > 0 && (e.definition_id || (e.new_label ?? "").trim().length > 0))
        .map((e) => e.definition_id
          ? { section: e.section, definition_id: e.definition_id, value: e.value.trim() }
          : { section: e.section, value: e.value.trim(), new_definition: { label: e.new_label!.trim(), field_type: e.new_field_type } },
        );
      if (customFieldsPayload.length > 0) body.custom_fields = customFieldsPayload;
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || json.error) { setError(json.error ?? "Erreur enregistrement."); setSaving(false); return; }
      sessionStorage.removeItem("upload_ocr_result");
      setIsDirty(false);
      setSavedBanner(true);
      // Laisser le banner visible 1.5s avant redirect
      setTimeout(() => router.push("/documents"), 1500);
    } catch {
      setError("Erreur réseau.");
      setSaving(false);
    }
  }

  // Helpers for updating nested state
  function setClient(k: keyof Extraction["client"], v: string) {
    setIsDirty(true);
    setExt((e) => e ? { ...e, client: { ...e.client, [k]: v || null } } : e);
  }
  function setContract(k: keyof Extraction["contract"], v: string | number | null) {
    setIsDirty(true);
    setExt((e) => e ? { ...e, contract: { ...e.contract, [k]: v } } : e);
  }
  function setInvoice(k: keyof Extraction["invoice"], v: string | number | boolean | null) {
    setIsDirty(true);
    setExt((e) => e ? { ...e, invoice: { ...e.invoice, [k]: v } } : e);
  }

  const isPdf = !ocr?.file_path || ocr.file_path.toLowerCase().endsWith(".pdf")
    || (!ocr.file_path.match(/\.(png|jpe?g|webp)$/i));

  if (!ext) return null;

  return (
    <div className="flex h-full">
      {/* ── Left: Document viewer ── */}
      <div className="flex w-[46%] min-w-[360px] flex-col border-r border-[var(--kn-border)] bg-[var(--kn-page)]">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--kn-border)] px-4 py-2.5">
          <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--kn-text-muted)]">
            Document original
          </span>
          {fileUrl && (
            <a
              href={fileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-[#f97316] hover:underline"
            >
              Ouvrir ↗
            </a>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {fileUrlError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--kn-text-muted)]">
              <AlertCircle className="size-6" />
              <span className="text-[13px]">Aperçu indisponible</span>
            </div>
          ) : !fileUrl ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-6 animate-spin text-[var(--kn-text-muted)]" />
            </div>
          ) : isPdf ? (
            <iframe
              src={`${fileUrl}#toolbar=1&view=FitH`}
              className="h-full w-full border-0"
              title="Facture PDF"
            />
          ) : (
            <div className="h-full overflow-y-auto p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={fileUrl} alt="Facture" className="w-full rounded-lg" />
            </div>
          )}
        </div>
      </div>

      {/* ── Right: Form ── */}
      <div className="flex-1 overflow-y-auto">
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
              className="flex shrink-0 items-center gap-2 rounded-xl bg-[var(--kn-solid)] px-5 py-2.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Enregistrer
            </button>
          </div>

          {savedBanner && (
            <div role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 font-semibold">
              <CheckCircle2 className="size-4 shrink-0" /> Facture enregistrée — redirection…
            </div>
          )}

          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="size-4 shrink-0" /> {error}
            </div>
          )}

          {validation && <ValidationPanel result={validation} />}

          {/* Override section — shown only when blocking errors exist */}
          {hasErrors && (
            <div className="mb-6 rounded-xl border-2 border-orange-300 bg-orange-50 p-4">
              <p className="mb-3 text-[13px] font-semibold text-orange-800">
                Passer outre les erreurs — justification requise
              </p>
              <textarea
                value={overrideComment}
                onChange={(e) => setOverrideComment(e.target.value)}
                placeholder="Expliquez pourquoi vous acceptez ces écarts (ex. facture correcte, erreur d'extraction connue…)"
                rows={3}
                className="w-full rounded-lg border border-orange-300 bg-white px-3 py-2 text-[13px] text-[var(--kn-text)] outline-none focus:border-orange-500 placeholder:text-[var(--kn-text-muted)] resize-none"
              />
              <p className="mt-3 mb-2 text-[12px] font-semibold text-orange-800">Détecter cette facture comme anomalie ?</p>
              <div className="flex gap-4">
                <label className="flex cursor-pointer items-center gap-2 text-[13px] text-orange-900">
                  <input
                    type="radio"
                    name="override_flag"
                    checked={overrideFlagAnomaly === true}
                    onChange={() => setOverrideFlagAnomaly(true)}
                    className="accent-orange-500"
                  />
                  Oui — détecter comme anomalie
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-[13px] text-orange-900">
                  <input
                    type="radio"
                    name="override_flag"
                    checked={overrideFlagAnomaly === false}
                    onChange={() => setOverrideFlagAnomaly(false)}
                    className="accent-orange-500"
                  />
                  Non — facture acceptée telle quelle
                </label>
              </div>
              {hasOverrideComment && overrideFlagAnomaly !== null && (
                <p className="mt-2 text-[12px] text-green-700 font-medium">✓ Justification enregistrée</p>
              )}
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
          <CustomFieldsBlock
            section="localisation"
            defs={customFieldDefs}
            entries={customFieldEntries.filter((e) => e.section === "localisation")}
            onChange={(next) => {
              setIsDirty(true);
              setCustomFieldEntries((all) => [...all.filter((e) => e.section !== "localisation"), ...next]);
            }}
          />
        </div>
      </Section>

      {/* Facture */}
      <Section title="En-tête de facture">
        <div className="grid grid-cols-2 gap-4">
          <Field label="N° Facture">
            <input className={`${inputCls} ${confidenceBorder(validation?.fieldConfidence?.facture_number)}`} value={ext.invoice.facture_number} onChange={(e) => setInvoice("facture_number", e.target.value)} />
          </Field>
          <Field label="Date facture">
            <input className={`${inputCls} ${confidenceBorder(validation?.fieldConfidence?.facture_date)}`} type="date" value={ext.invoice.facture_date} onChange={(e) => setInvoice("facture_date", e.target.value)} />
          </Field>
          <Field label="Total HT (€)">
            <input className={`${inputCls} ${confidenceBorder(validation?.fieldConfidence?.total_ht)}`} type="number" step="0.01" value={ext.invoice.total_ht} onChange={(e) => setInvoice("total_ht", parseFloat(e.target.value))} />
          </Field>
          <Field label="TVA (€)">
            <input className={`${inputCls} ${confidenceBorder(validation?.fieldConfidence?.tva)}`} type="number" step="0.01" value={ext.invoice.tva ?? ""} onChange={(e) => setInvoice("tva", e.target.value ? parseFloat(e.target.value) : null)} />
          </Field>
          <Field label="Autres taxes (€)">
            <input className={`${inputCls} ${confidenceBorder(validation?.fieldConfidence?.autres_taxes)}`} type="number" step="0.01" value={ext.invoice.autres_taxes ?? ""} onChange={(e) => setInvoice("autres_taxes", e.target.value ? parseFloat(e.target.value) : null)} />
          </Field>
          <Field label="Total TTC (€)">
            <input className={`${inputCls} ${confidenceBorder(validation?.fieldConfidence?.total_ttc)}`} type="number" step="0.01" value={ext.invoice.total_ttc} onChange={(e) => setInvoice("total_ttc", parseFloat(e.target.value))} />
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
          <CustomFieldsBlock
            section="invoice"
            defs={customFieldDefs}
            entries={customFieldEntries.filter((e) => e.section === "invoice")}
            onChange={(next) => {
              setIsDirty(true);
              setCustomFieldEntries((all) => [...all.filter((e) => e.section !== "invoice"), ...next]);
            }}
          />
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
          <CustomFieldsBlock
            section="client"
            defs={customFieldDefs}
            entries={customFieldEntries.filter((e) => e.section === "client")}
            onChange={(next) => {
              setIsDirty(true);
              setCustomFieldEntries((all) => [...all.filter((e) => e.section !== "client"), ...next]);
            }}
          />
        </div>
      </Section>

      {/* Contrat */}
      <Section title="Contrat">
        <div className="grid grid-cols-2 gap-4">
          <Field label="N° Contrat">
            <input className={inputCls} value={ext.contract.contract_number} onChange={(e) => setContract("contract_number", e.target.value)} />
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
          <CustomFieldsBlock
            section="contract"
            defs={customFieldDefs}
            entries={customFieldEntries.filter((e) => e.section === "contract")}
            onChange={(next) => {
              setIsDirty(true);
              setCustomFieldEntries((all) => [...all.filter((e) => e.section !== "contract"), ...next]);
            }}
          />
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
              <tfoot>
                <tr className="border-t-2 border-[var(--kn-border)]">
                  <td colSpan={3} className="pt-2 text-[11px] font-bold uppercase tracking-wide text-[var(--kn-text-muted)]">Total consommation</td>
                  <td className="pt-2 pr-3 text-right font-bold tabular-nums text-[var(--kn-text)]">
                    {ext.consumption_lines.reduce((s, r) => s + r.consommation_kwh, 0).toFixed(0)} kWh
                  </td>
                  <td />
                  <td className="pt-2 text-right font-bold tabular-nums text-[var(--kn-text)]">
                    {ext.consumption_lines.reduce((s, r) => s + r.montant_eur, 0).toFixed(2)} €
                  </td>
                </tr>
              </tfoot>
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
              <tfoot>
                <tr className="border-t-2 border-[var(--kn-border)]">
                  <td colSpan={3} className="pt-2 text-[11px] font-bold uppercase tracking-wide text-[var(--kn-text-muted)]">Total charges fixes</td>
                  <td className="pt-2 text-right font-bold tabular-nums text-[var(--kn-text)]">
                    {ext.fixed_charges.reduce((s, r) => s + r.montant_eur, 0).toFixed(2)} €
                  </td>
                </tr>
              </tfoot>
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
              <tfoot>
                <tr className="border-t-2 border-[var(--kn-border)]">
                  <td colSpan={2} className="pt-2 text-[11px] font-bold uppercase tracking-wide text-[var(--kn-text-muted)]">Total taxes</td>
                  <td className="pt-2 text-right font-bold tabular-nums text-[var(--kn-text)]">
                    {ext.taxes.reduce((s, r) => s + r.montant_eur, 0).toFixed(2)} €
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Section>
      )}

          {/* Bottom save */}
          <div className="flex justify-end gap-3 pb-8">
            <button
              onClick={() => {
                if (isDirty && !confirm("Des modifications non sauvegardées seront perdues. Continuer ?")) return;
                router.push("/upload");
              }}
              className="rounded-xl border border-[var(--kn-border)] px-5 py-2.5 text-[13px] font-medium text-[var(--kn-text)] hover:bg-[var(--kn-active)]">
              Annuler
            </button>
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-2 rounded-xl bg-[var(--kn-solid)] px-5 py-2.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {hasErrors ? "Enregistrer avec justification" : "Enregistrer"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
