// lib/prices.ts

export type Candle = {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
};

// Twelve Data REST base
const TD_BASE = "https://api.twelvedata.com/time_series";

/**
 * Map app instruments to Twelve Data symbols.
 * Add/adjust as you expand.
 */
const SYMBOL_MAP: Record<string, string> = {
  EURUSD: "EUR/USD",
  GBPJPY: "GBP/JPY",
  XAUUSD: "XAU/USD",
  NAS100: "NDX", // Nasdaq 100 index on Twelve Data
};

function tfToInterval(tf: "4h" | "1h" | "15m"): string {
  if (tf === "15m") return "15min";
  if (tf === "1h") return "1h";
  return "4h";
}

/**
 * Fetch OHLC candles from Twelve Data, newest…oldest in API response.
 * We return oldest→newest (ascending time).
 */
export default async function getCandles(
  instrument: string,
  tf: "4h" | "1h" | "15m",
  limit = 200
): Promise<Candle[]> {
  const apikey = process.env.TWELVEDATA_API_KEY;
  if (!apikey) {
    throw new Error("Missing TWELVEDATA_API_KEY env var");
  }

  const symbol = SYMBOL_MAP[instrument] ?? instrument;
  const interval = tfToInterval(tf);

  const url =
    `${TD_BASE}?` +
    new URLSearchParams({
      symbol,
      interval,
      outputsize: String(limit),
      format: "JSON",
      apikey,
    }).toString();

  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    throw new Error(`Twelve Data HTTP ${r.status}`);
  }

  const json: any = await r.json();

  // Handle Twelve Data error shape
  if (json?.status === "error") {
    const msg = json?.message || "Twelve Data error";
    throw new Error(msg);
  }

  const rows: any[] = json?.values;
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  // Map to Candle, oldest → newest
  const candles = rows
    .slice()
    .reverse()
    .map((v: any) => {
      // Twelve Data datetime like "2025-08-26 19:15:00"
      // Append Z to treat as UTC.
      const t = Date.parse(v.datetime.replace(" ", "T") + "Z");
      return {
        t,
        o: Number(v.open),
        h: Number(v.high),
        l: Number(v.low),
        c: Number(v.close),
        v: v.volume != null ? Number(v.volume) : undefined,
      } as Candle;
    })
    .filter((c: Candle) => Number.isFinite(c.t) && Number.isFinite(c.c));

  return candles;
}
