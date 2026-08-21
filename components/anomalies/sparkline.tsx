"use client";

import { SEVERITY_COLOR, type Severity } from "@/lib/data/anomalies";
import type { SitePoint } from "@/lib/data/anomaly-context";

/**
 * Historique kWh/jour d'un site, avec la bande de référence et le point incriminé.
 *
 * SVG écrit à la main plutôt que recharts : une page peut afficher plusieurs dizaines
 * de ces vignettes, et chaque graphique recharts monte un ResponsiveContainer, un
 * ResizeObserver et son propre arbre React. À 60 px de haut et sans interaction, le
 * coût ne se justifie pas — et le rendu serveur reste possible.
 *
 * La bande dessinée EST le seuil de détection (médiane ± 3,5 écarts robustes) : ce que
 * l'utilisateur voit dépasser est exactement ce qui a déclenché l'alerte. Toute autre
 * échelle donnerait des points visuellement hors bande sans alerte, ou l'inverse.
 */
export function Sparkline({
  points,
  highlightInvoiceId,
  baseline,
  band,
  severity,
  width = 132,
  height = 40,
}: {
  points: SitePoint[];
  highlightInvoiceId: string;
  baseline: number | null;
  band: number | null;
  severity: Severity;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;

  const pad = 3;
  const values = points.map((p) => p.kwhPerDay);
  const bandLow = baseline != null && band != null ? Math.max(0, baseline - band) : null;
  const bandHigh = baseline != null && band != null ? baseline + band : null;

  // L'échelle englobe la bande ET les points : sans ça, une bande plus large que les
  // données serait tronquée et le point "hors bande" paraîtrait dedans.
  const candidates = [...values];
  if (bandLow != null) candidates.push(bandLow);
  if (bandHigh != null) candidates.push(bandHigh);
  const min = Math.min(...candidates);
  const max = Math.max(...candidates);
  const span = max - min || 1;

  const x = (i: number) => pad + (i * (width - 2 * pad)) / (points.length - 1);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - 2 * pad);

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.kwhPerDay).toFixed(1)}`).join(" ");
  const hit = points.findIndex((p) => p.invoiceId === highlightInvoiceId);
  const color = SEVERITY_COLOR[severity];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Historique de consommation du site : ${points.length} factures, point signalé ${hit >= 0 ? `au ${points[hit].periodEnd}` : "non situé"}`}
      className="shrink-0 overflow-visible"
    >
      {bandLow != null && bandHigh != null && (
        <rect
          x={pad}
          y={y(bandHigh)}
          width={width - 2 * pad}
          height={Math.max(1, y(bandLow) - y(bandHigh))}
          fill="var(--kn-active)"
          rx={2}
        />
      )}
      {baseline != null && (
        <line
          x1={pad}
          x2={width - pad}
          y1={y(baseline)}
          y2={y(baseline)}
          stroke="var(--kn-text-muted)"
          strokeWidth={1}
          strokeDasharray="2 2"
          opacity={0.55}
        />
      )}
      <path d={path} fill="none" stroke="var(--kn-text-muted)" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" opacity={0.75} />
      {hit >= 0 && (
        <>
          <circle cx={x(hit)} cy={y(points[hit].kwhPerDay)} r={4.5} fill={color} opacity={0.25} />
          <circle cx={x(hit)} cy={y(points[hit].kwhPerDay)} r={2.6} fill={color} />
        </>
      )}
    </svg>
  );
}
