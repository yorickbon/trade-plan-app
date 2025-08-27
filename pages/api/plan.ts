// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { getCandles } from "../../lib/prices";
// We tolerate either sync or async exports from your local sentiment file.
import * as sentimentMod from "../../lib/sentiment";

/* ----------------------- Local API Shapes ----------------------- */
type Candle = { t:number; o:number; h:number; l:number; c:number };
type Instrument = { code: string; currencies?: string[] }; // e.g., EURUSD
type CalendarItem = {
  date: string; time?: string;
  country?: string; currency?: string;
  impact?: "Low"|"Medium"|"High"|"Undefined"|string;
  title?: string; actual?: string; forecast?: string; previous?: string;
};
type Headline = {
  title: string;
  url?: string;
  source?: string;
  seen?: string;          // ISO when we showed it
  published_at?: string;  // ISO from /api/news (optional)
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

/* --------------------- Small in-memory cache -------------------- */
type CacheEntry<T> = { data: T; exp: number };
const PLAN_CACHE: Map<string, CacheEntry<any>> =
  (globalThis as any)._PLAN_CACHE ?? new Map<string, CacheEntry<any>>();
(globalThis as any)._PLAN_CACHE = PLAN_CACHE;
const PLAN_CACHE_TTL = 5 * 60 * 1000;

function cacheGet<T>(key: string): T | null {
  const le = PLAN_CACHE.get(key);
  if (!le) return null;
  if (Date.now() > le.exp) { PLAN_CACHE.delete(key); return null; }
  return le.data as T;
}
function cacheSet(key: string, data: any) {
  PLAN_CACHE.set(key, { data, exp: Date.now() + PLAN_CACHE_TTL });
}

/* --------------------- Candle fetch utilities ------------------- */
function altSymbol(code: string): string {
  // EURUSD <-> EUR/USD
  if (code.includes("/")) return code.replace("/", "");
  if (code.length === 6) return `${code.slice(0,3)}/${code.slice(3)}`;
  return code;
}

async function fetchOneTF(symbol: string, interval: "15m"|"1h"|"4h", limit = 200): Promise<Candle[]> {
  try { return await getCandles(symbol, interval, limit); } catch { return []; }
}

async function fetchTFWithFallback(symbol: string, interval: "15m"|"1h"|"4h", limit = 200): Promise<Candle[]> {
  const a = await fetchOneTF(symbol, interval, limit);
  if (a.length) return a;
  const alt = altSymbol(symbol);
  if (alt !== symbol) {
    const b = await fetchOneTF(alt, interval, limit);
    if (b.length) return b;
  }
  return [];
}

/**
 * Fast parallel fetch for 4h/1h/15m with short micro-retries (no long polls).
 * Tries primary symbol, then alt symbol only for the timeframe(s) that fail.
 * Default total retry window ~5s (20 * 250ms).
 */
async function getAllTimeframesQuick(code: string) {
  const limit = 200;
  const maxRetries = 20;
  const delayMs = Math.max(50, Math.min(1000, Number(process.env.PLAN_CANDLES_POLL_MS ?? 250)));
  let m4: Candle[] = [], m1: Candle[] = [], m15: Candle[] = [];

  const tryAll = async () => {
    if (!m4.length) m4 = await fetchTFWithFallback(code, "4h", limit);
    if (!m1.length) m1 = await fetchTFWithFallback(code, "1h", limit);
    if (!m15.length) m15 = await fetchTFWithFallback(code, "15m", limit);
  };

  await tryAll();
  let tries = 0;
  while ((!(m4.length && m1.length && m15.length)) && tries < maxRetries) {
    await new Promise(r => setTimeout(r, delayMs));
    await tryAll();
    tries++;
  }

  const missing: string[] = [];
  if (!m4.length) missing.push("4h");
  if (!m1.length) missing.push("1h");
  if (!m15.length) missing.push("15m");

  return { m4, m1, m15, missing, tries };
}

/* ---------------------- Sentiment helper ------------------------ */
async function scoreHeadlines(text: string): Promise<number> {
  try {
    const maybe: any = (sentimentMod as any).default ?? (sentimentMod as any).scoreSentiment ?? sentimentMod;
    const ret = typeof maybe === "function" ? maybe(text) : maybe;
    const val = ret && typeof (ret.then) === "function" ? await ret : ret;
    if (typeof val === "number") return val;                 // already a score
    if (val && typeof val.score === "number") return val.score; // { score }
  } catch {}
  return 0;
}

/* ----------------------- Minor math helpers --------------------- */
const to5 = (n: number) => Number(n.toFixed(5));
const mean = (xs: number[]) => xs.reduce((a,b)=>a+b,0) / (xs.length || 1);
function trend(arr: Candle[]): number {
  const a = arr.at(-1)?.c ?? 0;
  const b = arr.at(-21)?.c ?? a;
  if (!a || !b) return 0;
  return a > b ? 1 : a < b ? -1 : 0;
}

/* ------------------------- API handler -------------------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOut>) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, reason: "Method not allowed", usedHeadlines: [], usedCalendar: [] });
  }

  try {
    const { instrument, date, calendar, headlines } = req.body as {
      instrument: Instrument | string; date?: string;
      calendar?: CalendarItem[] | null;
      headlines?: Headline[] | null;
    };

    const instr = typeof instrument === "string" ? { code: instrument } : instrument;
    if (!instr?.code) {
      return res.status(400).json({ ok: false, reason: "Missing instrument code", usedHeadlines: [], usedCalendar: [] });
    }

    // cache key: instrument + date (YYYY-MM-DD) + inputs snapshot sizes
    const cacheKey = JSON.stringify({
      code: instr.code,
      date: (date ?? new Date().toISOString().slice(0,10)),
      caln: Array.isArray(calendar) ? calendar.length : -1,
      news: Array.isArray(headlines) ? headlines.length : -1,
    });
    const hit = cacheGet<ApiOut>(cacheKey);
    if (hit && hit.ok) {
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.status(200).json(hit);
    }

    /* --------- ensure we have recent headlines (lightweight) ----- */
    const usedHeadlines: Headline[] = Array.isArray(headlines) ? headlines : [];
    const sinchHrs = Math.max(1, parseInt(process.env.HEADLINES_SINCE_HOURS ?? "24", 10));
    const cutoff = Date.now() - sinchHrs * 3600_000;
    const recent = usedHeadlines.filter(h => {
      const t = Date.parse(h.seen ?? h.published_at ?? "");
      return Number.isFinite(t) && t >= cutoff;
    });

    /* ----------------- blackout within ~90 minutes --------------- */
    const calItems: CalendarItem[] = Array.isArray(calendar) ? calendar : [];
    let blackout = false;
    if (calItems.length) {
      const now = Date.now();
      const within = 90 * 60 * 1000;
      blackout = calItems.some(ev => {
        const t = Date.parse(`${(ev as any).date}T${(ev as any).time ?? "00:00"}:00Z`);
        return Number.isFinite(t) && Math.abs(t - now) <= within && String(ev.impact ?? "").toLowerCase().includes("high");
      });
    }

    /* --------------- fetch candles (fast retries) ---------------- */
    const t0 = Date.now();
    const { m4, m1, m15, missing, tries } = await getAllTimeframesQuick(instr.code);

    if (missing.length) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      return res.status(200).json({
        ok: false,
        reason: `Missing candles for ${missing.join(", ")} after ${secs}s (tries=${tries}).`,
        usedHeadlines: recent.slice(0, 12),
        usedCalendar: calItems,
      });
    }

    /* -------------------- quick bias + levels -------------------- */
    const up4 = trend(m4) > 0;
    const up1 = trend(m1) > 0;
    const wantUp = trend(m15) > 0;

    const last40 = m15.slice(-40);
    const swingHi = Math.max(...last40.map(c => c.h));
    const swingLo = Math.min(...last40.map(c => c.l));
    const range   = Math.max(1e-9, swingHi - swingLo);
    const fib618  = swingLo + 0.618 * range;

    // Default "pullback" plan on 15m, HTFs adjust conviction only.
    let entry  = to5(fib618);
    let stop   = to5(swingLo - 0.25 * range);
    let tp1    = to5(swingLo + 0.25 * range);
    let tp2    = to5(swingLo + 0.50 * range);
    let setup  = "Pullback";
    let side   = wantUp ? "Buy" : "Sell";

    if (!wantUp) {
      // mirror for sell
      entry = to5(swingHi - 0.618 * range);
      stop  = to5(swingHi + 0.25 * range);
      tp1   = to5(swingHi - 0.25 * range);
      tp2   = to5(swingHi - 0.50 * range);
    }

    // Safety: make sure SL is on the **risk** side and TPs on the profit side
    if (side === "Buy") {
      if (!(stop < entry)) { const s = stop; stop = to5(Math.min(entry - 0.001, swingLo)); }
      if (!(tp1 > entry)) { tp1 = to5(entry + 0.25 * range); }
      if (!(tp2 > entry)) { tp2 = to5(entry + 0.50 * range); }
    } else {
      if (!(stop > entry)) { stop = to5(Math.max(entry + 0.001, swingHi)); }
      if (!(tp1 < entry)) { tp1 = to5(entry - 0.25 * range); }
      if (!(tp2 < entry)) { tp2 = to5(entry - 0.50 * range); }
    }

    /* ---------------- conviction from HTFs + news ---------------- */
    let conviction = 60;
    // HTF alignment = gentle, not strict
    if (up4 === wantUp) conviction += 10;
    if (up1 === wantUp) conviction += 10;

    // Lightweight news score
    let newsBias = "Neutral";
    let newsScore = 0;
    try {
      const recentText = recent.slice(0, 12).map(h => `• ${h.title}`).join("\n");
      const s = await scoreHeadlines(recentText);
      newsScore = Number(s || 0);
      newsBias = newsScore > 0.15 ? "Positive" : newsScore < -0.15 ? "Negative" : "Neutral";
    } catch { /* ignore */ }

    if (newsBias === "Positive" && side === "Buy") conviction += 5;
    if (newsBias === "Negative" && side === "Sell") conviction += 5;
    if (blackout) conviction = Math.max(0, conviction - 10);
    conviction = Math.max(0, Math.min(95, conviction));

    /* ----------------------- LLM formatting ---------------------- */
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const htfNote: string[] = [];
    htfNote.push(`4h ${up4 ? "up" : "down"}`);
    htfNote.push(`1h ${up1 ? "up" : "down"}`);

    const prompt = `
You are a trading assistant. Format a *single* trade card for ${instr.code}.

Context:
- Execution timeframe: 15m. 1H/4H used for context only (not strictly required).
- Macro headlines checked in last ${sinchHrs}h: ${recent.length}
- News sentiment (lightweight): ${newsBias} (${newsScore.toFixed(2)})
- HTF context: ${htfNote.join(", ")}
- Calendar blackout within ~90m: ${blackout ? "YES" : "NO"}

Proposed technicals:
- Direction: **${side}**
- Entry: **${entry}**
- Stop: **${stop}**
- TP1: **${tp1}**
- TP2: **${tp2}**

Return *only* these markdown fields:

**Trade Card: ${instr.code}**
**Type:** (${setup} | BOS | Range | Breakout)
**Direction:** (**Buy | Sell**)
**Entry:** <number>
**Stop:** <number>
**TP1:** <number>
**TP2:** <number>
**Conviction %:** ${conviction}

**Reasoning:** one paragraph with price-action logic. Mention HTF context briefly.
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
        setupType: setup,
        entry, stop, tp1, tp2,
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
