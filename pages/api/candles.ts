// /pages/api/candles.ts
import type { NextApiRequest, NextApiResponse } from "next";

/** Unified candle shape (newest -> oldest) */
type Candle = { t: number; o: number; h: number; l: number; c: number };
type TF = "15m" | "1h" | "4h";

const TD_KEY = process.env.TWELVEDATA_API_KEY || "";
const PG_KEY = process.env.POLYGON_API_KEY || "";
const FH_KEY = process.env.FINNHUB_API_KEY || "";

const PER_CALL_MS =
  Number(process.env.PLAN_PER_CALL_TIMEOUT_MS ?? "") || 8000;
// optional overall soft cap; we stop trying new providers if we cross it
const TOTAL_CAP_MS =
  Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? "") || 120000;

/** Small sleep helper */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Abortable fetch with timeout */
async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  ms: number
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const rsp = await fetch(input, { ...init, signal: ctrl.signal });
    return rsp;
  } finally {
    clearTimeout(timer);
  }
}

/** Accepts EURUSD or EUR/USD; returns both variants */
function symbolVariants(codeRaw: string) {
  const code = String(codeRaw || "").trim().toUpperCase();
  const noslash = code.replace("/", "");
  const slash =
    code.includes("/") || noslash.length !== code.length
      ? code.replace("/", "/")
      : `${code.slice(0, 3)}/${code.slice(3)}`;
  return { noslash, slash };
}

/** Normalize timestamp to seconds */
function toSec(x: number | string | undefined): number {
  if (x == null) return NaN;
  if (typeof x === "number") return x > 1e12 ? Math.floor(x / 1000) : x;
  const t = Date.parse(x);
  return Number.isFinite(t) ? Math.floor(t / 1000) : NaN;
}

/** Ensure array of {t,o,h,l,c}, newest -> oldest, all finite */
function normalize(list: any[]): Candle[] {
  const out: Candle[] = [];
  for (const v of list || []) {
    const t = toSec(v?.t ?? v?.time ?? v?.timestamp ?? v?.datetime);
    const o = Number(v?.o ?? v?.open);
    const h = Number(v?.h ?? v?.high);
    const l = Number(v?.l ?? v?.low);
    const c = Number(v?.c ?? v?.close);
    if (
      Number.isFinite(t) &&
      Number.isFinite(o) &&
      Number.isFinite(h) &&
      Number.isFinite(l) &&
      Number.isFinite(c)
    ) {
      out.push({ t, o, h, l, c });
    }
  }
  return out;
}

/** Roll up 15m candles to exact 1h or 4h OHLC (newest -> oldest) */
function rollupFrom15m(m15: Candle[], target: TF, want: number): Candle[] {
  const groupSize = target === "1h" ? 4 : 16; // 4×15m = 1h, 16×15m = 4h
  const out: Candle[] = [];
  for (let i = 0; i + groupSize - 1 < m15.length; i += groupSize) {
    const chunk = m15.slice(i, i + groupSize);
    // input is newest->oldest, group preserves that
    const o = chunk[chunk.length - 1].o; // oldest in chunk
    const c = chunk[0].c; // newest in chunk
    let h = -Infinity,
      l = Infinity,
      t = chunk[0].t;
    for (const k of chunk) {
      if (k.h > h) h = k.h;
      if (k.l < l) l = k.l;
      if (k.t > t) t = k.t; // keep newest time in the group
    }
    if (Number.isFinite(h) && Number.isFinite(l)) out.push({ t, o, h, l, c });
    if (out.length >= want) break;
  }
  return out;
}

/** TwelveData provider */
async function fromTwelveData(
  code: string,
  tf: TF,
  n: number
): Promise<Candle[]> {
  if (!TD_KEY) return [];
  // TD accepts "EUR/USD" and "EURUSD". Intervals: 15min, 1h, 4h
  const { slash, noslash } = symbolVariants(code);
  const symbol = slash; // prefer EUR/USD
  const interval = tf === "15m" ? "15min" : tf;
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(n));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", TD_KEY);

  const rsp = await fetchWithTimeout(url.toString(), { cache: "no-store" }, PER_CALL_MS);
  if (!rsp.ok) return [];
  const j: any = await rsp.json();
  const values: any[] = j?.values ?? j?.data ?? [];
  // TD gives newest first already
  return normalize(
    values.map((v) => ({
      t: v?.datetime,
      o: v?.open,
      h: v?.high,
      l: v?.low,
      c: v?.close,
    }))
  );
}

/** Polygon provider (best effort for FX) */
async function fromPolygon(
  code: string,
  tf: TF,
  n: number
): Promise<Candle[]> {
  if (!PG_KEY) return [];
  // Polygon FX aggregates use ticker like "C:EURUSD"
  // We'll try both C:EURUSD and C:EURUSD (noslash) – same result – but also
  // try "C:EURUSD" with both 15/60/240 minute ranges.
  const { noslash } = symbolVariants(code);
  const ticker = `C:${noslash}`;

  const mult = tf === "15m" ? 15 : tf === "1h" ? 60 : 240;
  const url = new URL(
    `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(
      ticker
    )}/range/${mult}/minute/now/${n}`
  );
  // Alternative form (from date range) often works better:
  // https://api.polygon.io/v2/aggs/ticker/C:EURUSD/range/15/minute/1970-01-01/now?limit=n
  url.searchParams.set("sort", "desc");
  url.searchParams.set("limit", String(n));
  url.searchParams.set("apiKey", PG_KEY);

  const rsp = await fetchWithTimeout(url.toString(), { cache: "no-store" }, PER_CALL_MS);
  if (!rsp.ok) return [];
  const j: any = await rsp.json();
  const results: any[] = j?.results ?? [];
  // Polygon returns newest -> oldest when sort=desc
  return normalize(
    results.map((v) => ({
      t: v?.t, // ms
      o: v?.o,
      h: v?.h,
      l: v?.l,
      c: v?.c,
    }))
  );
}

/** Finnhub provider (best effort for FX) */
async function fromFinnhub(
  code: string,
  tf: TF,
  n: number
): Promise<Candle[]> {
  if (!FH_KEY) return [];
  // Finnhub resolution uses: 1,5,15,60,240 etc.
  const res = tf === "15m" ? "15" : tf === "1h" ? "60" : "240";

  const { noslash } = symbolVariants(code);
  // Try a few common vendor symbols:
  const candidates = [
    `OANDA:${noslash.slice(0, 3)}_${noslash.slice(3)}`, // OANDA:EUR_USD
    `FX:${noslash}`, // FX:EURUSD
    noslash, // EURUSD
  ];

  for (const sym of candidates) {
    const url = new URL("https://finnhub.io/api/v1/forex/candle");
    url.searchParams.set("symbol", sym);
    url.searchParams.set("resolution", res);
    // Fetch enough recent bars. Finnhub needs from/to (unix seconds).
    const now = Math.floor(Date.now() / 1000);
    const back = 60 * 60 * 24 * 14; // last 14 days window (safe)
    url.searchParams.set("from", String(now - back));
    url.searchParams.set("to", String(now));
    url.searchParams.set("token", FH_KEY);

    const rsp = await fetchWithTimeout(url.toString(), { cache: "no-store" }, PER_CALL_MS);
    if (!rsp.ok) continue;
    const j: any = await rsp.json();
    if (j?.s !== "ok") continue;

    // Finnhub returns oldest->newest arrays; flip then slice newest->oldest
    const t: number[] = Array.isArray(j.t) ? j.t.slice() : [];
    const o: number[] = Array.isArray(j.o) ? j.o.slice() : [];
    const h: number[] = Array.isArray(j.h) ? j.h.slice() : [];
    const l: number[] = Array.isArray(j.l) ? j.l.slice() : [];
    const c: number[] = Array.isArray(j.c) ? j.c.slice() : [];

    const len = Math.min(t.length, o.length, h.length, l.length, c.length);
    const arr: Candle[] = [];
    for (let i = len - 1; i >= 0; i--) {
      arr.push({ t: t[i], o: o[i], h: h[i], l: l[i], c: c[i] });
    }
    return arr.slice(0, n);
  }

  return [];
}

/** Try providers in order. If direct TF fails, try 15m + roll-up */
async function getCandlesMulti(
  code: string,
  tf: TF,
  n: number
): Promise<{ candles: Candle[]; source: string }> {
  const started = Date.now();

  // 1) TwelveData direct
  let out = await fromTwelveData(code, tf, n);
  if (out.length >= n) return { candles: out.slice(0, n), source: "twelvedata" };
  if (Date.now() - started > TOTAL_CAP_MS) return { candles: out, source: "twelvedata" };

  // 2) Polygon direct
  let pg = await fromPolygon(code, tf, n);
  if (pg.length > out.length) out = pg;
  if (out.length >= n) return { candles: out.slice(0, n), source: "polygon" };
  if (Date.now() - started > TOTAL_CAP_MS) return { candles: out, source: "polygon" };

  // 3) Finnhub direct
  let fh = await fromFinnhub(code, tf, n);
  if (fh.length > out.length) out = fh;
  if (out.length >= n) return { candles: out.slice(0, n), source: "finnhub" };
  if (Date.now() - started > TOTAL_CAP_MS) return { candles: out, source: "finnhub" };

  // 4) Roll-up path from 15m
  const need15m = tf === "1h" ? n * 4 + 8 : tf === "4h" ? n * 16 + 16 : n;
  // 4a) TD 15m
  let m15 = await fromTwelveData(code, "15m", need15m);
  // 4b) if not enough, try polygon 15m
  if (m15.length < need15m) {
    const pg15 = await fromPolygon(code, "15m", need15m);
    if (pg15.length > m15.length) m15 = pg15;
  }
  // 4c) try finnhub 15m
  if (m15.length < need15m) {
    const fh15 = await fromFinnhub(code, "15m", need15m);
    if (fh15.length > m15.length) m15 = fh15;
  }
  if (tf === "15m") {
    return { candles: m15.slice(0, n), source: "15m-fallback" };
  }
  if (m15.length > 0) {
    const rolled = rollupFrom15m(m15, tf, n);
    return { candles: rolled.slice(0, n), source: "rollup-15m" };
  }

  // Nothing worked
  return { candles: out.slice(0, n), source: "none" };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, reason: "Method not allowed" });
  }

  const symbol = String(req.query.symbol ?? req.query.code ?? "EURUSD").toUpperCase();
  const tf = (String(req.query.interval ?? "15m") as TF);
  const n = Math.max(1, Math.min(1200, Number(req.query.limit ?? 200) || 200));
  const debug = String(req.query.debug ?? "") === "1";

  if (!["15m", "1h", "4h"].includes(tf)) {
    return res.status(400).json({ ok: false, reason: "Bad interval" });
  }

  try {
    const { candles, source } = await getCandlesMulti(symbol, tf, n);
    return res.status(200).json({
      ok: true,
      symbol,
      tf,
      limit: n,
      source,
      candles,
    });
  } catch (e: any) {
    if (debug) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
    return res.status(500).json({ ok: false });
  }
}
