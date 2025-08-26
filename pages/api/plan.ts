// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import getCandles from "../../lib/prices";

// ---- Types ----
type Instrument = {
  code: string;           // e.g. "EURUSD"
  currencies: string[];   // e.g. ["EUR","USD"]
};

type CalendarItem = {
  time: string;     // ISO timestamp
  country: string;
  currency: string;
  impact: string;   // "low" | "medium" | "high" | vendor-specific
  title: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};

type PlanResponse = {
  instrument: string;
  date: string;
  model: string;
  plan: {
    text: string;
    conviction: number | null;
  };
};

// ---- OpenAI client ----
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---- Helpers ----
/** Returns true if there is a high-impact event within +/- 90 minutes of now (or of given date). */
function isNewsBlackout(items: CalendarItem[] | undefined, baseDateISO: string): boolean {
  if (!items || items.length === 0) return false;

  // Use current time if the baseDate is today; otherwise center at midday of that date
  const base = new Date(baseDateISO);
  const now = new Date();
  const anchor =
    base.toDateString() === now.toDateString()
      ? now.getTime()
      : new Date(`${baseDateISO}T12:00:00Z`).getTime();

  const windowMs = 90 * 60 * 1000; // 90 minutes

  return items.some((it) => {
    const t = Date.parse(it.time);
    const isHigh = (it.impact || "").toLowerCase().includes("high");
    return isHigh && Math.abs(t - anchor) <= windowMs;
  });
}

/** Parse a conviction percentage like "Conviction: 72%" from model output. */
function extractConviction(text: string): number | null {
  const m = text.match(/conviction\D+?(\d{1,3})\s*%/i);
  if (!m) return null;
  const n = Math.max(0, Math.min(100, parseInt(m[1], 10)));
  return Number.isFinite(n) ? n : null;
}

// ---- Handler ----
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PlanResponse | { error: string }>
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const {
      instrument,  // { code: "EURUSD", currencies: ["EUR","USD"] } OR just "EURUSD"
      date,        // "YYYY-MM-DD"
      calendar,    // optional: CalendarItem[]
      debug,       // optional: boolean
    } = req.body as {
      instrument: Instrument | string;
      date: string;
      calendar?: CalendarItem[];
      debug?: boolean;
    };

    const instr: Instrument =
      typeof instrument === "string"
        ? { code: instrument, currencies: [] }
        : instrument;

    // 1) Optional news blackout using provided calendar snapshot
    if (isNewsBlackout(calendar, date)) {
      const blackoutText =
        `No Trade — high-impact event within ~90m for ${instr.currencies.join("/") || instr.code}.` +
        `\nNote: Stand aside until after the release and first impulse settles.`;
      return res.status(200).json({
        instrument: instr.code,
        date,
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        plan: { text: blackoutText, conviction: 0 },
      });
    }

    // 2) Fetch live candles (4h / 1h / 15m)
    const [h4, h1, m15] = await Promise.all([
      getCandles(instr, "4h", 200),
      getCandles(instr, "1h", 200),
      getCandles(instr, "15m", 200), // <-- fixed key
    ]);

    // Use the most recent price from 15m
    const price =
      m15 && m15.length > 0 && typeof m15[m15.length - 1]?.close === "number"
        ? m15[m15.length - 1].close
        : 0;

    // Trim for prompt size
    const ctx = {
      instrument: instr.code,
      date,
      currentPrice: price,
      candles: {
        h4: h4.slice(-120),
        h1: h1.slice(-120),
        m15: m15.slice(-120),
      },
      calendar: (calendar || []).slice(0, 15),
    };

    // 3) System rules (timeframe alignment, invalidation, risk rules, etc.)
    const system = `
You are a disciplined trading assistant. Use ONLY the live data provided.
Rules:
- Always anchor levels and bias on the provided candles (4h, 1h, 15m) and the current price ${price}.
- Timeframe alignment: Prefer trades where 4h and 1h structure supports the 15m setup.
  If alignment is weak, lower conviction and clearly explain why.
- If misaligned but there is a pullback into HTF structure, you may propose a pullback entry with lower conviction.
- Risk: Stop goes beyond a recent swing or clear structure level; target(s) sit at logical liquidity or structure.
- Include "Invalidation" notes: exactly when/where the idea is no longer valid.
- Return a clear card with fields: Type, Direction, Entry, Stop, TP1, TP2, Conviction %, and 1–2 sentence Reasoning.
- If data is unclear or risky: return "No Trade" and explain briefly.
- DO NOT fabricate data not in candles/calendar provided. Keep numbers sensible for the instrument.
`.trim();

    const user = `
Instrument: ${instr.code}
Date: ${date}
Current Price: ${price}
Currencies: ${instr.currencies.join(", ") || "(n/a)"}

Calendar (server snapshot, filtered):
${JSON.stringify(ctx.calendar, null, 2)}

H4 candles (tail):
${JSON.stringify(ctx.candles.h4.slice(-20))}

H1 candles (tail):
${JSON.stringify(ctx.candles.h1.slice(-20))}

M15 candles (tail):
${JSON.stringify(ctx.candles.m15.slice(-20))}

Create the card now. Keep it concise and machine-readable lines:
Type: ...
Direction: ...
Entry: ...
Stop: ...
TP1: ...
TP2: ...
Conviction: ...%
Reasoning: ...
`.trim();

    const model =
      process.env.OPENAI_MODEL ||
      process.env.OPENAI_MODEL_ALT ||
      "gpt-4o-mini";

    const ai = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    });

    const text =
      ai.choices?.[0]?.message?.content?.trim() ||
      "No Trade — insufficient data.";
    const conviction = extractConviction(text);

    if (debug) {
      console.log({ promptSystem: system, promptUser: user, reply: text });
    }

    const payload: PlanResponse = {
      instrument: instr.code,
      date,
      model,
      plan: {
        text,
        conviction,
      },
    };

    return res.status(200).json(payload);
  } catch (err: any) {
    console.error("plan.ts error:", err);
    const msg =
      err?.response?.data?.error ||
      err?.message ||
      "Server error";
    return res.status(500).json({ error: msg });
  }
}
