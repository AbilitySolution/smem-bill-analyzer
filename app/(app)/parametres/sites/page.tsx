import { Building2, Lightbulb, MapPinned } from "lucide-react";
import { requireRole } from "@/lib/auth-guard";
import { createClient } from "@/lib/supabase/server";
import { SettingsPageHeader } from "@/components/parametres/settings-page-header";
import { SitesList, type SiteAffiche } from "@/components/parametres/sites-list";

export default async function SitesPage() {
  const ctx = await requireRole("org_admin");
  const supabase = await createClient();
  const [{ data: sites }, { data: communes }] = await Promise.all([
    supabase
      .from("sites")
      .select("id, nom, categorie, pdl, kva, ampere, commune_id")
      .eq("org_id", ctx.orgId)
      .order("nom"),
    supabase
      .from("communes")
      .select("id, nom, archived")
      .eq("org_id", ctx.orgId)
      .order("nom"),
  ]);

  const communeParId = new Map((communes ?? []).map((commune) => [commune.id, commune]));
  const affiches: SiteAffiche[] = (sites ?? []).map((site) => {
    const commune = communeParId.get(site.commune_id);
    return {
      id: site.id,
      nom: site.nom,
      categorie: site.categorie as SiteAffiche["categorie"],
      pdl: site.pdl,
      kva: site.kva,
      ampere: site.ampere,
      commune: commune?.nom ?? "Commune inconnue",
      communeArchivee: commune?.archived ?? false,
    };
  });

  const batiments = affiches.filter((site) => site.categorie === "batiment").length;
  const eclairage = affiches.filter((site) => site.categorie === "eclairage_public").length;

  return (
    <div>
      <SettingsPageHeader
        eyebrow="Organisation"
        title="Sites"
        description="Consultez les bâtiments et installations d’éclairage public rattachés à chaque commune. Les informations proviennent des factures enregistrées."
        icon={MapPinned}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {[
          { label: "Sites au total", value: affiches.length, icon: MapPinned },
          { label: "Bâtiments", value: batiments, icon: Building2 },
          { label: "Éclairage public", value: eclairage, icon: Lightbulb },
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

      <SitesList sites={affiches} />
    </div>
  );
}
