// lib/prices.ts
export type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number };

const TD_BASE = "https://api.twelvedata.com/time_series";

// Map app instruments to Twelve Data symbols
const SYMBOL_MAP: Record<string, string> = {
  EURUSD: "EUR/USD",
  GBPJPY: "GBP/JPY",
  XAUUSD: "XAU/USD",
  BTCUSD: "BTC/USD",
  NAS100: "NDX", // or "Nasdaq 100" depending on your plan/symbol list
};

function tfToInterval(tf: "15m" | "1h" | "4h") {
  if (tf === "15m") return "15min";
  if (tf === "1h") return "1h";
  return "4h";
}

export async function getCandles(
  instrument: string,
  tf: "15m" | "1h" | "4h",
  bars: number
): Promise<Candle[]> {
  const apikey = process.env.TWELVEDATA_API_KEY;
  if (!apikey) throw new Error("Missing TWELVEDATA_API_KEY env");

  const symbol = SYMBOL_MAP[instrument] ?? instrument;
  const interval = tfToInterval(tf);

  const url =
    `${TD_BASE}?` +
    new URLSearchParams({
      symbol,
      interval,
      outputsize: String(bars),
      apikey,
      order: "ASC",     // oldest→newest
      format: "JSON",
    });

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err: any) {
    throw new Error(`fetch failed: ${err?.message || String(err)}`);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`TwelveData HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }

  let json: any;
  try {
    json = await res.json();
  } catch (err: any) {
    throw new Error(`twelvedata json parse error: ${err?.message || String(err)}`);
  }

  // TwelveData error payload?
  if (json?.status === "error") {
    throw new Error(`twelvedata error: ${json?.message || "unknown"}`);
  }

  if (!json?.values || !Array.isArray(json.values)) {
    throw new Error(`twelvedata unexpected payload: ${JSON.stringify(json).slice(0, 300)}`);
  }

  // Convert to our candle format
  return json.values.map((v: any) => ({
    t: Math.floor(new Date(v.datetime).getTime() / 1000),
    o: Number(v.open),
    h: Number(v.high),
    l: Number(v.low),
    c: Number(v.close),
  }));
}
