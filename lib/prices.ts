// /lib/prices.ts
export type Candle = { t: number; o: number; h: number; l: number; c: number };
export type TF = "15m" | "1h" | "4h";

/**
 * getCandles(instrument, tf, n)
 * - NEWEST → OLDEST mapped to {t,o,h,l,c} (t = unix seconds)
 * - providers (fallback):
 *   1) TwelveData (broad coverage + alias fan-out)
 *   2) Polygon (forex only)
 *   3) Finnhub (forex only)
 * - Last resort: synthetic from nearest HTF/LTF so we never hard stand-down.
 */
export async function getCandles(
  instrument: string | { code: string },
  tf: TF,
  n: number
): Promise<Candle[]> {
  const raw = (typeof instrument === "string" ? instrument : instrument.code) || "EURUSD";
  const symbol = normalizeSymbol(raw);
  const perCallTimeoutMs = Math.max(2000, Number(process.env.PLAN_PER_CALL_TIMEOUT_MS ?? 8000));

  // 1) Try TwelveData with aliases (indices/crypto/metal benefit most)
  const td = await tdTryAliases(symbol, tf, n, perCallTimeoutMs);
  if (td.length) return td;

  // 2) Polygon (forex only)
  if (isForex(symbol)) {
    const p = await polygonFetch(symbol, tf, n, perCallTimeoutMs);
    if (p.length) return p;
  }

  // 3) Finnhub (forex only)
  if (isForex(symbol)) {
    const f = await finnhubFetch(symbol, tf, n, perCallTimeoutMs);
    if (f.length) return f;
  }

  // 4) Synthetic from nearest TF on TwelveData (best-effort)
  const synth = await syntheticFromNearest(symbol, tf, n, perCallTimeoutMs);
  return synth;
}

// ───────────────────────────────── helpers

function isForex(s: string): boolean {
  if (s.includes("/")) {
    const [a, b] = s.split("/");
    return a?.length === 3 && b?.length === 3;
  }
  return /^[A-Z]{6}$/.test(s);
}

function normalizeSymbol(codeRaw: string): string {
  const s = codeRaw.trim().toUpperCase();
  if (s.includes("/")) return s;
  if (/^[A-Z]{6}$/.test(s)) return `${s.slice(0, 3)}/${s.slice(3)}`;
  return s;
}

function mapTf(tf: TF, provider: "td" | "polygon" | "finnhub"): string {
  if (provider === "td") return tf === "15m" ? "15min" : tf;
  // polygon/finnhub use minutes
  const m = tf === "15m" ? "15" : tf === "1h" ? "60" : "240";
  return m;
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

// ───────────────────────────── Provider: TwelveData with alias fan-out
// Aliases to improve hit-rate for indices/crypto/metals
const TD_ALIASES: Record<string, string[]> = {
  // indices
  "SPX500": ["SPX", "SP500", "US500"],
  "NAS100": ["NDX", "NASDAQ100", "NAS100"],
  "US30":   ["DJI", "DOW", "US30"],
  "GER40":  ["DAX", "DE40", "GER40"],
  // metals/crypto
  "XAU/USD": ["XAU/USD", "GOLD", "XAUUSD"],
  "BTC/USD": ["BTC/USD", "BTCUSD"],
  "ETH/USD": ["ETH/USD", "ETHUSD"],
};

function tdAliasesFor(sym: string): string[] {
  const base = sym.replace("/", "");
  const withSlash = sym.includes("/") ? sym : normalizeSymbol(sym);
  const candidates = new Set<string>([withSlash, base, sym]);
  const extras = TD_ALIASES[base] || TD_ALIASES[withSlash] || TD_ALIASES[sym] || [];
  extras.forEach(a => candidates.add(a));
  return [...candidates];
}

async function tdTryAliases(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  const aliases = tdAliasesFor(symbol);
  for (const s of aliases) {
    const out = await tdFetch(s, tf, n, ms);
    if (out.length) return out;
  }
  return [];
}

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
    // TD is newest → oldest; keep that order
    return out;
  } catch {
    return [];
  }
}

// ───────────────────────────── Provider: Polygon.io (forex)
async function polygonFetch(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  const key = process.env.POLYGON_API_KEY || "";
  if (!key) return [];
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
    })).filter(okCandle).reverse();
    return out.slice(0, n);
  } catch {
    return [];
  }
}

// ───────────────────────────── Synthetic fallbacks
function cloneC(c: Candle): Candle { return { t:c.t, o:c.o, h:c.h, l:c.l, c:c.c }; }

// explode a higher-TF candle into `ratio` sub-bars (simple step model)
function explode(bars: Candle[], ratio: number, stepSec: number): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) {
    // new bars: newest→oldest; create sub-bars newest-first
    for (let i = 0; i < ratio; i++) {
      const t = b.t - i * stepSec;
      out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c });
    }
  }
  return out;
}

// aggregate lower-TF bars into `ratio` groups (OHLC rollup)
function aggregate(bars: Candle[], ratio: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < bars.length; i += ratio) {
    const grp = bars.slice(i, i + ratio);
    if (!grp.length) continue;
    const o = grp[grp.length - 1].o;
    const c = grp[0].c;
    const h = Math.max(...grp.map(b => b.h));
    const l = Math.min(...grp.map(b => b.l));
    const t = grp[0].t;
    out.push({ t, o, h, l, c });
  }
  return out;
}

async function syntheticFromNearest(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  // Try TD 1h/4h and derive missing TFs
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
