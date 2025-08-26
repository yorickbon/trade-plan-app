// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import getCandles from "../../lib/prices"; // ✅ this path matches your repo layout

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

type PlanBody = {
  instrument: string;
  date?: string;
  debug?: boolean;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // quick env guardrails
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  try {
    const { instrument, date = new Date().toISOString().slice(0, 10), debug } =
      (req.body as PlanBody) ?? {};

    if (!instrument) {
      return res.status(400).json({ error: "instrument is required" });
    }

    // 1) Live market context
    // Pull a sensible amount so GPT can “see” structure without blowing tokens
    const [c4h, c1h, c15] = await Promise.all([
      getCandles(instrument, "4h", 200),
      getCandles(instrument, "1h", 200),
      getCandles(instrument, "15m", 200),
    ]);

    // If any feed is totally empty, don’t hallucinate trades
    if (!c15.length || !c1h.length || !c4h.length) {
      return res.status(200).json({
        instrument,
        date,
        model,
        reply:
          "No Trade – live candles unavailable (one or more timeframes returned no data).",
      });
    }

    // current price from most recent 15m close
    const price = Number(c15[c15.length - 1].c);

    // Keep payloads compact (last 60 bars / tf) to reduce token use
    const ctx = {
      instrument,
      date,
      current_price: price,
      candles: {
        "4h": c4h.slice(-60),
        "1h": c1h.slice(-60),
        "15m": c15.slice(-60),
      },
    };

    // 2) System rules
    const system = `
You are a trading assistant. Use ONLY the live data provided.
Hard rules:
- Anchor all levels to current_price exactly.
- Entry, Stop, TP1, TP2 must each be within ±2% of current_price.
- SL must sit beyond a recent swing or logical structure (from the supplied candles).
- TP targets should align with swing highs/lows or obvious liquidity.
- If structure is unclear or context is thin → output "No Trade".
Return a compact trade card:

Type: (Breakout / Pullback / Range / News)
Direction: (Buy / Sell)
Entry:
Stop:
TP1:
TP2:
Conviction: (0–100%)
Reasoning: one short sentence grounded in the given candles.
    `.trim();

    // 3) Ask the model
    const rsp = await client.chat.completions.create({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(ctx) },
      ],
    });

    const reply = rsp.choices?.[0]?.message?.content?.trim() || "No response";

    // 4) Sanity check: reject wild numbers (±2% from current price)
    const within = (n: number) => Math.abs(n - price) <= price * 0.02;
    const nums = [...reply.matchAll(/(\d+\.\d+)/g)].map((m) => Number(m[1]));
    const unrealistic = nums.length > 0 && nums.some((n) => !within(n));

    if (unrealistic) {
      return res.status(200).json({
        instrument,
        date,
        model,
        reply: `No Trade – generated levels were unrealistic vs live price (${price}).`,
      });
    }

    // 5) Done
    return res.status(200).json({
      instrument,
      date,
      model,
      reply,
      ...(debug ? { debug: { price, samples: { h4: c4h.slice(-3), h1: c1h.slice(-3), m15: c15.slice(-3) } } } : {}),
    });
  } catch (err: any) {
    console.error(err);
    // Normalize common upstream errors into a single message
    const msg =
      err?.message ||
      err?.error?.message ||
      (typeof err === "string" ? err : "Connection error.");
    return res.status(500).json({ error: msg });
  }
}
