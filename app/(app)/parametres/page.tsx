import Link from "next/link";
import { requireRole } from "@/lib/auth-guard";
import { isUserRole } from "@/lib/authz";
import type { UserRole } from "@/lib/types/database";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getCommunesDisponibles } from "@/lib/communes/disponibles";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RoleRow } from "@/components/parametres/role-row";
import { CommuneForm } from "@/components/parametres/commune-form";
import { InviteForm } from "@/components/parametres/invite-form";
import { CommuneCard, type CommuneAffichee } from "@/components/parametres/commune-card";

export default async function ParametresPage({
  searchParams,
}: {
  searchParams: Promise<{ archivees?: string }>;
}) {
  const sp = await searchParams;
  const afficherArchivees = sp.archivees === "1";

  // Renvoi vers /documents plutôt qu'un message « Réservé aux administrateurs » : la page
  // interrogeait la base avant de refuser, et le message confirmait au passage l'existence
  // du contenu à qui tentait l'URL.
  const ctx = await requireRole("org_admin");

  const supabase = await createClient();
  // org_id explicite en plus de la RLS : le reste du code le fait déjà, cette page était
  // la seule à s'appuyer sur la RLS seule (§1 du PLAN).
  const [{ data: communes }, { data: sites }, disponibles] = await Promise.all([
    supabase
      .from("communes")
      .select("id, nom, code_insee, archived, points_lumineux, armoires, travaux_debut, travaux_fin")
      .eq("org_id", ctx.orgId)
      .order("nom"),
    supabase.from("sites").select("commune_id, categorie").eq("org_id", ctx.orgId),
    getCommunesDisponibles(ctx.orgId),
  ]);

  const toutes = communes ?? [];
  const nbArchivees = toutes.filter((c) => c.archived).length;
  const visibles: CommuneAffichee[] = toutes
    .filter((c) => afficherArchivees || !c.archived)
    .map((c) => {
      const ofCommune = (sites ?? []).filter((s) => s.commune_id === c.id);
      return {
        id: c.id,
        nom: c.nom,
        codeInsee: c.code_insee,
        archived: c.archived,
        pointsLumineux: c.points_lumineux,
        armoires: c.armoires,
        travauxDebut: c.travaux_debut,
        travauxFin: c.travaux_fin,
        batiments: ofCommune.filter((s) => s.categorie === "batiment").length,
        eclairage: ofCommune.filter((s) => s.categorie === "eclairage_public").length,
      };
    });

  const admin = createAdminClient();
  const { data: roles } = await admin.from("user_roles").select("*").eq("org_id", ctx.orgId);
  const roleMap = new Map((roles ?? []).map((r) => [r.user_id, r]));
  // listUsers() liste tout le projet Supabase Auth — on borne aux membres de
  // cette org (résolus individuellement, le volume par org reste petit).
  const users = await Promise.all(
    (roles ?? []).map((r) => admin.auth.admin.getUserById(r.user_id).then((res) => res.data.user)),
  );

  // Le sélecteur de commune des rôles ne doit proposer que des communes actives.
  const communesActives = toutes.filter((c) => !c.archived).map((c) => ({ id: c.id, nom: c.nom }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Paramètres</h1>
        <p className="text-sm text-slate-500">Communes, sites et rôles utilisateurs.</p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle className="text-sm font-medium text-slate-700">
            Communes
            <span className="ml-2 font-normal text-slate-400">
              {communesActives.length} active{communesActives.length > 1 ? "s" : ""}
            </span>
          </CardTitle>
          <div className="flex items-center gap-3">
            {nbArchivees > 0 && (
              <Link
                href={afficherArchivees ? "/parametres" : "/parametres?archivees=1"}
                className="text-xs text-slate-500 underline-offset-2 hover:underline"
              >
                {afficherArchivees
                  ? "Masquer les archivées"
                  : `Afficher les ${nbArchivees} archivée${nbArchivees > 1 ? "s" : ""}`}
              </Link>
            )}
            <CommuneForm creables={disponibles.creables} archivees={disponibles.archivees} />
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {visibles.map((c) => (
            <CommuneCard key={c.id} commune={c} estAdmin />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <CardTitle className="text-sm font-medium text-slate-700">Utilisateurs &amp; rôles</CardTitle>
          <InviteForm />
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
              {users.filter((u) => u != null).map((u) => {
                const r = roleMap.get(u.id);
                // Une valeur inconnue (rôle d'avant le multi-tenant, ligne bricolée en base)
                // retombe sur le rôle le plus restreint plutôt que d'être affichée telle quelle.
                const roleBrut = r?.role;
                const roleAffiche: UserRole = isUserRole(roleBrut) ? roleBrut : "org_member";
                return (
                  <RoleRow
                    key={u.id}
                    userId={u.id}
                    email={u.email ?? u.id}
                    role={roleAffiche}
                    communeId={r?.commune_id ?? null}
                    communes={communesActives}
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
