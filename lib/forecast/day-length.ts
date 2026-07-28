// Longueur de nuit astronomique (déclinaison solaire + angle horaire) — aucune
// dépendance externe, formule déterministe valable pour tout point du globe
// hors cas polaires (non pertinent pour la Martinique, ~14.6°N).

const DEG = Math.PI / 180;

function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const cur = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((cur - start) / 86_400_000) + 1;
}

/** Déclinaison solaire (degrés) — approximation de Cooper (1969). */
function solarDeclinationDeg(n: number): number {
  return 23.45 * Math.sin(((2 * Math.PI) / 365) * (284 + n));
}

/** Durée de nuit (heures) pour une latitude et une date données. */
export function nightLengthHours(latitudeDeg: number, date: Date): number {
  const n = dayOfYear(date);
  const declRad = solarDeclinationDeg(n) * DEG;
  const latRad = latitudeDeg * DEG;
  // clamp : évite NaN aux latitudes polaires (nuit/jour polaire) — sans objet
  // pour la Martinique mais garde le module réutilisable ailleurs.
  const cosHourAngle = Math.max(-1, Math.min(1, -Math.tan(latRad) * Math.tan(declRad)));
  const hourAngleDeg = Math.acos(cosHourAngle) / DEG;
  const dayLengthHours = (2 / 15) * hourAngleDeg;
  return 24 - dayLengthHours;
}

/** Moyenne de la longueur de nuit sur une période [start, end] inclusive (échantillonnage journalier). */
export function averageNightLengthHours(latitudeDeg: number, start: Date, end: Date): number {
  let sum = 0;
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    sum += nightLengthHours(latitudeDeg, cur);
    count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count > 0 ? sum / count : nightLengthHours(latitudeDeg, start);
}
