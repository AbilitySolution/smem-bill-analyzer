"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { UploadCloud, CheckCircle2, Zap, Loader2 } from "lucide-react";

export default function DepotPage() {
  const { token } = useParams<{ token: string }>();
  const [label, setLabel] = useState<string | null>(null);
  const [communeNom, setCommuneNom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/depot/${token}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) {
          setError(json.error ?? "Lien invalide.");
          return;
        }
        setLabel(json.link.label);
        setCommuneNom(json.link.communes?.nom ?? null);
      })
      .finally(() => setLoading(false));
  }, [token]);

  async function handleFiles(files: FileList) {
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(`/api/depot/${token}`, { method: "POST", body: formData });
        if (!res.ok) {
          const json = await res.json();
          setError(json.error ?? "Erreur d'envoi.");
          return;
        }
        setDone((d) => d + 1);
      }
    } finally {
      setUploading(false);
    }
  }

  if (loading) {
    return <main className="flex min-h-screen items-center justify-center text-sm text-slate-400">Chargement…</main>;
  }

  if (error && !communeNom) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 text-center">
        <p className="text-sm text-red-600">{error}</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-blue-700">
            <Zap className="h-5 w-5 text-white" fill="white" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-slate-900">Dépôt de factures</h1>
            <p className="text-xs text-slate-500">{communeNom}</p>
          </div>
        </div>
        {label && <p className="mb-4 text-sm text-slate-600">{label}</p>}

        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
          }}
          className="flex h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 hover:border-blue-400"
        >
          {uploading ? (
            <Loader2 className="size-6 animate-spin text-blue-600" />
          ) : (
            <>
              <UploadCloud className="size-6 text-slate-400" />
              <p className="text-sm text-slate-600">Glissez vos factures ici ou cliquez</p>
            </>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        {done > 0 && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald-700">
            <CheckCircle2 className="size-4" />
            {done} fichier(s) envoyé(s). Merci !
          </p>
        )}
      </div>
    </main>
  );
}
