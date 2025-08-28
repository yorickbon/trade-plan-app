// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { getCandles } from "../../lib/prices";
// keep as named import to avoid default-export errors
import { scoreSentiment as scoreSentimentImported } from "../../lib/sentiment";

/* =========================
   Types
   ========================= */
type Candle = { t: number; o: number; h: number; l: number; c: number };

type Instrument = {
  code: string;
  currencies?: string[];
};

type CalendarItem = {
  date?: string;
  time?: string;
  country?: string;
  currency?: string;
  impact?: string; // "High" | "Medium" | ...
  title?: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};

type Headline = {
  title: string;
  url?: string;
  source?: string;
  seen?: string;         // ISO
  published_at?: string; // ISO
};

type PlanOut = {
  text: string;
  conviction: number | null;
  setupType: string | null;
  entry: number | null;
  stop: number | null;
  tp1: number | null;
  tp2: number | null;
  notes?: string | null;
};

type ApiOut =
  | { ok: true; plan: PlanOut; usedHeadlines: Headline[]; usedCalendar: CalendarItem[] }
  | { ok: false; reason: string; usedHeadlines: Headline[]; usedCalendar: CalendarItem[] };

/* =========================
   Config
   ========================= */
const PER_CALL_TIMEOUT_MS = Math.max(3000, Number(process.env.PLAN_PER_CALL_TIMEOUT_MS ?? 8000));
const TOTAL_BUDGET_MS     = Math.max(6000, Number(process.env.PLAN_TOTAL_BUDGET_MS ?? 12000));
const HEADLINES_SINCE_HOURS = Math.max(1, Number(process.env.HEADLINES_SINCE_HOURS ?? 48));
const LIMIT = 200;

/* =========================
   Helpers
   ========================= */
function withTimeout<T>(p: Promise<T>, ms: number, tag = "op"): Promise<T> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout:${tag}:${ms}`)), ms);
    p.then(v => { clearTimeout(to); resolve(v); })
     .catch(e => { clearTimeout(to); reject(e); });
  });
}

function altSymbol(code: string): string | null {
  if (!code) return null;
  const c = code.toUpperCase().trim();
  // EURUSD -> EUR/USD
  if (/^[A-Z]{6}$/.test(c)) return `${c.slice(0,3)}/${c.slice(3)}`;
  // EUR/USD -> EURUSD
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(c)) return c.replace("/", "");
  return null;
}

async function fetchAllTF(code: string, limit = LIMIT) {
  const calls = [
    withTimeout(getCandles(code, "15m", limit), PER_CALL_TIMEOUT_MS, `candles-15m`).catch(() => [] as Candle[]),
    withTimeout(getCandles(code, "1h",  limit), PER_CALL_TIMEOUT_MS, `candles-1h`).catch(() => [] as Candle[]),
    withTimeout(getCandles(code, "4h",  limit), PER_CALL_TIMEOUT_MS, `candles-4h`).catch(() => [] as Candle[]),
  ];
  const [m15, h1, h4] = await Promise.all(calls);
  return { m15, h1, h4 };
}

function missingTFs(m15: Candle[], h1: Candle[], h4: Candle[]) {
  const miss: string[] = [];
  if (!m15?.length) miss.push("15m");
  if (!h1?.length)  miss.push("1h");
  if (!h4?.length)  miss.push("4h");
  return miss;
}

function baseUrl(req: NextApiRequest) {
  const host = (req.headers["x-forwarded-host"] as string) || (req.headers.host as string);
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  return `${proto}://${host}`;
}

async function safeSentiment(text: string): Promise<number> {
  try {
    const maybe = (scoreSentimentImported as any)(text);
    const resolved = typeof maybe?.then === "function" ? await maybe : maybe;
    if (typeof resolved === "number") return resolved;
    if (resolved && typeof resolved.score === "number") return resolved.score;
  } catch {}
  return 0;
}

/* =========================
   Handler
   ========================= */
export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOut | any>) {
  // Probe GET → quick browser check: counts & missing (no LLM)
  if (req.method === "GET" && String(req.query.probe ?? "0") === "1") {
    const inputSymbol = String(req.query.symbol || "EURUSD").toUpperCase();
    const started = Date.now();

    // first attempt
    let symUsed = inputSymbol;
    let { m15, h1, h4 } = await fetchAllTF(symUsed, LIMIT);
    let miss = missingTFs(m15, h1, h4);

    // one alt attempt if missing and time remains
    if (miss.length && Date.now() - started < TOTAL_BUDGET_MS) {
      const alt = altSymbol(symUsed);
      if (alt && alt !== symUsed) {
        symUsed = alt;
        ({ m15, h1, h4 } = await fetchAllTF(symUsed, LIMIT));
        miss = missingTFs(m15, h1, h4);
      }
    }

    return res.status(200).json({
      ok: miss.length === 0,
      symbolUsed: symUsed,
      counts: { m15: m15.length, h1: h1.length, h4: h4.length },
      missing: miss,
    });
  }

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

    /* ---- Headlines (use provided or pull fallback) ---- */
    let usedHeadlines: Headline[] = Array.isArray(headlines) ? headlines : [];
    if (!usedHeadlines.length && instr.currencies?.length) {
      try {
        const rsp = await fetch(
          `${baseUrl(req)}/api/news?currencies=${encodeURIComponent(instr.currencies.join(","))}`,
          { cache: "no-store" }
        );
        const j = await rsp.json();
        usedHeadlines = Array.isArray(j.items) ? j.items : [];
      } catch {}
    }
    const cutoff = Date.now() - HEADLINES_SINCE_HOURS * 3600_000;
    const recentNews = usedHeadlines.filter(h => {
      const t = Date.parse(h.seen ?? h.published_at ?? "");
      return Number.isFinite(t) && t >= cutoff;
    }).slice(0, 12);

    /* ---- Calendar ---- */
    const calItems: CalendarItem[] = Array.isArray(calendar) ? calendar : [];
    const blackout = (() => {
      if (!calItems.length) return false;
      const now = Date.now();
      const windowMs = 90 * 60 * 1000;
      return calItems.some(ev => {
        const t = Date.parse(`${ev.date ?? ""}T${ev.time ?? "00:00"}:00Z`);
        const high = String(ev.impact || "").toLowerCase().includes("high");
        return Number.isFinite(t) && high && Math.abs(t - now) <= windowMs;
      });
    })();

    /* ---- Candles (one shot + alt retry, no polling) ---- */
    const started = Date.now();
    let symUsed = instr.code.toUpperCase();
    let { m15, h1, h4 } = await fetchAllTF(symUsed, LIMIT);
    let miss = missingTFs(m15, h1, h4);

    if (miss.length && Date.now() - started < TOTAL_BUDGET_MS) {
      const alt = altSymbol(symUsed);
      if (alt && alt !== symUsed) {
        symUsed = alt;
        ({ m15, h1, h4 } = await fetchAllTF(symUsed, LIMIT));
        miss = missingTFs(m15, h1, h4);
      }
    }

    if (miss.length) {
      return res.status(200).json({
        ok: false,
        reason: `Missing candles for ${miss.join(", ")} (symbol used: ${symUsed}).`,
        usedHeadlines: recentNews,
        usedCalendar: calItems,
      });
    }

    /* ---- Rule-based levels from 15m to avoid SL/TP inversion ---- */
    const last = m15[m15.length - 1]!;
    const prev = m15[m15.length - 2] ?? last;
    const close = Number(last.c);
    const directionUp = close >= Number(prev.c); // simple PA bias; LLM will refine

    // recent range from last N bars
    const N = 96;
    const recent = m15.slice(-N);
    const hi = Math.max(...recent.map(c => c.h));
    const lo = Math.min(...recent.map(c => c.l));
    const range = Math.max(hi - lo, 0.0005); // minimal buffer

    // build conservative levels (buy or sell)
    let entry = close;
    let stop  = directionUp ? close - range * 0.5 : close + range * 0.5;
    let tp1   = directionUp ? close + range * 0.5 : close - range * 0.5;
    let tp2   = directionUp ? close + range * 1.0 : close - range * 1.0;

    // ensure logical ordering
    if (directionUp) {
      // stop must be below entry, tps above
      if (!(stop < entry)) stop = entry - Math.abs(range) * 0.4;
      if (!(tp1 > entry)) tp1 = entry + Math.abs(range) * 0.4;
      if (!(tp2 > tp1))   tp2 = tp1 + Math.abs(range) * 0.4;
    } else {
      // stop must be above entry, tps below
      if (!(stop > entry)) stop = entry + Math.abs(range) * 0.4;
      if (!(tp1 < entry)) tp1 = entry - Math.abs(range) * 0.4;
      if (!(tp2 < tp1))   tp2 = tp1 - Math.abs(range) * 0.4;
    }

    /* ---- Lightweight sentiment ---- */
    const newsText = recentNews.map(h => `• ${h.title}`).join("\n");
    const sScore = newsText ? await safeSentiment(newsText) : 0;
    const newsBias = sScore > 0.15 ? "Positive" : sScore < -0.15 ? "Negative" : "Neutral";

    /* ---- Higher TF trend alignment (soft) ---- */
    const trend = (arr: Candle[]) => {
      const a = Number(arr[arr.length - 1]?.c ?? 0);
      const b = Number(arr[Math.max(0, arr.length - 21)]?.c ?? a);
      return a > b ? 1 : a < b ? -1 : 0;
    };
    const t1h = trend(h1);
    const t4h = trend(h4);
    const wantUp = directionUp;

    let conviction = 72;
    if ((wantUp && t1h < 0) || (!wantUp && t1h > 0)) conviction -= 6;
    if ((wantUp && t4h < 0) || (!wantUp && t4h > 0)) conviction -= 8;
    if (newsBias === "Positive" && wantUp) conviction += 4;
    if (newsBias === "Negative" && !wantUp) conviction += 4;
    if (blackout) conviction -= 10;
    conviction = Math.max(0, Math.min(95, conviction));

    /* ---- LLM: format the card (levels are ours; LLM does the wording) ---- */
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const htfNoteParts: string[] = [];
    if (t1h !== 0) htfNoteParts.push(`1H ${t1h > 0 ? "up" : "down"}`);
    if (t4h !== 0) htfNoteParts.push(`4H ${t4h > 0 ? "up" : "down"}`);

    const sys =
`You are a professional trader. You must keep the EXACT numeric levels provided. Do not change them.
Keep the response tight and structured for a trade card.`;

    const user =
`Instrument: ${symUsed}
Bias TF: 15m. HTFs 1h/4h for context.

Setup diagnosis:
- Consider BOS/continuation vs pullback-to-0.5/0.618 retrace.
- Consider liquidity at prior swing highs/lows on 15m.
- Mention if we are inside a prior 15m range.

Macro (last ${HEADLINES_SINCE_HOURS}h): ${recentNews.length} headlines, bias ${newsBias} (${sScore.toFixed(2)})
Calendar blackout (±90m): ${blackout ? "YES" : "NO"}
HTF note: ${htfNoteParts.join(", ") || "n/a"}

LEVELS (DO NOT ALTER):
Direction: ${wantUp ? "Buy" : "Sell"}
Entry: ${entry}
Stop: ${stop}
TP1: ${tp1}
TP2: ${tp2}
Conviction: ${conviction}

Return exactly:
**Trade Card:** ${symUsed}
**Type:** (Pullback | BOS | Range | Breakout)
**Direction:** (Buy | Sell)
**Entry:** ${entry}
**Stop:** ${stop}
**TP1:** ${tp1}
**TP2:** ${tp2}
**Conviction:** ${conviction}

**Reasoning:** one compact paragraph of price-action logic referencing 15m + HTF context.
**Timeframe Alignment:** short note on 4H/1H/15M.
**Invalidation Notes:** 1 sentence (what breaks the idea).
**Caution:** note if blackout/headlines suggest caution.
`;

    const chat = await client.chat.completions.create({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    });

    const text = chat.choices?.[0]?.message?.content?.trim() || 
`**Trade Card:** ${symUsed}
**Type:** Pullback
**Direction:** ${wantUp ? "Buy" : "Sell"}
**Entry:** ${entry}
**Stop:** ${stop}
**TP1:** ${tp1}
**TP2:** ${tp2}
**Conviction:** ${conviction}

**Reasoning:** Price-action bias from 15m with soft 1h/4h context and recent macro bias ${newsBias}.
**Timeframe Alignment:** 4H ${t4h>0?"up":"down"}/ 1H ${t1h>0?"up":"down"}/ 15M ${wantUp?"up":"down"}.
**Invalidation Notes:** Breach beyond stop invalidates idea.
**Caution:** ${blackout ? "High-impact event within ~90m; reduce size." : "Standard risk."}
`;

    const out: ApiOut = {
      ok: true,
      plan: {
        text,
        conviction,
        setupType: "PA + HTF + Macro",
        entry,
        stop,
        tp1,
        tp2,
        notes: blackout ? "High-impact event within ~90 min – reduced conviction." : null,
      },
      usedHeadlines: recentNews,
      usedCalendar: calItems,
    };

    return res.status(200).json(out);

  } catch (err: any) {
    console.error("PLAN API error", err);
    return res.status(500).json({ ok: false, reason: "Server error", usedHeadlines: [], usedCalendar: [] });
  }
}
