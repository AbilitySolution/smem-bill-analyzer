/**
 * Constantes et types de la liste de factures, sans dépendance serveur.
 *
 * Séparé de `lib/data/invoices.ts` à dessein : ce dernier importe `lib/supabase/server`
 * (donc `next/headers`), et le seul fait d'y lire une constante depuis un composant client
 * ferait entrer tout le module serveur dans le bundle client — et casse le build.
 */

export const PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;

export type SortKey = "date" | "number" | "site" | "commune" | "kwh" | "totalTtc";

export interface InvoiceListFilters {
  query?: string;
  categorie?: "batiment" | "eclairage_public";
  communeId?: string;
  siteId?: string;
  onlyAnomalies?: boolean;
  showArchived?: boolean;
  /** Plage de dates de facture (incluses), au format YYYY-MM-DD — période choisie au calendrier. */
  from?: string;
  to?: string;
  sort?: SortKey;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

/** Un jour du calendrier : nombre de factures et total TTC (agrégé en SQL). */
export interface CalendarDay {
  date: string; // YYYY-MM-DD
  count: number;
  ttc: number;
}

/** Période sélectionnée depuis la vue Calendrier. */
export interface PeriodFilter {
  from: string;
  to: string;
  label: string;
}

export interface InvoiceListKpis {
  count: number;
  totalTtc: number;
  totalKwh: number;
  periode: string;
  /** Nombre total de factures masquées de l'org (hors filtre courant) — libellé du bouton. */
  archivedCount: number;
  /** Nombre total de factures avec anomalie ouverte (hors filtre courant) — libellé du bouton. */
  anomalyCount: number;
}
