// lib/sentiment-lite.ts
// Lightweight sentiment helpers: intraday currency strength (G8) + COT (best-effort).
// No API keys. Short timeouts. In-memory TTL cache. Graceful-degrade on failure.

type CacheEntry<T> = { exp: number; val: T };
const cache = new Map<string, CacheEntry<any>>();

function setCache<T>(k: string, v: T, ttlSec: number) {
  cache.set(k, { exp: Date.now() + ttlSec * 1000, val: v });
}
function getCache<T>(k: string): T | null {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { cache.delete(k); return null; }
  return e.val as T;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "user-agent": "TradePlanApp/1.0" } });
    return r;
  } finally {
    clearTimeout(id);
  }
}

// ---------- Intraday Currency Strength (G8) ----------
// We derive a G8 basket from Yahoo Finance FX symbols without keys.
// Symbols (orientation matters):
//  - EURUSD=X, GBPUSD=X, AUDUSD=X, NZDUSD=X -> base is the currency, quote is USD
//  - USDJPY=X, USDCHF=X, USDCAD=X -> base is USD, quote is the currency
// For each pair, compute % change over the chosen intraday window (last vs first in range).
// Contribute +r to base currency and -r to quote currency; then average per currency.
// Return ranking strongest -> weakest.

type StrengthPoint = { ccy: string; score: number };
type StrengthResult = { ranking: StrengthPoint[]; summary: string };

const G8_PAIRS = [
  { sym: "EURUSD=X", base: "EUR", quote: "USD" },
  { sym: "GBPUSD=X", base: "GBP", quote: "USD" },
  { sym: "AUDUSD=X", base: "AUD", quote: "USD" },
  { sym: "NZDUSD=X", base: "NZD", quote: "USD" },
  { sym: "USDJPY=X", base: "USD", quote: "JPY" },
  { sym: "USDCHF=X", base: "USD", quote: "CHF" },
  { sym: "USDCAD=X", base: "USD", quote: "CAD" },
];

async function yahooChange(sym: string, range = "1d", interval = "15m", timeoutMs = 1200): Promise<number | null> {
  const key = `yf:${sym}:${range}:${interval}`;
  const cached = getCache<number>(key);
  if (cached != null) return cached;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`;
  try {
    const r = await fetchWithTimeout(url, timeoutMs);
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => null);
    const res = j?.chart?.result?.[0];
    const closes: number[] = res?.indicators?.quote?.[0]?.close || [];
    // Extract first and last valid closes
    let first: number | null = null;
    let last: number | null = null;
    for (let i = 0; i < closes.length; i++) {
      const v = closes[i];
      if (typeof v === "number" && isFinite(v)) { first = v; break; }
    }
    for (let i = closes.length - 1; i >= 0; i--) {
      const v = closes[i];
      if (typeof v === "number" && isFinite(v)) { last = v; break; }
    }
    if (first == null || last == null || first <= 0) return null;
    const pct = (last - first) / first;
    setCache(key, pct, 120); // 2 min cache per pair
    return pct;
  } catch {
    return null;
  }
}

export async function getCurrencyStrengthIntraday(opts?: {
  range?: "1d" | "5d";
  interval?: "15m" | "60m";
  ttlSec?: number;        // result cache
  timeoutMs?: number;     // per HTTP call
}): Promise<StrengthResult | null> {
  const range = opts?.range ?? "1d";
  const interval = opts?.interval ?? "15m";
  const ttlSec = opts?.ttlSec ?? 120; // overall ranking cache ~2m
  const timeoutMs = opts?.timeoutMs ?? 1200;

  const cacheKey = `strength:${range}:${interval}`;
  const hit = getCache<StrengthResult>(cacheKey);
  if (hit) return hit;

  // Contributions accumulator
  const sums = new Map<string, { sum: number; n: number }>();
  function add(ccy: string, r: number) {
    const cur = sums.get(ccy) || { sum: 0, n: 0 };
    cur.sum += r;
    cur.n += 1;
    sums.set(ccy, cur);
  }

  // Pull pairs in parallel with a hard cap timeout per request
  const changes = await Promise.all(G8_PAIRS.map(async p => {
    const r = await yahooChange(p.sym, range, interval, timeoutMs);
    return { ...p, r };
  }));

  let gotAny = false;
  for (const p of changes) {
    if (typeof p.r === "number") {
      gotAny = true;
      // Base up means base strong
      add(p.base, +p.r);
      add(p.quote, -p.r);
    }
  }
  if (!gotAny) return null;

  // Average per currency
  const ranking: StrengthPoint[] = [];
  for (const [ccy, { sum, n }] of sums.entries()) {
    if (n > 0) ranking.push({ ccy, score: sum / n });
  }
  ranking.sort((a, b) => b.score - a.score);

  const summary = ranking.map(x => x.ccy).join(" > ");
  const out = { ranking, summary };
  setCache(cacheKey, out, ttlSec);
  return out;
}

// ---------- COT Bias (best-effort from CFTC legacy financial futures file) ----------
// We parse "FinFutWk.txt" (legacy). If format changes or fetch fails, we return null.
// We compute Non-Commercial net (Long - Short) as simple bias.
// TTL: 24h.

const COT_URL = "https://www.cftc.gov/dea/newcot/FinFutWk.txt";
const COT_MAP: Record<string, string> = {
  EUR: "EURO FX",
  JPY: "JAPANESE YEN",
  GBP: "BRITISH POUND STERLING",
  AUD: "AUSTRALIAN DOLLAR",
  CAD: "CANADIAN DOLLAR",
  CHF: "SWISS FRANC",
  NZD: "NEW ZEALAND DOLLAR",
  // USD comes via Dollar Index, but it's less direct; we'll skip explicit USD here to avoid confusion.
};

export type CotBias = { ccy: string; net: number; bias: "net long" | "net short" | "flat" };
export type CotBrief = { updated?: string; items: CotBias[] };

export async function getCotBiasBrief(opts?: { ttlSec?: number; timeoutMs?: number }): Promise<CotBrief | null> {
  const ttlSec = opts?.ttlSec ?? 86400; // 24h
  const timeoutMs = opts?.timeoutMs ?? 1200;

  const cached = getCache<CotBrief>("cot:brief");
  if (cached) return cached;

  try {
    const r = await fetchWithTimeout(COT_URL, timeoutMs);
    if (!r.ok) return null;
    const txt = await r.text();

    const items: CotBias[] = [];

    function parseBlock(marketLabel: string): CotBias | null {
      const idx = txt.indexOf(marketLabel);
      if (idx < 0) return null;
      // Grab a window of lines following the label
      const window = txt.slice(idx, idx + 1200);
      // Try to capture Non-Commercial Long/Short on same or adjacent lines (format varies slightly)
      // Examples to match (case-insensitive):
      // "Non-Commercial    Long   123,456    Short   78,901"
      // "Non-Commercial Positions ... Longs 123,456 Shorts 78,901"
      const m = window.match(/Non[-\s]?Commercial[\s\S]{0,200}?Longs?\s+([\d,]+)[\s\S]{0,80}?Shorts?\s+([\d,]+)/i);
      if (!m) return null;
      const long = parseInt(m[1].replace(/,/g, ""), 10);
      const short = parseInt(m[2].replace(/,/g, ""), 10);
      if (!isFinite(long) || !isFinite(short)) return null;
      const net = long - short;
      const bias = Math.abs(net) < 500 ? "flat" : (net > 0 ? "net long" : "net short");
      return { ccy: "", net, bias };
    }

    for (const [ccy, label] of Object.entries(COT_MAP)) {
      const b = parseBlock(label);
      if (b) {
        b.ccy = ccy;
        items.push(b);
      }
    }

    if (!items.length) return null;

    const out: CotBrief = { items, updated: new Date().toISOString().slice(0, 10) };
    setCache("cot:brief", out, ttlSec);
    return out;
  } catch {
    return null;
  }
}

// ---------- Format helpers for context injection ----------

export function formatStrengthLine(res: StrengthResult | null): string | "" {
  if (!res?.ranking?.length) return "";
  // Keep it compact for prompt budget
  return `CSM (intraday): ${res.summary}`;
}

export function formatCotLine(res: CotBrief | null, focus?: string[]): string | "" {
  if (!res?.items?.length) return "";
  const picks = focus && focus.length
    ? res.items.filter(i => focus.includes(i.ccy))
    : res.items;
  if (!picks.length) return "";
  const parts = picks.map(i => `${i.ccy} ${i.bias}`);
  return `COT: ${parts.join("; ")}`;
}

// Utility to pull base/quote from instruments like "USDJPY", "EUR/USD", "XAUUSD"
export function parseInstrumentCurrencies(instrument: string): { base?: string; quote?: string } {
  const raw = String(instrument || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (raw.length >= 6) {
    return { base: raw.slice(0, 3), quote: raw.slice(3, 6) };
  }
  return {};
}
