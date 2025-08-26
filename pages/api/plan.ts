import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles } from "@/lib/prices";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { instrument, date } = req.body as { instrument: string; date: string };

    // 1. Fetch live candles
    const [c4h, c1h, c15] = await Promise.all([
      getCandles(instrument, "4h", 200),
      getCandles(instrument, "1h", 200),
      getCandles(instrument, "15m", 200),
    ]);

    const price = c15.at(-1)?.c ?? 0;

    // 2. Build trade context for GPT
    const user = {
      instrument,
      date,
      current_price: price,
      candles: {
        "4h": c4h.slice(-20),   // last 20 4H candles
        "1h": c1h.slice(-20),   // last 20 1H candles
        "15m": c15.slice(-20),  // last 20 15m candles
      },
    };

    // 3. System prompt (rules)
    const system = `
You are a trading assistant. 
You MUST base every level on the live data provided.
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
        { role: "user", content: JSON.stringify(user) },
      ],
      temperature: 0.2,
    });

    const text = rsp.choices[0]?.message?.content ?? "No response";

    // 5. Sanity filter: reject absurd levels
    const nums = [...text.matchAll(/(\d+\.\d+)/g)].map(m => Number(m[1]));
    const limit = price * 0.02; // ±2%
    const bad = nums.some(n => Math.abs(n - price) > limit);

    if (bad) {
      return res.status(200).json({
        text: `No Trade – generated levels were unrealistic vs live price (${price}).`,
        conviction: 0,
      });
    }

    // 6. Return result
    res.status(200).json({
      text,
      conviction: 70, // default, can later scale with logic
    });

  } catch (e: any) {
    res.status(500).json({ error: e.message || "server error" });
  }
}
