import { DocumentsTabs } from "@/components/documents/documents-tabs";

export default function DocumentsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-[var(--kn-border)] px-8 pt-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
          <div>
            <h1 className="font-heading text-xl font-bold text-[var(--kn-text)]">Mes documents</h1>
            <p className="text-[12px] text-[var(--kn-text-muted)]">
              Centralisez, consultez et exportez vos factures d&apos;électricité.
            </p>
          </div>
          <DocumentsTabs />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
