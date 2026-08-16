"use client";

import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";

/**
 * Vignette réelle d'un fichier encore local (pas encore, ou tout juste, déposé).
 *
 * Jumelle de `components/documents/pdf-thumb.tsx`, qui rend un PDF déjà stocké à partir
 * de son URL signée. Ici le fichier est en mémoire dans le navigateur : le rendre
 * directement évite un aller-retour de stockage et affiche l'aperçu instantanément, au
 * moment précis où l'utilisateur veut vérifier qu'il a déposé les bons documents.
 *
 * Rendu paresseux (`IntersectionObserver`) : sur un dépôt de plusieurs centaines de
 * fichiers, rendre chaque première page à l'écran figerait l'onglet. Seules les
 * vignettes réellement visibles sont produites.
 */

let workerConfigured = false;
async function loadPdfjs() {
  const pdfjsLib = await import("pdfjs-dist");
  if (!workerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    workerConfigured = true;
  }
  return pdfjsLib;
}

export function LocalFileThumb({ file, className = "size-12" }: { file: File; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) { setVisible(true); observer.disconnect(); } },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    void (async () => {
      try {
        // Les images se rendent directement — pas besoin de passer par pdf.js.
        if (file.type.startsWith("image/")) {
          objectUrl = URL.createObjectURL(file);
          if (!cancelled) setPreview(objectUrl);
          return;
        }

        const pdfjsLib = await loadPdfjs();
        const document_ = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        const page = await document_.getPage(1);
        const viewport = page.getViewport({ scale: 0.3 });
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) { if (!cancelled) setFailed(true); return; }
        // Fond blanc : pdf.js rend sur transparent, invisible en thème sombre.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        if (!cancelled) setPreview(canvas.toDataURL("image/jpeg", 0.6));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible, file]);

  return (
    <div ref={rootRef} className={`shrink-0 overflow-hidden rounded border border-[var(--kn-border)] bg-white ${className}`}>
      {preview && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="" className="size-full object-cover object-top" />
      ) : (
        <div className="flex size-full items-center justify-center bg-[var(--kn-panel)]">
          <FileText className="size-5 text-[#f97316]" strokeWidth={1.4} />
        </div>
      )}
    </div>
  );
}
