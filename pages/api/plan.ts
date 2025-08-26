// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import getCandles from "../../lib/prices";

// Permissive candle shape to satisfy various feeds
type Candle = {
  c?: number;      // close (most feeds we used)
  close?: number;  // some feeds use "close"
  o?: number;
  h?: number;
  l?: number;
  t?: string | number;
  time?: string | number;
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Instrument = {
  code: string;                // e.g., "EURUSD"
  currencies?: string[];       // e.g., ["EUR","USD"]
  label?: string;
};

type CalendarItem = {
  date: string;
  time?: string;
  country?: string;
  currency?: string;
  impact?: string;   // "High" | "Medium" | "Low" etc
  title?: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};

type PlanResponse = {
  instrument: string;
  date: string;
  model: string;
  plan: { text: string; conviction?: number | null };
  calendarUsed?: { highCount: number; mediumCount: number; itemsPreview: string[] };
  debug?: any;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PlanResponse | { error: string }>
) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
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

    if (!instrument || !date) return res.status(400).json({ error: "Missing instrument or date" });

    const symbol = typeof instrument === "string" ? instrument : (instrument as Instrument).code;
    if (!symbol) return res.status(400).json({ error: "Invalid instrument" });

    // ---- Fetch candles (cast to permissive Candle[]) ----
    const [h4, h1, m15] = (await Promise.all([
      getCandles(symbol, "4h", 200),
      getCandles(symbol, "1h", 200),
      getCandles(symbol, "15m", 200),
    ])) as [Candle[] | any, Candle[] | any, Candle[] | any];

    const h4Arr = (Array.isArray(h4) ? h4 : []) as Candle[];
    const h1Arr = (Array.isArray(h1) ? h1 : []) as Candle[];
    const m15Arr = (Array.isArray(m15) ? m15 : []) as Candle[];

    const last: Candle | undefined = m15Arr.length ? m15Arr[m15Arr.length - 1] : undefined;
    const currentPrice: number = (last?.c ?? last?.close ?? 0) as number;

    // ---- Calendar caution counts ----
    const highCount = calendar.filter((it) => (it.impact || "").toLowerCase().includes("high")).length;
    const mediumCount = calendar.filter((it) => (it.impact || "").toLowerCase().includes("medium")).length;

    const itemsPreview = calendar.slice(0, 6).map((it) => {
      const dt = (it.date || "") + (it.time ? ` ${it.time}` : "");
      const tag = [it.country || it.currency || "", it.impact || ""].filter(Boolean).join(" • ");
      return `${dt} — ${tag} — ${it.title || ""}`.trim();
    });

    const model = modelOverride || process.env.OPENAI_MODEL || "gpt-4o-mini";

    const system = `
You are a trading assistant. Use ONLY the data provided below.

Rules:
- Use the provided current price exactly.
- Output a concise trade card with: Type, Direction, Entry, Stop, TP1, TP2, Conviction %, and 1–2 sentence reasoning.
- Include **Timeframe Alignment** (4H/1H/15M): do they align? If not, how does this affect conviction?
- Include **Invalidation Notes**: the clear condition that kills the setup (level/structure breach).
- Risk: Stops beyond structure; TPs aligned to recent structure/liquidity.
- If there are High-impact events coming, lower conviction and add a one-line caution.
- If unclear, return "No Trade." with 0% conviction.`;

    const ctx = {
      instrument: symbol,
      date,
      currentPrice,
      candles: {
        "4h": h4Arr.slice(-20),
        "1h": h1Arr.slice(-20),
        "15m": m15Arr.slice(-20),
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

CANDLES (most recent last; truncated to 20):
4H: ${JSON.stringify(ctx.candles["4h"])}
1H: ${JSON.stringify(ctx.candles["1h"])}
15M: ${JSON.stringify(ctx.candles["15m"])}

ECON CALENDAR COUNTS: High=${highCount}, Medium=${mediumCount}
ECON PREVIEW: ${itemsPreview.length ? itemsPreview.join(" | ") : "None"}

Return the trade card as per rules.`;

    const rsp = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: user.trim() },
      ],
      temperature: 0.3,
    });

    const text = rsp.choices?.[0]?.message?.content?.trim() || "No Trade.";
    const convictionMatch = text.match(/Conviction[:\s]*([0-9]{1,3})\s*%/i);
    const conviction = convictionMatch
      ? Math.max(0, Math.min(100, parseInt(convictionMatch[1], 10)))
      : null;

    return res.status(200).json({
      instrument: symbol,
      date,
      model,
      plan: { text, conviction },
      calendarUsed: { highCount, mediumCount, itemsPreview },
      ...(debug ? { debug: { price: currentPrice, lens: { h4: h4Arr.length, h1: h1Arr.length, m15: m15Arr.length } } } : {}),
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
