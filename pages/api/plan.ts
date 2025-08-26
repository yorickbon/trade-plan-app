// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import getCandles, { Candle } from "../../lib/prices"; // <-- RELATIVE PATH

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { instrument, date } = (req.body || {}) as {
      instrument?: string;
      date?: string;
      debug?: boolean;
    };

    if (!instrument) {
      return res.status(400).json({ error: "instrument is required" });
    }

    // 1) Live candles from Twelve Data
    const [c4h, c1h, c15] = await Promise.all([
      getCandles(instrument, "4h", 200),
      getCandles(instrument, "1h", 200),
      getCandles(instrument, "15min", 200), // note: Twelve Data uses "15min"
    ]);

    // If any empty -> bail safely
    if (!c15.length || !c1h.length || !c4h.length) {
      return res.status(200).json({
        text: "No Trade — insufficient live data returned.",
        conviction: 0,
      });
    }

    const price = c15[c15.length - 1].c;

    // 2) Build user context for the model
    const user = {
      instrument,
      date: date ?? new Date().toISOString().slice(0, 10),
      current_price: price,
      candles: {
        "4h": tail(c4h, 20),
        "1h": tail(c1h, 20),
        "15m": tail(c15, 20),
      },
    };

    // 3) Trading rules (system prompt)
    const system = `
You are a professional trading assistant.
You MUST base every proposed level strictly on the provided live data (no guessing).

Rules:
- Anchor all levels to the provided current price.
- Entry/SL/TP must stay within ±2% of current price unless explicitly justified by a nearby swing or gap.
- SL must be beyond a recent swing or structural invalidation.
- TP must align with structure/liquidity (swing highs/lows, obvious inefficiencies).
- If the data is unclear or conflicting, respond with "No Trade".

Return a compact Trade Card in plain text with:
Type, Direction, Entry, Stop Loss, Take Profit 1, Take Profit 2, Conviction %, and a one–two sentence rationale.
    `.trim();

    // 4) Call the model
    const rsp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
    });

    const text = rsp.choices[0]?.message?.content ?? "No response";

    // 5) Sanity: reject absurd levels
    const nums = [...text.matchAll(/(\d+\.\d+)/g)].map((m) => Number(m[1]));
    const limit = price * 0.02; // ±2%
    const unrealistic = nums.some((n) => Math.abs(n - price) > limit);

    if (unrealistic) {
      return res.status(200).json({
        text: `No Trade — generated levels were unrealistic vs live price (${price}).`,
        conviction: 0,
      });
    }

    // 6) Done
    return res.status(200).json({
      text,
      conviction: 70,
    });
  } catch (err: any) {
    // surface concise error for debugging
    return res.status(500).json({ error: err?.message ?? "Connection error." });
  }
}

function tail<T>(arr: T[], n: number): T[] {
  return arr.slice(Math.max(0, arr.length - n));
}
