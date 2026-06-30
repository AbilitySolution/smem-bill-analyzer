"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, ScanText } from "lucide-react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

const tabs = [
  { href: "/documents", label: "Documents", icon: LayoutGrid, match: (p: string) => p === "/documents" },
  { href: "/documents/extraction", label: "Extraction", icon: ScanText, match: (p: string) => p.startsWith("/documents/extraction") },
];

export function DocumentsTabs() {
  const pathname = usePathname();
  return (
    <nav className="-mb-px flex items-center gap-1">
      {tabs.map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cx(
              "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
              active
                ? "border-[#f97316] text-[var(--kn-text)]"
                : "border-transparent text-[var(--kn-text-muted)] hover:border-[var(--kn-border)] hover:text-[var(--kn-text)]",
            )}
          >
            <t.icon className={cx("size-4", active && "text-[#ea580c]")} strokeWidth={1.85} />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
