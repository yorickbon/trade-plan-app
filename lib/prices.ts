// /lib/prices.ts

export type Candle = {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
};

export type TF = "15m" | "1h" | "4h";

/**
 * Fetch candles for an instrument from TwelveData
 * Accepts either a symbol string (e.g. "EURUSD") or an object { code: "EURUSD" }.
 * Always returns newest->oldest mapped to { t, o, h, l, c } (unix seconds).
 */
export async function getCandles(
  instrument: string | { code: string },
  tf: TF,
  n: number
): Promise<Candle[]> {
  const apikey = process.env.TWELVEDATA_API_KEY;
  const symbol = typeof instrument === "string" ? instrument : instrument.code;

  // Map our TF to TwelveData interval values
  const interval = tf === "15m" ? "15min" : tf; // "1h" and "4h" are already valid

  // Guard: if no key, return empty (prevents build from failing)
  if (!apikey) return [];

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(n));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", apikey);

  try {
    const rsp = await fetch(url.toString(), { cache: "no-store" });
    if (!rsp.ok) return [];
    const json: any = await rsp.json();

    const values: any[] = json?.values ?? json?.data ?? [];
    if (!Array.isArray(values)) return [];

    // TwelveData returns newest first; we keep that order (newest -> oldest).
    const out: Candle[] = values.map((v: any) => ({
      t: Math.floor(Date.parse(v.datetime) / 1000),
      o: Number(v.open),
      h: Number(v.high),
      l: Number(v.low),
      c: Number(v.close),
    }));

    return out.filter(
      (c) =>
        Number.isFinite(c.t) &&
        Number.isFinite(c.o) &&
        Number.isFinite(c.h) &&
        Number.isFinite(c.l) &&
        Number.isFinite(c.c)
    );
  } catch {
    return [];
  }
}
