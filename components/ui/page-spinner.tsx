import { Loader2 } from "lucide-react";

export function PageSpinner({ label = "Chargement…" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[400px] w-full flex-col items-center justify-center gap-3 text-[var(--kn-text-muted)]">
      <Loader2 className="size-7 animate-spin text-[#f97316]" strokeWidth={2} />
      <p className="text-[13px]">{label}</p>
    </div>
  );
}
