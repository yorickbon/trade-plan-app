// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { getCandles } from "../../lib/prices";           // named export in your repo
import { scoreSentiment } from "../../lib/sentiment";    // returns number in [-1, 1]

// ---------- short in-memory cache (5 min) ----------
type CacheEntry<T> = { data: T; exp: number };
const PLAN_CACHE: Map<string, CacheEntry<any>> =
  (globalThis as any).__PLAN_CACHE__ ?? new Map<string, CacheEntry<any>>();
(globalThis as any).__PLAN_CACHE__ = PLAN_CACHE;
const PLAN_CACHE_TTL = 5 * 60 * 1000;

// ---------- types ----------
type Candle = { t: number; o: number; h: number; l: number; c: number };

type Instrument = {
  code: string;           // e.g. "EURUSD"
  currencies?: string[];  // e.g. ["EUR","USD"]
};

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
  seen?: string;           // ISO timestamp
  published_at?: string;   // some providers use this name
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
  | ({ ok: true; plan: PlanOut; usedHeadlines: Headline[]; usedCalendar: CalendarItem[] })
  | ({ ok: false; reason: string; usedHeadlines: Headline[]; usedCalendar: CalendarItem[] });

// ---------- small cache helpers ----------
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

// ---------- helpers ----------
function pickRecentHeadlines(items: Headline[], hours = 48): Headline[] {
  const cutoff = Date.now() - hours * 3600_000;
  return items.filter((h) => {
    const t = Date.parse((h.seen ?? h.published_at ?? "") as string);
    return Number.isFinite(t) && t > cutoff;
  });
}

async function pollCandlesUntilAll(
  symbol: string,
  intervals: ("15m" | "1h" | "4h")[],
  limit = 200,
  timeoutMs = Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 20_000),
  pollMs = Number(process.env.PLAN_CANDLES_POLL_MS ?? 1000)
): Promise<Record<"15m" | "1h" | "4h", Candle[]>> {
  const start = Date.now();
  const out: Partial<Record<"15m" | "1h" | "4h", Candle[]>> = {};

  const need = new Set(intervals);

  while (need.size) {
    for (const tf of Array.from(need)) {
      try {
        const arr = await getCandles(symbol, tf, limit);
        if (Array.isArray(arr) && arr.length > 0) {
          out[tf] = arr;
          need.delete(tf);
        }
      } catch {
        // ignore; we'll retry until timeout
      }
    }
    if (!need.size) break;
    if (Date.now() - start >= timeoutMs) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  const missing = Array.from(need);
  if (missing.length) {
    throw new Error(
      `Missing candles for ${missing.join(", ")} (tried alt symbol where applicable). Timed out after ${timeoutMs / 1000}s.`
    );
  }
  return out as Record<"15m" | "1h" | "4h", Candle[]>;
}

// ---------- route ----------
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiOut>
) {
  try {
    if (req.method !== "POST") {
      return res
        .status(405)
        .json({ ok: false, reason: "Method not allowed", usedHeadlines: [], usedCalendar: [] });
    }

    // body
    const { instrument, date, calendar, headlines } = req.body as {
      instrument: Instrument | string;
      date?: string;
      calendar?: CalendarItem[] | null;
      headlines?: Headline[] | null;
    };

    const instr: Instrument =
      typeof instrument === "string" ? { code: instrument } : instrument;

    if (!instr?.code) {
      return res
        .status(400)
        .json({ ok: false, reason: "Missing instrument code", usedHeadlines: [], usedCalendar: [] });
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

    // ensure we have headlines (fallback: /api/news?curr=…)
    let usedHeadlines: Headline[] = Array.isArray(headlines) ? headlines : [];
    if (!usedHeadlines.length && instr.currencies?.length) {
      try {
        const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;
        const curr = encodeURIComponent(instr.currencies.join(","));
        const rsp = await fetch(`${base}/api/news?curr=${curr}`, { cache: "no-store" });
        if (rsp.ok) {
          const j = await rsp.json();
          usedHeadlines = Array.isArray(j.items) ? j.items : [];
        }
      } catch { /* ignore */ }
    }

    // recent headlines window
    const sinceHrs = Math.max(1, parseInt(process.env.HEADLINES_SINCE_HOURS || "48", 10));
    const recent = pickRecentHeadlines(usedHeadlines, sinceHrs);

    // optional “stand down on news” rule was removed per new plan; we only apply a small conviction modifier

    // optional blackout if a high-impact calendar event is within ~90 min
    const calItems: CalendarItem[] = Array.isArray(calendar) ? calendar : [];
    const blackout = calItems.some((ev) => {
      if (!ev?.date) return false;
      const when = Date.parse(`${ev.date}T${ev.time ?? "00:00"}:00Z`);
      if (!Number.isFinite(when)) return false;
      const dt = Math.abs(when - Date.now());
      return (ev.impact ?? "").toLowerCase().includes("high") && dt < 90 * 60 * 1000;
    });

    // ---------- fetch candles with polling (must have all 3 TFs) ----------
    const symbol = instr.code;
    const needTFs: ("15m" | "1h" | "4h")[] = ["15m", "1h", "4h"];
    let m15: Candle[] = [];
    let h1: Candle[] = [];
    let h4: Candle[] = [];
    try {
      const all = await pollCandlesUntilAll(symbol, needTFs, 200);
      m15 = all["15m"];
      h1 = all["1h"];
      h4 = all["4h"];
    } catch (e: any) {
      const reason = `Standing down: ${e?.message || "Missing candles for one or more timeframes."}`;
      const out: ApiOut = { ok: false, reason, usedHeadlines: recent.slice(0, 12), usedCalendar: calItems };
      cacheSet(cacheKey, out);
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.status(200).json(out);
    }

    // ---------- simple 15m bias ----------
    const last = m15[m15.length - 1] ?? m15[0];
    const prev = m15[m15.length - 2] ?? last;
    const upBias = last.c >= prev.c ? "Buy" : "Sell";

    // swings & range from last 40 bars
    const highs = m15.slice(-40).map((c) => c.h);
    const lows  = m15.slice(-40).map((c) => c.l);
    const swingHi = Math.max(...highs);
    const swingLo = Math.min(...lows);
    const range = Math.max(1e-9, swingHi - swingLo);

    // ------ level proposals based on bias (FIXED LOGIC) ------
    const fib618 = swingHi - 0.618 * range;     // pullback for long
    const buffer = 0.10 * range;                // 10% of range buffer

    let entry: number;
    let stop: number;
    let tp1: number;
    let tp2: number;

    if (upBias === "Buy") {
      entry = Number(fib618.toFixed(5));
      stop  = Number((swingLo - buffer).toFixed(5));
      tp1   = Number((swingHi + 0.25 * range).toFixed(5));
      tp2   = Number((swingHi + 0.50 * range).toFixed(5));
    } else {
      const shortFib = swingLo + 0.618 * range;
      entry = Number(shortFib.toFixed(5));
      stop  = Number((swingHi + buffer).toFixed(5));
      tp1   = Number((swingLo - 0.25 * range).toFixed(5));
      tp2   = Number((swingLo - 0.50 * range).toFixed(5));
    }

    // ---------- conviction baseline ----------
    let conviction = 60;
    // small boost when we actually have some recent headlines:
    conviction = Math.min(95, conviction + Math.min(3, recent.length));
    if (blackout) conviction = Math.min(conviction, 55);

    // ---------- lightweight news sentiment (does NOT block trading) ----------
    let newsBias = "Neutral";
    let newsScore = 0;
    try {
      const recentText =
        recent
          .slice(0, 12)
          .map((h) => `• ${h.title}`)
          .join("\n") || "";
      const s = scoreSentiment(recentText); // sync, number in [-1, 1]
      newsScore = Number(s || 0);
      newsBias = s > 0.15 ? "Positive" : s < -0.15 ? "Negative" : "Neutral";
    } catch {
      // ignore sentiment errors
    }

    // ---------- LLM formatting ----------
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const prompt = `
You are a trading assistant. Format a *single* trade card for ${instr.code}.

Context:
• Bias timeframe: 15m. HTFs (1h/4h) are used for alignment (not strict).
• 1h/4h context: compute broad trend (higher-highs/lows = uptrend; lower-highs/lows = downtrend).
• Setup candidates: pullback-to-0.618 vs. BOS continuation. Use the precomputed levels.
• Macro headlines in last ${sinceHrs}h: ${recent.length}
• News sentiment (lightweight): ${newsBias} (${newsScore.toFixed(2)})
• Calendar blackout within ~90m: ${blackout ? "YES" : "NO"}

**Proposed technicals**
- Direction: **${upBias}**
- Entry: **${entry}**
- Stop: **${stop}**
- TP1: **${tp1}**
- TP2: **${tp2}**
- Conviction %: **${conviction}**

Return **only** these markdown fields:

**Trade Card: ${instr.code}**
**Type:** (Pullback | BOS | Range | Breakout)
**Direction:** (Buy | Sell)
**Entry:** <number>
**Stop:** <number>
**TP1:** <number>
**TP2:** <number>
**Conviction %:** <number>

**Reasoning:** one paragraph with price-action logic and brief 1h/4h context.
**Timeframe Alignment:** short note about 4H/1H/15M alignment (not strict).
**Invalidation Notes:** when the idea is wrong.
**Caution:** mention blackout/headlines if relevant.
`;

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
      usedCalendar: calItems,
    };

    cacheSet(cacheKey, out);
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json(out);
  } catch (err: any) {
    console.error("Plan API error:", err?.message || err);
    return res
      .status(500)
      .json({ ok: false, reason: "Server error", usedHeadlines: [], usedCalendar: [] });
  }
}
