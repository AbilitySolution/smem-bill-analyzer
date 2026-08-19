"use server";

import { revalidatePath } from "next/cache";
import { getUserContext } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isUserRole } from "@/lib/authz";
import type { UserRole } from "@/lib/types/database";
import { REFERENTIEL_MARTINIQUE } from "@/lib/communes/referentiel-martinique";
import { scoreCommune } from "@/lib/extraction/matching";
import {
  creerCommuneSchema,
  modifierCommuneSchema,
  premierMessage,
  type CreerCommuneInput,
  type ModifierCommuneInput,
} from "@/lib/communes/validation";

/**
 * Attribution d'un rôle. Réservée à l'administrateur : un superviseur pilote la donnée,
 * pas les habilitations.
 *
 * Passe par le client service-role, donc hors RLS — d'où la double vérification
 * explicite : appartenance à la même organisation, puis verrou « dernier administrateur ».
 * Ce dernier existe aussi en base (trigger trg_prevent_last_admin_removal) ; on le double
 * ici uniquement pour rendre un message lisible plutôt qu'une erreur Postgres brute.
 */
export async function assignUserRole(userId: string, role: UserRole, communeId: string | null) {
  const ctx = await getUserContext();
  if (!ctx || ctx.role !== "org_admin") return { error: "Non autorisé." };
  if (!isUserRole(role)) return { error: "Rôle inconnu." };

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("user_roles")
    .select("org_id, role")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing && existing.org_id !== ctx.orgId) {
    return { error: "Cet utilisateur appartient déjà à une autre organisation." };
  }

  // Une organisation sans administrateur n'est plus gérable depuis l'application : plus
  // personne ne peut réattribuer de rôle, la remise en état passe par la base. Le cas le
  // plus courant est l'administrateur unique qui se rétrograde lui-même.
  if (existing?.role === "org_admin" && role !== "org_admin") {
    const { count } = await admin
      .from("user_roles")
      .select("user_id", { count: "exact", head: true })
      .eq("org_id", ctx.orgId)
      .eq("role", "org_admin");
    if ((count ?? 0) <= 1) {
      return {
        error:
          "Impossible de retirer le dernier administrateur de l'organisation. Nommez d'abord un autre administrateur.",
      };
    }
  }

  // La commune n'est qu'un préremplissage d'écran pour l'agent qui dépose des factures.
  // Elle n'a pas de sens au-dessus du membre : superviseur comme administrateur
  // travaillent au périmètre de l'organisation entière.
  const { error } = await admin.from("user_roles").upsert({
    user_id: userId,
    role,
    org_id: ctx.orgId,
    commune_id: role === "org_member" ? communeId : null,
  });
  if (error) {
    // Le trigger parle français et s'adresse déjà à l'utilisateur : on le laisse passer.
    if (error.message.includes("dernier administrateur")) return { error: error.message };
    console.error(`[authz] Échec d'attribution de rôle org=${ctx.orgId} user=${userId} : ${error.message}`);
    return { error: "L'attribution du rôle a échoué. Réessayez ou signalez-le à votre administrateur." };
  }

  revalidatePath("/parametres");
  return { success: true };
}

/* ── Communes (SCRUM-14) ──────────────────────────────────────────────────────
 *
 * Toutes ces actions passent par le client RLS, jamais par createAdminClient() : les
 * policies org_admin_* protègent déjà la table, et l'admin client contournerait
 * l'isolation multi-tenant. La vérification `ctx.role === "org_admin"` s'y ajoute —
 * ceinture et bretelles.
 */

/** Score au-delà duquel deux noms de communes sont jugés trop proches pour coexister. */
const SEUIL_HOMONYMIE = 0.8;

export async function createCommune(input: CreerCommuneInput) {
  const ctx = await getUserContext();
  if (!ctx || ctx.role !== "org_admin") return { error: "Non autorisé." };

  const parsed = creerCommuneSchema.safeParse(input);
  if (!parsed.success) return { error: premierMessage(parsed.error) };
  const donnees = parsed.data;

  // Résolution serveur : le client n'a envoyé qu'un code INSEE.
  const entree = REFERENTIEL_MARTINIQUE.find((c) => c.codeInsee === donnees.codeInsee);
  if (!entree) return { error: "Cette commune ne fait pas partie du référentiel de la Martinique." };

  const supabase = await createClient();
  const { data: existantes, error: lectureErr } = await supabase
    .from("communes")
    .select("id, nom, code_insee, archived")
    .eq("org_id", ctx.orgId);
  if (lectureErr) return { error: "Impossible de lire les communes existantes." };

  const dejaLa = (existantes ?? []).find((c) => c.code_insee === entree.codeInsee);
  if (dejaLa) {
    return dejaLa.archived
      ? { error: `« ${dejaLa.nom} » existe déjà mais est archivée. Réactivez-la plutôt que d'en créer une seconde.` }
      : { error: `« ${dejaLa.nom} » est déjà enregistrée.` };
  }

  // Garde-fou (§5 point 6 du PLAN) : un nom très proche d'une commune existante alors que
  // le code INSEE diffère signifie que le rapprochement du lot 1 a raté quelque chose. Ce
  // cas ne doit jamais se produire — s'il se produit, on veut le savoir, pas le contourner.
  const homonyme = (existantes ?? []).find(
    (c) => c.code_insee !== entree.codeInsee && scoreCommune(entree.nom, c.nom) >= SEUIL_HOMONYMIE,
  );
  if (homonyme) {
    console.error(
      `[SCRUM-14] Homonymie bloquante org=${ctx.orgId} : « ${entree.nom} » (${entree.codeInsee}) ` +
        `trop proche de « ${homonyme.nom} » (${homonyme.code_insee}). Rapprochement du référentiel à revoir.`,
    );
    return {
      error: `« ${entree.nom} » ressemble trop à « ${homonyme.nom} », déjà enregistrée. Création bloquée par sécurité, signalez-le à votre administrateur.`,
    };
  }

  const { data: creee, error } = await supabase
    .from("communes")
    .insert({
      org_id: ctx.orgId,
      nom: entree.nom,
      code_insee: entree.codeInsee,
      latitude: entree.latitude,
      longitude: entree.longitude,
      points_lumineux: donnees.pointsLumineux,
      armoires: donnees.armoires,
      travaux_debut: donnees.travauxDebut,
      travaux_fin: donnees.travauxFin,
      travaux_estimes: donnees.travauxEstimes,
    })
    .select("id, nom")
    .single();

  if (error) return { error: messageErreurCommune(error.message) };

  revalidateVuesCommunes();
  return { success: true as const, commune: creee };
}

/** Champs métier uniquement : nom, code INSEE et coordonnées viennent du référentiel. */
export async function updateCommune(id: string, input: ModifierCommuneInput) {
  const ctx = await getUserContext();
  if (!ctx || ctx.role !== "org_admin") return { error: "Non autorisé." };

  const parsed = modifierCommuneSchema.safeParse(input);
  if (!parsed.success) return { error: premierMessage(parsed.error) };
  const donnees = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase
    .from("communes")
    .update({
      points_lumineux: donnees.pointsLumineux,
      armoires: donnees.armoires,
      travaux_debut: donnees.travauxDebut,
      travaux_fin: donnees.travauxFin,
      travaux_estimes: donnees.travauxEstimes,
    })
    .eq("id", id)
    .eq("org_id", ctx.orgId);

  if (error) return { error: messageErreurCommune(error.message) };

  revalidateVuesCommunes();
  return { success: true as const };
}

/**
 * Archivage plutôt que suppression (D4 du PLAN) : `sites`, `file_request_links` et
 * `pending_uploads` sont en ON DELETE CASCADE, un DELETE détruirait les sites sans
 * prévenir, et échouerait de toute façon dès qu'une facture est rattachée.
 */
export async function archiveCommune(id: string) {
  return basculerArchivage(id, true);
}

export async function unarchiveCommune(id: string) {
  return basculerArchivage(id, false);
}

async function basculerArchivage(id: string, archived: boolean) {
  const ctx = await getUserContext();
  if (!ctx || ctx.role !== "org_admin") return { error: "Non autorisé." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("communes")
    .update({ archived })
    .eq("id", id)
    .eq("org_id", ctx.orgId);

  if (error) return { error: messageErreurCommune(error.message) };

  revalidateVuesCommunes();
  return { success: true as const };
}

/** Une commune touche presque toutes les vues — on les revalide toutes. */
function revalidateVuesCommunes() {
  for (const chemin of [
    "/parametres",
    "/analyses/consommation",
    "/rapport-excel",
    "/documents",
    "/upload/review",
  ]) {
    revalidatePath(chemin);
  }
}

/** Pas de message Postgres brut vers l'utilisateur. */
function messageErreurCommune(brut: string): string {
  if (brut.includes("communes_org_code_insee_key")) return "Cette commune est déjà enregistrée.";
  if (brut.includes("communes_org_nom_key")) return "Une commune porte déjà ce nom.";
  if (brut.includes("violates row-level security")) return "Non autorisé.";
  console.error(`[SCRUM-14] Erreur commune non mappée : ${brut}`);
  return "L'opération a échoué. Réessayez ou signalez-le à votre administrateur.";
}

export async function createFileRequestLink(communeId: string, label: string) {
  const ctx = await getUserContext();
  if (!ctx) return { error: "Non autorisé." };

  const admin = createAdminClient();
  const { error } = await admin
    .from("file_request_links")
    .insert({ commune_id: communeId, label, created_by: ctx.userId, org_id: ctx.orgId });

  if (error) return { error: error.message };
  revalidatePath("/parametres/demandes");
  return { success: true };
}
