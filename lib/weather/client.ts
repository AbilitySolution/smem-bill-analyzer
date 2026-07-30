// Open-Meteo — aucune clé API requise. Archive (historique) + prévision (~16 jours max).
import { retryWithBackoff, defaultIsRetryable } from "@/lib/http-retry";

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

export interface DailyTemp { date: string; tempMean: number }

interface HttpError extends Error { status?: number }

function isRetryableHttp(err: unknown): boolean {
  const status = (err as { status?: number })?.status ?? null;
  return defaultIsRetryable(err) || (status !== null && status >= 500);
}

async function fetchDaily(url: string, params: Record<string, string>): Promise<DailyTemp[]> {
  const qs = new URLSearchParams({ ...params, daily: "temperature_2m_mean", timezone: "auto" });
  const res = await retryWithBackoff(async () => {
    const r = await fetch(`${url}?${qs}`, { next: { revalidate: 43_200 } }); // cache 12h
    if (!r.ok) {
      const err = new Error(`Open-Meteo ${r.status}`) as HttpError;
      err.status = r.status;
      throw err;
    }
    return r;
  }, 3, [1000, 3000], isRetryableHttp);

  const json = await res.json();
  const dates: string[] = json.daily?.time ?? [];
  const temps: (number | null)[] = json.daily?.temperature_2m_mean ?? [];
  return dates
    .map((date, i) => ({ date, tempMean: temps[i] }))
    .filter((d): d is DailyTemp => d.tempMean != null);
}

/** Températures journalières historiques (archive Open-Meteo), dates au format YYYY-MM-DD. */
export function fetchHistoricalDailyTemps(lat: number, lon: number, startDate: string, endDate: string): Promise<DailyTemp[]> {
  return fetchDaily(ARCHIVE_URL, {
    latitude: String(lat), longitude: String(lon),
    start_date: startDate, end_date: endDate,
  });
}

/** Prévision météo court terme (~16 jours max — limite Open-Meteo gratuite). */
export function fetchForecastDailyTemps(lat: number, lon: number): Promise<DailyTemp[]> {
  return fetchDaily(FORECAST_URL, {
    latitude: String(lat), longitude: String(lon), forecast_days: "16",
  });
}
