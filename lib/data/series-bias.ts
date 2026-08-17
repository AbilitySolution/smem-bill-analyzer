// Correctifs du biais de couverture des séries temporelles.
//
// Le problème, mesuré sur le portefeuille de production : le nombre de sites réellement
// couverts par mois passe de 1 (2015-2018) à 2-3 (2019-2022), à 9 (2023-2024), puis
// retombe à 1 (2025). Une courbe de totaux mensuels ne décrit donc pas l'évolution de la
// consommation, elle décrit la progression du versement des factures dans l'outil : le
// « triplement » entre 2022 et 2023 est un triplement du périmètre, pas de la conso.
//
// Trois réponses, volontairement séparées :
//   - `coverageByMonth` : rendre le biais VISIBLE. Le moins cher, le plus robuste, et
//                         impossible à mal interpréter.
//   - `chainedIndex`    : le corriger sur le portefeuille entier, par un indice chaîné.
//   - `findFixedPanel`  : sur un périmètre restreint (une commune), permettre une vraie
//                         série en kWh — ou refuser d'afficher, plutôt que de tromper.
//
// Fonctions pures, sans dépendance à Supabase : directement testables.

/** kWh par site pour un mois donné. Clé externe = mois "YYYY-MM", clé interne = site. */
export type MonthSiteKwh = Map<string, Map<string, number>>;

/** Sites communs minimum entre deux mois pour chaîner une variation. */
export const MIN_COMMON_SITES = 3;
/** Durée minimum d'une fenêtre à périmètre figé — un cycle saisonnier complet. */
export const MIN_PANEL_MONTHS = 12;
/** Part minimum des sites du périmètre que le panel doit couvrir. */
export const MIN_PANEL_COVERAGE = 0.6;

export interface CoveragePoint {
  key: string; // "YYYY-MM"
  sites: number;
}

/** Nombre de sites couverts par mois — la bande affichée sous la courbe. */
export function coverageByMonth(data: MonthSiteKwh, monthKeys: string[]): CoveragePoint[] {
  return monthKeys.map((key) => ({ key, sites: data.get(key)?.size ?? 0 }));
}

export interface ChainedPoint {
  key: string;
  /** Indice base 100. `null` = série interrompue, faute de sites communs pour chaîner. */
  index: number | null;
  /** Nombre de sites ayant servi à calculer la variation depuis le mois précédent. */
  common: number;
}

/**
 * Indice chaîné base 100.
 *
 * Pour chaque paire de mois consécutifs, la variation n'est calculée que sur les sites
 * présents DANS LES DEUX mois, puis les variations sont enchaînées. Un site qui entre
 * dans le périmètre ne crée donc pas de saut — il n'a pas de mois précédent, il ne pèse
 * pas sur cette variation-là — et un site qui en sort non plus.
 *
 * C'est la méthode des indices de prix et des ventes à magasins comparables. Elle
 * exploite bien plus de données qu'un panel constant : tous les recouvrements partiels
 * comptent, pas seulement les sites présents de bout en bout.
 *
 * En dessous de `MIN_COMMON_SITES` sites communs, la série est INTERROMPUE (index null)
 * et repart à 100 au mois suivant. Prolonger le trait sur un ou deux sites donnerait une
 * courbe lisse et fausse — précisément ce qu'on cherche à éviter ici.
 */
export function chainedIndex(data: MonthSiteKwh, monthKeys: string[]): ChainedPoint[] {
  const out: ChainedPoint[] = [];
  let current: number | null = null;
  let prevKey: string | null = null;

  for (const key of monthKeys) {
    const now = data.get(key);
    if (!now || now.size === 0) {
      out.push({ key, index: null, common: 0 });
      prevKey = null;
      current = null;
      continue;
    }

    if (prevKey === null) {
      current = 100;
      out.push({ key, index: current, common: 0 });
      prevKey = key;
      continue;
    }

    const before = data.get(prevKey)!;
    let sumNow = 0;
    let sumBefore = 0;
    let common = 0;
    for (const [siteId, kwh] of now) {
      const was = before.get(siteId);
      if (was === undefined) continue;
      common += 1;
      sumNow += kwh;
      sumBefore += was;
    }

    if (common < MIN_COMMON_SITES || sumBefore <= 0 || current === null) {
      // Rupture : impossible de relier ce mois au précédent sans inventer.
      out.push({ key, index: null, common });
      current = 100;
      prevKey = key;
      continue;
    }

    current = current * (sumNow / sumBefore);
    out.push({ key, index: current, common });
    prevKey = key;
  }

  return out;
}

export interface SiteSpan {
  siteId: string;
  firstMonth: string;
  lastMonth: string;
  /** Nombre de mois effectivement couverts (pas la durée entre les deux bornes). */
  months: number;
}

export interface FixedPanel {
  ok: boolean;
  /** Sites retenus, couverts sans interruption sur toute la fenêtre. */
  siteIds: string[];
  /** Sites du périmètre au total — dénominateur du taux de couverture. */
  totalSites: number;
  /** Bornes de la fenêtre, "YYYY-MM". */
  from: string | null;
  to: string | null;
  months: string[];
  /** Sites hors panel retenu — sert au bandeau quand le panel est accepté. */
  excluded: { siteId: string; firstMonth: string | null }[];
  /**
   * Couverture réelle de CHAQUE site du périmètre.
   *
   * Indispensable au message de refus : quand aucune fenêtre ne convient, `excluded`
   * peut être vide (la meilleure fenêtre contient alors tous les sites, elle est
   * simplement trop courte) et l'écran d'explication n'aurait rien à montrer. Les
   * empans, eux, disent toujours quel site manque et sur quelle période.
   */
  siteSpans: SiteSpan[];
}

/**
 * Plus longue fenêtre de mois consécutifs sur laquelle un périmètre FIGÉ de sites est
 * couvert sans interruption.
 *
 * Le compromis est structurel et sans solution parfaite : plus la fenêtre est longue,
 * moins il reste de sites présents de bout en bout. D'où deux garde-fous — au moins
 * `MIN_PANEL_MONTHS` mois (sans quoi il n'y a pas de cycle saisonnier complet et
 * « l'évolution » compare surtout des saisons entre elles) et au moins
 * `MIN_PANEL_COVERAGE` des sites du périmètre (sans quoi une courbe serait présentée
 * comme celle d'une commune alors qu'elle ne décrit qu'une minorité de ses sites).
 *
 * Quand aucune fenêtre ne satisfait les deux, `ok: false` : l'appelant doit afficher une
 * explication actionnable plutôt qu'un graphique trompeur.
 */
export function findFixedPanel(data: MonthSiteKwh, monthKeys: string[], totalSites: number): FixedPanel {
  const floor = Math.max(1, Math.ceil(MIN_PANEL_COVERAGE * totalSites));

  const spanBySite = new Map<string, SiteSpan>();
  for (const key of monthKeys) {
    for (const siteId of data.get(key)?.keys() ?? []) {
      const s = spanBySite.get(siteId);
      if (!s) spanBySite.set(siteId, { siteId, firstMonth: key, lastMonth: key, months: 1 });
      else { s.lastMonth = key; s.months += 1; }
    }
  }

  let best: { start: number; end: number; sites: Set<string> } | null = null;

  for (let i = 0; i < monthKeys.length; i++) {
    const first = data.get(monthKeys[i]);
    if (!first || first.size < floor) continue;
    // Intersection courante, réduite à mesure que la fenêtre s'étend vers la droite.
    let running = new Set(first.keys());
    for (let j = i; j < monthKeys.length; j++) {
      const month = data.get(monthKeys[j]);
      if (!month) break;
      const next = new Set<string>();
      for (const s of running) if (month.has(s)) next.add(s);
      if (next.size < floor) break;
      running = next;
      const length = j - i + 1;
      const bestLength = best ? best.end - best.start + 1 : 0;
      // À longueur égale, on préfère le panel le plus large : même information
      // temporelle, mais représentative de davantage de sites.
      if (length > bestLength || (best !== null && length === bestLength && running.size > best.sites.size)) {
        best = { start: i, end: j, sites: new Set(running) };
      }
    }
  }

  const length = best ? best.end - best.start + 1 : 0;
  const ok = best !== null && length >= MIN_PANEL_MONTHS;

  return {
    ok,
    siteIds: best ? [...best.sites] : [],
    totalSites,
    from: best ? monthKeys[best.start] : null,
    to: best ? monthKeys[best.end] : null,
    months: best ? monthKeys.slice(best.start, best.end + 1) : [],
    excluded: [...spanBySite.keys()]
      .filter((s) => !best?.sites.has(s))
      .map((siteId) => ({ siteId, firstMonth: spanBySite.get(siteId)?.firstMonth ?? null })),
    // Trié du moins couvert au mieux couvert : le site à rattraper d'abord est en tête.
    siteSpans: [...spanBySite.values()].sort((a, b) => a.months - b.months),
  };
}
