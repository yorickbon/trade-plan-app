// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import getCandles from "../../lib/prices";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -------- Types sent from the client ----------
type Instrument = {
  code: string;                // e.g., "EURUSD"
  currencies?: string[];       // e.g., ["EUR","USD"]
  label?: string;              // optional UI label
};

type CalendarItem = {
  date: string;        // ISO date or datetime
  time?: string;
  country?: string;
  currency?: string;   // "USD", "EUR", etc
  impact?: string;     // "High" | "Medium" | "Low" | etc
  title?: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};

// -------- Response payload ----------
type PlanResponse = {
  instrument: string;
  date: string;
  model: string;
  plan: {
    text: string;
    conviction?: number | null;
  };
  calendarUsed?: {
    highCount: number;
    mediumCount: number;
    itemsPreview: string[];
  };
  debug?: any;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PlanResponse | { error: string }>
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // ---------- Parse body ----------
    const {
      instrument,
      date,
      calendar = [] as CalendarItem[],
      model: modelOverride,
      debug = false,
    } = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as {
      instrument: Instrument | string;
      date: string;
      calendar?: CalendarItem[];
      model?: string;
      debug?: boolean;
    };

    if (!instrument || !date) {
      return res.status(400).json({ error: "Missing instrument or date" });
    }

    const symbol =
      typeof instrument === "string" ? instrument : (instrument as Instrument).code;

    if (!symbol || typeof symbol !== "string") {
      return res.status(400).json({ error: "Invalid instrument" });
    }

    // ---------- Fetch live candles ----------
    // NOTE: getCandles expects a SYMBOL string, not the Instrument object.
    const [h4, h1, m15] = await Promise.all([
      getCandles(symbol, "4h", 200),
      getCandles(symbol, "1h", 200),
      getCandles(symbol, "15m", 200),
    ]);

    const last = Array.isArray(m15) && m15.length ? m15[m15.length - 1] : null;
    const currentPrice =
      last && (last.close ?? last.c) !== undefined
        ? (last.close ?? last.c)
        : 0;

    // ---------- Calendar-based caution / blackout ----------
    // Count High and Medium impact items
    const highCount = calendar.filter(
      (it) => (it.impact || "").toLowerCase().includes("high")
    ).length;
    const mediumCount = calendar.filter(
      (it) => (it.impact || "").toLowerCase().includes("medium")
    ).length;

    // Build a short preview of events for the prompt (max 6)
    const itemsPreview = calendar.slice(0, 6).map((it) => {
      const t =
        (it.date || "") + (it.time ? ` ${it.time}` : "");
      const tag = [it.country || it.currency || "", it.impact || ""]
        .filter(Boolean)
        .join(" • ");
      return `${t} — ${tag} — ${it.title || ""}`.trim();
    });

    // ---------- System & user prompts ----------
    const model = modelOverride || process.env.OPENAI_MODEL || "gpt-4o-mini";

    const system = `
You are a trading assistant. Use ONLY the data provided below.
Rules:
- Use the current price EXACTLY as provided.
- Produce a concise “trade card” with: Type, Direction, Entry, Stop, TP1, TP2, Conviction%, and 1–2 sentence reasoning.
- Include **Timeframe Alignment** (4H/1H/15M): say whether they align or diverge and how this affects conviction.
- Include **Invalidation Notes**: the specific condition that kills the idea (e.g., break/close beyond a level or structure).
- Risk: Stops must sit beyond a sensible structural level; TPs must align with recent structure/liquidity.
- If upcoming High-impact economic events are present, lower conviction and add a short caution note.
- If the picture is unclear, return "No Trade." with 0% conviction.
- Be precise, numeric, and realistic.`;

    // Keep candles short for the model: last 20 each
    const ctx = {
      instrument: symbol,
      date,
      currentPrice,
      candles: {
        "4h": h4?.slice(-20) ?? [],
        "1h": h1?.slice(-20) ?? [],
        "15m": m15?.slice(-20) ?? [],
      },
      calendar: {
        counts: { high: highCount, medium: mediumCount },
        itemsPreview,
      },
    };

    const user = `
INSTRUMENT: ${symbol}
DATE: ${date}
PRICE: ${currentPrice}

CANDLES (most recent last; arrays truncated to 20):
4H: ${JSON.stringify(ctx.candles["4h"])}
1H: ${JSON.stringify(ctx.candles["1h"])}
15M: ${JSON.stringify(ctx.candles["15m"])}

ECON CALENDAR (counts): High=${highCount}, Medium=${mediumCount}
ECON PREVIEW (subset): ${itemsPreview.length ? itemsPreview.join(" | ") : "None"}

Return a compact trade card with the fields requested in the rules.`;

    const rsp = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: user.trim() },
      ],
      temperature: 0.3,
    });

    const text =
      rsp.choices?.[0]?.message?.content?.trim() || "No Trade.";
    // Try to gently parse a conviction % if model returns one; otherwise null
    const convictionMatch = text.match(/Conviction[:\s]*([0-9]{1,3})\s*%/i);
    const conviction = convictionMatch
      ? Math.max(0, Math.min(100, parseInt(convictionMatch[1], 10)))
      : null;

    const payload: PlanResponse = {
      instrument: symbol,
      date,
      model,
      plan: {
        text,
        conviction,
      },
      calendarUsed: {
        highCount,
        mediumCount,
        itemsPreview,
      },
      ...(debug
        ? {
            // expose minimal debug if requested
            debug: {
              price: currentPrice,
              len: { h4: h4?.length || 0, h1: h1?.length || 0, m15: m15?.length || 0 },
            },
          }
        : {}),
    };

    return res.status(200).json(payload);
  } catch (err: any) {
    console.error(err);
    const msg =
      err?.message ||
      (typeof err === "string" ? err : "Server error");
    return res.status(500).json({ error: msg });
  }
}
