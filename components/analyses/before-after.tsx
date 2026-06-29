"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { downloadCsv } from "@/lib/csv";
import type { PivotRow } from "@/lib/data/pivot";

export function BeforeAfter({ rows }: { rows: PivotRow[] }) {
  const [cutover, setCutover] = useState<string>("");

  const result = useMemo(() => {
    if (!cutover) return [];
    const cutoverDate = new Date(cutover);
    const bySite = new Map<
      string,
      { nom: string; commune: string; before: number[]; after: number[] }
    >();

    for (const row of rows) {
      if (!bySite.has(row.site_id)) {
        bySite.set(row.site_id, {
          nom: row.site_nom,
          commune: row.commune_nom,
          before: [],
          after: [],
        });
      }
      const entry = bySite.get(row.site_id)!;
      const date = new Date(row.facture_date);
      if (date < cutoverDate) entry.before.push(row.total_kwh);
      else entry.after.push(row.total_kwh);
    }

    return Array.from(bySite.values())
      .filter((e) => e.before.length > 0 && e.after.length > 0)
      .map((e) => {
        const avgBefore = e.before.reduce((s, v) => s + v, 0) / e.before.length;
        const avgAfter = e.after.reduce((s, v) => s + v, 0) / e.after.length;
        const variation = avgBefore ? ((avgAfter - avgBefore) / avgBefore) * 100 : 0;
        return { nom: e.nom, commune: e.commune, avgBefore, avgAfter, variation };
      });
  }, [rows, cutover]);

  function exportCsv() {
    const header = ["Commune", "Site", "Moyenne avant (kWh)", "Moyenne après (kWh)", "Variation (%)"];
    const body = result.map((r) => [
      r.commune,
      r.nom,
      Math.round(r.avgBefore),
      Math.round(r.avgAfter),
      r.variation.toFixed(1),
    ]);
    downloadCsv(`avant-apres-travaux-${Date.now()}.csv`, [header, ...body]);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">
            Date de bascule (travaux)
          </label>
          <Input type="date" value={cutover} onChange={(e) => setCutover(e.target.value)} className="w-48" />
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={result.length === 0}>
          <Download className="size-3.5" />
          Exporter CSV
        </Button>
      </div>

      {cutover && (
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Site</TableHead>
                <TableHead className="text-right">Moyenne avant</TableHead>
                <TableHead className="text-right">Moyenne après</TableHead>
                <TableHead className="text-right">Variation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.map((r) => (
                <TableRow key={r.nom + r.commune}>
                  <TableCell className="font-medium">
                    {r.nom}
                    <span className="ml-1.5 text-xs text-slate-400">{r.commune}</span>
                  </TableCell>
                  <TableCell className="text-right">{r.avgBefore.toFixed(0)} kWh</TableCell>
                  <TableCell className="text-right">{r.avgAfter.toFixed(0)} kWh</TableCell>
                  <TableCell
                    className={`text-right font-medium ${r.variation < 0 ? "text-emerald-600" : "text-red-600"}`}
                  >
                    {r.variation > 0 ? "+" : ""}
                    {r.variation.toFixed(1)} %
                  </TableCell>
                </TableRow>
              ))}
              {result.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-slate-400">
                    Pas assez de données avant/après cette date pour comparer.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
