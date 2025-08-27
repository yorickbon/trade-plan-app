// lib/prices.ts

type TDInterval = "4h" | "1h" | "15m" | "5m";

export type Candle = {
  time: string;   // ISO timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
};

// TwelveData fetcher
async function fetchTwelveData(
  symbol: string,
  interval: TDInterval,
  limit: number
): Promise<Candle[]> {
  const key = process.env.TWELVEDATA_API_KEY || "";
  if (!key) throw new Error("Missing TWELVEDATA_API_KEY");

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(limit));
  url.searchParams.set("format", "JSON");
  url.searchParams.set("apikey", key);

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);

  const rsp = await fetch(url.toString(), { signal: ctl.signal });
  clearTimeout(t);

  if (!rsp.ok) {
    const text = await rsp.text().catch(() => "");
    throw new Error(`TwelveData ${rsp.status}: ${text || rsp.statusText}`);
  }

  const json = await rsp.json();
  if (!json || !Array.isArray(json.values)) return [];

  // TD returns newest first; normalize + reverse to oldest->newest
  const out: Candle[] = json.values
    .map((v: any) => ({
      time: new Date(v.datetime).toISOString(),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: v.volume != null ? Number(v.volume) : null,
    }))
    .reverse();

  return out;
}

/**
 * Exported helper used by API routes and the chat box.
 */
export async function getCandles(
  symbol: string,
  interval: TDInterval,
  limit = 200
): Promise<Candle[]> {
  return fetchTwelveData(symbol, interval, limit);
}
