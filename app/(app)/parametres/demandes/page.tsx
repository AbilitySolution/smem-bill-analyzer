import Link from "next/link";
import { requireRole } from "@/lib/auth-guard";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateLinkForm } from "@/components/parametres/create-link-form";
import { CopyLinkButton } from "@/components/parametres/copy-link-button";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { FileText, Inbox } from "lucide-react";
import { SettingsPageHeader } from "@/components/parametres/settings-page-header";

export default async function DemandesPage() {
  // Les liens de dépôt donnent un accès non authentifié au dépôt de factures :
  // leur création reste une prérogative d'administrateur.
  const ctx = await requireRole("org_admin");

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
      <SettingsPageHeader
        eyebrow="Organisation"
        title="Liens de dépôt"
        description="Générez un lien public sécurisé pour qu’une commune dépose ses factures sans créer de compte."
        icon={Inbox}
      />

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-[var(--kn-text)]">Créer un lien</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateLinkForm communes={communes ?? []} />
        </CardContent>
      </Card>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-[var(--kn-text)]">Liens actifs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(links ?? []).map((l) => (
            <div key={l.id} className="flex items-center justify-between rounded-xl border border-[var(--kn-border)] p-3">
              <div>
                <p className="text-sm font-medium text-[var(--kn-text)]">
                  {(l as unknown as { communes: { nom: string } | null }).communes?.nom}
                </p>
                <p className="text-xs text-[var(--kn-text-muted)]">{l.label || "Sans message"}</p>
              </div>
              <CopyLinkButton path={`/depot/${l.token}`} />
            </div>
          ))}
          {(links ?? []).length === 0 && (
            <p className="text-sm text-[var(--kn-text-muted)]">Aucun lien créé pour le moment.</p>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-[var(--kn-text)]">
            Fichiers déposés en attente de traitement
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(pending ?? []).map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-xl border border-[var(--kn-border)] p-3">
              <div className="flex items-center gap-2">
                <FileText className="size-4 text-[var(--kn-text-muted)]" />
                <div>
                  <p className="text-sm font-medium text-[var(--kn-text)]">{p.original_name}</p>
                  <p className="text-xs text-[var(--kn-text-muted)]">
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
            <p className="text-sm text-[var(--kn-text-muted)]">Aucun dépôt en attente.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
