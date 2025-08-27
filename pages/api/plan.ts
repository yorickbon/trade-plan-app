// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { getCandles } from "../../lib/prices"; // named export
import { scoreSentiment } from "../../lib/sentiment";

// -------- short in-memory cache (5 min) --------
type CacheEntry<T> = { data: T; exp: number };
const PLAN_CACHE =
  (globalThis as any).__PLAN_CACHE__ ?? new Map<string, CacheEntry<any>>();
(globalThis as any).__PLAN_CACHE__ = PLAN_CACHE;
const PLAN_CACHE_TTL = 5 * 60 * 1000;

type Candle = { t: number; o: number; h: number; l: number; c: number };

type Instrument = {
  code: string;        // e.g. "EURUSD"
  currencies?: string[]; // e.g. ["EUR","USD"]
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
  // these two are optional across providers; keep both so filtering compiles
  seen?: string;          // ISO timestamp
  published_at?: string;  // optional provider field
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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiOut>
) {
  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ ok: false, reason: "Method not allowed", usedHeadlines: [], usedCalendar: [] });
  }

  const { instrument, date, calendar, headlines } = req.body as {
    instrument: Instrument | string;
    date?: string; // yyy-mm-dd
    calendar?: CalendarItem[] | null;
    headlines?: Headline[] | null;
  };

  const instr: Instrument =
    typeof instrument === "string" ? { code: instrument } : instrument || {};

  if (!instr?.code) {
    return res
      .status(400)
      .json({ ok: false, reason: "Missing instrument code", usedHeadlines: [], usedCalendar: [] });
  }

  // cache key
  const cacheKey = JSON.stringify({
    code: instr.code,
    date: (date || new Date().toISOString().slice(0, 10)),
    calN: Array.isArray(calendar) ? calendar.length : -1,
    newsN: Array.isArray(headlines) ? headlines.length : -1,
  });

  const hit = cacheGet<ApiOut>(cacheKey);
  if (hit) {
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json(hit);
  }

  // ensure we have headlines (pull from /api/news if not supplied)
  let usedHeadlines: Headline[] = Array.isArray(headlines) ? headlines : [];
  if (!usedHeadlines.length) {
    const curr =
      instr.currencies && instr.currencies.length
        ? `?currencies=${encodeURIComponent(instr.currencies.join(","))}`
        : "";
    const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const rsp = await fetch(`${base}/api/news${curr}`, { cache: "no-store" });
    const j = await rsp.json();
    usedHeadlines = (Array.isArray(j?.items) ? j.items : []) as Headline[];
  }

  // gate on headlines recency
  const sinceH = Math.max(1, parseInt(process.env.HEADLINES_SINCE_HOURS || "24", 10));
  const cutoff = Date.now() - sinceH * 3600_000;
  const recent = usedHeadlines.filter((h) => {
    const t = Date.parse(h.seen ?? h.published_at ?? "");
    return Number.isFinite(t) && t >= cutoff;
  });

  // Optional: stand down ONLY if you want no-recent-news mode to reduce conviction
  // We DO NOT block trading here; we only note it later and slightly reduce conviction.

  // optional blackout if a high-impact event is within ~90 min
  const calItems: CalendarItem[] = Array.isArray(calendar) ? calendar : [];
  let blackout = false;
  try {
    const soon = calItems.some((ev) => {
      const when = Date.parse(`${ev.date}T${(ev.time || "00:00")}:00Z`);
      const dt = Math.abs(when - Date.now());
      return when && dt <= 90 * 60 * 1000 && String(ev.impact || "").toLowerCase().includes("high");
    });
    blackout = soon;
  } catch { /* ignore calendar parsing errors */ }

  // -------- fetch candles (4h / 1h / 15m) --------
  // NOTE: this preserves your previous logic. If a TF is missing, we keep going; we only stand down if 15m is missing.
  const [h4, h1, m15] = await Promise.allSettled<Candle[]>([
    getCandles(instr.code, "4h", 200),
    getCandles(instr.code, "1h", 200),
    getCandles(instr.code, "15m", 200),
  ]).then((all) =>
    all.map((r) => (r.status === "fulfilled" ? r.value : [])) as [Candle[], Candle[], Candle[]]
  );

  if (!m15.length) {
    const out: ApiOut = {
      ok: false,
      reason: "Missing candles for one or more timeframes.",
      usedHeadlines: recent.slice(0, 12),
      usedCalendar: calItems,
    };
    cacheSet(cacheKey, out);
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json(out);
  }

  // -------- simple 15m bias & levels (pullback vs BOS heuristic) --------
  const last = m15[m15.length - 1] ?? m15[0];
  const prev = m15[m15.length - 2] ?? last;
  const upBias = last.c >= prev.c ? "Buy" : "Sell";

  const swingHi = Math.max(...m15.slice(-40).map((c) => c.h));
  const swingLo = Math.min(...m15.slice(-40).map((c) => c.l));
  const range = Math.max(1e-9, swingHi - swingLo);
  const fib618 = swingHi - 0.618 * range; // for pullback scenario

  const entry  = Number(fib618.toFixed(5));
  const stop   = Number((swingHi + 0.25 * range).toFixed(5));
  const tp1    = Number((swingLo + 0.25 * range).toFixed(5));
  const tp2    = Number((swingLo + 0.50 * range).toFixed(5));

  // -------- conviction baseline --------
  let conviction = 60;
  conviction = Math.min(95, conviction + Math.min(3, recent.length)); // headlines present → small bump
  if (blackout) conviction = Math.min(conviction, 55);

  // -------- lightweight headline sentiment → bias note (does not block trading) --------
  let newsBias: "Positive" | "Neutral" | "Negative" = "Neutral";
  let newsScore = 0;

  // Build a short text from recent headlines for scoring
  const recentText = recent
    .slice(0, 10)
    .map((h) => h.title)
    .filter(Boolean)
    .join(" • ");

  try {
    const resS: any = await scoreSentiment(recentText as any);
    const score: number =
      typeof resS === "number"
        ? resS
        : (resS && typeof resS === "object" && "score" in resS ? Number(resS.score) : 0);

    newsScore = Number.isFinite(score) ? Number(score) : 0;
    newsBias = score > 0.15 ? "Positive" : score < -0.15 ? "Negative" : "Neutral";
  } catch {
    // ignore sentiment errors
  }

  // -------- LLM formatting (unchanged from your working version) --------
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const prompt = `
You are a trading assistant. Format a *single* trade card for ${instr.code}.

Context:
• Bias timeframe: 15m. HTFs (1h/4h) are for confirmation only.
• Setup candidates: pullback-to-0.618 vs. BOS continuation.
• Macro headlines in last ${sinceH}h: ${recent.length}
• News sentiment (lightweight): ${newsBias} (${newsScore.toFixed(2)})
• Calendar blackout within ~90m: ${blackout ? "YES" : "NO"}

Proposed technicals:
• Direction: **${upBias}**
• Entry: ${entry}
• Stop: ${stop}
• TP1: ${tp1}
• TP2: ${tp2}

Return *only* these markdown fields:
**Trade Card: ${instr.code}**
**Type:** (Pullback | BOS | Range | Breakout)
**Direction:** (Buy | Sell)
**Entry:** <number>
**Stop:** <number>
**TP1:** <number>
**TP2:** <number>
**Conviction %:** ${conviction}

**Reasoning:** one paragraph with price-action logic.
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
      usedCalendar: calItems,
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
