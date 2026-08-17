"use client";

import { useState, useTransition } from "react";
import { Building2, Lightbulb, Archive, ArchiveRestore, Pencil } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { archiveCommune, unarchiveCommune, updateCommune } from "@/app/(app)/parametres/actions";

/**
 * SCRUM-14 (lot 3) — Une commune dans la page Paramètres.
 *
 * Seuls les champs métier sont modifiables. Le nom, le code INSEE et les coordonnées
 * viennent du référentiel et ne sont pas éditables : renommer changerait le rattachement
 * des factures, et une coordonnée saisie à la main rouvrirait la dette du §3.2.
 */

export interface CommuneAffichee {
  id: string;
  nom: string;
  codeInsee: string | null;
  archived: boolean;
  pointsLumineux: number | null;
  armoires: number | null;
  travauxDebut: string | null;
  travauxFin: string | null;
  batiments: number;
  eclairage: number;
}

export function CommuneCard({ commune, estAdmin }: { commune: CommuneAffichee; estAdmin: boolean }) {
  const [editionOuverte, setEditionOuverte] = useState(false);
  const [pointsLumineux, setPointsLumineux] = useState(commune.pointsLumineux?.toString() ?? "");
  const [armoires, setArmoires] = useState(commune.armoires?.toString() ?? "");
  const [travauxDebut, setTravauxDebut] = useState(commune.travauxDebut ?? "");
  const [travauxFin, setTravauxFin] = useState(commune.travauxFin ?? "");
  const [erreur, setErreur] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function enregistrer() {
    setErreur(null);
    startTransition(async () => {
      const r = await updateCommune(commune.id, {
        pointsLumineux,
        armoires,
        travauxDebut,
        travauxFin,
      });
      if (r && "error" in r && r.error) {
        setErreur(r.error);
        return;
      }
      setEditionOuverte(false);
    });
  }

  function basculerArchivage() {
    setErreur(null);
    startTransition(async () => {
      const r = commune.archived
        ? await unarchiveCommune(commune.id)
        : await archiveCommune(commune.id);
      if (r && "error" in r && r.error) setErreur(r.error);
    });
  }

  return (
    <div
      className={`rounded-md border p-3 ${
        commune.archived ? "border-dashed border-slate-300 bg-slate-50" : "border-slate-200"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className={`font-medium ${commune.archived ? "text-slate-500" : "text-slate-900"}`}>
            {commune.nom}
            {commune.archived && (
              <span className="ml-2 text-xs font-normal text-slate-400">archivée</span>
            )}
          </p>
          <div className="mt-1 flex gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1">
              <Building2 className="size-3.5" />
              {commune.batiments} bâtiments
            </span>
            <span className="flex items-center gap-1">
              <Lightbulb className="size-3.5" />
              {commune.eclairage} éclairage
            </span>
          </div>
        </div>

        {estAdmin && (
          <div className="flex shrink-0 gap-1">
            {!commune.archived && (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setEditionOuverte(true)}
                disabled={pending}
                aria-label={`Modifier ${commune.nom}`}
              >
                <Pencil className="size-4" />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={basculerArchivage}
              disabled={pending}
              aria-label={`${commune.archived ? "Réactiver" : "Archiver"} ${commune.nom}`}
            >
              {commune.archived ? (
                <ArchiveRestore className="size-4" />
              ) : (
                <Archive className="size-4" />
              )}
            </Button>
          </div>
        )}
      </div>

      {erreur && <p className="mt-2 text-xs text-red-600">{erreur}</p>}

      <Dialog open={editionOuverte} onOpenChange={setEditionOuverte}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{commune.nom}</DialogTitle>
            <DialogDescription>
              Code INSEE {commune.codeInsee ?? "—"}. Le nom ne se modifie pas : il sert au
              rattachement automatique des factures.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">
                  Points lumineux
                </label>
                <Input
                  type="number"
                  min={0}
                  value={pointsLumineux}
                  onChange={(e) => setPointsLumineux(e.target.value)}
                  placeholder="Non renseigné"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">Armoires</label>
                <Input
                  type="number"
                  min={0}
                  value={armoires}
                  onChange={(e) => setArmoires(e.target.value)}
                  placeholder="Non renseigné"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">
                  Début des travaux
                </label>
                <Input
                  type="date"
                  value={travauxDebut}
                  onChange={(e) => setTravauxDebut(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">
                  Fin des travaux
                </label>
                <Input
                  type="date"
                  value={travauxFin}
                  onChange={(e) => setTravauxFin(e.target.value)}
                />
              </div>
            </div>

            {erreur && <p className="text-sm text-red-600">{erreur}</p>}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditionOuverte(false)} disabled={pending}>
              Annuler
            </Button>
            <Button onClick={enregistrer} disabled={pending}>
              {pending ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
