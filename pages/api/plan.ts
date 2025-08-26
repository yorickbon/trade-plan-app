// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

// If you don't have tsconfig path aliases, change the next line to:
// import { getCandles } from "../../lib/prices";
import { getCandles } from "@/lib/prices";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

type PlanInput = { instrument: string; date: string };
type PlanOutput = { text: string; conviction: number };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "GET") {
      // /api/plan?instrument=EURUSD&date=2025-08-26
      const instrument = (req.query.instrument as string) || "EURUSD";
      const date =
        (req.query.date as string) || new Date().toISOString().slice(0, 10);
      const plan = await buildPlan({ instrument, date });
      return res.status(200).json(plan);
    }

    if (req.method === "POST") {
      const { instrument, date } = (req.body || {}) as Partial<PlanInput>;
      if (!instrument) return res.status(400).json({ error: "Missing instrument" });
      const safeDate = date || new Date().toISOString().slice(0, 10);
      const plan = await buildPlan({ instrument, date: safeDate });
      return res.status(200).json(plan);
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (e: any) {
    console.error("plan route error:", e?.message || e);
    return res.status(500).json({ error: e?.message || "server error" });
  }
}

async function buildPlan({ instrument, date }: PlanInput): Promise<PlanOutput> {
  // 1) fetch live candles (Twelve Data via lib/prices)
  const [c4h, c1h, c15] = await Promise.all([
    getCandles(instrument, "4h", 200),
    getCandles(instrument, "1h", 200),
    getCandles(instrument, "15m", 200),
  ]);

  // Guard: if any TF is empty, return a safe "No Trade"
  if (c15.length === 0) {
    return {
      text:
        `No Trade – live price data missing for ${instrument}. ` +
        `Check TWELVEDATA_API_KEY and symbol mapping.`,
      conviction: 0,
    };
  }

  const price = c15.at(-1)!.c;

  // 2) context for GPT
  const user = {
    instrument,
    date,
    current_price: price,
    candles: {
      "4h": c4h.slice(-20),
      "1h": c1h.slice(-20),
      "15m": c15.slice(-20),
    },
  };

  // 3) rules
  const system = `
You are a strict trading assistant. You MUST base every level on the live data provided.
Rules:
- Use the current price exactly as an anchor.
- All levels (Entry/SL/TP) must stay within ±2% of current price.
- SL must be placed beyond a recent swing or logical structure level.
- TPs must align with structure/liquidity (recent swing high/low, clear levels).
- If data is unclear, return "No Trade".
Return a compact trade card with:
Type (breakout/pullback/etc), Direction, Entry, Stop, TP1, TP2, Conviction %, and a 1–2 sentence rationale.
  `.trim();

  // 4) call OpenAI
  const rsp = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-5-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) },
    ],
    temperature: 0.2,
  });

  const text = rsp.choices[0]?.message?.content ?? "No response";

  // 5) sanity filter: reject absurd levels
  const nums = [...text.matchAll(/(\d+\.\d+)/g)].map((m) => Number(m[1]));
  const limit = price * 0.02; // ±2%
  const bad = nums.some((n) => Math.abs(n - price) > limit);

  if (bad) {
    return {
      text: `No Trade – generated levels were unrealistic vs live price (${price}).`,
      conviction: 0,
    };
  }

  // 6) done
  return { text, conviction: 70 };
}
