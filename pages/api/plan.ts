// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { getCandles } from "../../lib/prices";
import { scoreSentiment as scoreSentimentImported } from "../../lib/sentiment";

type CacheEntry<T> = { data: T; exp: number };
const PLAN_CACHE: Map<string, CacheEntry<any>> =
  (globalThis as any).__PLAN_CACHE__ ?? new Map<string, CacheEntry<any>>();
(globalThis as any).__PLAN_CACHE__ = PLAN_CACHE;
const PLAN_CACHE_TTL = 5 * 60 * 1000;

type Candle = { t: number; o: number; h: number; l: number; c: number };
type Instrument = { code: string; currencies?: string[] };
type CalendarItem = {
  date: string; time?: string; country?: string; currency?: string;
  impact?: "Low" | "Medium" | "High" | "Undefined" | string;
  title?: string; actual?: string; forecast?: string; previous?: string;
};
type Headline = { title: string; url?: string; source?: string; seen?: string; published_at?: string };

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

// -------- cache helpers --------
function cacheGet<T>(key: string): T | null {
  const e = PLAN_CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { PLAN_CACHE.delete(key); return null; }
  return e.data as T;
}
function cacheSet(key: string, data: any, ttl = PLAN_CACHE_TTL) {
  PLAN_CACHE.set(key, { data, exp: Date.now() + ttl });
}

// -------- candles ----------
async function loadCandles(symbol: string, interval: "15m" | "1h" | "4h", limit = 200): Promise<Candle[]> {
  try { return await getCandles(symbol, interval, limit); } catch { return []; }
}
function altSymbol(code: string): string {
  if (!code) return code;
  if (code.includes("/")) return code.replace("/", "");
  if (code.length === 6) return `${code.slice(0,3)}/${code.slice(3)}`;
  return code;
}
type AllFrames = { m4: Candle[]; m1: Candle[]; m15: Candle[]; triedAlt: string | null };

async function tryOnceAll(code: string, bigLimits = false): Promise<AllFrames> {
  const lim = bigLimits ? 400 : 200;
  const [m4, m1, m15] = await Promise.all([
    loadCandles(code, "4h", lim),
    loadCandles(code, "1h", lim),
    loadCandles(code, "15m", lim),
  ]);
  return { m4, m1, m15, triedAlt: null };
}

async function getAllTimeframesWithTimeout(code: string): Promise<AllFrames & { missing: string[]; note: string }> {
  const totalMs = Math.max(0, Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 60000));
  const pollMs  = Math.max(200, Number(process.env.PLAN_CANDLES_POLL_MS ?? 1000));
  const start = Date.now();

  let useAlt = false;
  let big = false;
  let last: AllFrames = { m4: [], m1: [], m15: [], triedAlt: null };
  let note = "";

  while (Date.now() - start < totalMs) {
    const symbol = useAlt ? altSymbol(code) : code;
    last = await tryOnceAll(symbol, big);
    if (useAlt) last.triedAlt = symbol;

    if (last.m4.length && last.m1.length && last.m15.length) {
      return { ...last, missing: [], note };
    }
    if (!big && !useAlt) { big = true; note = "bigger limits"; }
    else if (big && !useAlt) { big = false; useAlt = true; note = "alt symbol"; }
    else if (!big && useAlt) { big = true; note = "alt + bigger limits"; }
    else { big = false; useAlt = false; note = "retry"; }

    await new Promise(r => setTimeout(r, pollMs));
  }

  const missing: string[] = [];
  if (!last.m4.length) missing.push("4h");
  if (!last.m1.length) missing.push("1h");
  if (!last.m15.length) missing.push("15m");
  return { ...last, missing, note };
}

// -------- sentiment (works sync/async) --------
async function scoreHeadlines(text: string): Promise<number> {
  try {
    const maybe: any = (scoreSentimentImported as any)(text);
    if (typeof maybe?.then === "function") {
      const resolved = await maybe;
      if (typeof resolved === "number") return resolved;
      if (resolved && typeof resolved.score === "number") return resolved.score;
      return 0;
    }
    if (typeof maybe === "number") return maybe;
    if (maybe && typeof maybe.score === "number") return maybe.score;
  } catch {}
  return 0;
}

// ------------------------------ handler ------------------------------
export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOut>) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, reason: "Method not allowed", usedHeadlines: [], usedCalendar: [] });
  }

  try {
    const { instrument, date, calendar, headlines, nocache, resetCache, nonce } = req.body as {
      instrument: Instrument | string;
      date?: string;
      calendar?: CalendarItem[] | null;
      headlines?: Headline[] | null;
      nocache?: boolean;         // new: skip server/browser cache for this hit
      resetCache?: boolean;      // new: clear in-memory cache entirely
      nonce?: number | string;   // new: makes cache key unique after Reset
    };

    if (resetCache) PLAN_CACHE.clear(); // full server cache wipe on demand

    const instr: Instrument = typeof instrument === "string" ? { code: instrument } : instrument;
    if (!instr?.code) {
      return res.status(400).json({ ok: false, reason: "Missing instrument code", usedHeadlines: [], usedCalendar: [] });
    }

    // build cache key; include nonce so Reset/instrument-change is a fresh run
    const cacheKey = JSON.stringify({
      code: instr.code,
      date: (date || new Date().toISOString().slice(0, 10)),
      n: Array.isArray(headlines) ? headlines.length : -1,
      c: Array.isArray(calendar) ? calendar.length : -1,
      nonce: nonce ?? null, // <<< busts cache when provided
    });

    if (!nocache) {
      const hit = cacheGet<ApiOut>(cacheKey);
      if (hit) {
        res.setHeader("Cache-Control", "public, max-age=60");
        return res.status(200).json(hit);
      }
    }

    // headlines (fallback to /api/news)
    let usedHeadlines: Headline[] = Array.isArray(headlines) ? headlines : [];
    if (!usedHeadlines.length && instr.currencies?.length) {
      try {
        const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;
        const q = encodeURIComponent(instr.currencies.join(","));
        const rsp = await fetch(`${base}/api/news?currencies=${q}`, { cache: "no-store" });
        const js = await rsp.json();
        usedHeadlines = Array.isArray(js.items) ? js.items : [];
      } catch {}
    }

    const sinceHrs = Math.max(24, parseInt(process.env.HEADLINES_SINCE_HOURS || "48", 10));
    const cutoff = Date.now() - sinceHrs * 3600_000;
    const recent = usedHeadlines.filter(h => Number.isFinite(Date.parse(h.seen ?? h.published_at ?? "")) && Date.parse(h.seen ?? h.published_at ?? "") >= cutoff);

    const calItems: CalendarItem[] = Array.isArray(calendar) ? calendar : [];
    const blackout = (() => {
      if (!calItems.length) return false;
      const now = Date.now(), within = 90 * 60 * 1000;
      return calItems.some(ev => {
        const ts = Date.parse(`${(ev as any).date ?? ""}T${(ev as any).time ?? "00:00"}:00Z`);
        return Number.isFinite(ts) && Math.abs(now - ts) <= within && String(ev.impact || "").toLowerCase().includes("high");
      });
    })();

    // fetch candles (require all TFs)
    const all = await getAllTimeframesWithTimeout(instr.code);
    if (all.missing.length) {
      const reason = `Missing candles for ${all.missing.join(", ")} (tried alt symbol: ${all.triedAlt ?? "n/a"}). Timed out after ${Math.round(Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 60000)/1000)}s.`;
      const out: ApiOut = { ok: false, reason, usedHeadlines: recent.slice(0, 12), usedCalendar: calItems };
      // when nocache, don't poison cache with a transient failure
      if (!nocache) cacheSet(cacheKey, out, 30 * 1000);
      res.setHeader("Cache-Control", nocache ? "no-store" : "public, max-age=30");
      return res.status(200).json(out);
    }

    const { m4, m1, m15 } = all;

    // 15m bias & levels
    const last = m15[m15.length - 1] ?? m15[0];
    const prev = m15[m15.length - 2] ?? last;
    const upBias = last.c >= prev.c ? "Buy" : "Sell";

    const swingHi = Math.max(...m15.slice(-40).map(c => c.h));
    const swingLo = Math.min(...m15.slice(-40).map(c => c.l));
    const range = Math.max(1e-9, swingHi - swingLo);

    let entry: number, stop: number, tp1: number, tp2: number;
    if (upBias === "Buy") {
      const fib618 = swingHi - 0.618 * range;
      entry = Number(fib618.toFixed(5));
      stop  = Number((swingHi + 0.25 * range).toFixed(5));
      tp1   = Number((swingLo + 0.25 * range).toFixed(5));
      tp2   = Number((swingLo + 0.50 * range).toFixed(5));
      if (stop < entry) { const t = stop; stop = tp2; tp2 = t; }
    } else {
      const fibShort = swingLo + 0.618 * range;
      entry = Number(fibShort.toFixed(5));
      stop  = Number((swingLo - 0.25 * range).toFixed(5));
      tp1   = Number((swingHi - 0.25 * range).toFixed(5));
      tp2   = Number((swingHi - 0.50 * range).toFixed(5));
      if (stop > entry) { const t = stop; stop = tp2; tp2 = t; }
    }

    // conviction
    let conviction = 60;
    conviction = Math.min(95, conviction * Math.min(3, recent.length));
    if (blackout) conviction = Math.min(conviction, 55);

    // sentiment
    let newsBias = "Neutral", newsScore = 0;
    try {
      const recentText = recent.slice(0, 12).map(h => `- ${h.title}`).join("\n");
      const s = await scoreHeadlines(recentText);
      newsScore = Number(s || 0);
      newsBias = newsScore > 0.15 ? "Positive" : newsScore < -0.15 ? "Negative" : "Neutral";
    } catch {}

    // HTF alignment penalty (1h/4h)
    const trend = (arr: Candle[]) => {
      const a = arr[arr.length - 1]?.c ?? 0;
      const b = arr[Math.max(0, arr.length - 21)]?.c ?? a;
      return a > b ? 1 : a < b ? -1 : 0;
    };
    const t1h = trend(m1), t4h = trend(m4);
    const wantUp = upBias === "Buy";
    const opp1h = t1h !== 0 && (wantUp ? t1h < 0 : t1h > 0);
    const opp4h = t4h !== 0 && (wantUp ? t4h < 0 : t4h > 0);
    let tfPenalty = 0; if (opp1h && opp4h) tfPenalty = 10; else if (opp1h || opp4h) tfPenalty = 5;
    conviction = Math.max(0, conviction - tfPenalty);

    // LLM card
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const htfNote: string[] = [];
    if (t1h) htfNote.push(`1h ${t1h > 0 ? "up" : "down"}`);
    if (t4h) htfNote.push(`4h ${t4h > 0 ? "up" : "down"}`);

    const prompt = `
You are a trading assistant. Format a *single* trade card for ${instr.code}.

Context:
- Bias timeframe: 15m. HTFs (1h/4h) are for confirmation & conviction adjustments.
- Setup candidates: pullback-to-0.618 vs. BOS continuation.
- Macro headlines in last ${sinceHrs}h: ${recent.length}
- News sentiment (lightweight): ${newsBias} (${newsScore.toFixed(2)})
- HTF context: ${htfNote.join(", ") || "n/a"}
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
      model, temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    });
    const text = chat.choices?.[0]?.message?.content?.trim() || "";

    const out: ApiOut = {
      ok: true,
      plan: { text, conviction, setupType: upBias ? "Pullback" : "BOS", entry, stop, tp1, tp2,
              notes: blackout ? "High-impact event within ~90 min – reduced conviction." : null },
      usedHeadlines: recent.slice(0, 12),
      usedCalendar: calItems,
    };

    // cache fresh success unless caller asked for nocache
    if (!nocache) cacheSet(cacheKey, out);
    res.setHeader("Cache-Control", nocache ? "no-store" : "public, max-age=60");
    return res.status(200).json(out);

  } catch (err: any) {
    console.error("PLAN API error:", err?.message || err);
    return res.status(500).json({ ok: false, reason: "Server error", usedHeadlines: [], usedCalendar: [] });
  }
}
