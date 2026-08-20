"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { createCommune, unarchiveCommune } from "@/app/(app)/parametres/actions";
import type { CommuneReferentiel } from "@/lib/communes/referentiel-martinique";
import type { CommuneArchivee } from "@/lib/communes/disponibles";

/**
 * SCRUM-14 (lot 3) — Ajout d'une commune.
 *
 * Le domaine est fermé : pas de champ texte pour le nom, un sélecteur dans le référentiel.
 * Les coordonnées ne sont PAS affichées — c'est de la plomberie, le référentiel ne se
 * montre pas dans l'outil (§3.2bis du PLAN). Seul le code INSEE apparaît, en lecture
 * seule, pour rassurer sur le bon choix.
 *
 * Une commune archivée ne peut pas être recréée : elle est proposée à la réactivation.
 */

const PREFIXE_CREATION = "creer:";
const PREFIXE_REACTIVATION = "reactiver:";

export function CommuneForm({
  creables,
  archivees,
}: {
  creables: CommuneReferentiel[];
  archivees: CommuneArchivee[];
}) {
  const [ouvert, setOuvert] = useState(false);
  const [choix, setChoix] = useState("");
  const [pointsLumineux, setPointsLumineux] = useState("");
  const [armoires, setArmoires] = useState("");
  const [travauxDebut, setTravauxDebut] = useState("");
  const [travauxFin, setTravauxFin] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toutesCreees = creables.length === 0 && archivees.length === 0;
  const estReactivation = choix.startsWith(PREFIXE_REACTIVATION);
  const communeChoisie = choix.startsWith(PREFIXE_CREATION)
    ? creables.find((c) => c.codeInsee === choix.slice(PREFIXE_CREATION.length))
    : undefined;
  const archiveeChoisie = estReactivation
    ? archivees.find((c) => c.id === choix.slice(PREFIXE_REACTIVATION.length))
    : undefined;

  /**
   * Base UI affiche la valeur brute de l'item sélectionné. Sans ce libellé explicite, le
   * champ montrerait « creer:97213 » au lieu de « Le Lamentin ».
   */
  function libelle(valeur: unknown): string {
    const v = typeof valeur === "string" ? valeur : "";
    if (v.startsWith(PREFIXE_CREATION)) {
      return creables.find((c) => c.codeInsee === v.slice(PREFIXE_CREATION.length))?.nom ?? "";
    }
    if (v.startsWith(PREFIXE_REACTIVATION)) {
      const a = archivees.find((c) => c.id === v.slice(PREFIXE_REACTIVATION.length));
      return a ? `${a.nom} — archivée` : "";
    }
    return "";
  }

  function reinitialiser() {
    setChoix("");
    setPointsLumineux("");
    setArmoires("");
    setTravauxDebut("");
    setTravauxFin("");
    setErreur(null);
  }

  function soumettre() {
    if (!choix) return;
    setErreur(null);

    startTransition(async () => {
      const resultat = estReactivation
        ? await unarchiveCommune(choix.slice(PREFIXE_REACTIVATION.length))
        : await createCommune({
            codeInsee: choix.slice(PREFIXE_CREATION.length),
            pointsLumineux,
            armoires,
            travauxDebut,
            travauxFin,
          });

      if (resultat && "error" in resultat && resultat.error) {
        setErreur(resultat.error);
        return;
      }
      reinitialiser();
      setOuvert(false);
    });
  }

  if (toutesCreees) {
    return (
      <p className="text-xs text-[var(--kn-text-muted)]">
        Toutes les communes de Martinique sont déjà enregistrées.
      </p>
    );
  }

  return (
    <Dialog
      open={ouvert}
      onOpenChange={(o) => {
        setOuvert(o);
        if (!o) reinitialiser();
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <Plus className="size-4" />
            Ajouter une commune
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ajouter une commune</DialogTitle>
          <DialogDescription>
            {creables.length > 0
              ? `${creables.length} commune${creables.length > 1 ? "s" : ""} de Martinique reste${creables.length > 1 ? "nt" : ""} à enregistrer.`
              : "Toutes les communes restantes sont archivées : vous pouvez les réactiver."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--kn-text-muted)]">Commune</label>
            <Select value={choix} onValueChange={(v) => setChoix(v ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choisir une commune">{libelle}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {creables.map((c) => (
                  <SelectItem key={c.codeInsee} value={PREFIXE_CREATION + c.codeInsee}>
                    {c.nom}
                  </SelectItem>
                ))}
                {archivees.map((c) => (
                  <SelectItem key={c.id} value={PREFIXE_REACTIVATION + c.id}>
                    {c.nom} — archivée
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {communeChoisie && (
              <p className="mt-1 text-xs text-[var(--kn-text-muted)]">Code INSEE {communeChoisie.codeInsee}</p>
            )}
            {archiveeChoisie && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                Cette commune existe déjà mais elle est archivée. Elle sera réactivée avec ses
                sites et ses factures, telle quelle.
              </p>
            )}
          </div>

          {/* Champs métier : optionnels, éditables plus tard. Ne pas bloquer l'ajout sur
              des données que l'utilisateur n'a peut-être pas sous la main (§3.5). */}
          {!estReactivation && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--kn-text-muted)]">
                    Points lumineux
                  </label>
                  <Input
                    type="number"
                    min={0}
                    value={pointsLumineux}
                    onChange={(e) => setPointsLumineux(e.target.value)}
                    placeholder="Optionnel"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--kn-text-muted)]">Armoires</label>
                  <Input
                    type="number"
                    min={0}
                    value={armoires}
                    onChange={(e) => setArmoires(e.target.value)}
                    placeholder="Optionnel"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--kn-text-muted)]">
                    Début des travaux
                  </label>
                  <Input
                    type="date"
                    value={travauxDebut}
                    onChange={(e) => setTravauxDebut(e.target.value)}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--kn-text-muted)]">
                    Fin des travaux
                  </label>
                  <Input
                    type="date"
                    value={travauxFin}
                    onChange={(e) => setTravauxFin(e.target.value)}
                  />
                </div>
              </div>
            </>
          )}

          {erreur && <p className="text-sm text-red-600 dark:text-red-400">{erreur}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOuvert(false)} disabled={pending}>
            Annuler
          </Button>
          <Button onClick={soumettre} disabled={pending || !choix}>
            {pending ? "Enregistrement…" : estReactivation ? "Réactiver" : "Ajouter"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
