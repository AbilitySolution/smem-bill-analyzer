"use client";

import { useMemo, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download } from "lucide-react";
import { semestreLabel } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import type { PivotRow } from "@/lib/data/pivot";

function periodSortKey(label: string): number {
  const [half, year] = label.split(" ");
  return Number(year) * 10 + (half === "S1" ? 1 : 2);
}

export function PivotTable({ rows }: { rows: PivotRow[] }) {
  const [metric, setMetric] = useState<"eur" | "kwh">("eur");
  const [categorie, setCategorie] = useState<"all" | "batiment" | "eclairage_public">("all");

  const filtered = useMemo(
    () => (categorie === "all" ? rows : rows.filter((r) => r.categorie === categorie)),
    [rows, categorie],
  );

  const { sites, periods, matrix, totals } = useMemo(() => {
    const periodSet = new Set<string>();
    const siteMap = new Map<string, { nom: string; commune: string }>();
    const matrix = new Map<string, Map<string, number>>();

    for (const row of filtered) {
      const period = semestreLabel(row.facture_date);
      periodSet.add(period);
      siteMap.set(row.site_id, { nom: row.site_nom, commune: row.commune_nom });
      if (!matrix.has(row.site_id)) matrix.set(row.site_id, new Map());
      const cell = matrix.get(row.site_id)!;
      const value = metric === "eur" ? row.total_ttc : row.total_kwh;
      cell.set(period, (cell.get(period) ?? 0) + value);
    }

    const periods = Array.from(periodSet).sort((a, b) => periodSortKey(a) - periodSortKey(b));
    const sites = Array.from(siteMap.entries())
      .map(([id, info]) => ({ id, ...info }))
      .sort((a, b) => a.commune.localeCompare(a.commune) || a.nom.localeCompare(b.nom));

    const totals = new Map<string, number>();
    for (const period of periods) {
      let sum = 0;
      for (const site of sites) sum += matrix.get(site.id)?.get(period) ?? 0;
      totals.set(period, sum);
    }

    return { sites, periods, matrix, totals };
  }, [filtered, metric]);

  function exportCsv() {
    const header = ["Commune", "Site", ...periods, "Total"];
    const body = sites.map((site) => {
      const cells = periods.map((p) => Math.round((matrix.get(site.id)?.get(p) ?? 0) * 100) / 100);
      const total = cells.reduce((s, v) => s + v, 0);
      return [site.commune, site.nom, ...cells, Math.round(total * 100) / 100];
    });
    const totalRow = [
      "",
      "TOTAL",
      ...periods.map((p) => Math.round((totals.get(p) ?? 0) * 100) / 100),
      Math.round(Array.from(totals.values()).reduce((s, v) => s + v, 0) * 100) / 100,
    ];
    downloadCsv(`analyse-pivot-${metric}-${Date.now()}.csv`, [header, ...body, totalRow]);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={metric} onValueChange={(v) => setMetric(v as "eur" | "kwh")}>
          <TabsList>
            <TabsTrigger value="eur">€</TabsTrigger>
            <TabsTrigger value="kwh">kWh</TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs value={categorie} onValueChange={(v) => setCategorie(v as typeof categorie)}>
          <TabsList>
            <TabsTrigger value="all">Tous</TabsTrigger>
            <TabsTrigger value="batiment">Bâtiments</TabsTrigger>
            <TabsTrigger value="eclairage_public">Éclairage public</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button variant="outline" size="sm" className="ml-auto" onClick={exportCsv}>
          <Download className="size-3.5" />
          Exporter CSV
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-slate-200">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 bg-white">Site</TableHead>
              {periods.map((p) => (
                <TableHead key={p} className="text-right">
                  {p}
                </TableHead>
              ))}
              <TableHead className="text-right font-semibold">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sites.map((site) => {
              const cells = periods.map((p) => matrix.get(site.id)?.get(p) ?? 0);
              const total = cells.reduce((s, v) => s + v, 0);
              return (
                <TableRow key={site.id}>
                  <TableCell className="sticky left-0 bg-white font-medium">
                    {site.nom}
                    <span className="ml-1.5 text-xs text-slate-400">{site.commune}</span>
                  </TableCell>
                  {cells.map((v, idx) => (
                    <TableCell key={periods[idx]} className="text-right text-slate-700">
                      {v ? (metric === "eur" ? `${v.toFixed(0)} €` : `${v.toFixed(0)} kWh`) : "—"}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-semibold">
                    {metric === "eur" ? `${total.toFixed(0)} €` : `${total.toFixed(0)} kWh`}
                  </TableCell>
                </TableRow>
              );
            })}
            {sites.length > 0 && (
              <TableRow className="bg-slate-50 font-semibold">
                <TableCell className="sticky left-0 bg-slate-50">TOTAL</TableCell>
                {periods.map((p) => (
                  <TableCell key={p} className="text-right">
                    {metric === "eur"
                      ? `${(totals.get(p) ?? 0).toFixed(0)} €`
                      : `${(totals.get(p) ?? 0).toFixed(0)} kWh`}
                  </TableCell>
                ))}
                <TableCell className="text-right">
                  {metric === "eur"
                    ? `${Array.from(totals.values()).reduce((s, v) => s + v, 0).toFixed(0)} €`
                    : `${Array.from(totals.values()).reduce((s, v) => s + v, 0).toFixed(0)} kWh`}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {sites.length === 0 && (
          <p className="p-6 text-center text-sm text-slate-400">Aucune donnée pour ce filtre.</p>
        )}
      </div>
    </div>
  );
}
