import { ShieldCheck, UserCog, UsersRound } from "lucide-react";
import { requireRole } from "@/lib/auth-guard";
import { isUserRole } from "@/lib/authz";
import type { UserRole } from "@/lib/types/database";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { InviteForm } from "@/components/parametres/invite-form";
import { RoleRow } from "@/components/parametres/role-row";
import { SettingsPageHeader } from "@/components/parametres/settings-page-header";

export default async function UtilisateursPage() {
  const ctx = await requireRole("org_admin");
  const supabase = await createClient();
  const { data: communes } = await supabase
    .from("communes")
    .select("id, nom")
    .eq("org_id", ctx.orgId)
    .eq("archived", false)
    .order("nom");

  const admin = createAdminClient();
  const { data: roles } = await admin.from("user_roles").select("*").eq("org_id", ctx.orgId);
  const roleMap = new Map((roles ?? []).map((role) => [role.user_id, role]));
  const users = await Promise.all(
    (roles ?? []).map((role) =>
      admin.auth.admin.getUserById(role.user_id).then((resultat) => resultat.data.user),
    ),
  );
  const membres = users.filter((user) => user != null);
  const administrateurs = (roles ?? []).filter((role) => role.role === "org_admin").length;

  return (
    <div>
      <SettingsPageHeader
        eyebrow="Utilisateurs"
        title="Accès et rôles"
        description="Invitez les membres de votre organisation et définissez précisément leur niveau d’accès ainsi que leur commune par défaut."
        icon={UsersRound}
        action={<InviteForm />}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {[
          { label: "Utilisateurs", value: membres.length, icon: UsersRound },
          { label: "Administrateurs", value: administrateurs, icon: ShieldCheck },
          {
            label: "Autres rôles",
            value: Math.max(membres.length - administrateurs, 0),
            icon: UserCog,
          },
        ].map((statistique) => (
          <div
            key={statistique.label}
            className="flex items-center gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] px-4 py-3.5 shadow-sm"
          >
            <div className="flex size-9 items-center justify-center rounded-lg bg-[var(--kn-panel)] text-[var(--kn-text-muted)]">
              <statistique.icon className="size-4" strokeWidth={1.8} />
            </div>
            <div>
              <p className="text-xl font-semibold tabular-nums text-[var(--kn-text)]">{statistique.value}</p>
              <p className="text-xs text-[var(--kn-text-muted)]">{statistique.label}</p>
            </div>
          </div>
        ))}
      </div>

      <section className="overflow-hidden rounded-2xl border border-[var(--kn-border)] bg-[var(--kn-card)] shadow-sm">
        <div className="border-b border-[var(--kn-border)] px-5 py-4">
          <h3 className="font-heading text-base font-semibold text-[var(--kn-text)]">Membres de l’organisation</h3>
          <p className="mt-0.5 text-xs text-[var(--kn-text-muted)]">
            Les nouveaux comptes arrivent avec le rôle Membre, puis peuvent être ajustés ici.
          </p>
        </div>
        <div className="overflow-x-auto px-5 pb-3">
          <table className="w-full min-w-[650px] text-left">
            <thead>
              <tr className="border-b border-[var(--kn-border)] text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--kn-text-muted)]">
                <th className="py-3 pr-4">Compte</th>
                <th className="px-4 py-3">Rôle</th>
                <th className="py-3 pl-4">Commune par défaut</th>
              </tr>
            </thead>
            <tbody>
              {membres.map((user) => {
                const role = roleMap.get(user.id);
                const roleAffiche: UserRole = isUserRole(role?.role) ? role.role : "org_member";
                return (
                  <RoleRow
                    key={user.id}
                    userId={user.id}
                    email={user.email ?? user.id}
                    role={roleAffiche}
                    communeId={role?.commune_id ?? null}
                    communes={communes ?? []}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
