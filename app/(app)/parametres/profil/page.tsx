import { CalendarDays, Mail, ShieldCheck, UserRound } from "lucide-react";
import { requireRole } from "@/lib/auth-guard";
import { ROLE_LABELS } from "@/lib/authz";
import { createClient } from "@/lib/supabase/server";
import { ProfileForm } from "@/components/parametres/profile-form";
import { SettingsPageHeader } from "@/components/parametres/settings-page-header";

export default async function ProfilPage() {
  const ctx = await requireRole("org_admin");
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  const metadata = user?.user_metadata ?? {};
  const fullName = typeof metadata.full_name === "string" ? metadata.full_name : "";
  const avatarUrl = typeof metadata.avatar_url === "string" ? metadata.avatar_url : "";
  const createdAt = user?.created_at
    ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date(user.created_at))
    : "—";

  return (
    <div>
      <SettingsPageHeader
        eyebrow="Votre compte"
        title="Profil utilisateur"
        description="Personnalisez les informations qui vous représentent dans Ability sans modifier vos droits d’accès."
        icon={UserRound}
      />

      <ProfileForm
        email={ctx.email ?? "Adresse inconnue"}
        initialFullName={fullName}
        initialAvatarUrl={avatarUrl}
      />

      <section className="mt-6 rounded-2xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-5 shadow-sm">
        <h3 className="font-heading text-base font-semibold text-[var(--kn-text)]">Informations du compte</h3>
        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            { label: "Adresse e-mail", value: ctx.email ?? "—", icon: Mail },
            { label: "Rôle", value: ROLE_LABELS[ctx.role], icon: ShieldCheck },
            { label: "Compte créé le", value: createdAt, icon: CalendarDays },
          ].map((information) => (
            <div key={information.label} className="rounded-xl bg-[var(--kn-panel)] p-4">
              <dt className="flex items-center gap-2 text-xs text-[var(--kn-text-muted)]">
                <information.icon className="size-3.5" />
                {information.label}
              </dt>
              <dd className="mt-2 break-words text-sm font-medium text-[var(--kn-text)]">{information.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
