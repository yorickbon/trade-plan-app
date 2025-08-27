// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { getCandles } from "../../lib/prices";
// IMPORTANT: your lib exports a *named* function; do NOT default-import it.
import { scoreSentiment as scoreSentimentImported } from "../../lib/sentiment";

/* ---------------- types ---------------- */
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
  url?: string;
  source?: string;
  seen?: string; // ISO string we add when rendering
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
type ApiOut = {
  ok: true;
  plan: PlanOut;
  usedHeadlines: Headline[];
  usedCalendar: CalendarItem[];
} | {
  ok: false;
  reason: string;
  usedHeadlines: Headline[];
  usedCalendar: CalendarItem[];
};

/* --------------- helpers: robust candle fetch (15m, 1h, 4h) --------------- */

const TIMEOUT_MS = Math.max(10000, Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 8000));
const POLL_MS    = Math.max(150,   Number(process.env.PLAN_CANDLES_POLL_MS ?? 500));

const INTERVALS: Array<"15m" | "1h" | "4h"> = ["15m", "1h", "4h"];
const LIMIT_NORMAL = 200;
const LIMIT_BIG    = 400;

async function loadCandles(symbol: string, interval: "15m" | "1h" | "4h", limit: number): Promise<Candle[]> {
  try {
    return await getCandles(symbol, interval, limit);
  } catch {
    return [];
  }
}
function altSymbols(code: string): string[] {
  // Try a few safe alternates
  const list = new Set<string>();
  list.add(code);
  // EURUSD <-> EUR/USD
  if (code.includes("/")) list.add(code.replace("/", ""));
  else if (code.length === 6) list.add(`${code.slice(0,3)}/${code.slice(3)}`);
  // Yahoo-style
  list.add(`${code}=X`);
  return [...list];
}
type AllFrames = { m15: Candle[]; h1: Candle[]; h4: Candle[]; triedAlt?: string };

async function fetchAllFramesWithRetry(code: string): Promise<{ frames: AllFrames; missing: string[]; timedOut: boolean }> {
  const start = Date.now();
  const alts = altSymbols(code);
  let altIdx = 0;
  let limit = LIMIT_NORMAL;

  let frames: AllFrames = { m15: [], h1: [], h4: [], triedAlt: undefined };

  while (Date.now() - start < TIMEOUT_MS) {
    const symbol = alts[altIdx];
    frames.triedAlt = symbol !== code ? symbol : undefined;

    const [m15, h1, h4] = await Promise.all([
      frames.m15.length ? Promise.resolve(frames.m15) : loadCandles(symbol, "15m", limit),
      frames.h1.length  ? Promise.resolve(frames.h1)  : loadCandles(symbol, "1h",  limit),
      frames.h4.length  ? Promise.resolve(frames.h4)  : loadCandles(symbol, "4h",  limit),
    ]);

    if (!frames.m15.length) frames.m15 = m15;
    if (!frames.h1.length)  frames.h1  = h1;
    if (!frames.h4.length)  frames.h4  = h4;

    const missing: string[] = [];
    if (!frames.h4.length) missing.push("4h");
    if (!frames.h1.length) missing.push("1h");
    if (!frames.m15.length) missing.push("15m");

    if (missing.length === 0) return { frames, missing: [], timedOut: false };

    // rotate alt symbol every few attempts; escalate limit once
    await new Promise(r => setTimeout(r, POLL_MS));
    if (Date.now() - start > TIMEOUT_MS * 0.33 && limit === LIMIT_NORMAL) {
      limit = LIMIT_BIG;
    }
    if (Date.now() - start > TIMEOUT_MS * 0.66) {
      altIdx = (altIdx + 1) % alts.length;
      // on alt change, drop any empties to re-fetch
      if (!frames.m15.length) frames.m15 = [];
      if (!frames.h1.length)  frames.h1  = [];
      if (!frames.h4.length)  frames.h4  = [];
    }
  }

  const missing: string[] = [];
  if (!frames.h4.length) missing.push("4h");
  if (!frames.h1.length) missing.push("1h");
  if (!frames.m15.length) missing.push("15m");

  return { frames, missing, timedOut: true };
}

/* -------- sentiment wrapper (works if lib returns number or Promise) ------- */

async function scoreHeadlines(text: string): Promise<number> {
  try {
    const maybe: any = (scoreSentimentImported as any)(text);
    const resolved = (typeof maybe?.then === "function") ? await maybe : maybe;
    if (typeof resolved === "number" && Number.isFinite(resolved)) return resolved;
  } catch {}
  return 0;
}

/* ------------------- simple 15m heuristic for levels/bias ------------------ */

function lastClose(arr: Candle[], idxFromEnd = 1): number | null {
  const k = arr.length - idxFromEnd;
  return k >= 0 && arr[k] ? arr[k].c : null;
}
function computeLevels(m15: Candle[]): { bias: "Buy" | "Sell"; entry: number; stop: number; tp1: number; tp2: number } {
  // range from last ~40 bars
  const tail = m15.slice(-40);
  const highs = tail.map(c => c.h);
  const lows  = tail.map(c => c.l);
  const swingHi = Math.max(...highs);
  const swingLo = Math.min(...lows);
  const range = Math.max(1e-9, swingHi - swingLo);
  const fib618 = swingHi - 0.618 * range; // “pullback to 0.618” entry for BUY

  const last = lastClose(m15) ?? ((tail.length && tail[tail.length-1].c) || 0);
  const prev = lastClose(m15, 2) ?? last;
  const upBias = last > prev ? "Buy" : "Sell";

  if (upBias === "Buy") {
    const entry = Number(fib618.toFixed(5));
    const stop  = Number((swingLo - 0.25 * range).toFixed(5)); // ALWAYS < entry
    const tp1   = Number((swingLo + 0.50 * range).toFixed(5));
    const tp2   = Number((swingLo + 0.90 * range).toFixed(5));
    return { bias: "Buy", entry, stop, tp1, tp2 };
  } else {
    // mirror for SELL
    const fib618Sell = swingLo + 0.618 * range;
    const entry = Number(fib618Sell.toFixed(5));
    const stop  = Number((swingHi + 0.25 * range).toFixed(5)); // ALWAYS > entry
    const tp1   = Number((swingHi - 0.50 * range).toFixed(5));
    const tp2   = Number((swingHi - 0.90 * range).toFixed(5));
    return { bias: "Sell", entry, stop, tp1, tp2 };
  }
}

/* ----------------------------- API handler --------------------------------- */

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

    /* --- recent headlines & sentiment (24–48h by ENV) --- */
    const sinceHrs = Math.max(1, parseInt(process.env.HEADLINES_SINCE_HOURS ?? "24", 10));
    const cutoffT = Date.now() - sinceHrs * 3600_000;
    const usedHeadlines = (Array.isArray(headlines) ? headlines : [])
      .filter(h => {
        const t = Date.parse(h.seen ?? h.published_at ?? "");
        return Number.isFinite(t) && t >= cutoffT;
      })
      .slice(0, Math.max(1, parseInt(process.env.HEADLINES_MAX ?? "8", 10)));
    const recentText = usedHeadlines.map(h => `- ${h.title}`).join("\n");
    const sentimentVal = await scoreHeadlines(recentText);
    const newsScore = Number(sentimentVal || 0);
    const newsBias = newsScore > 0.15 ? "Positive" : newsScore < -0.15 ? "Negative" : "Neutral";

    /* --- optional calendar blackout within ±90m for High impact --- */
    const usedCalendar: CalendarItem[] = Array.isArray(calendar) ? calendar : [];
    const blackout = (() => {
      if (!usedCalendar.length) return false;
      const now = Date.now();
      const win = 90 * 60 * 1000;
      return usedCalendar.some(ev => {
        const ts = Date.parse(`${(ev as any).date ?? ""}T${(ev as any).time ?? "00:00"}:00Z`);
        const high = (ev.impact ?? "").toLowerCase().includes("high");
        return Number.isFinite(ts) && Math.abs(ts - now) <= win && high;
      });
    })();

    /* --- fetch all candles with retry --- */
    const { frames, missing, timedOut } = await fetchAllFramesWithRetry(instr.code);
    if (missing.length) {
      const triedTxt = frames.triedAlt ? ` tried alt symbol: ${frames.triedAlt}` : "";
      const secs = Math.round(TIMEOUT_MS / 1000);
      return res.status(200).json({
        ok: false,
        reason: `Missing candles for ${missing.join(", ")}.${triedTxt}. Timed out after ${secs}s.`,
        usedHeadlines,
        usedCalendar,
      });
    }

    /* --- compute 15m levels and HTF alignment for conviction --- */
    const { m15, h1, h4 } = frames;
    const levels = computeLevels(m15);

    // HTF trend check (soft, not blocking)
    const trend = (arr: Candle[]) => {
      const a = arr[arr.length - 1]?.c ?? null;
      const b = arr[Math.max(0, arr.length - 21)]?.c ?? a;
      if (a == null || b == null) return 0;
      return a > b ? 1 : a < b ? -1 : 0;
    };
    const t1h = trend(h1);
    const t4h = trend(h4);
    let conviction = 60; // base; can go higher/lower
    if (levels.bias === "Buy") {
      if (t1h >= 0) conviction += 10;
      if (t4h >= 0) conviction += 10;
    } else {
      if (t1h <= 0) conviction += 10;
      if (t4h <= 0) conviction += 10;
    }
    // news & blackout adjustments
    if (newsBias === "Positive" && levels.bias === "Buy") conviction += 5;
    if (newsBias === "Negative" && levels.bias === "Sell") conviction += 5;
    if (blackout) conviction = Math.max(0, conviction - 15);
    conviction = Math.max(5, Math.min(conviction, 95));

    /* --- LLM formatting (same model as before) --- */
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const htfNote: string[] = [];
    htfNote.push(`1h ${t1h > 0 ? "up" : t1h < 0 ? "down" : "flat"}`);
    htfNote.push(`4h ${t4h > 0 ? "up" : t4h < 0 ? "down" : "flat"}`);

    const prompt = `
You are a trading assistant. Format a *single* trade card for ${instr.code}.

Context:
- Bias timeframe: 15m execution; 1H/4H used for context (soft alignment).
- Macro headlines in last ${sinceHrs}h: ${usedHeadlines.length}
- News sentiment (lightweight): ${newsBias} (${newsScore.toFixed(2)})
- HTF context: ${htfNote.join(", ")}
- Calendar blackout within ±90m: ${blackout ? "YES" : "NO"}

Proposed technicals:
- Direction: **${levels.bias}**
- Entry: **${levels.entry}**
- Stop: **${levels.stop}**
- TP1: **${levels.tp1}**
- TP2: **${levels.tp2}**

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

    return res.status(200).json({
      ok: true,
      plan: {
        text,
        conviction,
        setupType: levels.bias === "Buy" ? "Pullback" : "BOS",
        entry: levels.entry,
        stop: levels.stop,
        tp1: levels.tp1,
        tp2: levels.tp2,
        notes: blackout ? "High-impact event within ±90m — reduced conviction." : null,
      },
      usedHeadlines,
      usedCalendar,
    });
  } catch (err: any) {
    console.error("PLAN API error ->", err?.message || err);
    return res.status(500).json({ ok: false, reason: "Server error", usedHeadlines: [], usedCalendar: [] });
  }
}
