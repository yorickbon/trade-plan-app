// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

// Use the same price source as /api/candles
import { getCandles } from "../../lib/prices";

// Be resilient to how the sentiment helper is exported (default/named, sync/async)
import * as SentimentMod from "../../lib/sentiment";

// ---------- short in-memory cache (5 min) ----------
type CacheEntry<T> = { data: T; exp: number };
const PLAN_CACHE: Map<string, CacheEntry<any>> =
  (globalThis as any).__PLAN_CACHE__ ?? new Map<string, CacheEntry<any>>();
(globalThis as any).__PLAN_CACHE__ = PLAN_CACHE;
const PLAN_CACHE_TTL = 5 * 60 * 1000;

// ---------- Types ----------
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
  seen?: string;        // ISO timestamp we mark when shown
  published_at?: string; // optional from /api/news
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

// ---------- cache helpers ----------
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

// ---------- candle helpers ----------
async function loadCandles(symbol: string, interval: "15m" | "1h" | "4h", limit = 200): Promise<Candle[]> {
  // 1) try library directly
  try {
    const arr: any = await getCandles(symbol, interval, limit);
    if (Array.isArray(arr) && arr.length) return arr as Candle[];
  } catch (_) {
    // ignore and fall through
  }

  // 2) fall back to your HTTP route (/api/candles) — this mirrors the manual test you do in the browser
  try {
    const base = process.env.NEXT_PUBLIC_BASE_URL || "";
    const url = `${base}/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
    const rsp = await fetch(url, { cache: "no-store" });
    const j = await rsp.json();
    if (Array.isArray(j?.candles) && j.candles.length) return j.candles as Candle[];
  } catch (_) {
    // ignore
  }

  return [];
}

function altSymbol(code: string): string {
  if (!code) return code;
  if (code.includes("/")) return code.replace("/", "");
  if (code.length <= 6) return `${code.slice(0, 3)}/${code.slice(3)}`;
  return code;
}

type AllFrames = { m4: Candle[]; m1: Candle[]; m15: Candle[]; triedAlt: string | null };

async function tryOnce(
  code: string,
  useAlt = false,
  bigLimits = false
): Promise<AllFrames> {
  const symbol = useAlt ? altSymbol(code) : code;
  const lim = bigLimits ? 400 : 200;

  const m4 = await loadCandles(symbol, "4h", lim);
  const m1 = await loadCandles(symbol, "1h", lim);
  const m15 = await loadCandles(symbol, "15m", lim);

  return { m4, m1, m15, triedAlt: useAlt ? symbol : null };
}

async function getAllTimeframesWithTimeout(code: string): Promise<AllFrames & { missing: string[] }> {
  const totalMs = Math.max(0, Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 60000));
  const pollMs = Math.max(200, Number(process.env.PLAN_CANDLES_POLL_MS ?? 500));
  const start = Date.now();

  let last: AllFrames = { m4: [], m1: [], m15: [], triedAlt: null };
  let lastAltWas: string | null = null; // persist any alt we actually tried

  while (Date.now() - start < totalMs) {
    // 1) normal
    last = await tryOnce(code, false, false);
    if (last.m4.length && last.m1.length && last.m15.length) return { ...last, missing: [] };

    // 2) bigger limits
    last = await tryOnce(code, false, true);
    if (last.m4.length && last.m1.length && last.m15.length) return { ...last, missing: [] };

    // 3) alt symbol
    last = await tryOnce(code, true, false);
    if (last.triedAlt) lastAltWas = last.triedAlt;
    if (last.m4.length && last.m1.length && last.m15.length) return { ...last, missing: [] };

    // 4) alt + bigger limits
    last = await tryOnce(code, true, true);
    if (last.triedAlt) lastAltWas = last.triedAlt;
    if (last.m4.length && last.m1.length && last.m15.length) return { ...last, missing: [] };

    await new Promise(r => setTimeout(r, pollMs));
  }

  const missing: string[] = [];
  if (!last.m4.length) missing.push("4h");
  if (!last.m1.length) missing.push("1h");
  if (!last.m15.length) missing.push("15m");

  // Show the last alt we actually attempted (if any)
  return { ...last, triedAlt: lastAltWas, missing };
}

// ---------- sentiment helper (works for sync or async) ----------
async function scoreHeadlines(text: string): Promise<number> {
  try {
    const modAny: any = SentimentMod as any;
    const fn =
      modAny.default ||
      modAny.scoreSentiment ||
      modAny.score ||
      modAny.analyze ||
      null;

    if (!fn) return 0;

    const maybe = fn(text);
    if (typeof maybe === "number") return maybe;
    if (maybe && typeof maybe.then === "function") {
      const resolved = await maybe;
      if (typeof resolved === "number") return resolved;
      if (resolved && typeof resolved.score === "number") return resolved.score;
    }
  } catch {
    // ignore
  }
  return 0;
}

// ---------- handler ----------
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

    const instr: Instrument =
      typeof instrument === "string" ? { code: instrument } : instrument;

    if (!instr?.code) {
      return res.status(400).json({ ok: false, reason: "Missing instrument code", usedHeadlines: [], usedCalendar: [] });
    }

    // Avoid caches in proxies/CDN for plan calls
    res.setHeader("Cache-Control", "no-store");

    // -------- ensure headlines (fallback to /api/news) --------
    let usedHeadlines: Headline[] = Array.isArray(headlines) ? headlines : [];
    if (!usedHeadlines.length && Array.isArray(instr.currencies) && instr.currencies.length) {
      try {
        const base = process.env.NEXT_PUBLIC_BASE_URL || "";
        const qs = encodeURIComponent(instr.currencies.join(","));
        const rsp = await fetch(`${base}/api/news?currencies=${qs}`, { cache: "no-store" });
        const j = await rsp.json();
        usedHeadlines = Array.isArray(j?.items) ? j.items : [];
      } catch {
        usedHeadlines = [];
      }
    }

    // -------- recent headline filter (24–48h window) --------
    const sinceHrs = Math.max(1, parseInt(process.env.HEADLINES_SINCE_HOURS || "48", 10));
    const cutoff = Date.now() - sinceHrs * 3600_000;
    const recent = usedHeadlines.filter((h) => {
      const t = Date.parse(h.seen ?? h.published_at ?? "");
      return Number.isFinite(t) && t >= cutoff;
    });

    // -------- optional blackout within ~90 min --------
    const calItems: CalendarItem[] = Array.isArray(calendar) ? calendar : [];
    let blackout = false;
    if (calItems.length) {
      try {
        const now = Date.now();
        const within = 90 * 60 * 1000;
        blackout = calItems.some((ev) => {
          const ts = Date.parse(`${(ev as any).date ?? ""}T${(ev as any).time ?? "00:00"}:00Z`);
          if (!Number.isFinite(ts)) return false;
          const imp = (ev.impact ?? "").toLowerCase();
          return Math.abs(ts - now) <= within && (imp.includes("high") || imp.includes("undefined"));
        });
      } catch {
        blackout = false;
      }
    }

    // -------- fetch candles (REQUIRE all 4h/1h/15m, with timeout & retries) --------
    const all = await getAllTimeframesWithTimeout(instr.code);
    if (all.missing.length) {
      const tried = all.triedAlt ?? "n/a";
      const msg = `Standing down: Missing candles for ${all.missing.join(", ")} (tried alt symbol: ${tried}). Timed out after ${Math.round((Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 60000))/1000)}s.`;
      return res.status(200).json({ ok: false, reason: msg, usedHeadlines: recent.slice(0, 12), usedCalendar: calItems });
    }

    const m15 = all.m15;

    // -------- simple 15m bias & levels (pullback vs BOS heuristic) --------
    const last = m15[m15.length - 1] ?? m15[0];
    const prev = m15[m15.length - 2] ?? last;
    const upBias = last.c >= prev.c ? "Buy" : "Sell";

    const swingHi = Math.max(...m15.slice(-40).map(c => c.h));
    const swingLo = Math.min(...m15.slice(-40).map(c => c.l));
    const range = Math.max(1e-9, swingHi - swingLo);

    // For BUY: entry near 61.8% pullback above swingLo; stop below swingLo; targets above entry.
    // For SELL: mirrored.
    let entry: number, stop: number, tp1: number, tp2: number;

    if (upBias === "Buy") {
      entry = swingLo + 0.618 * range;
      stop  = swingLo - 0.25 * range;
      tp1   = entry + 0.25 * range;
      tp2   = entry + 0.50 * range;
      // safety: enforce stop < entry
      if (!(stop < entry)) stop = entry - 0.25 * range;
    } else {
      entry = swingHi - 0.618 * range;
      stop  = swingHi + 0.25 * range;
      tp1   = entry - 0.25 * range;
      tp2   = entry - 0.50 * range;
      // safety: enforce stop > entry
      if (!(stop > entry)) stop = entry + 0.25 * range;
    }

    // -------- conviction baseline --------
    let conviction = 60;

    // headlines present can nudge (we cap)
    conviction = Math.min(95, conviction + Math.min(3, recent.length));
    if (blackout) conviction = Math.min(conviction, 55);

    // -------- lightweight headline sentiment → bias note (does not block trading) --------
    let newsBias = "Neutral";
    let newsScore = 0;
    try {
      const recentText = recent.slice(0, 12).map(h => `• ${h.title}`).join("\n");
      const val = await scoreHeadlines(recentText);  // number in [-1, 1] (or 0 if unavailable)
      newsScore = Number(val || 0);
      newsBias = val > 0.15 ? "Positive" : val < -0.15 ? "Negative" : "Neutral";
    } catch {
      // ignore sentiment errors
    }

    // -------- 1h / 4h alignment for conviction --------
    const trend = (arr: Candle[]) => {
      const a = arr[arr.length - 1]?.c ?? 0;
      const b = arr[Math.max(0, arr.length - 21)]?.c ?? a;
      if (!a || !b) return 0;
      return a > b ? 1 : a < b ? -1 : 0;
    };
    const t1h = trend(all.m1);
    const t4h = trend(all.m4);

    const wantUp = upBias === "Buy";
    const opposes1h = (t1h && ((wantUp ? t1h < 0 : t1h > 0)));
    const opposes4h = (t4h && ((wantUp ? t4h < 0 : t4h > 0)));

    // time-frame conviction penalty (not a blocker)
    let timeFramePenalty = 0;
    if (opposes1h && opposes4h) timeFramePenalty += 10;
    else if (opposes1h || opposes4h) timeFramePenalty += 5;
    conviction = Math.max(0, conviction - timeFramePenalty);

    // -------- LLM formatting (unchanged spirit of your version) --------
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
- Macro headlines in last ${sinceHrs}h: ${recent.length}
- News sentiment (lightweight): ${newsBias} (${newsScore.toFixed(2)})
- HTF context: ${htfNoteParts.join(", ") || "n/a"}
- Calendar blackout within ~90m: ${blackout ? "YES" : "NO"}

Proposed technicals:
- Direction: **${upBias}**
- Entry: **${entry.toFixed(5)}**
- Stop: **${stop.toFixed(5)}**
- TP1: **${tp1.toFixed(5)}**
- TP2: **${tp2.toFixed(5)}**

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
        entry: Number(entry.toFixed(5)),
        stop: Number(stop.toFixed(5)),
        tp1: Number(tp1.toFixed(5)),
        tp2: Number(tp2.toFixed(5)),
        notes: blackout ? "High-impact event within ~90 min — reduced conviction." : null,
      },
      usedHeadlines: recent.slice(0, 12),
      usedCalendar: calItems,
    };

    // light cache on success
    const cacheKey = JSON.stringify({
      code: instr.code,
      date: (date ?? new Date().toISOString().slice(0, 10)),
      cal: calItems.length,
      news: usedHeadlines.length,
    });
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
