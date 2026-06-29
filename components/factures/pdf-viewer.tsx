"use client";

import { useRef, useState } from "react";
import { Download, ExternalLink, Maximize2, FileX2, RotateCw } from "lucide-react";

/** Visionneuse PDF : aperçu intégré (signed URL) + outils (télécharger, ouvrir, plein écran, rotation). */
export function PdfViewer({ url, filename }: { url: string | null; filename: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rotation, setRotation] = useState(0);

  const fullscreen = () => containerRef.current?.requestFullscreen?.();

  if (!url) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--kn-border)] bg-[var(--kn-panel)] text-[var(--kn-text-muted)]">
        <FileX2 className="size-7" strokeWidth={1.5} />
        <p className="text-[13px]">Aucun document PDF associé à cette facture.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full flex-col overflow-hidden rounded-xl border border-[var(--kn-border)] bg-white">
      {/* Barre d'outils */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--kn-border)] px-3 text-[var(--kn-text-muted)]">
        <span className="mr-auto truncate text-[12px] font-medium text-[#1a1a1a]">{filename}</span>
        <button onClick={() => setRotation((r) => (r + 90) % 360)} title="Pivoter" className="rounded p-1.5 hover:bg-[var(--kn-active)] hover:text-[#1a1a1a]">
          <RotateCw className="size-4" />
        </button>
        <a href={url} download={filename} title="Télécharger" className="rounded p-1.5 hover:bg-[var(--kn-active)] hover:text-[#1a1a1a]">
          <Download className="size-4" />
        </a>
        <a href={url} target="_blank" rel="noopener noreferrer" title="Ouvrir dans un onglet" className="rounded p-1.5 hover:bg-[var(--kn-active)] hover:text-[#1a1a1a]">
          <ExternalLink className="size-4" />
        </a>
        <button onClick={fullscreen} title="Plein écran" className="rounded p-1.5 hover:bg-[var(--kn-active)] hover:text-[#1a1a1a]">
          <Maximize2 className="size-4" />
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
