import { createClient } from "@/lib/supabase/server";
import { REFERENTIEL_MARTINIQUE, type CommuneReferentiel } from "./referentiel-martinique";

/**
 * SCRUM-14 (lot 2) — Ce que le sélecteur d'ajout de commune peut proposer.
 *
 * Le domaine est fermé : 34 communes en Martinique. La liste proposée, c'est le
 * référentiel MOINS ce que l'organisation possède déjà. Le rapprochement se fait
 * **par `code_insee`**, jamais par nom — une org peut très bien avoir « Carbet »
 * là où le référentiel dit « Le Carbet », c'est le même 97204.
 */

export interface CommuneArchivee {
  id: string;
  nom: string;
  codeInsee: string;
}

export interface CommunesDisponibles {
  /** Entrées du référentiel absentes de l'organisation, triées par nom. */
  creables: CommuneReferentiel[];
  /**
   * Communes de l'organisation actuellement archivées. Elles ne sont PAS créables — le
   * `UNIQUE (org_id, code_insee)` le refuserait — mais l'utilisateur qui les cherche dans
   * le sélecteur doit se voir proposer de les réactiver plutôt qu'un message d'échec.
   */
  archivees: CommuneArchivee[];
  /** true quand les 34 communes existent déjà : le bouton « Ajouter » n'a plus d'objet. */
  toutesCreees: boolean;
}

export async function getCommunesDisponibles(orgId: string): Promise<CommunesDisponibles> {
  const supabase = await createClient();

  // org_id explicite en plus de la RLS (défense en profondeur, cf. §1 du PLAN).
  const { data, error } = await supabase
    .from("communes")
    .select("id, nom, code_insee, archived")
    .eq("org_id", orgId);

  if (error) throw new Error(`Lecture des communes impossible : ${error.message}`);

  const existantes = (data ?? []) as Array<{
    id: string;
    nom: string;
    code_insee: string;
    archived: boolean;
  }>;

  const codesPris = new Set(existantes.map((c) => c.code_insee));

  const creables = REFERENTIEL_MARTINIQUE.filter((c) => !codesPris.has(c.codeInsee))
    .map((c) => ({ ...c }))
    .sort((a, b) => a.nom.localeCompare(b.nom, "fr"));

  const archivees = existantes
    .filter((c) => c.archived)
    .map((c) => ({ id: c.id, nom: c.nom, codeInsee: c.code_insee }))
    .sort((a, b) => a.nom.localeCompare(b.nom, "fr"));

  return {
    creables,
    archivees,
    toutesCreees: creables.length === 0 && archivees.length === 0,
  };
}
