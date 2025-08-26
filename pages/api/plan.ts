// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import getCandles from "../../lib/prices";

// -----------------------
// Light in-memory cache
// -----------------------
type CacheEntry<T> = { expires: number; data: T };
const PLAN_CACHE = (globalThis as any).__PLAN_CACHE__ ?? new Map<string, CacheEntry<any>>();
(globalThis as any).__PLAN_CACHE__ = PLAN_CACHE;

function getCache<T>(key: string): T | null {
  const hit = PLAN_CACHE.get(key) as CacheEntry<T> | undefined;
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    PLAN_CACHE.delete(key);
    return null;
  }
  return hit.data;
}
function setCache<T>(key: string, data: T, ttlMs = 60_000) {
  PLAN_CACHE.set(key, { data, expires: Date.now() + ttlMs });
}

// -----------------------
// Helpers
// -----------------------
type CalendarItem = {
  date: string;         // ISO
  time?: string;        // optional
  country?: string;
  currency?: string;    // e.g., EUR / USD
  impact?: "Low" | "Medium" | "High";
  title?: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};

type PlanOut = {
  type: string;          // Pullback / Breakout / Range / No Trade
  direction?: "Buy" | "Sell";
  entry?: number;
  stop?: number;
  tp1?: number;
  tp2?: number;
  conviction?: number;   // 0–100
  invalidation?: string; // what cancels the setup
  notes?: string;        // short rationale
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// decimals by instrument (fallback rules for FX/JPY/Gold/Indices)
function decimalsFor(code: string): number {
  const u = code.toUpperCase();
  if (u.includes("XAU")) return 2;          // gold
  if (u.includes("NAS") || u.includes("US100")) return 2;
  if (u.endsWith("JPY")) return 3;          // JPY pairs
  if (/^[A-Z]{6}$/.test(u)) return 5;       // generic FX
  return 2;                                 // default
}

function roundTo(n: number | undefined, dp: number): number | undefined {
  if (typeof n !== "number" || !isFinite(n)) return undefined;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function rrRatio(entry: number, stop: number, tp: number, dir: "Buy"|"Sell"): number {
  if (dir === "Buy") return (tp - entry) / (entry - stop);
  return (entry - tp) / (stop - entry);
}

function adjustRRfloor(plan: PlanOut, dp: number, floor = 1.5): { plan: PlanOut; adjusted: boolean } {
  if (!plan.entry || !plan.stop || !plan.tp1 || !plan.direction) return { plan, adjusted: false };
  // Try to satisfy floor by shifting TP2 if needed; leave TP1 as the conservative target
  let adjusted = false;
  const dir = plan.direction;

  const current = rrRatio(plan.entry, plan.stop, plan.tp2 ?? plan.tp1, dir);
  if (!isFinite(current) || current >= floor) {
    // still round to desired precision
    plan.entry = roundTo(plan.entry, dp);
    plan.stop  = roundTo(plan.stop,  dp);
    plan.tp1   = roundTo(plan.tp1,   dp);
    if (plan.tp2) plan.tp2 = roundTo(plan.tp2, dp);
    return { plan, adjusted };
  }

  // compute minimal TP2 that meets floor
  if (dir === "Buy") {
    const needed = plan.entry + floor * (plan.entry - plan.stop);
    plan.tp2 = Math.max(needed, plan.tp2 ?? needed);
  } else {
    const needed = plan.entry - floor * (plan.stop - plan.entry);
    plan.tp2 = Math.min(needed, plan.tp2 ?? needed);
  }
  adjusted = true;

  plan.entry = roundTo(plan.entry, dp);
  plan.stop  = roundTo(plan.stop,  dp);
  plan.tp1   = roundTo(plan.tp1,   dp);
  if (plan.tp2) plan.tp2 = roundTo(plan.tp2, dp);

  plan.notes = (plan.notes ? plan.notes + " " : "") + `Adjusted TP2 to satisfy R:R ≥ ${floor}.`;
  return { plan, adjusted };
}

function withinMinutes(aISO: string, bISO: string, minutes = 90): boolean {
  const a = new Date(aISO).getTime();
  const b = new Date(bISO).getTime();
  return Math.abs(a - b) <= minutes * 60_000;
}

// -----------------------
// Handler
// -----------------------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { instrument, date, calendar = [], debug = false } = req.body as {
      instrument: string;
      date: string;                   // YYYY-MM-DD
      calendar?: CalendarItem[];
      debug?: boolean;
    };

    if (!instrument || !date) return res.status(400).json({ error: "instrument and date are required" });

    // cache key (instrument+date+impact snapshot)
    const cacheKey = JSON.stringify({ instrument, date });
    const cached = getCache<any>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.status(200).json(cached);
    }

    // 1) Fetch candles (4h/1h/15m)
    const [h4, h1, m15] = await Promise.all([
      getCandles(instrument, "4h", 200),
      getCandles(instrument, "1h", 200),
      getCandles(instrument, "15min", 200),
    ]);

    // 2) News blackout guard (±90 min) using provided calendar
    const hasBlackout = (calendar as CalendarItem[]).some(
      (it) =>
        (it.impact === "High" || /FOMC|Rate|NFP|CPI|GDP|ECB|BOE/i.test(it.title || "")) &&
        withinMinutes(`${date}T00:00:00`, it.date, 90) // using plan date as anchor; UI can refine to exact time if needed
    );
    if (hasBlackout) {
      const reply = `No Trade: high-impact event within the blackout window (±90m). Wait for the release and first impulse to settle.`;
      const payload = { instrument, date, model: MODEL, plan: { text: reply, conviction: 0 } };
      setCache(cacheKey, payload, 60_000);
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.status(200).json(payload);
    }

    // 3) Build system prompt with timeframe alignment + invalidation rules
    const system = `
You are a strict trading assistant. Use ONLY the provided live candles + calendar snapshot.
Rules:
- Timeframe alignment: Prefer trades where 4H and 1H bias agree. If not aligned, either return "No Trade" OR allow a 15m pullback entry ONLY if it re-aligns with 4H bias; in that case reduce conviction.
- Force structure: Provide {Type, Direction, Entry, Stop, TP1, TP2, Conviction%, Invalidation, Notes}.
- Entry/SL must be logical (beyond swing/structure or liquidity). TPs must be at structure, equal highs/lows or measured move targets.
- Include "Invalidation" (what price behaviour cancels the idea).
- Respect upcoming calendar risks: If a very high-risk event is imminent, prefer "No Trade".
- If data unclear -> "No Trade".
- Keep Notes concise (1–2 sentences).
`;

    const user = {
      date,
      instrument,
      context: {
        // last ~50 to keep token budget
        h4: h4.slice(-50),
        h1: h1.slice(-60),
        m15: m15.slice(-80),
        calendar: (calendar as CalendarItem[]).slice(0, 12),
      },
      format: `Return a compact plan in plain text lines exactly like:
Type: <Pullback|Breakout|Range|No Trade>
Direction: <Buy|Sell> (omit if No Trade)
Entry: <number>
Stop: <number>
TP1: <number>
TP2: <number>
Conviction: <0-100>%
Invalidation: <one concise sentence>
Reasoning: <one concise sentence>
`,
    };

    const rsp = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: JSON.stringify(user) },
      ],
      temperature: 0.2,
    });

    const text = rsp.choices[0]?.message?.content?.trim() || "No Trade";
    // parse numbers out
    const plan: PlanOut = {
      type: /Type:\s*(.*)/i.exec(text)?.[1]?.trim() || "No Trade",
      direction: /Direction:\s*(Buy|Sell)/i.exec(text)?.[1]?.trim() as any,
      entry: parseFloat(/Entry:\s*([0-9.\-]+)/i.exec(text)?.[1] || ""),
      stop: parseFloat(/Stop:\s*([0-9.\-]+)/i.exec(text)?.[1] || ""),
      tp1: parseFloat(/TP1:\s*([0-9.\-]+)/i.exec(text)?.[1] || ""),
      tp2: parseFloat(/TP2:\s*([0-9.\-]+)/i.exec(text)?.[1] || ""),
      conviction: parseFloat(/Conviction:\s*([0-9.\-]+)/i.exec(text)?.[1] || "0"),
      invalidation: /Invalidation:\s*(.*)/i.exec(text)?.[1]?.trim(),
      notes: /Reasoning:\s*(.*)/i.exec(text)?.[1]?.trim(),
    };

    // 4) Precision + R:R floor
    const dp = decimalsFor(instrument);
    if (plan.entry)  plan.entry  = roundTo(plan.entry, dp)!;
    if (plan.stop)   plan.stop   = roundTo(plan.stop,  dp)!;
    if (plan.tp1)    plan.tp1    = roundTo(plan.tp1,   dp)!;
    if (plan.tp2)    plan.tp2    = roundTo(plan.tp2,   dp)!;

    if (plan.type !== "No Trade" && plan.direction && plan.entry && plan.stop && (plan.tp1 || plan.tp2)) {
      const adjusted = adjustRRfloor(plan, dp, 1.5);
      // keep adjusted.plan
    }

    const payload = {
      instrument,
      date,
      model: MODEL,
      plan: {
        text,
        ...plan,
      },
      debug: debug ? { h4: h4.slice(-10), h1: h1.slice(-10), m15: m15.slice(-10), calendar: (calendar as CalendarItem[]).slice(0, 6) } : undefined,
    };

    setCache(cacheKey, payload, 60_000); // 1 minute cache
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json(payload);
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
