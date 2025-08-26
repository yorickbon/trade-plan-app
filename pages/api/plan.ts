// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { getCandles } from "../../lib/prices"; // <-- correct import from /lib

type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number };

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Require POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { instrument, date } = (req.body ?? {}) as {
      instrument?: string;
      date?: string;
    };

    if (!instrument) {
      return res.status(400).json({ error: "Missing 'instrument' in body" });
    }

    // 1) Fetch live candles (Twelve Data via lib/prices.ts)
    const [c4h, c1h, c15] = await Promise.all([
      getCandles(instrument, "4h", 200),
      getCandles(instrument, "1h", 200),
      getCandles(instrument, "15m", 200),
    ]);

    // Basic sanity check on data
    const last = c15.at(-1);
    if (!last) {
      return res.status(200).json({
        text: `No Trade – no live data returned for ${instrument}.`,
        conviction: 0,
      });
    }
    const price = last.c;

    // 2) Build user context for the model (only last N bars to keep prompt compact)
    const ctx = {
      instrument,
      date: date ?? new Date().toISOString().slice(0, 10),
      current_price: price,
      candles: {
        "4h": sliceSafe(c4h, 20),
        "1h": sliceSafe(c1h, 20),
        "15m": sliceSafe(c15, 20),
      },
    };

    // 3) System rules to keep outputs realistic and anchored to live price
    const system = `
You are a professional trading assistant. Use ONLY the provided live candles and current price.
Rules:
- Anchor every level to current price exactly.
- Entry/SL/TP must be within ±2% of current price unless explicit strong structure requires slightly more; if so, explain.
- SL must sit beyond a logical swing/structure; TP at liquidity or prior S/R.
- If structure is unclear: respond "No Trade".
Return a concise trade card:
Type, Direction, Entry, Stop, TP1, TP2, Conviction %, Rationale (1–2 sentences).
`;

    // 4) Call OpenAI
    const rsp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(ctx) },
      ],
      temperature: 0.2,
    });

    const text = rsp.choices[0]?.message?.content?.trim() || "No response";

    // 5) Sanity filter: reject absurd numbers vs live price
    const numbers = [...text.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0])).filter((n) => !Number.isNaN(n));
    const band = price * 0.02; // ±2%
    const absurd = numbers.some((n) => Math.abs(n - price) > band * 3); // allow a little tolerance

    if (absurd) {
      return res.status(200).json({
        text: `No Trade – generated levels looked unrealistic vs live price ${price}.`,
        conviction: 0,
      });
    }

    return res.status(200).json({
      text,
      conviction: inferConviction(text) ?? 70,
    });
  } catch (err: any) {
    console.error("plan.ts error:", err?.message || err);
    return res.status(500).json({ error: err?.message || "server error" });
  }
}

// ---------- helpers ----------
function sliceSafe<T>(arr: T[], n: number): T[] {
  if (!Array.isArray(arr)) return [];
  return arr.slice(Math.max(0, arr.length - n));
}

function inferConviction(text: string): number | null {
  const m = text.match(/Conviction\s*%?\s*[:\-]?\s*(\d{1,3})/i);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isNaN(n) && n >= 0 && n <= 100) return n;
  return null;
}
