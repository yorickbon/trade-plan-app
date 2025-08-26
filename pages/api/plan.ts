// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import getCandles from "../../lib/prices";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { instrument, date } = req.body as { instrument: string; date: string };

    // 1. Fetch live candles
    const [h4, h1, c15] = await Promise.all([
      getCandles(instrument, "4h", 200),
      getCandles(instrument, "1h", 200),
      getCandles(instrument, "15m", 200),
    ]);

    const price = c15.at(-1)?.c ?? 0;

    // 2. Build trade context for GPT
    const context = {
      instrument,
      date,
      currentPrice: price,
      candles: {
        h4: h4.slice(-20),   // last 20 4H candles
        h1: h1.slice(-20),   // last 20 1H candles
        c15: c15.slice(-20), // last 20 15m candles
      },
    };

    // 3. System prompt (rules)
    const system = `
You are a trading assistant.
You must base every level on the live data provided.
Rules:
- Use the current price exactly as an anchor.
- All levels (Entry/SL/TP) must stay within ±2% of current price.
- Stop Loss must be placed beyond a recent swing or logical structure level.
- Take Profits must align with structure/liquidity (e.g., swing high/low).
- If data is unclear, output "No Trade".
Return a clear trade card with:
Type, Direction, Entry, Stop, TP1, TP2, Conviction %, and 1–2 sentence rationale.
`;

    // 4. Call GPT
    const rsp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(context) },
      ],
    });

    const plan = rsp.choices[0].message?.content || "No plan generated.";

    res.status(200).json({ plan });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}
