"use client";

import { useRef, useTransition } from "react";
import { addActivity } from "@/app/(app)/factures/[id]/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageSquare } from "lucide-react";

export interface ActivityItem {
  id: string;
  body: string;
  created_at: string;
  author_email?: string | null;
}

export function ActivityFeed({
  invoiceId,
  activities,
}: {
  invoiceId: string;
  activities: ActivityItem[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    const value = ref.current?.value ?? "";
    startTransition(async () => {
      await addActivity(invoiceId, value);
      if (ref.current) ref.current.value = "";
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
        <MessageSquare className="size-4" />
        Activités &amp; notes
      </div>
      <div className="space-y-2">
        {activities.length === 0 && (
          <p className="text-xs text-slate-400">Aucune note pour l&apos;instant.</p>
        )}
        {activities.map((a) => (
          <div key={a.id} className="rounded-md border border-slate-200 bg-[var(--kn-card)] p-2.5 text-sm">
            <p className="text-slate-700">{a.body}</p>
            <p className="mt-1 text-[11px] text-slate-400">
              {new Date(a.created_at).toLocaleString("fr-FR")}
            </p>
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <Textarea ref={ref} placeholder="Ajouter une note interne..." rows={2} />
        <Button size="sm" disabled={pending} onClick={submit}>
          Ajouter
        </Button>
      </div>
    </div>
  );
}
