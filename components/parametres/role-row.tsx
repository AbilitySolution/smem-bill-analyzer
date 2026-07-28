"use client";

import { useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { assignUserRole } from "@/app/(app)/parametres/actions";

export function RoleRow({
  userId,
  email,
  role,
  communeId,
  communes,
}: {
  userId: string;
  email: string;
  role: "org_admin" | "org_member";
  communeId: string | null;
  communes: { id: string; nom: string }[];
}) {
  const [pending, startTransition] = useTransition();

  function update(nextRole: "org_admin" | "org_member", nextCommune: string | null) {
    startTransition(async () => {
      await assignUserRole(userId, nextRole, nextCommune);
    });
  }

  return (
    <tr className="border-b border-slate-100">
      <td className="py-2 text-sm text-slate-800">{email}</td>
      <td className="py-2">
        <Select
          value={role}
          onValueChange={(v) => update(v as "org_admin" | "org_member", communeId)}
          disabled={pending}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="org_admin">Administrateur</SelectItem>
            <SelectItem value="org_member">Membre</SelectItem>
          </SelectContent>
        </Select>
      </td>
      <td className="py-2">
        <Select
          value={communeId ?? "none"}
          onValueChange={(v) => update(role, v === "none" ? null : v)}
          disabled={pending || role === "org_admin"}
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
