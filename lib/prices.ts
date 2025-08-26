// lib/prices.ts

export type Candle = {
  t: number; // unix ms
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
};

const TD_BASE = "https://api.twelvedata.com/time_series";

/**
 * Instruments in your UI -> Twelve Data symbols
 * NAS100 is not available on the free tier, so we proxy it to QQQ (NASDAQ)
 */
const SYMBOL_MAP: Record<string, string> = {
  EURUSD: "EUR/USD",
  GBPJPY: "GBP/JPY",
  XAUUSD: "XAU/USD",
  BTCUSD: "BTC/USD",
  NAS100: "QQQ", // <- proxy for NAS100 on free plan
};

/** Optional exchange hints (needed for some equities/ETFs) */
const EXCHANGE_MAP: Record<string, string> = {
  QQQ: "NASDAQ",
};

function toTdInterval(tf: "15m" | "1h" | "4h"): string {
  if (tf === "15m") return "15min";
  if (tf === "1h") return "1h";
  return "4h";
}

/**
 * Fetch candles from Twelve Data.
 * @param instrument e.g. 'EURUSD', 'GBPJPY', 'XAUUSD', 'NAS100'
 * @param tf '15m' | '1h' | '4h'
 * @param bars number of bars to fetch (max 5000 on TD)
 */
export default async function getCandles(
  instrument: string,
  tf: "15m" | "1h" | "4h",
  bars: number
): Promise<Candle[]> {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) throw new Error("Missing TWELVEDATA_API_KEY env var.");

  const symbol = SYMBOL_MAP[instrument] ?? instrument;
  const exchange = EXCHANGE_MAP[symbol];
  const interval = toTdInterval(tf);

  const url =
    `${TD_BASE}?symbol=${encodeURIComponent(symbol)}` +
    (exchange ? `&exchange=${encodeURIComponent(exchange)}` : "") +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${encodeURIComponent(String(bars))}` +
    `&order=ASC&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TwelveData HTTP ${res.status}: ${text || res.statusText}`);
  }

  const json: any = await res.json();

  // Twelve Data error payload shape
  if (json?.status === "error") {
    const msg: string =
      json?.message ||
      json?.note ||
      `TwelveData error for ${symbol} (${interval})`;
    throw new Error(msg);
  }

  const values = json?.values;
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  // Map to our Candle type (ascending order is already requested via &order=ASC)
  const out: Candle[] = values.map((v: any) => ({
    t: new Date(v.datetime).getTime(),
    o: Number(v.open),
    h: Number(v.high),
    l: Number(v.low),
    c: Number(v.close),
    v: v.volume != null ? Number(v.volume) : undefined,
  }));

  return out;
}
