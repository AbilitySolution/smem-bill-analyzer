"use client";

import { useRef, useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { inviteUser } from "@/app/(app)/parametres/actions";

/**
 * Invitation d'un utilisateur. Le rôle n'est volontairement pas demandé ici : tout compte
 * invité arrive Membre (défaut posé en base), l'administrateur l'élève ensuite depuis le
 * tableau ci-dessous. Une seule décision à la fois, et jamais de droits accordés par
 * inadvertance au moment de la création.
 */
export function InviteForm() {
  const emailRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ ton: "ok" | "erreur"; texte: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    const email = emailRef.current?.value?.trim() ?? "";
    if (!email) return;
    setMessage(null);
    startTransition(async () => {
      const res = await inviteUser(email);
      if ("error" in res && res.error) {
        setMessage({ ton: "erreur", texte: res.error });
        return;
      }
      setMessage({ ton: "ok", texte: `Invitation envoyée à ${email}. Le compte arrive en Membre.` });
      if (emailRef.current) emailRef.current.value = "";
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-end gap-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--kn-text-muted)]" htmlFor="invite-email">
            Inviter un utilisateur
          </label>
          <Input
            id="invite-email"
            ref={emailRef}
            type="email"
            placeholder="prenom.nom@exemple.fr"
            className="w-64"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <Button type="button" onClick={submit} disabled={pending}>
          {pending ? "Envoi…" : "Inviter"}
        </Button>
      </div>
      {message && (
        <p className={message.ton === "ok" ? "text-xs text-emerald-700 dark:text-emerald-400" : "text-xs text-red-600 dark:text-red-400"}>
          {message.texte}
        </p>
      )}
    </div>
  );
}
