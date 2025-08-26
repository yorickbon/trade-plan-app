// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import getCandles from "../../lib/prices";

// --- Fix: trim the key and guard if missing ---
const OPENAI_KEY = (process.env.OPENAI_API_KEY || "").trim();

if (!OPENAI_KEY) {
  throw new Error("❌ OPENAI_API_KEY is missing. Set it in Vercel → Settings → Environment Variables.");
}

const client = new OpenAI({ apiKey: OPENAI_KEY });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { instrument, date } = req.body as { instrument: string; date: string };

    // --- 1. Preflight check for OpenAI connectivity ---
    try {
      const ping = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      });

      if (!ping.ok) {
        const details = await ping.text().catch(() => "");
        return res.status(500).json({
          error: `OpenAI auth failed: HTTP ${ping.status}. ${details?.slice(0, 200)}`,
        });
      }
    } catch (e: any) {
      return res.status(500).json({
        error: `OpenAI reachability failed: ${e?.message || e}`,
      });
    }

    // --- 2. Fetch live candles ---
    const [h4, h1, c15] = await Promise.all([
      getCandles(instrument, "4h", 200),
      getCandles(instrument, "1h", 200),
      getCandles(instrument, "15m", 200),
    ]);

    const price = c15.at(-1)?.c ?? 0;

    // --- 3. Build trade context ---
    const context = {
      instrument,
      date,
      currentPrice: price,
      candles: {
        h4: h4.slice(-20),
        h1: h1.slice(-20),
        c15: c15.slice(-20),
      },
    };

    // --- 4. System rules ---
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

    // --- 5. Call OpenAI ---
    const rsp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify(context, null, 2),
        },
      ],
      temperature: 0.3,
    });

    const content = rsp.choices[0]?.message?.content || "No response";

    // --- 6. Return result ---
    res.status(200).json({ plan: content, context });
  } catch (err: any) {
    console.error("Plan API Error:", err);
    res.status(500).json({ error: err.message || "Internal Server Error" });
  }
}
