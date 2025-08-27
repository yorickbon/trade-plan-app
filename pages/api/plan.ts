// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { getCandles } from "../../lib/prices";
import { scoreSentiment } from "../../lib/sentiment";

// ---- short in-memory cache (5 min) ----
type CacheEntry<T> = { data: T; exp: number };
const PLAN_CACHE =
  (globalThis as any).__PLAN_CACHE__ ?? new Map<string, CacheEntry<any>>();
(globalThis as any).__PLAN_CACHE__ = PLAN_CACHE;
const PLAN_CACHE_TTL = 5 * 60 * 1000;

type Candle = { t: number; o: number; h: number; l: number; c: number };

type Instrument = {
  code: string;
  currencies?: string[];
};

type CalendarItem = {
  date: string;
  time?: string;
  country?: string;
  currency?: string;
  impact?: "Low" | "Medium" | "High" | "Undefined" | string;
  title: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};

type Headline = {
  title: string;
  url: string;
  source: string;
  published_at: string; // ISO
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

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOut>) {
  try {
    if (req.method !== "POST") {
      return res
        .status(405)
        .json({ ok: false, reason: "Method not allowed", usedHeadlines: [], usedCalendar: [] });
    }

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
      calN: Array.isArray(calendar) ? calendar.length : -1,
      newsN: Array.isArray(headlines) ? headlines.length : -1,
    });

    const hit = cacheGet<ApiOut>(cacheKey);
    if (hit) {
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.status(200).json(hit);
    }

    // Ensure headlines; pull from /api/news if none supplied
    let usedHeadlines: Headline[] = Array.isArray(headlines) ? headlines : [];
    if (!usedHeadlines.length) {
      const cur = (instr.currencies && instr.currencies.length)
        ? `?currencies=${encodeURIComponent(instr.currencies.join(","))}`
        : "";
      const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;
      const rsp = await fetch(`${base}/api/news${cur}`, { cache: "no-store" });
      const j: any = await rsp.json().catch(() => ({}));
      const items = Array.isArray(j?.items) ? j.items : [];
      usedHeadlines = items.map((it: any) => ({
        title: String(it.title || ""),
        url: String(it.url || ""),
        source: String(it.source || "unknown"),
        published_at: String(it.published_at || ""),
      }));
    }

    // Headlines window (do NOT block planning if empty)
    const sinceH = Math.max(1, parseInt(process.env.HEADLINES_SINCE_HOURS || "24", 10));
    const sinceMs = Date.now() - sinceH * 3600_000;
    const recent = usedHeadlines.filter(h => {
      const t = Date.parse(h.published_at || "");
      return Number.isFinite(t) && t >= sinceMs;
    });

    // Optional blackout if a high-impact event is within ~90 min
    const calItems: CalendarItem[] = Array.isArray(calendar) ? calendar : [];
    const blackout = calItems.some(ev => {
      const when = Date.parse(`${ev.date}T${ev.time ?? "00:00"}Z`);
      const dt = Math.abs(when - Date.now());
      return dt <= 90 * 60 * 1000 && String(ev.impact || "").toLowerCase().includes("high");
    });

    // Fetch candles (4h / 1h / 15m)
    const [h4, h1, m15] = await Promise.all<Candle[]>([
      getCandles(instr.code, "4h", 200),
      getCandles(instr.code, "1h", 200),
      getCandles(instr.code, "15m", 200),
    ]);

    if (!h4.length || !h1.length || !m15.length) {
      const out: ApiOut = {
        ok: false,
        reason: "Missing candles for one or more timeframes.",
        usedHeadlines: recent.slice(0, 12),
        usedCalendar: calItems,
      };
      cacheSet(cacheKey, out);
      return res.status(200).json(out);
    }

    // 15m bias & levels (pullback vs BOS heuristic)
    const last = m15[m15.length - 1];
    const prev = m15[m15.length - 2] ?? last;
    const upBias = last.c >= prev.c;

    const swingHi = Math.max(...m15.slice(-40).map(c => c.h));
    const swingLo = Math.min(...m15.slice(-40).map(c => c.l));
    const range = swingHi - swingLo || 1e-6;

    // Pullback anchor: 0.618 into current leg
    const fib618 = swingLo + 0.618 * range; // long leg from swingLo -> swingHi
    const entry = Number(fib618.toFixed(3));
    const stop  = upBias
      ? Number((swingLo - 0.25 * range).toFixed(3))
      : Number((swingHi + 0.25 * range).toFixed(3));
    const tp1   = upBias
      ? Number((swingLo + 0.50 * range).toFixed(3))
      : Number((swingLo + 0.50 * range).toFixed(3)); // symmetric target around mid
    const tp2   = upBias
      ? Number((swingLo + 0.90 * range).toFixed(3))
      : Number((swingLo + 0.10 * range).toFixed(3)); // conservative mirror

    // Conviction: base + news nudge + blackout cap
    let conviction = 60;
    if (recent.length === 0) conviction = Math.max(40, conviction - 10); // no headlines penalty
    if (blackout) conviction = Math.min(conviction, 55);

    // Sentiment from headlines (titles only). Your current scoreSentiment returns number [-1..1].
    let newsScore = 0;
    try {
      const joined = recent.map(r => r.title).join(" | ");
      const s = scoreSentiment(joined) as any;
      newsScore = typeof s === "number" ? s : Number(s?.score || 0);
      // small nudge based on alignment with technical direction
      const aligned = (newsScore >= 0 && upBias) || (newsScore < 0 && !upBias);
      const adj = Math.round(Math.min(10, Math.abs(newsScore) * 10)); // cap ±10
      conviction = Math.max(35, Math.min(95, conviction + (aligned ? adj : -adj)));
    } catch {}

    // LLM formatting
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const prompt = `
You are a trading assistant. Format a *single* trade card for ${instr.code}.

Context:
- Bias timeframe: 15m. HTFs (1h/4h) confirm only.
- Setup candidates: Pullback to 0.618 vs. BOS continuation.
- Macro headlines in last ${sinceH}h: ${recent.length}
- News sentiment score: ${newsScore.toFixed(2)}
- Calendar blackout within ~90m: ${blackout ? "YES" : "NO"}

Proposed technicals (heuristic):
- Direction: ${upBias ? "Buy" : "Sell"}
- Entry: ${entry}
- Stop: ${stop}
- TP1: ${tp1}
- TP2: ${tp2}

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
    console.error("PLAN api error:", err?.message || err);
    return res
      .status(500)
      .json({ ok: false, reason: "Server error", usedHeadlines: [], usedCalendar: [] });
  }
}
