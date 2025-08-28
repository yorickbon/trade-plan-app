// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles } from "../../lib/prices";

type Candle = { t: number; o: number; h: number; l: number; c: number };
type Instrument = { code: string; currencies?: string[] };

type CalendarItem = {
  date?: string; time?: string; country?: string; currency?: string;
  impact?: string; title?: string; actual?: string; forecast?: string; previous?: string;
};

type HeadlineItem = {
  title: string; url?: string; source?: string; seen?: string; published_at?: string;
};

type PlanOut = {
  text: string;
  conviction?: number | null;
};

type ApiOut = {
  ok: boolean;
  plan?: PlanOut;
  reason?: string;
  usedHeadlines?: HeadlineItem[];
  usedCalendar?: CalendarItem[];
};

// ---------- helpers ----------
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function altSymbol(code: string): string | null {
  // EURUSD -> EUR/USD ; if already has slash, return null
  if (code.includes("/")) return null;
  if (code.length === 6) return `${code.slice(0, 3)}/${code.slice(3)}`;
  return null;
}

async function fetchTF(code: string, tf: "15m" | "1h" | "4h", limit = 200): Promise<Candle[]> {
  try {
    return await getCandles(code, tf, limit);
  } catch {
    return [];
  }
}

type AllFrames = {
  m15: Candle[];
  m1: Candle[];
  m4: Candle[];
  triedAlt: string | null;
  tries: number;
  pollMs: number;
  totalMs: number;
};

async function getAllTimeframesWithTimeout(codeIn: string): Promise<{ frames: AllFrames; missing: string[] }> {
  const totalMs = Math.max(1000, Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 8000)); // e.g. 120000
  const pollMs  = Math.max(100,  Number(process.env.PLAN_CANDLES_POLL_MS    ?? 1000)); // e.g. 200
  const maxTries = Math.max(1, Math.floor(totalMs / pollMs));

  let code = (codeIn || "").trim().toUpperCase();
  let m15: Candle[] = [];
  let m1: Candle[] = [];
  let m4: Candle[] = [];
  let triedAlt: string | null = null;

  for (let i = 1; i <= maxTries; i++) {
    if (!m15.length) m15 = await fetchTF(code, "15m", 200);
    if (!m1.length)  m1  = await fetchTF(code, "1h",  200);
    if (!m4.length)  m4  = await fetchTF(code, "4h",  200);

    if (m15.length && m1.length && m4.length) {
      return { frames: { m15, m1, m4, triedAlt, tries: i, pollMs, totalMs }, missing: [] };
    }

    // on the 3rd pass, try an alt symbol if we still don't have all TFs
    if (i === 3 && !triedAlt) {
      const alt = altSymbol(code);
      if (alt) { code = alt; triedAlt = alt; }
    }

    if (i < maxTries) await sleep(pollMs);
  }

  const missing: string[] = [];
  if (!m4.length)  missing.push("4h");
  if (!m1.length)  missing.push("1h");
  if (!m15.length) missing.push("15m");

  return { frames: { m15, m1, m4, triedAlt, tries: maxTries, pollMs, totalMs }, missing };
}

// ---------- handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiOut | any>) {
  try {
    // DEBUG GET so you can click in a browser
    if (req.method === "GET" && req.query.debug === "1") {
      const symbol = String(req.query.symbol || req.query.code || "EURUSD").toUpperCase();
      const { frames, missing } = await getAllTimeframesWithTimeout(symbol);
      return res.status(200).json({
        ok: missing.length === 0,
        missing,
        symbolUsed: symbol,
        triedAlt: frames.triedAlt,
        tries: frames.tries,
        pollMs: frames.pollMs,
        totalMs: frames.totalMs,
        counts: { m15: frames.m15.length, h1: frames.m1.length, h4: frames.m4.length },
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, reason: "Method not allowed" });
    }

    const { instrument, date, calendar, headlines } = req.body as {
      instrument: Instrument | string;
      date?: string;
      calendar?: CalendarItem[];
      headlines?: HeadlineItem[];
    };

    const instr: Instrument = typeof instrument === "string" ? { code: instrument } : instrument;
    if (!instr?.code) {
      return res.status(400).json({ ok: false, reason: "Missing instrument code" });
    }

    // candles with retries + alt symbol
    const { frames, missing } = await getAllTimeframesWithTimeout(instr.code);

    if (missing.length) {
      const secs = (frames.tries * frames.pollMs) / 1000;
      const reason =
        `Missing candles for ${missing.join(", ")} after ${secs.toFixed(1)}s ` +
        `(tries=${frames.tries}, poll=${frames.pollMs}ms, timeout=${frames.totalMs}ms, ` +
        `symbol=${instr.code}${frames.triedAlt ? `, alt=${frames.triedAlt}` : ""}).`;

      return res.status(200).json({
        ok: false,
        reason,
        usedHeadlines: Array.isArray(headlines) ? headlines.slice(0, 12) : [],
        usedCalendar: Array.isArray(calendar) ? calendar.slice(0, 12) : [],
      });
    }

    // --------- If we got here, we have m15/m1/m4. For now return a placeholder card text. ---------
    const last = (arr: Candle[]) => arr[arr.length - 1]?.c;
    const entry = Number(last(frames.m15) ?? 0);
    const stop  = Number(entry ? entry - 0.003 : 0); // placeholder until your strategy block is re-enabled
    const tp1   = Number(entry ? entry + 0.003 : 0);
    const tp2   = Number(entry ? entry + 0.006 : 0);

    const text =
`**Trade Card: ${instr.code}**
**Type:** Pullback
**Direction:** (Buy | Sell)
**Entry:** ${entry}
**Stop:** ${stop}
**TP1:** ${tp1}
**TP2:** ${tp2}
**Conviction %:** 60

**Reasoning:** Placeholder while we stabilize candles.`;

    return res.status(200).json({
      ok: true,
      plan: { text, conviction: 60 },
      usedHeadlines: Array.isArray(headlines) ? headlines.slice(0, 12) : [],
      usedCalendar: Array.isArray(calendar) ? calendar.slice(0, 12) : [],
    });
  } catch (err: any) {
    console.error("PLAN API error", err);
    return res.status(500).json({ ok: false, reason: "Server error" });
  }
}
