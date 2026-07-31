"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Menu, Moon, Sun, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const NAV = [
  { href: "#fonctionnalites", label: "Fonctionnalités" },
  { href: "#comment-ca-marche", label: "Comment ça marche" },
  { href: "#contact", label: "Contact" },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--kn-border)] bg-[var(--kn-page)]/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/accueil" className="flex items-center gap-2.5">
          <Image src="/ability-mark.png" alt="" width={120} height={108} className="h-7 w-auto object-contain" priority />
          <span className="font-heading text-[15px] font-bold tracking-tight text-[var(--kn-text)]">ABILITY</span>
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-[13px] font-medium text-[var(--kn-text-muted)] transition-colors hover:text-[var(--kn-text)]"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <ThemeToggle />
          <Button render={<Link href="/login" />} nativeButton={false} variant="accent" size="sm">
            Accéder à mon espace
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Fermer le menu" : "Ouvrir le menu"}
          className="flex size-9 items-center justify-center rounded-lg text-[var(--kn-text)] md:hidden"
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>

      {open && (
        <div className="border-t border-[var(--kn-border)] bg-[var(--kn-page)] px-6 py-4 md:hidden">
          <div className="flex flex-col gap-3">
            {NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="py-1.5 text-[14px] font-medium text-[var(--kn-text-muted)]"
              >
                {item.label}
              </a>
            ))}
            <div className="mt-2 flex items-center gap-2 border-t border-[var(--kn-border)] pt-4">
              <ThemeToggle />
              <Button render={<Link href="/login" />} nativeButton={false} variant="accent" size="sm" className="flex-1">
                Accéder à mon espace
              </Button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => { setDark(document.documentElement.classList.contains("dark")); }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* stockage indisponible */ }
    setDark(next);
  }

  return (
    <button
      onClick={toggle}
      aria-label={dark ? "Passer en thème clair" : "Passer en thème sombre"}
      title={dark ? "Thème clair" : "Thème sombre"}
      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--kn-border)] text-[var(--kn-text-muted)] transition-colors hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]"
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
