// lib/prices.ts

export type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number };

const TD_BASE = "https://api.twelvedata.com/time_series";

// Map instruments to Twelve Data symbols
const SYMBOL_MAP: Record<string, string> = {
  EURUSD: "EUR/USD",
  GBPJPY: "GBP/JPY",
  XAUUSD: "XAU/USD",
  BTCUSD: "BTC/USD",
  NAS100: "NDX", // Nasdaq index
};

function tfToInterval(tf: "15m" | "1h" | "4h"): string {
  if (tf === "15m") return "15min";
  if (tf === "1h") return "1h";
  if (tf === "4h") return "4h";
  return "1h";
}

export async function getCandles(
  instrument: string,
  tf: "15m" | "1h" | "4h",
  bars: number
): Promise<Candle[]> {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) throw new Error("Missing TWELVEDATA_API_KEY env");

  const symbol = SYMBOL_MAP[instrument] ?? instrument;
  const interval = tfToInterval(tf);

  const url =
    `${TD_BASE}?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}&outputsize=${bars}&apikey=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`TwelveData HTTP ${res.status}`);
  const json = await res.json();

  if (!json.values || !Array.isArray(json.values)) {
    throw new Error(`TwelveData bad response: ${JSON.stringify(json).slice(0, 120)}`);
  }

  return json.values
    .reverse()
    .map((v: any) => ({
      t: new Date(v.datetime).getTime() / 1000,
      o: Number(v.open),
      h: Number(v.high),
      l: Number(v.low),
      c: Number(v.close),
      v: Number(v.volume ?? 0),
    }));
}
