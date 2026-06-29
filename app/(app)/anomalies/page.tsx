import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ResolveButton } from "@/components/anomalies/resolve-button";
import { formatKwh, formatDate } from "@/lib/format";
import { AlertTriangle } from "lucide-react";

const SEVERITY_CLASSES: Record<string, string> = {
  high: "bg-red-100 text-red-700 border-red-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
};

export default async function AnomaliesPage() {
  const supabase = await createClient();

  const { data: anomalies } = await supabase
    .from("anomalies")
    .select(
      "*, invoices(facture_number, facture_date, sites(nom), communes(nom))",
    )
    .order("detected_at", { ascending: false });

  const open = (anomalies ?? []).filter((a) => !a.resolved);
  const resolved = (anomalies ?? []).filter((a) => a.resolved);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Anomalies</h1>
        <p className="text-sm text-slate-500">
          {open.length} anomalie(s) ouverte(s), {resolved.length} résolue(s)
        </p>
      </div>

      {open.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 py-16 text-center">
          <AlertTriangle className="size-7 text-slate-300" />
          <p className="text-sm text-slate-500">Aucune anomalie ouverte.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {open.map((a) => {
            const inv = a.invoices as unknown as {
              facture_number: string;
              facture_date: string;
              sites: { nom: string } | null;
              communes: { nom: string } | null;
            } | null;
            return (
              <Card key={a.id} className="flex items-center justify-between gap-3 p-3">
                <div className="flex items-start gap-3">
                  <Badge variant="outline" className={`border ${SEVERITY_CLASSES[a.severity]}`}>
                    {a.severity}
                  </Badge>
                  <div>
                    <Link href={`/factures/${a.invoice_id}`} className="font-medium text-slate-900 hover:underline">
                      {inv?.sites?.nom} — {inv?.communes?.nom}
                    </Link>
                    <p className="text-sm text-slate-600">{a.description}</p>
                    <p className="text-xs text-slate-400">
                      Facture {inv?.facture_number} · {formatDate(inv?.facture_date)} · valeur{" "}
                      {formatKwh(a.detected_value)} (attendu {formatKwh(a.expected_range_min)} –{" "}
                      {formatKwh(a.expected_range_max)})
                    </p>
                  </div>
                </div>
                <ResolveButton anomalyId={a.id} />
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
