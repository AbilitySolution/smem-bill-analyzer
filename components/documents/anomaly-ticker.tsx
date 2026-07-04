"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { loadResolved, anomalyKey, type AnomalyLite } from "@/lib/data/anomalies";

/**
 * Indicateur d'anomalie : triangle + lien « Résoudre l'anomalie » (ambre) près du n° de facture.
 * Survol = résumé ; clic = module Anomalies. Tient compte des résolutions (localStorage).
 * `label=false` : version compacte (triangle seul) pour les espaces étroits.
 */
export function AnomalyTicker({
  invoiceId, anomalies, label = true, size = "size-3.5",
}: { invoiceId: string; anomalies?: AnomalyLite[]; label?: boolean; size?: string }) {
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  useEffect(() => { setResolved(loadResolved()); }, []);

  const open = (anomalies ?? []).filter((a) => !resolved.has(anomalyKey(invoiceId, a.type)));
  if (!open.length) return null;

  const summary = `${open.length} anomalie${open.length > 1 ? "s" : ""} détectée${open.length > 1 ? "s" : ""} :\n` + open.map((a) => `• ${a.message}`).join("\n");

  return (
    <Link
      href={`/anomalies?focus=${invoiceId}`}
      onClick={(e) => e.stopPropagation()}
      title={summary}
      aria-label={`${open.length} anomalie(s) — résoudre`}
      className="inline-flex shrink-0 items-center gap-1 font-medium text-[#d97706] transition-colors hover:text-[#b45309] hover:underline"
    >
      <AlertTriangle className={size} strokeWidth={2.25} />
      {label && <span className="text-[12px]">Résoudre l&apos;anomalie</span>}
    </Link>
  );
}
