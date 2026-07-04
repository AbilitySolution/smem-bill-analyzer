"use client";

import Image from "next/image";
import { useActionState } from "react";
import { login } from "./actions";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, undefined);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--kn-card)] px-4">
      <form
        action={formAction}
        className="w-full max-w-[360px] rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-8 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
      >
        <div className="mb-1 flex justify-center">
          <Image
            src="/ability-logo-dark.png"
            alt="Ability"
            width={479}
            height={483}
            className="h-14 w-auto"
            priority
          />
        </div>
        <p className="mb-7 text-center text-[12px] text-[#9ca3af]">
          Gestion documentaire &amp; factures d&apos;énergie
        </p>

        <label htmlFor="email" className="mb-1.5 block text-[13px] font-medium text-[#374151]">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="mb-4 w-full rounded-md border border-[var(--kn-border)] px-3 py-2 text-[14px] outline-none focus:border-[#111] focus:ring-2 focus:ring-[#111]/10"
        />

        <label htmlFor="password" className="mb-1.5 block text-[13px] font-medium text-[#374151]">
          Mot de passe
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="mb-5 w-full rounded-md border border-[var(--kn-border)] px-3 py-2 text-[14px] outline-none focus:border-[#111] focus:ring-2 focus:ring-[#111]/10"
        />

        {state?.error && (
          <p className="mb-4 text-[13px] text-[#b42318]" role="alert">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full cursor-pointer rounded-md bg-[#111] px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Connexion…" : "Se connecter"}
        </button>
      </form>
    </main>
  );
}
