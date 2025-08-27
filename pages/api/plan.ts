// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { getCandles } from "../../lib/prices";
import { scoreSentiment } from "../../lib/sentiment";

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
  url?: string;
  source?: string;
  seen?: string;           // ISO timestamp (our app)
  published_at?: string;   // provider field (newsdata)
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

// ---------- tiny cache helpers ----------
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
function pickRecentHeadlines(items: Headline[], sinceHrs: number): Headline[] {
  const cutoff = Date.now() - sinceHrs * 3600_000;
  return items.filter((h) => {
    const t = Date.parse(h.seen ?? h.published_at ?? "");
    return Number.isFinite(t) && t >= cutoff;
  });
}

// poll until all TFs have candles or timeout
async function fetchCandlesAll(
  symbol: string,
  intervals: ("15m" | "1h" | "4h")[],
  limit = 200
): Promise<Record<string, Candle[]>> {
  const timeoutMs = parseInt(process.env.PLAN_CANDLES_TIMEOUT_MS || "20000", 10);
  const pollMs = parseInt(process.env.PLAN_CANDLES_POLL_MS || "1000", 10);
  const deadline = Date.now() + timeoutMs;

  const result: Record<string, Candle[]> = { "15m": [], "1h": [], "4h": [] };

  while (Date.now() < deadline) {
    await Promise.all(
      intervals.map(async (iv) => {
        if (result[iv]?.length) return;
        const arr = await getCandles({ code: symbol }, iv, limit);
        if (Array.isArray(arr) && arr.length) result[iv] = arr as Candle[];
      })
    );
    const allHave = intervals.every((iv) => result[iv]?.length);
    if (allHave) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return result;
}

function round5(n: number) {
  return Number(n.toFixed(5));
}

function trendFrom(c: Candle[]): "Up" | "Down" | "Flat" {
  if (!c?.length) return "Flat";
  const last = c[c.length - 1];
  const prev = c[c.length - 2] ?? last;
  if (last.c > prev.c) return "Up";
  if (last.c < prev.c) return "Down";
  return "Flat";
}

// ---------- handler ----------
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiOut>
) {
  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ ok: false, reason: "Method not allowed", usedHeadlines: [], usedCalendar: [] });
  }

  try {
    const { instrument, date, calendar, headlines } = req.body as {
      instrument: Instrument | string;
      date?: string;
      calendar?: CalendarItem[] | null;
      headlines?: Headline[] | null;
    };

    // normalize instrument
    const instr: Instrument =
      typeof instrument === "string" ? { code: instrument } : instrument || ({} as any);
    if (!instr.code) {
      return res
        .status(400)
        .json({ ok: false, reason: "Missing instrument code", usedHeadlines: [], usedCalendar: [] });
    }

    // cache key
    const cacheKey = JSON.stringify({
      code: instr.code,
      date: (date || new Date().toISOString()).slice(0, 10),
      caln: Array.isArray(calendar) ? calendar.length : -1,
      news: Array.isArray(headlines) ? headlines.length : -1,
    });
    const cached = cacheGet<ApiOut>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.status(200).json(cached);
    }

    // ensure headlines (fallback to API)
    let usedHeadlines: Headline[] = Array.isArray(headlines) ? headlines : [];
    if (!usedHeadlines.length && instr.currencies?.length) {
      const curr = encodeURIComponent(instr.currencies.join(","));
      const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;
      const rsp = await fetch(`${base}/api/news?curr=${curr}`, { cache: "no-store" });
      const j = await rsp.json();
      usedHeadlines = (Array.isArray(j?.items) ? j.items : []) as Headline[];
    }

    // recent headline window
    const sinceHrs = Math.max(1, parseInt(process.env.HEADLINES_SINCE_HOURS || "48", 10));
    const recent = pickRecentHeadlines(usedHeadlines, sinceHrs);

    // blackout: if any high-impact event within 90 min
    const callItems: CalendarItem[] = Array.isArray(calendar) ? calendar : [];
    const blackout = callItems.some((ev) => {
      if (!ev?.time || !ev?.date) return false;
      const when = Date.parse(`${ev.date}T${ev.time || "00:00"}:00Z`);
      if (!Number.isFinite(when)) return false;
      const dt = Math.abs(when - Date.now());
      return (ev.impact || "").toLowerCase().includes("high") && dt < 90 * 60 * 1000;
    });

    // fetch candles with polling (all three TFs)
    const { "15m": m15, "1h": h1, "4h": h4 } = await fetchCandlesAll(instr.code, ["15m", "1h", "4h"], 200);
    if (!m15?.length || !h1?.length || !h4?.length) {
      const out: ApiOut = {
        ok: false,
        reason: `Missing candles for one or more timeframes.`,
        usedHeadlines: recent.slice(0, 12),
        usedCalendar: callItems,
      };
      cacheSet(cacheKey, out);
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.status(200).json(out);
    }

    // -------- technicals on 15m (direction + range) --------
    const last15 = m15[m15.length - 1];
    const prev15 = m15[m15.length - 2] ?? last15;
    const upBias = last15.c >= prev15.c ? "Buy" : "Sell";

    const swingHi = Math.max(...m15.slice(-40).map((c) => c.h));
    const swingLo = Math.min(...m15.slice(-40).map((c) => c.l));
    const range = Math.max(1e-9, swingHi - swingLo);

    // pullback reference levels
    const pullbackBuy = swingHi - 0.618 * range;
    const pullbackSell = swingLo + 0.618 * range;

    // direction-aware entry/SL/TP with guard rails
    let entry: number, stop: number, tp1: number, tp2: number;
    if (upBias === "Buy") {
      entry = pullbackBuy;
      stop = Math.min(entry - 0.10 * range, swingLo - 0.05 * range); // must be < entry
      tp1 = entry + 0.25 * range;
      tp2 = entry + 0.50 * range;
      if (stop >= entry) stop = entry - 0.05 * range;
      if (tp1 <= entry) tp1 = entry + 0.25 * range;
      if (tp2 <= tp1) tp2 = tp1 + 0.25 * range;
    } else {
      entry = pullbackSell;
      stop = Math.max(entry + 0.10 * range, swingHi + 0.05 * range); // must be > entry
      tp1 = entry - 0.25 * range;
      tp2 = entry - 0.50 * range;
      if (stop <= entry) stop = entry + 0.05 * range;
      if (tp1 >= entry) tp1 = entry - 0.25 * range;
      if (tp2 >= tp1) tp2 = tp1 - 0.25 * range;
    }

    // round to 5dp for FX
    entry = round5(entry);
    stop  = round5(stop);
    tp1   = round5(tp1);
    tp2   = round5(tp2);

    // -------- conviction baseline + flexible HTF alignment --------
    let conviction = 60;
    const trend1h = trendFrom(h1);
    const trend4h = trendFrom(h4);
    const sign15 = upBias === "Buy" ? 1 : -1;
    const sign1h = trend1h === "Up" ? 1 : trend1h === "Down" ? -1 : 0;
    const sign4h = trend4h === "Up" ? 1 : trend4h === "Down" ? -1 : 0;

    if (sign15 && sign1h) conviction += sign15 === sign1h ? 10 : -5;
    if (sign15 && sign4h) conviction += sign15 === sign4h ? 10 : -5;

    conviction = Math.min(95, Math.max(5, conviction + Math.min(3, recent.length)));
    if (blackout) conviction = Math.min(conviction, 55);

    // -------- lightweight headline sentiment (SYNC) --------
    let newsBias = "Neutral";
    let newsScore = 0;
    try {
      const recentText = recent.slice(0, 12).map((h) => `• ${h.title}`).join("\n");
      const s = scoreSentiment(recentText); // number in [-1, 1]
      newsScore = Number(s || 0);
      newsBias = s > 0.15 ? "Positive" : s < -0.15 ? "Negative" : "Neutral";
    } catch {}

    // -------- LLM formatting (unchanged intent) --------
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const prompt = `
You are a trading assistant. Format a *single* trade card for ${instr.code}.

Context:
- Bias timeframe: 15m. HTFs (1h/4h) are for confirmation only (not strict).
- Setup candidates: pullback-to-0.618 vs. BOS continuation.
- 1H trend: ${trend1h}; 4H trend: ${trend4h}
- Macro headlines in last ${sinceHrs}h: ${recent.length}
- News sentiment (lightweight): ${newsBias} (${newsScore.toFixed(2)})
- Calendar blackout within ~90m: ${blackout ? "YES" : "NO"}

**Proposed technicals**
- Direction: **${upBias}**
- Entry: ${entry}
- Stop: ${stop}
- TP1: ${tp1}
- TP2: ${tp2}
- Conviction %: ${conviction}

**Reasoning:** one paragraph with price-action logic.
**Timeframe Alignment:** 4H/1H/15M note.
**Invalidation Notes:** one sentence.
**Caution:** mention blackout/headlines if relevant.

Return **only** these markdown fields:
**Trade Card: ${instr.code}**
**Type:** (Pullback | BOS | Range | Breakout)
**Direction:** (Buy | Sell)
**Entry:** <number>
**Stop:** <number>
**TP1:** <number>
**TP2:** <number>
**Conviction %:** <number>

**Reasoning:** ...
**Timeframe Alignment:** ...
**Invalidation Notes:** ...
**Caution:** ...
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
        setupType: "Pullback",
        entry,
        stop,
        tp1,
        tp2,
        notes: blackout ? "High-impact event within ~90m — reduced conviction." : null,
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
