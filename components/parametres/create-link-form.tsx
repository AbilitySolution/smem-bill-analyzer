"use client";

import { useRef, useState, useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { createFileRequestLink } from "@/app/(app)/parametres/actions";

export function CreateLinkForm({ communes }: { communes: { id: string; nom: string }[] }) {
  const [communeId, setCommuneId] = useState("");
  const labelRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!communeId) return;
    startTransition(async () => {
      await createFileRequestLink(communeId, labelRef.current?.value ?? "");
      if (labelRef.current) labelRef.current.value = "";
    });
  }

  return (
    <div className="flex items-end gap-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-500">Commune</label>
        <Select value={communeId} onValueChange={(v) => setCommuneId(v ?? "")}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Choisir" />
          </SelectTrigger>
          <SelectContent>
            {communes.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.nom}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-500">Message (optionnel)</label>
        <Input ref={labelRef} placeholder="Ex: Factures S1 2026" className="w-56" />
      </div>
      <Button onClick={submit} disabled={pending || !communeId}>
        Créer le lien
      </Button>
    </div>
  );
}
