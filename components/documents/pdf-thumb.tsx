"use client";

import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

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

/**
 * Vignette réelle d'une facture : rend la 1ʳᵉ page du PDF (haut de page) sur un canvas,
 * en chargement paresseux (IntersectionObserver). Repli icône si pas d'URL ou erreur.
 */
export function PdfThumb({ url, heightClass = "h-28", iconSize = "size-10" }: { url: string | null | undefined; heightClass?: string; iconSize?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) { setVisible(true); io.disconnect(); } },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !url) return;
    let cancelled = false;
    (async () => {
      setState("loading");
      try {
        const pdfjsLib = await loadPdfjs();
        const doc = await pdfjsLib.getDocument({ url }).promise;
        const page = await doc.getPage(1);
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const cssWidth = canvas.parentElement?.clientWidth ?? 240;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const v1 = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (cssWidth * dpr) / v1.width });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = "100%";
        canvas.style.height = "auto";
        const ctx = canvas.getContext("2d");
        if (!ctx) { setState("error"); return; }
        // Fond blanc « papier » (pdf.js rend sur fond transparent → invisible en thème sombre)
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        if (!cancelled) setState("done");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => { cancelled = true; };
  }, [visible, url]);

  const fallback = !url || state === "error";

  return (
    <div ref={rootRef} className={cx("relative overflow-hidden bg-[var(--kn-panel)]", heightClass)}>
      {fallback ? (
        <div className="flex h-full items-center justify-center">
          <FileText className={cx(iconSize, "text-[#ea580c]")} strokeWidth={1.4} />
        </div>
      ) : (
        <>
          {state !== "done" && <div className="absolute inset-0 animate-pulse bg-[var(--kn-value-box)]" />}
          <canvas ref={canvasRef} className="block w-full" style={{ display: state === "done" ? "block" : "none" }} />
        </>
      )}
    </div>
  );
}
