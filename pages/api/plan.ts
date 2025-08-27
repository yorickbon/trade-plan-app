// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { getCandles } from "../../lib/prices";
import { default as scoreSentimentImported } from "../../lib/sentiment";

/* ============================================================
   Types
   ============================================================ */
type Candle = { t: number; o: number; h: number; l: number; c: number };
type Instrument = { code: string; currencies?: string[] }; // e.g. EURUSD
type CalendarItem = {
  date: string;        // "YYYY-MM-DD"
  time?: string;       // "HH:mm" or ""
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
  url?: string;
  source?: string;
  seen?: string;       // ISO we mark when we showed it
  published_at?: string;
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
  | {
      ok: true;
      plan: PlanOut;
      usedHeadlines: Headline[];
      usedCalendar: CalendarItem[];
    }
  | {
      ok: false;
      reason: string;
      usedHeadlines: Headline[];
      usedCalendar: CalendarItem[];
    };

/* ============================================================
   Short in-memory cache (5 min)
   ============================================================ */
type CacheEntry<T> = { data: T; exp: number };
const PLAN_CACHE: Map<string, CacheEntry<any>> =
  (globalThis as any).__PLAN_CACHE__ ?? new Map<string, CacheEntry<any>>();
(globalThis as any).__PLAN_CACHE__ = PLAN_CACHE;
const PLAN_CACHE_TTL = 5 * 60 * 1000;

function cacheGet<T>(key: string): T | null {
  const e = PLAN_CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) {
    PLAN_CACHE.delete(key);
    return null;
  }
  return e.data as T;
}
function cacheSet(key: string, data: any) {
  PLAN_CACHE.set(key, { data, exp: Date.now() + PLAN_CACHE_TTL });
}

/* ============================================================
   Candle helpers
   ============================================================ */
async function loadCandles(
  symbol: string,
  interval: "15m" | "1h" | "4h",
  limit = 200
): Promise<Candle[]> {
  try {
    return await getCandles(symbol, interval, limit);
  } catch {
    return [];
  }
}

// Handle broker alt symbol (EUR/USD -> EURUSD)
function altSymbol(code: string): string {
  if (!code.includes("/")) return code;
  if (code.length <= 6) return `${code.slice(0, 3)}${code.slice(3)}`; // EUR/USD -> EURUSD
  return code.replace("/", "");
}

type AllFrames = { m4: Candle[]; m1: Candle[]; m15: Candle[]; triedAlt: string | null };

// Try one pass with given symbol and limit sizes
async function tryOnce(
  code: string,
  bigLimits = false
): Promise<AllFrames> {
  const limit15 = bigLimits ? 300 : 200;
  const limit1  = bigLimits ? 600 : 200;
  const limit4  = bigLimits ? 800 : 200;

  const [m4, m1, m15] = await Promise.all([
    loadCandles(code, "4h", limit4),
    loadCandles(code, "1h", limit1),
    loadCandles(code, "15m", limit15),
  ]);
  return { m4, m1, m15, triedAlt: null };
}

// Poll until all TF present or timeout
async function getAllTimeframesWithTimeout(code: string): Promise<AllFrames & { missing: string[] }> {
  const totalMs = Math.max(0, Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 60000));
  const pollMs  = Math.max(100, Number(process.env.PLAN_CANDLES_POLL_MS ?? 1000));
  const start   = Date.now();

  let last: AllFrames = { m4: [], m1: [], m15: [], triedAlt: null };

  // Loop: normal -> big -> alt -> alt+big -> repeat
  while (Date.now() - start < totalMs) {
    // 1) normal on base symbol
    last = await tryOnce(code, false);
    if (last.m4.length && last.m1.length && last.m15.length) return { ...last, missing: [] };

    // 2) big limits on base symbol
    last = await tryOnce(code, true);
    if (last.m4.length && last.m1.length && last.m15.length) return { ...last, missing: [] };

    // 3) alt symbol (EURUSD)
    const alt = altSymbol(code);
    last = { ...(await tryOnce(alt, false)), triedAlt: alt };
    if (last.m4.length && last.m1.length && last.m15.length) return { ...last, missing: [] };

    // 4) alt symbol + big limits
    last = { ...(await tryOnce(alt, true)), triedAlt: alt };
    if (last.m4.length && last.m1.length && last.m15.length) return { ...last, missing: [] };

    await new Promise((r) => setTimeout(r, pollMs));
  }

  const missing: string[] = [];
  if (!last.m4.length)  missing.push("4h");
  if (!last.m1.length)  missing.push("1h");
  if (!last.m15.length) missing.push("15m");
  return { ...last, missing };
}

/* ============================================================
   Sentiment helper — tolerant to sync/async/number return
   ============================================================ */
async function scoreHeadlines(text: string): Promise<number> {
  try {
    const maybe = (scoreSentimentImported as any)(text);
    const val   = typeof maybe?.then === "function" ? await maybe : maybe;
    return typeof val === "number" ? val : 0;
  } catch {
    return 0;
  }
}

/* ============================================================
   Simple 15m bias + pullback/BOS levels
   ============================================================ */
function lastClose(arr: Candle[]): number {
  return Number(arr[arr.length - 1]?.c ?? 0);
}
function prevClose(arr: Candle[]): number {
  return Number(arr[arr.length - 2]?.c ?? 0);
}
function trendSign(arr: Candle[]): number {
  // Use 21-period lookback as a light trend proxy
  const a = arr[arr.length - 1];
  const b = arr[Math.max(0, arr.length - 21)];
  if (!a || !b) return 0;
  return a.c > b.c ? 1 : a.c < b.c ? -1 : 0;
}

function computeLevels(m15: Candle[], wantUp: boolean) {
  // swing window
  const highs = m15.slice(-40).map((c) => c.h);
  const lows  = m15.slice(-40).map((c) => c.l);
  const swingHi = Math.max(...highs);
  const swingLo = Math.min(...lows);
  const range   = Math.max(1e-9, swingHi - swingLo);
  const fib618  = swingHi - 0.618 * range; // pullback-to-0.618

  // Ensure logical SL/TP relative to entry for both directions
  if (wantUp) {
    const entry = Number(fib618.toFixed(5));
    const stop  = Number((swingLo - 0.25 * range).toFixed(5));
    const tp1   = Number((swingLo + 0.25 * range).toFixed(5));
    const tp2   = Number((swingLo + 0.50 * range).toFixed(5));
    // Force monotonic: stop < entry < tp1 < tp2
    return {
      entry,
      stop: Math.min(stop, entry - 0.0001),
      tp1:  Math.max(tp1, entry + 0.0001),
      tp2:  Math.max(tp2, Math.max(tp1, entry + 0.0002)),
    };
  } else {
    const entry = Number((swingLo + 0.618 * range).toFixed(5)); // pullback up into short
    const stop  = Number((swingHi + 0.25 * range).toFixed(5));
    const tp1   = Number((swingHi - 0.25 * range).toFixed(5));
    const tp2   = Number((swingHi - 0.50 * range).toFixed(5));
    // Force monotonic: tp2 < tp1 < entry < stop
    return {
      entry,
      stop: Math.max(stop, entry + 0.0001),
      tp1:  Math.min(tp1, entry - 0.0001),
      tp2:  Math.min(tp2, Math.min(tp1, entry - 0.0002)),
    };
  }
}

/* ============================================================
   API Handler
   ============================================================ */
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

    // Cache key for same plan inputs
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

    // Use provided headlines; otherwise skip (UI fetches them)
    const usedHeadlines: Headline[] = Array.isArray(headlines) ? headlines : [];
    // Calendar if provided
    const usedCalendar: CalendarItem[] = Array.isArray(calendar) ? calendar : [];

    // ---- recent headline filter (24–48h) ----
    const sincHrs = Math.max(1, parseInt(process.env.HEADLINES_SINCE_HOURS || "48", 10));
    const cutoff = Date.now() - sincHrs * 3600_000;
    const recent = usedHeadlines.filter((h) => {
      const t = Date.parse(h.seen ?? h.published_at ?? "");
      return Number.isFinite(t) && t >= cutoff;
    });

    // ---- optional blackout within ~90 min (High impact) ----
    const callItems: CalendarItem[] = Array.isArray(calendar) ? calendar : [];
    const blackout = (() => {
      if (!callItems.length) return false;
      const now = Date.now();
      const within = 90 * 60 * 1000;
      return callItems.some((ev) => {
        const ts = Date.parse(`${(ev as any).date ?? ""}T${(ev as any).time ?? "00:00"}:00Z`);
        if (!Number.isFinite(ts)) return false;
        const soon = Math.abs(ts - now) <= within;
        return soon && String(ev.impact || "").toLowerCase().includes("high");
      });
    })();

    // ---- Fetch candles (REQUIRE all 4h/1h/15m, with timeout & retries) ----
    const all = await getAllTimeframesWithTimeout(instr.code);
    if (all.missing.length) {
      const sec = Math.floor(Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 60000) / 1000);
      const msg =
        `Standing down: Missing candles for ${all.missing.join(", ")}`
        + (all.triedAlt ? ` (tried alt symbol: ${all.triedAlt})` : "")
        + `. Timed out after ${sec}s.`;
      const out: ApiOut = { ok: false, reason: msg, usedHeadlines: recent.slice(0, 12), usedCalendar: callItems };
      cacheSet(cacheKey, out);
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.status(200).json(out);
    }

    const { m15, m1, m4 } = all;

    // ---- 15m bias & levels ----
    const last = lastClose(m15);
    const prev = prevClose(m15);
    const upBias = last > prev; // simple micro-bias

    const { entry, stop, tp1, tp2 } = computeLevels(m15, upBias);

    // ---- conviction baseline (adjust for headlines presence & TF alignment) ----
    let conviction = 60;
    conviction = Math.min(95, conviction + Math.min(3, recent.length)); // presence of headlines adds a bit
    if (blackout) conviction = Math.min(conviction, 55);                // cap if blackout

    // ---- lightweight headline sentiment (compile-time-safe) ----
    let newsBias = "Neutral";
    let newsScore = 0;
    try {
      const recentText = recent.slice(0, 12).map(h => `• ${h.title}`).join("\n");
      const s = await scoreHeadlines(recentText); // number in [-1..1]
      newsScore = Number(s || 0);
      newsBias = s >= 0.15 ? "Positive" : s <= -0.15 ? "Negative" : "Neutral";
    } catch { /* ignore */ }

    // ---- 1h / 4h alignment for conviction (not strict, just adjust) ----
    const t15 = trendSign(m15);
    const t1h = trendSign(m1);
    const t4h = trendSign(m4);
    const wantUp = upBias ? 1 : -1;

    let timePenalty = 0;
    const opp1 = t1h && (wantUp ? t1h < 0 : t1h > 0);
    const opp4 = t4h && (wantUp ? t4h < 0 : t4h > 0);
    if (opp1 && opp4) timePenalty += 10;
    else if (opp1 || opp4) timePenalty += 5;

    conviction = Math.max(0, conviction - timePenalty);

    // ---- LLM prompt (kept tight; it formats the card text) ----
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const htfNoteParts: string[] = [];
    if (t1h) htfNoteParts.push(`1h ${t1h > 0 ? "up" : "down"}`);
    if (t4h) htfNoteParts.push(`4h ${t4h > 0 ? "up" : "down"}`);

    const prompt = `
You are a trading assistant. Format a *single* trade card for ${instr.code}.

Context:
- Bias timeframe: 15m. HTFs (1h/4h) are for confirmation & conviction adjustments (not hard filters).
- Setup candidates: pullback-to-0.618 vs. BOS continuation.
- Macro headlines in last ${sincHrs}h: ${recent.length}
- News sentiment (lightweight): ${newsBias} (${newsScore.toFixed(2)})
- HTF context: ${htfNoteParts.join(", ") || "n/a"}
- Calendar blackout within ~90m: ${blackout ? "YES" : "NO"}

Proposed technicals:
- Direction: **${upBias ? "Buy" : "Sell"}**
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

**Reasoning:** one paragraph with price-action logic; include HTF note if relevant.
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
        setupType: upBias ? "Pullback" : "BOS",
        entry,
        stop,
        tp1,
        tp2,
        notes: blackout ? "High-impact event within ~90 min — reduced conviction." : null,
      },
      usedHeadlines: recent.slice(0, 12),
      usedCalendar: callItems,
    };

    cacheSet(cacheKey, out);
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json(out);
  } catch (err: any) {
    console.error("PLAN API error:", err?.message || err);
    return res
      .status(500)
      .json({ ok: false, reason: "Server error", usedHeadlines: [], usedCalendar: [] });
  }
}
