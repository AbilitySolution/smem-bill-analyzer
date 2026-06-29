"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { resolveAnomaly } from "@/app/(app)/anomalies/actions";
import { Check } from "lucide-react";

export function ResolveButton({ anomalyId }: { anomalyId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() => startTransition(async () => { await resolveAnomaly(anomalyId); })}
    >
      <Check className="size-3.5" />
      Marquer résolue
    </Button>
  );
}
