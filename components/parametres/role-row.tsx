"use client";

import { useState, useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { assignUserRole } from "@/app/(app)/parametres/actions";
import { ROLE_LABELS } from "@/lib/authz";
import type { UserRole } from "@/lib/types/database";

/** Ordre d'affichage : du plus large au plus restreint, comme la matrice de lib/authz.ts. */
const ROLES_ASSIGNABLES: UserRole[] = ["org_admin", "org_supervisor", "org_member"];

export function RoleRow({
  userId,
  email,
  role,
  communeId,
  communes,
}: {
  userId: string;
  email: string;
  role: UserRole;
  communeId: string | null;
  communes: { id: string; nom: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const [erreur, setErreur] = useState<string | null>(null);

  function update(nextRole: UserRole, nextCommune: string | null) {
    setErreur(null);
    startTransition(async () => {
      const res = await assignUserRole(userId, nextRole, nextCommune);
      // Sans ce retour, le refus du verrou « dernier administrateur » était muet : le
      // sélecteur revenait à sa valeur d'origine sans que rien n'explique pourquoi.
      if ("error" in res && res.error) setErreur(res.error);
    });
  }

  return (
    <tr className="border-b border-slate-100">
      <td className="py-2 text-sm text-slate-800">
        {email}
        {erreur && <p className="mt-1 text-xs text-red-600">{erreur}</p>}
      </td>
      <td className="py-2">
        <Select
          value={role}
          onValueChange={(v) => update(v as UserRole, communeId)}
          disabled={pending}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES_ASSIGNABLES.map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
      <td className="py-2">
        <Select
          value={communeId ?? "none"}
          onValueChange={(v) => update(role, v === "none" ? null : v)}
          disabled={pending || role !== "org_member"}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">—</SelectItem>
            {communes.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.nom}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
    </tr>
  );
}
