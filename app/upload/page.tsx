"use client";

import { useRef, useState } from "react";
import ReviewForm from "./ReviewForm";
import type { ExtractError, ExtractResponse } from "./types";

export default function UploadPage() {
  const [extractResult, setExtractResult] = useState<ExtractResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setLoading(true);
    setError(null);
    setExtractResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/extract", { method: "POST", body: formData });
      const json = (await res.json()) as ExtractResponse | ExtractError;
      if (!res.ok || "error" in json) {
        setError("error" in json ? json.error : "Erreur d'extraction OCR.");
        return;
      }
      setExtractResult(json);
    } catch {
      setError("Erreur réseau lors de l'extraction.");
    } finally {
      setLoading(false);
    }
  }

  if (extractResult) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="mb-6 text-lg font-semibold text-[#1E3A8A]">
          Vérifier et corriger les données extraites
        </h1>
        <ReviewForm initialExtraction={extractResult.extraction} filePath={extractResult.file_path} />
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col items-center px-4 py-16">
      <h1 className="mb-2 text-lg font-semibold text-[#1E3A8A]">Importer une facture EDF</h1>
      <p className="mb-8 text-sm text-slate-600">
        PDF, PNG, JPEG ou WEBP. Extraction automatique via OCR Claude.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) handleFile(file);
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex h-48 w-full cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors duration-200 ${
          dragOver ? "border-[#1E40AF] bg-blue-50" : "border-slate-300 bg-white hover:border-[#1E40AF]"
        }`}
      >
        {loading ? (
          <p className="text-sm text-slate-600">Extraction OCR en cours...</p>
        ) : (
          <>
            <p className="text-sm font-medium text-slate-700">
              Glissez-déposez la facture ici, ou cliquez pour sélectionner
            </p>
            <p className="mt-1 text-xs text-slate-500">PDF, PNG, JPEG, WEBP</p>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
    </main>
  );
}
