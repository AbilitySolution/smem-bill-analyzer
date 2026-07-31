"use client";

import Image from "next/image";
import Link from "next/link";
import { useActionState, useState } from "react";
import { AlertCircle, ArrowLeft, Eye, EyeOff, Loader2, ShieldCheck, TrendingUp, Zap } from "lucide-react";
import { login } from "./actions";

const inputCls =
  "w-full rounded-lg border border-[var(--kn-border)] bg-[var(--kn-panel)] px-3 py-2.5 text-[14px] text-[var(--kn-text)] outline-none transition-colors placeholder:text-[var(--kn-text-muted)] focus:border-[#f97316] focus:ring-2 focus:ring-[#f97316]/15";

// Hauteurs figées (pas de Math.random au rendu — évite un mismatch d'hydratation)
// pour évoquer une courbe de consommation kWh sans dépendance graphique.
const BARS = [38, 52, 34, 61, 47, 70, 55, 40, 66, 45, 58, 72, 50, 63, 42, 68, 56, 48, 74, 60, 44, 65, 53, 37];

const FEATURES = [
  { icon: Zap, label: "Extraction automatique des données des factures." },
  { icon: TrendingUp, label: "Prévision de consommation site par site" },
  { icon: ShieldCheck, label: "Détection d'anomalies et erreurs de facturation" },
];

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, undefined);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <main className="grid min-h-screen grid-cols-1 lg:grid-cols-[1.15fr_1fr]">
      <style>{`
        @keyframes bar-rise { from { transform: scaleY(0); } to { transform: scaleY(1); } }
        @keyframes bar-pulse {
          0%, 100% { transform: scaleY(1); }
          25% { transform: scaleY(0.93); }
          55% { transform: scaleY(1.1); }
          80% { transform: scaleY(0.97); }
        }
        @keyframes fade-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .bar-rise { transform-origin: bottom; animation-name: bar-rise, bar-pulse; animation-timing-function: cubic-bezier(.16,1,.3,1), ease-in-out; animation-fill-mode: both; animation-iteration-count: 1, infinite; }
        .fade-up { animation: fade-up 600ms cubic-bezier(.16,1,.3,1) both; }
        @media (prefers-reduced-motion: reduce) {
          .bar-rise { animation: none; transform: scaleY(1); }
          .fade-up { animation: none; opacity: 1; transform: none; }
        }
      `}</style>

      {/* ── Panneau gauche : identité produit ── */}
      <div className="relative hidden overflow-hidden bg-[#111318] lg:flex lg:flex-col lg:justify-between lg:p-14">
        {/* Texture points + halo orange */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: "radial-gradient(circle, #fff 1px, transparent 1px)", backgroundSize: "22px 22px" }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 -top-40 size-[560px] rounded-full opacity-40 blur-3xl"
          style={{ background: "radial-gradient(circle, #f97316 0%, transparent 70%)" }}
        />

        <div className="relative fade-up flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Image src="/ability-mark.png" alt="" width={32} height={32} className="size-8" priority />
            <span className="font-display text-[15px] font-semibold tracking-wide text-white">Ability</span>
          </div>
          <Link href="/accueil" className="flex items-center gap-1.5 text-[13px] font-medium text-[#9ba1ad] transition-colors hover:text-white">
            <ArrowLeft className="size-3.5" /> Accueil
          </Link>
        </div>

        <div className="relative">
          <h1 className="fade-up font-display text-[44px] font-semibold leading-[1.05] tracking-tight text-white" style={{ animationDelay: "80ms" }}>
            Vos factures d&apos;énergie,
            <br />
            enfin lisibles.
          </h1>
          <p className="fade-up mt-5 max-w-[420px] text-[15px] leading-relaxed text-[#9ba1ad]" style={{ animationDelay: "160ms" }}>
            Centralisez, vérifiez et analysez la consommation électrique de vos sites.
          </p>

          {/* Motif barres — évoque une courbe de consommation kWh */}
          <div className="fade-up mt-10 flex h-24 items-end gap-1" style={{ animationDelay: "220ms" }}>
            {BARS.map((h, i) => {
              const riseDelay = 260 + i * 22;
              const pulseDuration = 2400 + (i % 5) * 340; // vitesse propre à chaque barre → mouvement non synchrone
              const pulseDelay = riseDelay + 900 + (i % 7) * 90; // décalage additionnel pour casser l'effet de vague uniforme
              return (
                <div
                  key={i}
                  className="bar-rise flex-1 rounded-sm"
                  style={{
                    height: `${h}%`,
                    animationDuration: `900ms, ${pulseDuration}ms`,
                    animationDelay: `${riseDelay}ms, ${pulseDelay}ms`,
                    background: i % 6 === 4
                      ? "linear-gradient(180deg, #fb923c, #f97316)"
                      : "linear-gradient(180deg, #2a2f37, #1c1f25)",
                  }}
                />
              );
            })}
          </div>

          <ul className="fade-up mt-10 flex flex-col gap-3" style={{ animationDelay: "320ms" }}>
            {FEATURES.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-3 text-[13px] text-[#c3c8d1]">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.06] text-[#f97316]">
                  <Icon className="size-3.5" />
                </span>
                {label}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative fade-up text-[12px] text-[#6b7180]" style={{ animationDelay: "380ms" }}>
          Gestion documentaire &amp; factures d&apos;énergie
        </p>
      </div>

      {/* ── Panneau droit : formulaire ── */}
      <div className="flex items-center justify-center bg-[var(--kn-page)] px-6 py-12">
        <form action={formAction} className="fade-up w-full max-w-[360px]">
          <div className="mb-8 flex items-center justify-between lg:hidden">
            <Image src="/ability-logo-dark.png" alt="Ability" width={479} height={483} className="h-10 w-auto dark:hidden" priority />
            <Image src="/ability-logo-white.png" alt="Ability" width={479} height={483} className="hidden h-10 w-auto dark:block" priority />
            <Link href="/accueil" className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--kn-text-muted)] transition-colors hover:text-[var(--kn-text)]">
              <ArrowLeft className="size-3.5" /> Accueil
            </Link>
          </div>

          <h2 className="font-heading text-[26px] font-bold text-[var(--kn-text)]">Bon retour</h2>
          <p className="mb-8 mt-1.5 text-[13px] text-[var(--kn-text-muted)]">Connectez-vous pour accéder à votre espace.</p>

          <div className="mb-4 flex flex-col gap-1.5">
            <label htmlFor="email" className="text-[11px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoFocus
              autoComplete="email"
              placeholder="vous@exemple.fr"
              className={inputCls}
            />
          </div>

          <div className="mb-5 flex flex-col gap-1.5">
            <label htmlFor="password" className="text-[11px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">
              Mot de passe
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className={`${inputCls} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                className="absolute right-2.5 top-1/2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-[var(--kn-text-muted)] transition-colors hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          {state?.error && (
            <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              <AlertCircle className="size-4 shrink-0" />
              {state.error}
            </div>
          )}

          <button
            type="submit"
            disabled={pending}
            className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-[var(--kn-solid)] px-4 py-2.5 text-[14px] font-semibold text-[var(--kn-solid-fg)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {pending ? "Connexion…" : "Se connecter"}
          </button>
        </form>
      </div>
    </main>
  );
}
