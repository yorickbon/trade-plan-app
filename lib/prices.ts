// /lib/prices.ts
export type Candle = { t: number; o: number; h: number; l: number; c: number };
export type TF = "15m" | "1h" | "4h";

// ──────────────────────────────────────────────────────────────────────────────
// Small in-memory TTL cache to avoid hammering providers on bursts (plan + debug)
const CANDLE_CACHE = new Map<string, { expires: number; data: Candle[] }>();
const TTL_MS = 20_000; // 20s cache

export async function getCandles(
  instrument: string | { code: string },
  tf: TF,
  n: number
): Promise<Candle[]> {
  const raw = (typeof instrument === "string" ? instrument : instrument.code) || "EURUSD";
  const symbol = normalize(raw);
  const cacheKey = `${symbol}|${tf}`;
  const now = Date.now();

  // cache hit
  const hit = CANDLE_CACHE.get(cacheKey);
  if (hit && hit.expires > now && hit.data?.length) {
    return hit.data.slice(0, n);
  }

  const perCall = Math.max(2000, Number(process.env.PLAN_PER_CALL_TIMEOUT_MS ?? 8000));

  // 1) TwelveData (with alias fan-out for indices/crypto/metals)
  const td = await tdTryAliases(symbol, tf, n, perCall);
  if (td.length) return remember(cacheKey, td);

  // 2) Polygon (FOREX only)
  if (isForex(symbol)) {
    const pg = await polygonFetch(symbol, tf, n, perCall);
    if (pg.length) return remember(cacheKey, pg);
  }

  // 3) Finnhub (FOREX only)
  if (isForex(symbol)) {
    const fh = await finnhubFetch(symbol, tf, n, perCall);
    if (fh.length) return remember(cacheKey, fh);
  }

  // 4) Synthetic from nearest TF (best-effort so we never hard stand-down)
  const synth = await syntheticFromNearest(symbol, tf, n, perCall);
  if (synth.length) return remember(cacheKey, synth);

  return [];
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers

function remember(key: string, data: Candle[]): Candle[] {
  CANDLE_CACHE.set(key, { expires: Date.now() + TTL_MS, data });
  return data;
}

const ok = (c: Candle) =>
  [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite);

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return (await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ])) as T;
}

function normalize(s: string) {
  s = s.trim().toUpperCase();
  if (s.includes("/")) return s;
  if (/^[A-Z]{6}$/.test(s)) return `${s.slice(0, 3)}/${s.slice(3)}`;
  return s;
}

function isForex(s: string) {
  if (s.includes("/")) {
    const [a, b] = s.split("/");
    return a?.length === 3 && b?.length === 3;
  }
  return /^[A-Z]{6}$/.test(s);
}

function mapTf(tf: TF, provider: "td" | "polygon" | "finnhub"): string {
  if (provider === "td") return tf === "15m" ? "15min" : tf; // TD naming
  // polygon/finnhub use minutes
  return tf === "15m" ? "15" : tf === "1h" ? "60" : "240";
}

// ──────────────────────────────────────────────────────────────────────────────
// TwelveData with alias fan-out

const TD_ALIASES: Record<string, string[]> = {
  // Indices
  SPX500: ["SPX", "SP500", "US500", "S&P500", "SPX500"],
  NAS100: ["NDX", "NASDAQ100", "NAS100"],
  US30: ["DJI", "DOW", "US30"],
  GER40: ["DAX", "DE40", "GER40"],

  // Metals/Crypto (both slash and noslash forms)
  "XAU/USD": ["XAU/USD", "GOLD", "XAUUSD"],
  "BTC/USD": ["BTC/USD", "BTCUSD"],
  "ETH/USD": ["ETH/USD", "ETHUSD"],
};

function tdAliasesFor(sym: string): string[] {
  const base = sym.replace("/", "");
  const withSlash = sym.includes("/") ? sym : normalize(sym);
  const s = new Set<string>([withSlash, base, sym]);
  const extras = TD_ALIASES[base] || TD_ALIASES[withSlash] || TD_ALIASES[sym] || [];
  for (const a of extras) s.add(a);
  return [...s];
}

async function tdTryAliases(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  for (const s of tdAliasesFor(symbol)) {
    const out = await tdFetch(s, tf, n, ms);
    if (out.length) return out;
  }
  return [];
}

async function tdFetch(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  const key = process.env.TWELVEDATA_API_KEY || "";
  if (!key) return [];
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", mapTf(tf, "td"));
  url.searchParams.set("outputsize", String(n));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", key);

  try {
    const rsp = await withTimeout(fetch(url.toString(), { cache: "no-store" }), ms);
    if (!rsp.ok) return [];
    const j: any = await rsp.json();
    const values: any[] = Array.isArray(j?.values) ? j.values : [];
    const out = values
      .map(
        (v: any): Candle => ({
          t: Math.floor(Date.parse(v?.datetime ?? "") / 1000),
          o: Number(v?.open),
          h: Number(v?.high),
          l: Number(v?.low),
          c: Number(v?.close),
        })
      )
      .filter(ok);
    // TD returns newest → oldest already
    return out;
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Polygon (FOREX only)

async function polygonFetch(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  const key = process.env.POLYGON_API_KEY || "";
  if (!key) return [];
  const pSym = "C:" + symbol.replace("/", "");
  const mult = mapTf(tf, "polygon");
  // last 14 days window; sorted desc so newest→oldest
  const url = new URL(`https://api.polygon.io/v2/aggs/ticker/${pSym}/range/${mult}/minute/now-14d/now`);
  url.searchParams.set("limit", String(n));
  url.searchParams.set("adjusted", "true");
  url.searchParams.set("sort", "desc");
  url.searchParams.set("apiKey", key);

  try {
    const rsp = await withTimeout(fetch(url.toString(), { cache: "no-store" }), ms);
    if (!rsp.ok) return [];
    const j: any = await rsp.json();
    const r: any[] = Array.isArray(j?.results) ? j.results : [];
    return r
      .map(
        (x: any): Candle => ({
          t: Math.floor(Number(x?.t) / 1000),
          o: Number(x?.o),
          h: Number(x?.h),
          l: Number(x?.l),
          c: Number(x?.c),
        })
      )
      .filter(ok);
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Finnhub (FOREX only)

async function finnhubFetch(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  const key = process.env.FINNHUB_API_KEY || "";
  if (!key) return [];
  const finSym = `OANDA:${symbol.replace("/", "_")}`;
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
    const out: Candle[] = j.t
      .map((t: number, i: number) => ({
        t,
        o: Number(j.o[i]),
        h: Number(j.h[i]),
        l: Number(j.l[i]),
        c: Number(j.c[i]),
      }))
      .filter(ok)
      .reverse(); // Finnhub returns oldest→newest; reverse then slice newest-first
    return out.slice(0, n);
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
/** Synthetic fallbacks so we never “hard stand down”.
 *  We “explode” higher TF into lower TF bars (step model),
 *  or “aggregate” lower TF into higher TF OHLC.
 */

function explode(bars: Candle[], ratio: number, stepSec: number): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) {
    for (let i = 0; i < ratio; i++) {
      out.push({ t: b.t - i * stepSec, o: b.o, h: b.h, l: b.l, c: b.c });
    }
  }
  return out;
}

function aggregate(bars: Candle[], ratio: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < bars.length; i += ratio) {
    const g = bars.slice(i, i + ratio);
    if (!g.length) continue;
    const o = g[g.length - 1].o;
    const c = g[0].c;
    const h = Math.max(...g.map((x) => x.h));
    const l = Math.min(...g.map((x) => x.l));
    const t = g[0].t;
    out.push({ t, o, h, l, c });
  }
  return out;
}

async function syntheticFromNearest(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  // Try derive requested TF from closest available TD TFs
  if (tf === "15m") {
    const h1 = await tdTryAliases(symbol, "1h", Math.ceil(n / 4), ms);
    if (h1.length) return explode(h1, 4, 15 * 60).slice(0, n);
    const h4 = await tdTryAliases(symbol, "4h", Math.ceil(n / 16), ms);
    if (h4.length) return explode(h4, 16, 15 * 60).slice(0, n);
  }
  if (tf === "1h") {
    const h4 = await tdTryAliases(symbol, "4h", Math.ceil(n / 4), ms);
    if (h4.length) return explode(h4, 4, 60 * 60).slice(0, n);
    const m15 = await tdTryAliases(symbol, "15m", n * 4, ms);
    if (m15.length) return aggregate(m15, 4).slice(0, n);
  }
  if (tf === "4h") {
    const h1 = await tdTryAliases(symbol, "1h", n * 4, ms);
    if (h1.length) return aggregate(h1, 4).slice(0, n);
  }
  return [];
}
