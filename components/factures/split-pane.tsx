"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical } from "lucide-react";

/**
 * Vue partagée horizontale redimensionnable à la souris/clavier.
 * Par défaut : gauche (PDF) ~60 %, bornée [35 %, 72 %]. Empile en colonne sur mobile.
 */
export function SplitPane({
  left,
  right,
  defaultLeft = 60,
  min = 35,
  max = 72,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  defaultLeft?: number;
  min?: number;
  max?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState(defaultLeft);
  const [dragging, setDragging] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setLeftPct(clamp(((e.clientX - rect.left) / rect.width) * 100));
    };
    const onUp = () => setDragging(false);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, clamp]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") setLeftPct((p) => clamp(p - 2));
    if (e.key === "ArrowRight") setLeftPct((p) => clamp(p + 2));
  };

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col gap-4 lg:flex-row lg:gap-0">
      {/* Calque qui capte la souris pendant le drag (empêche l'iframe PDF d'avaler les événements) */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}

      <div
        className="min-h-[640px] lg:min-h-0"
        style={isDesktop ? { width: `${leftPct}%` } : undefined}
      >
        {left}
      </div>

      {/* Poignée de redimensionnement (desktop) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionner les panneaux"
        tabIndex={0}
        onMouseDown={() => setDragging(true)}
        onKeyDown={onKey}
        className={`group hidden shrink-0 cursor-col-resize items-center justify-center px-1 outline-none lg:flex ${
          dragging ? "" : "transition-colors"
        }`}
      >
        <div
          className={`flex h-12 w-1.5 items-center justify-center rounded-full transition-colors ${
            dragging ? "bg-[#f97316]" : "bg-[var(--kn-border)] group-hover:bg-[#fb923c] group-focus-visible:bg-[#f97316]"
          }`}
        >
          <GripVertical className={`size-3 ${dragging ? "text-white" : "text-transparent group-hover:text-white"}`} />
        </div>
      </div>

      <div className="min-h-0 flex-1">{right}</div>
    </div>
  );
}
