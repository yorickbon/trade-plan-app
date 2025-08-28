// /lib/prices.ts
export type Candle = { t: number; o: number; h: number; l: number; c: number };
export type TF = "15m" | "1h" | "4h";

// ── in-memory TTL cache (shield providers from bursts)
const CANDLE_CACHE = new Map<string, { expires: number; data: Candle[]; source: string }>();
const TTL_MS = 20_000; // 20s

// expose last source for debug
const LAST_SOURCE = new Map<string, string>();
export function getLastSource(key: string): string {
  return LAST_SOURCE.get(key) || "";
}

export async function getCandles(
  instrument: string | { code: string },
  tf: TF,
  n: number
): Promise<Candle[]> {
  const raw = (typeof instrument === "string" ? instrument : instrument.code) || "EURUSD";
  const symbol = normalize(raw);
  const cacheKey = `${symbol}|${tf}`;
  const now = Date.now();

  const hit = CANDLE_CACHE.get(cacheKey);
  if (hit && hit.expires > now && hit.data?.length) {
    LAST_SOURCE.set(cacheKey, hit.source);
    return hit.data.slice(0, n);
  }

  const perCall = Math.max(2000, Number(process.env.PLAN_PER_CALL_TIMEOUT_MS ?? 8000));

  // 1) TwelveData (alias fan-out)
  const td = await tdTryAliases(symbol, tf, n, perCall);
  if (td.length) return remember(cacheKey, td, "twelvedata");

  // 2) Polygon (FOREX only)
  if (isForex(symbol)) {
    const pg = await polygonFetch(symbol, tf, n, perCall);
    if (pg.length) return remember(cacheKey, pg, "polygon");
  }

  // 3) Finnhub (FOREX only)
  if (isForex(symbol)) {
    const fh = await finnhubFetch(symbol, tf, n, perCall);
    if (fh.length) return remember(cacheKey, fh, "finnhub");
  }

  // 4) Yahoo Finance (FREE fallback)
  const yf = await yahooFetch(symbol, tf, n, perCall);
  if (yf.length) return remember(cacheKey, yf, "yahoo");

  // 5) Synthetic from nearest TF
  const synth = await syntheticFromNearest(symbol, tf, n, perCall);
  if (synth.length) return remember(cacheKey, synth, "synthetic");

  LAST_SOURCE.set(cacheKey, "none");
  return [];
}

// ── helpers
function remember(key: string, data: Candle[], source: string): Candle[] {
  CANDLE_CACHE.set(key, { expires: Date.now() + TTL_MS, data, source });
  LAST_SOURCE.set(key, source);
  return data;
}

const ok = (c: Candle) => [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite);

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
function mapTf(tf: TF, provider: "td" | "polygon" | "finnhub" | "yf"): string {
  if (provider === "td") return tf === "15m" ? "15min" : tf;
  if (provider === "yf") return tf === "15m" ? "15m" : "60m"; // 60m; 4h built from 60m
  return tf === "15m" ? "15" : tf === "1h" ? "60" : "240";
}

// ── TwelveData with alias fan-out
const TD_ALIASES: Record<string, string[]> = {
  SPX500: ["SPX", "SP500", "US500", "S&P500", "SPX500"],
  NAS100: ["NDX", "NASDAQ100", "NAS100"],
  US30:  ["DJI", "DOW", "US30"],
  GER40: ["DAX", "DE40", "GER40"],
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
    const out = values.map((v: any): Candle => ({
      t: Math.floor(Date.parse(v?.datetime ?? "") / 1000),
      o: Number(v?.open), h: Number(v?.high), l: Number(v?.low), c: Number(v?.close),
    })).filter(ok);
    return out; // TD is newest→oldest
  } catch { return []; }
}

// ── Polygon (FOREX)
async function polygonFetch(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  const key = process.env.POLYGON_API_KEY || "";
  if (!key) return [];
  const pSym = "C:" + symbol.replace("/", "");
  const mult = mapTf(tf, "polygon");
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
    return r.map((x: any): Candle => ({
      t: Math.floor(Number(x?.t) / 1000),
      o: Number(x?.o), h: Number(x?.h), l: Number(x?.l), c: Number(x?.c),
    })).filter(ok);
  } catch { return []; }
}

// ── Finnhub (FOREX)
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
    const out: Candle[] = j.t.map((t: number, i: number) => ({
      t, o: Number(j.o[i]), h: Number(j.h[i]), l: Number(j.l[i]), c: Number(j.c[i]),
    })).filter(ok).reverse();
    return out.slice(0, n);
  } catch { return []; }
}

// ── Yahoo Finance (FREE fallback)
function yahooSymbol(symbol: string): string | null {
  if (isForex(symbol)) return `${symbol.replace("/", "")}=X`;
  if (symbol.startsWith("XAU/") || symbol === "XAUUSD" || symbol === "XAU/USD") return "XAUUSD=X";
  if (symbol.startsWith("BTC/") || symbol === "BTCUSD" || symbol === "BTC/USD") return "BTC-USD";
  if (symbol.startsWith("ETH/") || symbol === "ETHUSD" || symbol === "ETH/USD") return "ETH-USD";
  if (symbol === "SPX500") return "^GSPC";
  if (symbol === "NAS100") return "^NDX";
  if (symbol === "US30")  return "^DJI";
  if (symbol === "GER40") return "^GDAXI";
  return null;
}
async function yahooFetch(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  const y = yahooSymbol(symbol);
  if (!y) return [];
  const interval = mapTf(tf, "yf"); // 15m or 60m
  const range = tf === "15m" ? "30d" : "60d";
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}`);
  url.searchParams.set("interval", interval);
  url.searchParams.set("range", range);
  url.searchParams.set("events", "history");
  try {
    const rsp = await withTimeout(fetch(url.toString(), { cache: "no-store" }), ms);
    if (!rsp.ok) return [];
    const j: any = await rsp.json();
    const r = j?.chart?.result?.[0];
    const ts: number[] = Array.isArray(r?.timestamp) ? r.timestamp : [];
    const q = r?.indicators?.quote?.[0] || {};
    const opens: number[] = q?.open || [];
    const highs: number[] = q?.high || [];
    const lows: number[] = q?.low || [];
    const closes: number[] = q?.close || [];
    let bars: Candle[] = [];
    for (let i = ts.length - 1; i >= 0; i--) {
      const t = Number(ts[i]), o = Number(opens[i]), h = Number(highs[i]), l = Number(lows[i]), c = Number(closes[i]);
      if ([t,o,h,l,c].every(Number.isFinite)) bars.push({ t, o, h, l, c });
      if (bars.length >= (tf === "4h" ? n * 4 : n)) break;
    }
    if (tf === "4h") bars = aggregate(bars, 4);
    return bars.slice(0, n);
  } catch { return []; }
}

// ── synthetic helpers
function explode(bars: Candle[], ratio: number, stepSec: number): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) for (let i = 0; i < ratio; i++) out.push({ t: b.t - i * stepSec, o: b.o, h: b.h, l: b.l, c: b.c });
  return out;
}
function aggregate(bars: Candle[], ratio: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < bars.length; i += ratio) {
    const g = bars.slice(i, i + ratio); if (!g.length) continue;
    const o = g[g.length - 1].o, c = g[0].c;
    const h = Math.max(...g.map(x => x.h)), l = Math.min(...g.map(x => x.l));
    const t = g[0].t; out.push({ t, o, h, l, c });
  }
  return out;
}
async function syntheticFromNearest(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  if (tf === "15m") {
    const h1 = await tdTryAliases(symbol, "1h", Math.ceil(n / 4), ms); if (h1.length) return explode(h1, 4, 15 * 60).slice(0, n);
    const h4 = await tdTryAliases(symbol, "4h", Math.ceil(n / 16), ms); if (h4.length) return explode(h4, 16, 15 * 60).slice(0, n);
  }
  if (tf === "1h") {
    const h4 = await tdTryAliases(symbol, "4h", Math.ceil(n / 4), ms); if (h4.length) return explode(h4, 4, 60 * 60).slice(0, n);
    const m15 = await tdTryAliases(symbol, "15m", n * 4, ms); if (m15.length) return aggregate(m15, 4).slice(0, n);
  }
  if (tf === "4h") {
    const h1 = await tdTryAliases(symbol, "1h", n * 4, ms); if (h1.length) return aggregate(h1, 4).slice(0, n);
  }
  return [];
}
