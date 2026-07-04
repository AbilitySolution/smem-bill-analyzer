/** Badge de confiance (précision modèle moyenne). « — » si non disponible. */
export function ConfidenceBadge({ value, className }: { value?: number | null; className?: string }) {
  if (value == null) {
    return <span className={`text-[var(--kn-text-muted)] ${className ?? ""}`}>—</span>;
  }
  const color = value >= 85 ? "#16a34a" : value >= 60 ? "#d97706" : "#dc2626";
  return (
    <span className={`inline-flex items-center gap-1 text-[12px] font-medium tabular-nums ${className ?? ""}`} style={{ color }} title="Précision moyenne estimée par le modèle OCR">
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {value}%
    </span>
  );
}
