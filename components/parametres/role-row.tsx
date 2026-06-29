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
  role: "admin_smem" | "agent_commune";
  communeId: string | null;
  communes: { id: string; nom: string }[];
}) {
  const [pending, startTransition] = useTransition();

  function update(nextRole: "admin_smem" | "agent_commune", nextCommune: string | null) {
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
          onValueChange={(v) => update(v as "admin_smem" | "agent_commune", communeId)}
          disabled={pending}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin_smem">Admin SMEM</SelectItem>
            <SelectItem value="agent_commune">Agent commune</SelectItem>
          </SelectContent>
        </Select>
      </td>
      <td className="py-2">
        <Select
          value={communeId ?? "none"}
          onValueChange={(v) => update(role, v === "none" ? null : v)}
          disabled={pending || role === "admin_smem"}
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
