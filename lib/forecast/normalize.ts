export interface InvoicePeriodRow {
  invoice_id: string;
  period_start: string | null;
  period_end: string | null;
  consommation_kwh: number | null;
}

export interface InvoiceRate {
  invoiceId: string;
  kwhPerDay: number;
  days: number;
  start: string;
  end: string;
}

/** Regroupe des lignes consumption_periods par facture → débit kWh/jour par facture. */
export function computeInvoiceRates(rows: InvoicePeriodRow[]): InvoiceRate[] {
  const byInvoice = new Map<string, { kwh: number; start: string | null; end: string | null }>();
  for (const r of rows) {
    const cur = byInvoice.get(r.invoice_id) ?? { kwh: 0, start: null, end: null };
    byInvoice.set(r.invoice_id, {
      kwh: cur.kwh + (r.consommation_kwh ?? 0),
      start: !cur.start || (r.period_start && r.period_start < cur.start) ? r.period_start : cur.start,
      end: !cur.end || (r.period_end && r.period_end > cur.end) ? r.period_end : cur.end,
    });
  }
  const out: InvoiceRate[] = [];
  for (const [invoiceId, { kwh, start, end }] of byInvoice) {
    if (!start || !end) continue;
    const days = (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000;
    if (days > 0 && kwh > 0) out.push({ invoiceId, kwhPerDay: kwh / days, days, start, end });
  }
  return out;
}

/** Débit moyen kWh/jour, pondéré par la durée de chaque facture. */
export function weightedAverageRate(rates: InvoiceRate[]): number | null {
  if (rates.length === 0) return null;
  const totalKwh = rates.reduce((s, r) => s + r.kwhPerDay * r.days, 0);
  const totalDays = rates.reduce((s, r) => s + r.days, 0);
  return totalDays > 0 ? totalKwh / totalDays : null;
}

/** Bornes [start, end] couvrant l'ensemble des factures historiques fournies. */
export function historicalSpan(rates: InvoiceRate[]): { start: string; end: string } | null {
  if (!rates.length) return null;
  return {
    start: rates.reduce((m, r) => (r.start < m ? r.start : m), rates[0].start),
    end: rates.reduce((m, r) => (r.end > m ? r.end : m), rates[0].end),
  };
}
