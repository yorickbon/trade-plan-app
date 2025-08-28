// /lib/prices.ts
export type Candle = { t: number; o: number; h: number; l: number; c: number };
export type TF = "15m" | "1h" | "4h";

/**
 * getCandles(instrument, tf, n)
 * - instrument: "EURUSD" | "EUR/USD" | { code: "EURUSD" } etc.
 * - returns NEWEST → OLDEST mapped to {t,o,h,l,c} (t = unix seconds)
 * - providers (fallback): TwelveData -> Polygon -> Finnhub
 * - All providers are called with short timeouts per-call (PLAN_PER_CALL_TIMEOUT_MS)
 */
export async function getCandles(
  instrument: string | { code: string },
  tf: TF,
  n: number
): Promise<Candle[]> {
  const symbol = normalizeSymbol(typeof instrument === "string" ? instrument : instrument.code);
  const perCallTimeoutMs = Math.max(2000, Number(process.env.PLAN_PER_CALL_TIMEOUT_MS ?? 8000));

  // Try providers in order
  const providers: Array<() => Promise<Candle[]>> = [
    () => tdFetch(symbol, tf, n, perCallTimeoutMs),
    () => polygonFetch(symbol, tf, n, perCallTimeoutMs),
    () => finnhubFetch(symbol, tf, n, perCallTimeoutMs),
  ];

  for (const fn of providers) {
    try {
      const arr = await fn();
      if (arr.length) return arr;
    } catch {
      // ignore and fall through to next provider
    }
  }
  return [];
}

// ───────────────────────────────── helpers

function normalizeSymbol(codeRaw: string): string {
  const s = codeRaw.trim().toUpperCase();
  if (s.includes("/")) return s; // already "EUR/USD"
  if (s.length === 6) return `${s.slice(0, 3)}/${s.slice(3)}`;
  return s;
}

function mapTf(tf: TF, provider: "td" | "polygon" | "finnhub"): string {
  if (provider === "td") return tf === "15m" ? "15min" : tf;
  if (provider === "polygon") return tf === "15m" ? "15" : tf === "1h" ? "60" : "240"; // minutes
  if (provider === "finnhub") return tf === "15m" ? "15" : tf === "1h" ? "60" : "240"; // minutes
  return tf;
}

function okCandle(c: Candle): boolean {
  return Number.isFinite(c.t) && Number.isFinite(c.o) && Number.isFinite(c.h) &&
         Number.isFinite(c.l) && Number.isFinite(c.c);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

// ───────────────────────────── Provider: TwelveData
async function tdFetch(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  const apikey = process.env.TWELVEDATA_API_KEY || "";
  if (!apikey) return [];
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", mapTf(tf, "td"));
  url.searchParams.set("outputsize", String(n));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", apikey);

  try {
    const rsp = await withTimeout(fetch(url.toString(), { cache: "no-store" }), ms);
    if (!rsp.ok) return [];
    const json: any = await rsp.json();
    const values: any[] = Array.isArray(json?.values) ? json.values : [];
    const out = values.map((v: any): Candle => ({
      t: Math.floor(Date.parse(v?.datetime ?? "") / 1000),
      o: Number(v?.open), h: Number(v?.high), l: Number(v?.low), c: Number(v?.close),
    })).filter(okCandle);
    // TD is newest → oldest; keep it that way to match app usage
    return out;
  } catch {
    return [];
  }
}

// ───────────────────────────── Provider: Polygon.io (forex)
async function polygonFetch(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  const key = process.env.POLYGON_API_KEY || "";
  if (!key) return [];
  // Polygon forex format: "C:EURUSD" (no slash)
  const pSym = "C:" + symbol.replace("/", "");
  const mult = mapTf(tf, "polygon"); // minutes
  const url = new URL(`https://api.polygon.io/v2/aggs/ticker/${pSym}/range/${mult}/minute/now-14d/now`);
  url.searchParams.set("limit", String(n));
  url.searchParams.set("adjusted", "true");
  url.searchParams.set("sort", "desc");
  url.searchParams.set("apiKey", key);

  try {
    const rsp = await withTimeout(fetch(url.toString(), { cache: "no-store" }), ms);
    if (!rsp.ok) return [];
    const json: any = await rsp.json();
    const results: any[] = Array.isArray(json?.results) ? json.results : [];
    // Polygon returns newest→oldest when sort=desc; convert to our shape
    return results.map((r: any): Candle => ({
      t: Math.floor(Number(r?.t) / 1000),
      o: Number(r?.o), h: Number(r?.h), l: Number(r?.l), c: Number(r?.c),
    })).filter(okCandle);
  } catch {
    return [];
  }
}

// ───────────────────────────── Provider: Finnhub (forex)
async function finnhubFetch(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  const key = process.env.FINNHUB_API_KEY || "";
  if (!key) return [];
  // Finnhub forex symbol: "OANDA:EUR_USD" or "FX:EURUSD" — use FX major:
  const finSym = `OANDA:${symbol.replace("/", "_")}`;

  // pull last ~14 days worth of bars for the interval
  const minutes = Number(mapTf(tf, "finnhub"));
  const to = Math.floor(Date.now() / 1000);
  const from = to - 14 * 24 * 3600;

  const url = new URL("https://finnhub.io/api/v1/forex/candle");
  url.searchParams.set("symbol", finSym);
  url.searchParams.set("resolution", String(minutes));
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(to));
  url.searchParams.set("token", key);

  try {
    const rsp = await withTimeout(fetch(url.toString(), { cache: "no-store" }), ms);
    if (!rsp.ok) return [];
    const j: any = await rsp.json();
    if (j?.s !== "ok" || !Array.isArray(j?.t)) return [];
    // Finnhub returns oldest→newest; we want NEWEST→OLDEST
    const out: Candle[] = j.t.map((t: number, i: number) => ({
      t, o: Number(j.o[i]), h: Number(j.h[i]), l: Number(j.l[i]), c: Number(j.c[i]),
    })).filter(okCandle).reverse();
    return out.slice(0, n);
  } catch {
    return [];
  }
}
