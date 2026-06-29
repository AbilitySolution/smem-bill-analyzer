import { redirect } from "next/navigation";
import { getUserContext } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RoleRow } from "@/components/parametres/role-row";
import { Building2, Lightbulb } from "lucide-react";

export default async function ParametresPage() {
  const ctx = await getUserContext();
  if (!ctx) redirect("/login");
  if (ctx.role !== "admin_smem") {
    return <p className="text-sm text-slate-500">Réservé aux administrateurs SMEM.</p>;
  }

  const supabase = await createClient();
  const { data: communes } = await supabase.from("communes").select("id, nom").order("nom");
  const { data: sites } = await supabase.from("sites").select("commune_id, categorie");

  const admin = createAdminClient();
  const { data: usersData } = await admin.auth.admin.listUsers();
  const { data: roles } = await admin.from("user_roles").select("*");
  const roleMap = new Map((roles ?? []).map((r) => [r.user_id, r]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Paramètres</h1>
        <p className="text-sm text-slate-500">Communes, sites et rôles utilisateurs.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-slate-700">Communes</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {(communes ?? []).map((c) => {
            const ofCommune = (sites ?? []).filter((s) => s.commune_id === c.id);
            return (
              <div key={c.id} className="rounded-md border border-slate-200 p-3">
                <p className="font-medium text-slate-900">{c.nom}</p>
                <div className="mt-1 flex gap-4 text-xs text-slate-500">
                  <span className="flex items-center gap-1">
                    <Building2 className="size-3.5" />
                    {ofCommune.filter((s) => s.categorie === "batiment").length} bâtiments
                  </span>
                  <span className="flex items-center gap-1">
                    <Lightbulb className="size-3.5" />
                    {ofCommune.filter((s) => s.categorie === "eclairage_public").length} éclairage
                  </span>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-slate-700">Utilisateurs &amp; rôles</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-slate-200 text-xs text-slate-500">
                <th className="py-2">Email</th>
                <th className="py-2">Rôle</th>
                <th className="py-2">Commune</th>
              </tr>
            </thead>
            <tbody>
              {(usersData?.users ?? []).map((u) => {
                const r = roleMap.get(u.id);
                return (
                  <RoleRow
                    key={u.id}
                    userId={u.id}
                    email={u.email ?? u.id}
                    role={(r?.role as "admin_smem" | "agent_commune") ?? "agent_commune"}
                    communeId={r?.commune_id ?? null}
                    communes={communes ?? []}
                  />
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
