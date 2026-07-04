"use client";

import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Maximize2, Minimize2, FileX2, RotateCw, Link2, Check } from "lucide-react";

/** Visionneuse PDF : aperçu intégré (signed URL) + outils (lien, télécharger, ouvrir, plein écran réductible, rotation). */
export function PdfViewer({ url, filename }: { url: string | null; filename: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rotation, setRotation] = useState(0);
  const [isFull, setIsFull] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFull(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else containerRef.current?.requestFullscreen?.();
  };

  async function copyLink() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* presse-papiers indisponible */
    }
  }

  if (!url) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--kn-border)] bg-[var(--kn-panel)] text-[var(--kn-text-muted)]">
        <FileX2 className="size-7" strokeWidth={1.5} />
        <p className="text-[13px]">Aucun document PDF associé à cette facture.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full flex-col overflow-hidden rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)]">
      {/* Barre d'outils */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--kn-border)] px-3 text-[var(--kn-text-muted)]">
        <span className="mr-auto truncate text-[12px] font-medium text-[var(--kn-text)]">{filename}</span>
        <button onClick={copyLink} title="Obtenir le lien" className="flex items-center gap-1 rounded p-1.5 hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]">
          {copied ? <Check className="size-4 text-[#0f6e56]" /> : <Link2 className="size-4" />}
          {copied && <span className="text-[11px] text-[#0f6e56]">Copié</span>}
        </button>
        <button onClick={() => setRotation((r) => (r + 90) % 360)} title="Pivoter" className="rounded p-1.5 hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]">
          <RotateCw className="size-4" />
        </button>
        <a href={url} download={filename} title="Télécharger" className="rounded p-1.5 hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]">
          <Download className="size-4" />
        </a>
        <a href={url} target="_blank" rel="noopener noreferrer" title="Ouvrir dans un onglet" className="rounded p-1.5 hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]">
          <ExternalLink className="size-4" />
        </a>
        <button onClick={toggleFullscreen} title={isFull ? "Quitter le plein écran" : "Plein écran"} className="rounded p-1.5 hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]">
          {isFull ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
      </div>
      {/* Aperçu */}
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--kn-panel)]">
        <iframe
          src={url}
          title={filename}
          className="h-full min-h-[640px] w-full border-0"
          style={{ transform: `rotate(${rotation}deg)` }}
        />
      </div>
    </div>
  );
}
