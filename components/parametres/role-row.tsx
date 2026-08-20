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
    <tr className="border-b border-[var(--kn-border)] last:border-0">
      <td className="py-3 pr-4 text-sm font-medium text-[var(--kn-text)]">
        {email}
        {erreur && <p className="mt-1 max-w-sm text-xs font-normal text-red-600 dark:text-red-400">{erreur}</p>}
      </td>
      <td className="px-4 py-3">
        <Select
          value={role}
          onValueChange={(v) => update(v as UserRole, communeId)}
          disabled={pending}
        >
          <SelectTrigger className="w-44">
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
      <td className="py-3 pl-4">
        <Select
          value={communeId ?? "none"}
          onValueChange={(v) => update(role, v === "none" ? null : v)}
          disabled={pending || role !== "org_member"}
        >
          <SelectTrigger className="w-52">
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
