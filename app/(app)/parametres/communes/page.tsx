import Link from "next/link";
import { Archive, Building2, Landmark, Lightbulb } from "lucide-react";
import { requireRole } from "@/lib/auth-guard";
import { createClient } from "@/lib/supabase/server";
import { getCommunesDisponibles } from "@/lib/communes/disponibles";
import { CommuneForm } from "@/components/parametres/commune-form";
import { CommuneCard, type CommuneAffichee } from "@/components/parametres/commune-card";
import { SettingsPageHeader } from "@/components/parametres/settings-page-header";

export default async function CommunesPage({
  searchParams,
}: {
  searchParams: Promise<{ archivees?: string }>;
}) {
  const afficherArchivees = (await searchParams).archivees === "1";
  const ctx = await requireRole("org_admin");
  const supabase = await createClient();

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
  const actives = toutes.filter((commune) => !commune.archived);
  const archivees = toutes.filter((commune) => commune.archived);
  const sitesActifs = (sites ?? []).filter((site) =>
    actives.some((commune) => commune.id === site.commune_id),
  );
  const visibles: CommuneAffichee[] = toutes
    .filter((commune) => afficherArchivees || !commune.archived)
    .map((commune) => {
      const sitesCommune = (sites ?? []).filter((site) => site.commune_id === commune.id);
      return {
        id: commune.id,
        nom: commune.nom,
        codeInsee: commune.code_insee,
        archived: commune.archived,
        pointsLumineux: commune.points_lumineux,
        armoires: commune.armoires,
        travauxDebut: commune.travaux_debut,
        travauxFin: commune.travaux_fin,
        batiments: sitesCommune.filter((site) => site.categorie === "batiment").length,
        eclairage: sitesCommune.filter((site) => site.categorie === "eclairage_public").length,
      };
    });

  const statistiques = [
    { label: "Communes actives", value: actives.length, icon: Landmark },
    { label: "Bâtiments", value: sitesActifs.filter((site) => site.categorie === "batiment").length, icon: Building2 },
    { label: "Sites d’éclairage", value: sitesActifs.filter((site) => site.categorie === "eclairage_public").length, icon: Lightbulb },
  ];

  return (
    <div>
      <SettingsPageHeader
        eyebrow="Organisation"
        title="Communes"
        description="Ajoutez les communes suivies par votre organisation et maintenez leurs informations métier sans perdre l’historique associé."
        icon={Landmark}
        action={<CommuneForm creables={disponibles.creables} archivees={disponibles.archivees} />}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {statistiques.map((statistique) => (
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

      <section className="rounded-2xl border border-[var(--kn-border)] bg-[var(--kn-card)] shadow-sm">
        <div className="flex flex-col gap-3 border-b border-[var(--kn-border)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-heading text-base font-semibold text-[var(--kn-text)]">
              Référentiel des communes
            </h3>
            <p className="mt-0.5 text-xs text-[var(--kn-text-muted)]">
              {actives.length} commune{actives.length > 1 ? "s" : ""} active{actives.length > 1 ? "s" : ""}
            </p>
          </div>
          {archivees.length > 0 && (
            <Link
              href={afficherArchivees ? "/parametres/communes" : "/parametres/communes?archivees=1"}
              className="inline-flex items-center gap-1.5 self-start rounded-lg px-2.5 py-2 text-xs font-medium text-[var(--kn-text-muted)] transition-colors hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)] sm:self-auto"
            >
              <Archive className="size-3.5" />
              {afficherArchivees
                ? "Masquer les archivées"
                : `Afficher ${archivees.length} archivée${archivees.length > 1 ? "s" : ""}`}
            </Link>
          )}
        </div>

        <div className="grid gap-3 p-4 lg:grid-cols-2">
          {visibles.map((commune) => (
            <CommuneCard key={commune.id} commune={commune} estAdmin />
          ))}
          {visibles.length === 0 && (
            <div className="col-span-full rounded-xl border border-dashed border-[var(--kn-border)] px-6 py-12 text-center">
              <Landmark className="mx-auto size-8 text-[var(--kn-text-muted)]" strokeWidth={1.5} />
              <p className="mt-3 text-sm font-medium text-[var(--kn-text)]">Aucune commune enregistrée</p>
              <p className="mt-1 text-xs text-[var(--kn-text-muted)]">
                Ajoutez votre première commune pour commencer à organiser les sites.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
