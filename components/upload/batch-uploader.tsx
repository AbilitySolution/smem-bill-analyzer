"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { UploadCloud, Loader2, AlertCircle, CheckCircle2, FileWarning, MapPin } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { buildInvoiceStoragePath } from "@/lib/extraction/storage-path";
import { ACCEPTED_EXTENSIONS, MAX_FILES_PER_BATCH, mediaTypeFromName } from "@/lib/batches/constants";

interface Commune { id: string; nom: string }

interface BatchItem {
  id: string;
  original_name: string;
  status: "pending" | "imported" | "needs_commune" | "skipped_duplicate" | "failed";
  invoice_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error: string | null;
}

interface BatchState {
  id: string;
  status: string;
  total_count: number;
  imported_count: number;
  failed_count: number;
  error: string | null;
}

/** Intervalle de sondage. Le batch dure typiquement plusieurs minutes : inutile d'insister. */
const POLL_MS = 30_000;

export function BatchUploader({ orgId, userId }: { orgId: string; userId: string }) {
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase] = useState<"idle" | "reading" | "uploading" | "submitting" | "tracking">("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [communes, setCommunes] = useState<Commune[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = phase !== "idle" && phase !== "tracking";

  // Communes chargées une fois : elles alimentent le rattrapage manuel des documents
  // dont la commune n'a pas été reconnue.
  useEffect(() => {
    fetch("/api/communes")
      .then((r) => r.json())
      .then((j) => setCommunes(j.communes ?? []))
      .catch(() => {});
  }, []);

  const refresh = useCallback(async (batchId: string) => {
    const res = await fetch(`/api/batches/${batchId}`);
    if (!res.ok) return;
    const json = await res.json();
    setBatch(json.batch);
    setItems(json.items ?? []);
  }, []);

  // Sondage : tant que la page est ouverte, on pousse le lot vers son import. Le cron
  // fait le même travail en arrière-plan si l'utilisateur ferme l'onglet.
  useEffect(() => {
    if (!batch || batch.status === "done" || batch.status === "failed") return;
    let cancelled = false;

    const tick = async () => {
      try {
        await fetch(`/api/batches/${batch.id}/sync`, { method: "POST" });
        if (!cancelled) await refresh(batch.id);
      } catch {
        // Réseau instable : on retentera au prochain intervalle.
      }
    };

    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [batch, refresh]);

  const handleZip = useCallback(async (file: File) => {
    setError(null);
    setPhase("reading");
    setProgress({ done: 0, total: 0 });

    try {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(file);

      // Ne garder que les vrais documents : on ignore les dossiers, les métadonnées
      // macOS (__MACOSX/, ._fichier) et tout format que l'extraction ne sait pas lire.
      const entries = Object.values(zip.files).filter((e) => {
        if (e.dir) return false;
        const name = e.name;
        if (name.startsWith("__MACOSX/") || name.split("/").pop()!.startsWith("._")) return false;
        return ACCEPTED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
      });

      if (entries.length === 0) {
        setError("Aucune facture trouvée dans l'archive (PDF, PNG, JPEG ou WEBP attendus).");
        setPhase("idle");
        return;
      }
      if (entries.length > MAX_FILES_PER_BATCH) {
        setError(`${entries.length} fichiers : maximum ${MAX_FILES_PER_BATCH} par import. Scindez votre archive.`);
        setPhase("idle");
        return;
      }

      setPhase("uploading");
      setProgress({ done: 0, total: entries.length });

      const supabase = createClient();
      const uploaded: Array<{ path: string; original_name: string }> = [];

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const originalName = entry.name.split("/").pop()!;
        const blob = await entry.async("blob");
        const contentType = mediaTypeFromName(originalName) ?? "application/octet-stream";

        // Le suffixe `i` évite qu'un homonyme écrase le précédent : tous les fichiers
        // d'un ZIP sont écrits dans la même milliseconde.
        const path = buildInvoiceStoragePath(orgId, userId, originalName, i);
        const { error: upErr } = await supabase.storage
          .from("invoice-files")
          .upload(path, blob, { contentType });

        if (upErr) throw new Error(`Envoi de ${originalName} : ${upErr.message}`);

        uploaded.push({ path, original_name: originalName });
        setProgress({ done: i + 1, total: entries.length });
      }

      setPhase("submitting");
      const res = await fetch("/api/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: uploaded }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Soumission du lot échouée.");

      setPhase("tracking");
      await refresh(json.batch_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import échoué.");
      setPhase("idle");
    }
  }, [orgId, userId, refresh]);

  const resolveCommune = useCallback(async (itemId: string, communeId: string) => {
    if (!batch || !communeId) return;
    setResolving(itemId);
    try {
      const res = await fetch(`/api/batches/${batch.id}/items/${itemId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commune_id: communeId }),
      });
      const json = await res.json();
      if (!res.ok) setError(json.error ?? "Affectation échouée.");
      await refresh(batch.id);
    } finally {
      setResolving(null);
    }
  }, [batch, refresh]);

  const needsCommune = items.filter((i) => i.status === "needs_commune");
  const failed = items.filter((i) => i.status === "failed");
  const duplicates = items.filter((i) => i.status === "skipped_duplicate");
  const imported = items.filter((i) => i.status === "imported");
  const stillPending = items.filter((i) => i.status === "pending");
  const tokens = items.reduce(
    (acc, i) => ({ input: acc.input + (i.input_tokens ?? 0), output: acc.output + (i.output_tokens ?? 0) }),
    { input: 0, output: 0 },
  );

  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Importer un lot de factures</h1>
      <p className="mb-8 text-[13px] text-[var(--kn-text-muted)]">
        Déposez une archive ZIP. Les factures sont extraites en une passe, à moitié prix,
        puis créées en « à valider ». Vous pouvez fermer cet onglet : le traitement continue.
      </p>

      {!batch && (
        <>
          <div
            onDragOver={(e) => { e.preventDefault(); if (!busy) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragOver(false);
              if (busy) return;
              const f = e.dataTransfer.files[0]; if (f) void handleZip(f);
            }}
            onClick={() => { if (!busy) inputRef.current?.click(); }}
            className={`flex h-56 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed transition-colors ${
              busy ? "cursor-default border-[var(--kn-border)] bg-[var(--kn-panel)]"
              : dragOver ? "cursor-pointer border-[#f97316] bg-[var(--kn-yellow-soft)]"
              : "cursor-pointer border-[#c8ccd2] bg-[var(--kn-card)] hover:border-[#f97316]"
            }`}
          >
            {busy ? (
              <>
                <Loader2 className="size-7 animate-spin text-[#f97316]" />
                <div className="text-center">
                  <p className="text-sm font-medium text-[var(--kn-text)]">
                    {phase === "reading" && "Lecture de l'archive…"}
                    {phase === "uploading" && `Envoi des factures… ${progress.done}/${progress.total}`}
                    {phase === "submitting" && "Soumission du lot d'extraction…"}
                  </p>
                </div>
                {progress.total > 0 && (
                  <div className="h-1 w-40 overflow-hidden rounded-full bg-[var(--kn-border)]">
                    <div
                      className="h-full rounded-full bg-[#f97316] transition-all"
                      style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                    />
                  </div>
                )}
              </>
            ) : (
              <>
                <UploadCloud className="size-8 text-[var(--kn-text-muted)]" />
                <div className="text-center">
                  <p className="text-sm font-medium text-[var(--kn-text)]">Glissez une archive ZIP ici ou cliquez</p>
                  <p className="text-xs text-[var(--kn-text-muted)]">
                    PDF, PNG, JPEG, WEBP — jusqu&apos;à {MAX_FILES_PER_BATCH} factures
                  </p>
                </div>
              </>
            )}
          </div>

          <input ref={inputRef} type="file" accept=".zip,application/zip" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleZip(f); e.target.value = ""; }} />

          <p className="mt-4 text-[13px] text-[var(--kn-text-muted)]">
            Une seule facture ?{" "}
            <Link href="/upload" className="text-[#ea580c] underline">Import unitaire</Link>
          </p>
        </>
      )}

      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      {batch && (
        <div className="space-y-5">
          <div className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
            <div className="flex items-center gap-2">
              {batch.status === "done" ? (
                <CheckCircle2 className="size-5 text-emerald-600" />
              ) : (
                <Loader2 className="size-5 animate-spin text-[#f97316]" />
              )}
              <p className="text-sm font-medium text-[var(--kn-text)]">
                {batch.status === "done"
                  ? "Extraction terminée"
                  : `Extraction en cours — ${stillPending.length} facture(s) en attente`}
              </p>
            </div>

            {batch.status !== "done" && (
              <p className="mt-1 text-xs text-[var(--kn-text-muted)]">
                Le traitement se fait par lot, il peut prendre plusieurs minutes.
                Vous pouvez fermer cette page et revenir plus tard.
              </p>
            )}

            <dl className="mt-4 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
              <Stat label="Créées" value={imported.length} />
              <Stat label="Sans commune" value={needsCommune.length} />
              <Stat label="Déjà en base" value={duplicates.length} />
              <Stat label="En échec" value={failed.length} />
            </dl>

            {(tokens.input > 0 || tokens.output > 0) && (
              <p className="mt-3 text-xs text-[var(--kn-text-muted)]">
                Consommation mesurée : {tokens.input.toLocaleString("fr-FR")} tokens en entrée,{" "}
                {tokens.output.toLocaleString("fr-FR")} en sortie (tarif lot, −50 %).
              </p>
            )}

            {imported.length > 0 && (
              <Link
                href="/documents"
                className="mt-4 inline-block rounded-lg bg-[#ea580c] px-3 py-1.5 text-[13px] font-medium text-white"
              >
                Voir les {imported.length} facture(s) créée(s)
              </Link>
            )}
          </div>

          {needsCommune.length > 0 && (
            <section className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
              <h2 className="flex items-center gap-2 text-sm font-medium text-[var(--kn-text)]">
                <MapPin className="size-4 text-[#f97316]" />
                Commune non reconnue ({needsCommune.length})
              </h2>
              <p className="mt-1 mb-3 text-xs text-[var(--kn-text-muted)]">
                Ces factures sont extraites mais pas encore créées. Désignez la commune —
                aucune nouvelle extraction ne sera facturée.
              </p>
              <ul className="space-y-2">
                {needsCommune.map((item) => (
                  <li key={item.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--kn-text)]">
                      {item.original_name}
                    </span>
                    <select
                      disabled={resolving === item.id}
                      defaultValue=""
                      onChange={(e) => void resolveCommune(item.id, e.target.value)}
                      className="rounded-md border border-[var(--kn-border)] bg-[var(--kn-panel)] px-2 py-1 text-[13px] text-[var(--kn-text)]"
                    >
                      <option value="" disabled>Choisir une commune…</option>
                      {communes.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
                    </select>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(failed.length > 0 || duplicates.length > 0) && (
            <section className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
              <h2 className="flex items-center gap-2 text-sm font-medium text-[var(--kn-text)]">
                <FileWarning className="size-4 text-[var(--kn-text-muted)]" />
                Non importées ({failed.length + duplicates.length})
              </h2>
              <ul className="mt-3 space-y-1.5">
                {[...duplicates, ...failed].map((item) => (
                  <li key={item.id} className="text-[13px]">
                    <span className="text-[var(--kn-text)]">{item.original_name}</span>
                    <span className="text-[var(--kn-text-muted)]">
                      {" — "}
                      {item.status === "skipped_duplicate" ? "déjà en base" : (item.error ?? "erreur")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-[var(--kn-panel)] px-3 py-2">
      <dt className="text-xs text-[var(--kn-text-muted)]">{label}</dt>
      <dd className="text-lg font-semibold text-[var(--kn-text)]">{value}</dd>
    </div>
  );
}
