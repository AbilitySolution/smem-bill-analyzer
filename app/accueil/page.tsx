import Link from "next/link";
import type { Metadata } from "next";
import { AlertTriangle, FileSpreadsheet, Gauge, ShieldCheck, TrendingUp, UploadCloud, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/marketing/site-header";
import { SiteFooter } from "@/components/marketing/site-footer";
import { ProductDemo } from "@/components/marketing/product-demo";

export const metadata: Metadata = {
  title: "Ability — Vos factures d'énergie, enfin lisibles",
  description: "Centralisez, vérifiez et analysez la consommation électrique de vos sites — sans ressaisie manuelle.",
};

const FEATURES = [
  {
    icon: Zap,
    title: "Extraction automatique par IA",
    description: "Déposez vos factures d'énergie : les données clés sont extraites et vérifiées automatiquement.",
  },
  {
    icon: Gauge,
    title: "Analyse de consommation",
    description: "Suivez la consommation de chaque site dans le temps, comparez les périodes et repérez les tendances en un coup d'œil.",
  },
  {
    icon: AlertTriangle,
    title: "Détection d'anomalies",
    description: "Pics de consommation, écarts de coût , données manquantes : les anomalies sont signalées automatiquement, site par site.",
  },
  {
    icon: FileSpreadsheet,
    title: "Rapports exportables",
    description: "Générez des rapports de synthèse ou par site, prêts à partager, sans ressaisie manuelle dans un tableur.",
  },
];

const STEPS = [
  {
    icon: UploadCloud,
    title: "Déposez vos factures",
    description: "Glissez vos factures d'énergie, un par un ou en lot, depuis l'interface ou un lien de dépôt.",
  },
  {
    icon: Zap,
    title: "L'IA extrait les données",
    description: "Les données sont extraits et pré-vérifiés avant validation.",
  },
  {
    icon: ShieldCheck,
    title: "Analysez et sécurisez",
    description: "Consultez vos analyses de consommation et laissez le système signaler les anomalies à traiter.",
  },
];

export default function VitrinePage() {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--kn-page)]">
      <style>{`
        @keyframes fade-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .fade-up { animation: fade-up 600ms cubic-bezier(.16,1,.3,1) both; }
        @media (prefers-reduced-motion: reduce) {
          .fade-up { animation: none; opacity: 1; transform: none; }
        }
      `}</style>

      <SiteHeader />

      <main className="flex-1">
        {/* ── Hero ── */}
        <section className="relative overflow-hidden px-6 pb-20 pt-16 md:pb-28 md:pt-24">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-40 -top-40 size-[560px] rounded-full opacity-30 blur-3xl"
            style={{ background: "radial-gradient(circle, #f97316 0%, transparent 70%)" }}
          />

          <div className="relative mx-auto max-w-3xl text-center">
            <h1
              className="fade-up font-heading text-4xl font-semibold leading-[1.1] tracking-tight text-[var(--kn-text)] md:text-6xl"
              style={{ animationDelay: "80ms" }}
            >
              Vos factures d&apos;énergie,
              <br />
              enfin lisibles.
            </h1>

            <p
              className="fade-up mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-[var(--kn-text-muted)] md:text-base"
              style={{ animationDelay: "160ms" }}
            >
              Centralisez, vérifiez et analysez la consommation électrique de vos sites — sans ressaisie manuelle.
            </p>

            <div className="fade-up mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row" style={{ animationDelay: "220ms" }}>
              <Button render={<Link href="/login" />} nativeButton={false} variant="accent" size="lg" className="w-full sm:w-auto">
                Accéder à mon espace
              </Button>
              <Button render={<a href="#fonctionnalites" />} nativeButton={false} variant="outline" size="lg" className="w-full sm:w-auto">
                Découvrir les fonctionnalités
              </Button>
            </div>
          </div>
        </section>

        {/* ── Fonctionnalités ── */}
        <section id="fonctionnalites" className="border-t border-[var(--kn-border)] bg-[var(--kn-panel)] px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <div className="mx-auto max-w-xl text-center">
              <h2 className="font-heading text-2xl font-semibold tracking-tight text-[var(--kn-text)] md:text-3xl">
                Tout ce qu&apos;il faut pour piloter vos factures
              </h2>
              <p className="mt-3 text-[14px] text-[var(--kn-text-muted)]">
                De l&apos;extraction à l&apos;analyse, une seule plateforme pour l&apos;ensemble de vos sites.
              </p>
            </div>

            <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map(({ icon: Icon, title, description }) => (
                <div key={title} className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-5">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-[var(--kn-yellow-soft)] text-[#ea580c]">
                    <Icon className="size-4.5" />
                  </span>
                  <h3 className="mt-4 text-[14px] font-semibold text-[var(--kn-text)]">{title}</h3>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--kn-text-muted)]">{description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Comment ça marche ── */}
        <section id="comment-ca-marche" className="px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <div className="mx-auto max-w-xl text-center">
              <h2 className="font-heading text-2xl font-semibold tracking-tight text-[var(--kn-text)] md:text-3xl">
                Comment ça marche
              </h2>
              <p className="mt-3 text-[14px] text-[var(--kn-text-muted)]">Trois étapes, sans ressaisie manuelle.</p>
            </div>

            <div className="mt-12 grid grid-cols-1 gap-8 sm:grid-cols-3">
              {STEPS.map(({ icon: Icon, title, description }, i) => (
                <div key={title} className="relative text-center">
                  <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-[var(--kn-border)] bg-[var(--kn-card)]">
                    <Icon className="size-5 text-[#ea580c]" />
                  </div>
                  <p className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">
                    Étape {i + 1}
                  </p>
                  <h3 className="mt-1 text-[15px] font-semibold text-[var(--kn-text)]">{title}</h3>
                  <p className="mx-auto mt-1.5 max-w-xs text-[13px] leading-relaxed text-[var(--kn-text-muted)]">{description}</p>
                </div>
              ))}
            </div>

            <div className="mt-16">
              <ProductDemo />
            </div>
          </div>
        </section>

        {/* ── CTA final ── */}
        <section className="border-t border-[var(--kn-border)] bg-[var(--kn-panel)] px-6 py-16">
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-5 text-center">
            <TrendingUp className="size-8 text-[#ea580c]" />
            <h2 className="font-heading text-2xl font-semibold tracking-tight text-[var(--kn-text)] md:text-3xl">
              Prêt à reprendre le contrôle de vos factures ?
            </h2>
            <Button render={<Link href="/login" />} nativeButton={false} variant="accent" size="lg">
              Accéder à mon espace
            </Button>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
