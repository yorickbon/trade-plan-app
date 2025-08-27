// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { getCandles } from "../../lib/prices";
import { scoreSentiment } from "../../lib/sentiment";

// ---------------- short in-memory cache (5 min) ----------------
type CacheEntry<T> = { data: T; exp: number };
const PLAN_CACHE: Map<string, CacheEntry<any>> =
  (globalThis as any).__PLAN_CACHE__ ?? new Map<string, CacheEntry<any>>();
(globalThis as any).__PLAN_CACHE__ = PLAN_CACHE;
const PLAN_CACHE_TTL = 5 * 60 * 1000;

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
  seen?: string;             // ISO timestamp we mark when shown
  published_at?: string;     // optional from /api/news
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

// --------- helpers to load candles with fallbacks (limit bump + alt symbol) ---------
async function loadCandles(symbol: string, interval: "15m" | "1h" | "4h", limit = 200): Promise<Candle[]> {
  try { return await getCandles(symbol, interval, limit); } catch { return []; }
}
function altSymbol(code: string): string {
  if (code.includes("/")) return code.replace("/", "");
  if (code.length === 6) return `${code.slice(0,3)}/${code.slice(3)}`;
  return code;
}

async function getAllTimeframes(code: string) {
  // first attempt
  let m4 = await loadCandles(code, "4h", 200);
  let m1 = await loadCandles(code, "1h", 200);
  let m15 = await loadCandles(code, "15m", 200);

  // second attempt: larger history window
  if (!m4.length) m4 = await loadCandles(code, "4h", 400);
  if (!m1.length) m1 = await loadCandles(code, "1h", 400);
  if (!m15.length) m15 = await loadCandles(code, "15m", 400);

  // third attempt: alternate symbol form
  const alt = altSymbol(code);
  if (alt !== code) {
    if (!m4.length) m4 = await loadCandles(alt, "4h", 200);
    if (!m1.length) m1 = await loadCandles(alt, "1h", 200);
    if (!m15.length) m15 = await loadCandles(alt, "15m", 200);
  }

  return { m4, m1, m15, triedAlt: alt !== code ? alt : null };
}

// ------------------------------ handler ------------------------------
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

    // ----------- ensure we have headlines (pull from /api/news if not supplied) -----------
    let usedHeadlines: Headline[] = Array.isArray(headlines) ? headlines : [];
    if (!usedHeadlines.length && instr.currencies?.length) {
      const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;
      const q = encodeURIComponent(instr.currencies.join(","));
      try {
        const rsp = await fetch(`${base}/api/news?currencies=${q}`, { cache: "no-store" });
        if (rsp.ok) {
          const j = await rsp.json();
          usedHeadlines = Array.isArray(j.items) ? j.items : [];
        }
      } catch { /* ignore */ }
    }

    // ----------- recent headline filter (24–48h window) -----------
    const sinceH = parseInt(process.env.HEADLINES_SINCE_HOURS || "24", 10);
    const cutoff = Date.now() - sinceH * 3600_000;
    const recent = usedHeadlines.filter((h) => {
      const t = Date.parse(h.seen ?? h.published_at ?? "");
      return Number.isFinite(t) && t >= cutoff;
    });

    // optional blackout if a high-impact event is within ~90 min
    const calItems: CalendarItem[] = Array.isArray(calendar) ? calendar : [];
    const blackout = (() => {
      if (!calItems.length) return false;
      const now = Date.now();
      const within = 90 * 60 * 1000;
      return calItems.some((ev) => {
        const ts = Date.parse(`${(ev as any).date ?? ""}T${(ev as any).time ?? "00:00"}:00Z`);
        return Number.isFinite(ts) && Math.abs(ts - now) <= within && String(ev.impact || "").toLowerCase().includes("high");
      });
    })();

    // ----------- fetch candles (require ALL: 4h / 1h / 15m) -----------
    const { m4, m1, m15, triedAlt } = await getAllTimeframes(instr.code);

    const missing: string[] = [];
    if (!m4.length) missing.push("4h");
    if (!m1.length) missing.push("1h");
    if (!m15.length) missing.push("15m");

    if (missing.length) {
      const detail = `Missing candles for ${missing.join(", ")}${triedAlt ? ` (tried alt symbol: ${triedAlt})` : ""}.`;
      const out: ApiOut = {
        ok: false,
        reason: detail,
        usedHeadlines: recent.slice(0, 12),
        usedCalendar: calItems,
      };
      cacheSet(cacheKey, out);
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.status(200).json(out);
    }

    // ----------- 15m bias & levels (pullback vs BOS heuristic) -----------
    const last = m15[m15.length - 1] ?? m15[0];
    const prev = m15[m15.length - 2] ?? last;
    const upBias = last.c >= prev.c ? "Buy" : "Sell";

    const swingHi = Math.max(...m15.slice(-40).map((c) => c.h));
    const swingLo = Math.min(...m15.slice(-40).map((c) => c.l));
    const range = Math.max(1e-9, swingHi - swingLo);
    const fib618 = swingHi - 0.618 * range; // pullback level

    const entry = Number(fib618.toFixed(5));
    const stop = Number((swingHi + 0.25 * range).toFixed(5));
    const tp1  = Number((swingLo + 0.25 * range).toFixed(5));
    const tp2  = Number((swingLo + 0.50 * range).toFixed(5));

    // ----------- conviction baseline + adjustments -----------
    let conviction = 60;

    // headlines present -> bump slightly
    conviction = Math.min(95, conviction + Math.min(3, recent.length));
    if (blackout) conviction = Math.min(conviction, 55);

    // lightweight headline sentiment (does not block trading)
    let newsBias = "Neutral";
    let newsScore = 0;
    try {
      const recentText = recent.slice(0, 12).map(h => h.title || "").join(" | ");
      const score = scoreSentiment(recentText); // [-1..1]
      newsScore = Number(score || 0);
      newsBias = score > 0.15 ? "Positive" : score < -0.15 ? "Negative" : "Neutral";
    } catch { /* ignore */ }

    // 1h / 4h alignment for conviction
    const trend = (arr: Candle[]) => {
      const a = arr[arr.length - 1]?.c ?? 0;
      const b = arr[Math.max(0, arr.length - 21)]?.c ?? a;
      if (!a || !b) return 0;
      return a > b ? 1 : a < b ? -1 : 0;
    };
    const t1h = trend(m1);
    const t4h = trend(m4);

    const wantUp = upBias === "Buy";
    const oppose1h = t1h !== 0 && (wantUp ? t1h < 0 : t1h > 0);
    const oppose4h = t4h !== 0 && (wantUp ? t4h < 0 : t4h > 0);

    let timeFramePenalty = 0;
    if (oppose1h && oppose4h) timeFramePenalty += 10;
    else if (oppose1h || oppose4h) timeFramePenalty += 5;

    conviction = Math.max(0, conviction - timeFramePenalty);

    // ----------- LLM trade card -----------
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const htfNoteParts: string[] = [];
    if (t1h !== 0) htfNoteParts.push(`1h ${t1h > 0 ? "up" : "down"}`);
    if (t4h !== 0) htfNoteParts.push(`4h ${t4h > 0 ? "up" : "down"}`);

    const prompt = `
You are a trading assistant. Format a *single* trade card for ${instr.code}.

Context:
- Bias timeframe: 15m. HTFs (1h/4h) are for confirmation & conviction adjustments.
- Setup candidates: pullback-to-0.618 vs. BOS continuation.
- Macro headlines in last ${sinceH}h: ${recent.length}
- News sentiment (lightweight): ${newsBias} (${newsScore.toFixed(2)})
- HTF context: ${htfNoteParts.join(", ") || "n/a"}
- Calendar blackout within ~90m: ${blackout ? "YES" : "NO"}

Proposed technicals:
- Direction: **${upBias}**
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
