"use client";

import { useState, useTransition } from "react";
import { Check, ImageIcon, Save } from "lucide-react";
import { updateOwnProfile } from "@/app/(app)/parametres/actions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ProfileForm({
  email,
  initialFullName,
  initialAvatarUrl,
}: {
  email: string;
  initialFullName: string;
  initialAvatarUrl: string;
}) {
  const [fullName, setFullName] = useState(initialFullName);
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const initials = (fullName || email)
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((partie) => partie[0]?.toUpperCase())
    .join("");

  function enregistrer() {
    setMessage(null);
    startTransition(async () => {
      const resultat = await updateOwnProfile({ fullName, avatarUrl });
      if ("error" in resultat && resultat.error) {
        setMessage({ type: "error", text: resultat.error });
        return;
      }
      setMessage({ type: "success", text: "Votre profil a bien été mis à jour." });
    });
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--kn-border)] bg-[var(--kn-card)] shadow-sm">
      <div className="border-b border-[var(--kn-border)] px-5 py-4">
        <h3 className="font-heading text-base font-semibold text-[var(--kn-text)]">Identité visible</h3>
        <p className="mt-0.5 text-xs text-[var(--kn-text-muted)]">
          Ces informations servent à vous identifier dans l’application et les historiques d’activité.
        </p>
      </div>

      <div className="grid gap-8 p-5 lg:grid-cols-[220px_minmax(0,1fr)] lg:p-6">
        <div className="flex flex-col items-center rounded-2xl bg-[var(--kn-panel)] p-6 text-center">
          <Avatar className="size-24 text-xl" aria-label="Aperçu de la photo de profil">
            {avatarUrl && <AvatarImage src={avatarUrl} alt="Photo de profil" />}
            <AvatarFallback className="bg-[var(--kn-solid)] text-lg font-semibold text-[var(--kn-solid-fg)]">
              {initials || "?"}
            </AvatarFallback>
          </Avatar>
          <p className="mt-4 max-w-full truncate text-sm font-semibold text-[var(--kn-text)]">
            {fullName || "Nom non renseigné"}
          </p>
          <p className="mt-1 max-w-full truncate text-xs text-[var(--kn-text-muted)]">{email}</p>
        </div>

        <div className="space-y-5">
          <div>
            <label htmlFor="profile-name" className="mb-1.5 block text-xs font-semibold text-[var(--kn-text)]">
              Nom complet
            </label>
            <Input
              id="profile-name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Ex. Marie Dupont"
              maxLength={80}
              className="h-9"
            />
            <p className="mt-1.5 text-xs text-[var(--kn-text-muted)]">
              Le nom affiché dans votre espace de travail.
            </p>
          </div>

          <div>
            <label htmlFor="profile-avatar" className="mb-1.5 block text-xs font-semibold text-[var(--kn-text)]">
              Photo de profil
            </label>
            <div className="relative">
              <ImageIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--kn-text-muted)]" />
              <Input
                id="profile-avatar"
                type="url"
                value={avatarUrl}
                onChange={(event) => setAvatarUrl(event.target.value)}
                placeholder="https://exemple.fr/ma-photo.jpg"
                className="h-9 pl-9"
              />
            </div>
            <p className="mt-1.5 text-xs text-[var(--kn-text-muted)]">
              Collez l’adresse publique d’une image carrée. L’aperçu se met à jour immédiatement.
            </p>
          </div>

          <div className="flex flex-col gap-3 border-t border-[var(--kn-border)] pt-5 sm:flex-row sm:items-center sm:justify-between">
            <div aria-live="polite">
              {message && (
                <p
                  className={`flex items-center gap-1.5 text-xs ${
                    message.type === "success"
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-red-600 dark:text-red-400"
                  }`}
                >
                  {message.type === "success" && <Check className="size-3.5" />}
                  {message.text}
                </p>
              )}
            </div>
            <Button onClick={enregistrer} disabled={pending} className="sm:min-w-32">
              <Save className="size-4" />
              {pending ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
