// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

type Candle = { t: number; o: number; h: number; l: number; c: number };

type Instrument = { code: string; currencies?: string[] };

type CalendarItem = {
  date: string;
  time?: string;
  country?: string;
  currency?: string;
  impact?: "Low" | "Medium" | "High" | "Undefined" | string;
  title?: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};

type Headline = {
  title: string;
  url: string;
  source: string;
  seen?: string;          // ISO timestamp when we showed it
  published_at?: string;  // optional from /api/news
};

type PlanOut = {
  text: string;
  conviction?: number | null;
  setupType?: string | null;
  entry?: number | null;
  stop?: number | null;
  tp1?: number | null;
  tp2?: number | null;
  notes?: string | null;
};

type ApiOut =
  | { ok: true; plan: PlanOut; usedHeadlines: Headline[]; usedCalendar: CalendarItem[] }
  | { ok: false; reason: string; usedHeadlines: Headline[]; usedCalendar: CalendarItem[] };

// -------- short in-memory cache (5 min) ------------
type CacheEntry<T> = { data: T; exp: number };
const PLAN_CACHE: Map<string, CacheEntry<any>> =
  (globalThis as any).__PLAN_CACHE__ ?? new Map<string, CacheEntry<any>>();
(globalThis as any).__PLAN_CACHE__ = PLAN_CACHE;
const PLAN_CACHE_TTL = 5 * 60 * 1000;

function cacheGet<T>(key: string): T | null {
  const le = PLAN_CACHE.get(key);
  if (!le) return null;
  if (Date.now() > le.exp) {
    PLAN_CACHE.delete(key);
    return null;
  }
  return le.data as T;
}

function cacheSet(key: string, data: any) {
  PLAN_CACHE.set(key, { data, exp: Date.now() + PLAN_CACHE_TTL });
}

// -------------- candle helpers ---------------------

// Always call our own /api/candles endpoint (it’s the one you’ve verified works)
async function fetchCandlesViaApi(
  symbol: string,
  interval: "15m" | "1h" | "4h",
  limit = 200
): Promise<Candle[]> {
  try {
    const base =
      process.env.NEXT_PUBLIC_BASE_URL ||
      `https://${process.env.VERCEL_URL || ""}`.replace(/\/+$/, "");

    // Fallback if NEXT_PUBLIC_BASE_URL is missing in local dev:
    const url =
      base && base.startsWith("http")
        ? `${base}/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`
        : `/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;

    const rsp = await fetch(url, { cache: "no-store" });
    if (!rsp.ok) return [];
    const j = await rsp.json();
    return Array.isArray(j.candles) ? j.candles : [];
  } catch {
    return [];
  }
}

// EURUSD <-> EUR/USD
function altSymbol(code: string): string {
  if (code.includes("/")) return code.replace("/", "");
  if (code.length === 6) return `${code.slice(0, 3)}/${code.slice(3)}`;
  return code;
}

type AllFrames = { m4: Candle[]; m1: Candle[]; m15: Candle[]; triedAlt: string | null };

async function tryAll(symbol: string, limit = 200): Promise<AllFrames> {
  const [m4, m1, m15] = await Promise.all([
    fetchCandlesViaApi(symbol, "4h", limit),
    fetchCandlesViaApi(symbol, "1h", limit),
    fetchCandlesViaApi(symbol, "15m", limit),
  ]);
  return { m4, m1, m15, triedAlt: null };
}

async function getAllWithTimeout(code: string): Promise<AllFrames & { missing: string[] }> {
  const totalMs = Math.max(8000, Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 8000));
  const pollMs = Math.max(200, Number(process.env.PLAN_CANDLES_POLL_MS ?? 1000));
  const bigLimit = 200;

  const start = Date.now();
  let last: AllFrames = { m4: [], m1: [], m15: [], triedAlt: null };
  let used = code;
  let step = 0;

  while (Date.now() - start < totalMs) {
    step++;

    // sequence: normal -> bigLimit -> alt -> alt + bigLimit (then repeat)
    const useBig = step % 4 === 2 || step % 4 === 0;
    const useAlt = step % 4 === 3 || step % 4 === 0;

    used = useAlt ? altSymbol(code) : code;

    last = await tryAll(used, useBig ? bigLimit : 120);

    if (last.m4.length && last.m1.length && last.m15.length) {
      return { ...last, triedAlt: useAlt ? used : null, missing: [] };
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  const missing: string[] = [];
  if (!last.m4.length) missing.push("4h");
  if (!last.m1.length) missing.push("1h");
  if (!last.m15.length) missing.push("15m");
  return { ...last, missing };
}

// -------------- sentiment helper -------------------
async function scoreHeadlines(text: string): Promise<number> {
  // Your /lib/sentiment may be sync or async and may export default or named;
  // call through /api/news bias is simpler later, but keep this as a no-op for now.
  try {
    // very light lexicon placeholder (safe if lib signature varies)
    const lc = text.toLowerCase();
    const pos = (lc.match(/\b(up|beat|gain|rise|bull|strong)\b/g) || []).length;
    const neg = (lc.match(/\b(down|fall|lose|bear|weak)\b/g) || []).length;
    return Math.max(-1, Math.min(1, (pos - neg) / 10));
  } catch {
    return 0;
  }
}

// ------------------- handler -----------------------
export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOut>) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, reason: "Method not allowed", usedHeadlines: [], usedCalendar: [] });
  }

  try {
    const { instrument, date, calendar, headlines } = req.body as {
      instrument: Instrument | string;
      date?: string;
      calendar?: CalendarItem[] | null;
      headlines?: Headline[] | null;
    };

    const instr: Instrument = typeof instrument === "string" ? { code: instrument } : instrument;
    if (!instr?.code) {
      return res.status(400).json({ ok: false, reason: "Missing instrument code", usedHeadlines: [], usedCalendar: [] });
    }

    // cache key
    const cacheKey = JSON.stringify({
      code: instr.code,
      date: (date || new Date().toISOString().slice(0, 10)),
      caln: Array.isArray(calendar) ? calendar.length : -1,
      news: Array.isArray(headlines) ? headlines.length : -1,
    });
    const hit = cacheGet<ApiOut>(cacheKey);
    if (hit) {
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.status(200).json(hit);
    }

    // ensure headlines (fallback to /api/news)
    let usedHeadlines: Headline[] = Array.isArray(headlines) ? headlines : [];
    if (!usedHeadlines.length && instr.currencies?.length) {
      const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${process.env.VERCEL_URL || ""}`.replace(/\/+$/, "");
      const curr = encodeURIComponent(instr.currencies.join(","));
      const rsp = await fetch(`${base}/api/news?currencies=${curr}`, { cache: "no-store" });
      const j = await rsp.json();
      usedHeadlines = Array.isArray(j.items) ? j.items : [];
    }

    // recent headline filter (24–48h window)
    const sinceHrs = Math.max(24, parseInt(process.env.HEADLINES_SINCE_HOURS || "24", 10));
    const cutoff = Date.now() - sinceHrs * 3600_000;
    const recent = usedHeadlines.filter((h) => {
      const t = Date.parse(h.seen ?? h.published_at ?? "");
      return Number.isFinite(t) && t >= cutoff;
    });

    // optional blackout within ±90 min
    const calItems: CalendarItem[] = Array.isArray(calendar) ? calendar : [];
    const blackout = (() => {
      if (!calItems.length) return false;
      const now = Date.now();
      const within = 90 * 60 * 1000;
      return calItems.some((ev) => {
        const t = Date.parse(`${(ev as any).date ?? ""}T${(ev as any).time ?? "00:00"}:00Z`);
        return Number.isFinite(t) && Math.abs(t - now) <= within && String(ev.impact || "").toLowerCase().includes("high");
      });
    })();

    // --- Fetch candles (REQUIRE all 4h/1h/15m, with timeout & retries)
    const all = await getAllWithTimeout(instr.code);
    if (all.missing.length) {
      const secs = Math.round(Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 8000) / 1000);
      const triedAlt = all.triedAlt ? ` (tried alt symbol: ${all.triedAlt})` : "";
      const reason = `Missing candles for ${all.missing.join(", ")}.${triedAlt} Timed out after ${secs}s.`;
      const out: ApiOut = { ok: false, reason, usedHeadlines: recent.slice(0, 12), usedCalendar: calItems };
      cacheSet(cacheKey, out);
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.status(200).json(out);
    }

    const m15 = all.m15;
    const m1 = all.m1;
    const m4 = all.m4;

    // ----- baseline levels from 15m (guard against bad ordering)
    const lastClose = Number(m15.at(-1)?.c ?? NaN);
    const highs = m15.slice(-40).map((c) => Number(c.h));
    const lows = m15.slice(-40).map((c) => Number(c.l));
    const swingHi = Math.max(...highs);
    const swingLo = Math.min(...lows);
    const range = Math.max(1e-9, swingHi - swingLo);
    const fib618 = swingHi - 0.618 * range;

    let entry = Number(fib618.toFixed(5));
    let stop: number, tp1: number, tp2: number;

    // simple directional guess from last 20 candles (15m)
    const dir =
      (m15.at(-1)?.c ?? 0) > (m15.at(-21)?.c ?? 0) ? "Buy" :
      (m15.at(-1)?.c ?? 0) < (m15.at(-21)?.c ?? 0) ? "Sell" : "Buy";

    if (dir === "Buy") {
      stop = Number((swingLo - 0.25 * range).toFixed(5));
      tp1 = Number((swingHi + 0.25 * range).toFixed(5));
      tp2 = Number((swingHi + 0.50 * range).toFixed(5));
      // Safety: ensure stop < entry < tps
      if (!(stop < entry && entry < tp1 && tp1 < tp2)) {
        // fallback around lastClose
        entry = Number(lastClose.toFixed(5));
        stop = Number((entry - 0.5 * range).toFixed(5));
        tp1 = Number((entry + 0.5 * range).toFixed(5));
        tp2 = Number((entry + 0.8 * range).toFixed(5));
      }
    } else {
      // Sell
      entry = Number((swingLo + 0.382 * range).toFixed(5));
      stop  = Number((swingHi + 0.25 * range).toFixed(5));
      tp1   = Number((swingLo - 0.25 * range).toFixed(5));
      tp2   = Number((swingLo - 0.50 * range).toFixed(5));
      // Safety: ensure tps < entry < stop
      if (!(tp2 < tp1 && tp1 < entry && entry < stop)) {
        entry = Number(lastClose.toFixed(5));
        stop  = Number((entry + 0.5 * range).toFixed(5));
        tp1   = Number((entry - 0.5 * range).toFixed(5));
        tp2   = Number((entry - 0.8 * range).toFixed(5));
      }
    }

    // conviction base + HTF alignment
    let conviction = 60;
    const trend = (arr: Candle[]) => {
      const a = arr.at(-1)?.c ?? 0;
      const b = arr.at(-21)?.c ?? a;
      return a > b ? 1 : a < b ? -1 : 0;
    };
    const t1h = trend(m1);
    const t4h = trend(m4);
    const wantUp = dir === "Buy";
    let tfPenalty = 0;
    if (t1h < 0 && wantUp) tfPenalty += 10;
    if (t4h < 0 && wantUp) tfPenalty += 10;
    if (t1h > 0 && !wantUp) tfPenalty += 10;
    if (t4h > 0 && !wantUp) tfPenalty += 10;
    conviction = Math.max(0, conviction - tfPenalty);

    // news bias (light)
    const newsText = recent.map((h) => h.title).slice(0, 12).join("\n");
    try {
      const s = await scoreHeadlines(newsText);
      if (s > 0.15) conviction = Math.min(95, conviction + 5);
      if (s < -0.15) conviction = Math.max(5, conviction - 5);
    } catch { /* ignore */ }

    // blackout penalty
    if (blackout) conviction = Math.max(0, conviction - 15);

    // LLM formatting (uses your existing OPENAI env)
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const htf: string[] = [];
    htf.push(`4h ${t4h > 0 ? "up" : t4h < 0 ? "down" : "flat"}`);
    htf.push(`1h ${t1h > 0 ? "up" : t1h < 0 ? "down" : "flat"}`);

    const prompt = `
You are a trading assistant. Format a *single* trade card for ${instr.code}.

Context:
- Bias timeframe: 15m (1h/4h only for alignment/conviction).
- Headlines in last ${sinceHrs}h: ${recent.length}.
- HTF context: ${htf.join(", ")}.
- Blackout within ±90m: ${blackout ? "YES" : "NO"}.

Proposed technicals:
- Direction: **${dir}**
- Entry: **${entry}**
- Stop: **${stop}**
- TP1: **${tp1}**
- TP2: **${tp2}**

Return *only* these markdown fields:

**Trade Card: ${instr.code}**
**Type:** (Pullback | BOS | Range | Breakout)
**Direction:** (Buy | Sell)
**Entry:** <number>
**Stop:** <number>
**TP1:** <number>
**TP2:** <number>
**Conviction %:** ${conviction}

**Reasoning:** one paragraph with price-action logic, include HTF note if relevant.
**Timeframe Alignment:** 4H/1H/15M note.
**Invalidation Notes:** one sentence.
**Caution:** mention blackout/headlines if relevant.
`.trim();

    const chat = await client.chat.completions.create({
      model,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    });

    const text = chat.choices?.[0]?.message?.content?.trim() || "";

    const out: ApiOut = {
      ok: true,
      plan: {
        text,
        conviction,
        setupType: dir === "Buy" ? "Pullback" : "BOS",
        entry,
        stop,
        tp1,
        tp2,
        notes: blackout ? "High-impact event within ~90m – reduced conviction." : null,
      },
      usedHeadlines: recent.slice(0, 12),
      usedCalendar: calItems,
    };

    cacheSet(cacheKey, out);
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json(out);
  } catch (err: any) {
    console.error("PLAN API error:", err?.message || err);
    return res.status(500).json({ ok: false, reason: "Server error", usedHeadlines: [], usedCalendar: [] });
  }
}
