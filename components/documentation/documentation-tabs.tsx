"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, SlidersHorizontal } from "lucide-react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

const tabs = [
  { href: "/documentation", label: "Guide", icon: BookOpen, match: (p: string) => p === "/documentation" },
  { href: "/documentation/champs", label: "Champs d'extraction", icon: SlidersHorizontal, match: (p: string) => p.startsWith("/documentation/champs") },
];

export function DocumentationTabs() {
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
