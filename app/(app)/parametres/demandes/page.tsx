import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateLinkForm } from "@/components/parametres/create-link-form";
import { CopyLinkButton } from "@/components/parametres/copy-link-button";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { FileText } from "lucide-react";

export default async function DemandesPage() {
  const ctx = await getUserContext();
  if (!ctx) redirect("/login");

  const supabase = await createClient();
  const { data: communes } = await supabase.from("communes").select("id, nom").eq("org_id", ctx.orgId).eq("archived", false).order("nom");

  const { data: links } = await supabase
    .from("file_request_links")
    .select("*, communes(nom)")
    .eq("org_id", ctx.orgId)
    .order("created_at", { ascending: false });

  const { data: pending } = await supabase
    .from("pending_uploads")
    .select("*, communes(nom)")
    .eq("org_id", ctx.orgId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Demandes de fichier</h1>
        <p className="text-sm text-slate-500">
          Générez un lien public pour qu&apos;une commune dépose ses factures sans compte.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-slate-700">Créer un lien</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateLinkForm communes={communes ?? []} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-slate-700">Liens actifs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(links ?? []).map((l) => (
            <div key={l.id} className="flex items-center justify-between rounded-md border border-slate-200 p-2.5">
              <div>
                <p className="text-sm font-medium text-slate-900">
                  {(l as unknown as { communes: { nom: string } | null }).communes?.nom}
                </p>
                <p className="text-xs text-slate-500">{l.label || "Sans message"}</p>
              </div>
              <CopyLinkButton path={`/depot/${l.token}`} />
            </div>
          ))}
          {(links ?? []).length === 0 && (
            <p className="text-sm text-slate-400">Aucun lien créé pour le moment.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-slate-700">
            Fichiers déposés en attente de traitement
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(pending ?? []).map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-md border border-slate-200 p-2.5">
              <div className="flex items-center gap-2">
                <FileText className="size-4 text-slate-400" />
                <div>
                  <p className="text-sm font-medium text-slate-900">{p.original_name}</p>
                  <p className="text-xs text-slate-500">
                    {(p as unknown as { communes: { nom: string } | null }).communes?.nom} ·{" "}
                    {formatDate(p.created_at)}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                nativeButton={false}
                render={<Link href={`/upload?pending=${p.id}`}>Traiter</Link>}
              />
            </div>
          ))}
          {(pending ?? []).length === 0 && (
            <p className="text-sm text-slate-400">Aucun dépôt en attente.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
