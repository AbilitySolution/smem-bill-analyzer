import { DocumentationTabs } from "@/components/documentation/documentation-tabs";

export default function DocumentationLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-[var(--kn-border)] px-8 pt-5">
        <h1 className="font-heading text-xl font-bold text-[var(--kn-text)]">Documentation</h1>
        <p className="mb-3 mt-0.5 text-[12px] text-[var(--kn-text-muted)]">
          Comment fonctionne chaque partie de l&apos;application, et la configuration du modèle d&apos;extraction.
        </p>
        <DocumentationTabs />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
