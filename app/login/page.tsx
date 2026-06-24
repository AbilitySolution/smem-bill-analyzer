"use client";

import { useActionState } from "react";
import { login } from "./actions";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, undefined);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F8FAFC] px-4">
      <form
        action={formAction}
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm"
      >
        <h1 className="mb-1 text-xl font-semibold text-[#1E3A8A]">
          EDF Invoice Analyzer
        </h1>
        <p className="mb-6 text-sm text-slate-600">Connexion à votre compte.</p>

        <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-700">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="mb-4 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[#1E40AF] focus:outline-none focus:ring-2 focus:ring-[#1E40AF]/30"
        />

        <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-700">
          Mot de passe
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="mb-4 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[#1E40AF] focus:outline-none focus:ring-2 focus:ring-[#1E40AF]/30"
        />

        {state?.error && (
          <p className="mb-4 text-sm text-red-600" role="alert">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full cursor-pointer rounded-md bg-[#1E40AF] px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-[#1E3A8A] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Connexion..." : "Se connecter"}
        </button>
      </form>
    </main>
  );
}
