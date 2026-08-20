import type { LucideIcon } from "lucide-react";

export function SettingsPageHeader({
  eyebrow,
  title,
  description,
  icon: Icon,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-col gap-4 border-b border-[var(--kn-border)] pb-6 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-3.5">
        <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] text-[#ea580c] shadow-sm">
          <Icon className="size-[19px]" strokeWidth={1.8} />
        </div>
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#c2410c] dark:text-[#fb923c]">
            {eyebrow}
          </p>
          <h2 className="font-heading text-2xl font-semibold tracking-tight text-[var(--kn-text)]">
            {title}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--kn-text-muted)]">
            {description}
          </p>
        </div>
      </div>
      {action && <div className="shrink-0 sm:pt-5">{action}</div>}
    </header>
  );
}
