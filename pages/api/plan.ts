// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { getCandles } from "@/lib/prices"; // <-- keep this path

// Helper to safely read envs
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  let stage = "start";
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const { instrument, date, debug } = (req.body || {}) as {
      instrument?: string; date?: string; debug?: boolean;
    };
    if (!instrument) return res.status(400).json({ error: "Missing instrument" });

    stage = "fetch-candles";
    const [c4h, c1h, c15] = await Promise.all([
      getCandles(instrument, "4h", 200),
      getCandles(instrument, "1h", 200),
      getCandles(instrument, "15m", 200),
    ]);

    const last = c15.at(-1);
    if (!last) {
      return res.status(200).json({ stage, note: "No candles returned", instrument, c15len: c15.length });
    }

    const price = last.c;

    // If debug flag is true, stop here to confirm TwelveData works end-to-end
    if (debug) {
      return res.status(200).json({
        stage,
        ok: true,
        instrument,
        price,
        lens: { h4: c4h.length, h1: c1h.length, m15: c15.length },
        sample: { last15m: last }
      });
    }

    // ---------- OpenAI step ----------
    stage = "openai-init";
    if (!OPENAI_KEY) {
      return res.status(200).json({ stage, error: "Missing OPENAI_API_KEY", note: "Set it in Vercel env & redeploy." });
    }
    const client = new OpenAI({ apiKey: OPENAI_KEY });

    const system = `
You are a trading assistant. Use the live data provided.
- Anchor levels around current price within ±2%.
- SL beyond a recent swing; TP at logical structure.
- If unclear, output "No Trade".
Return: Type, Direction, Entry, Stop, TP1, TP2, Conviction %, brief rationale.
    `;

    const user = {
      instrument, date,
      current_price: price,
      candles: {
        "4h": c4h.slice(-20),
        "1h": c1h.slice(-20),
        "15m": c15.slice(-20),
      },
    };

    stage = "openai-call";
    const rsp = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
      temperature: 0.2,
    });

    stage = "openai-parse";
    const text = rsp.choices[0]?.message?.content ?? "No response";

    // sanity check: keep levels near price
    const nums = [...text.matchAll(/(\d+\.\d+)/g)].map(m => Number(m[1]));
    const limit = price * 0.02;
    const bad = nums.some(n => Math.abs(n - price) > limit);
    if (bad) {
      return res.status(200).json({
        stage,
        text: `No Trade – generated levels were unrealistic vs live price (${price}).`,
        conviction: 0,
      });
    }

    return res.status(200).json({ stage: "done", text, conviction: 70, price });

  } catch (e: any) {
    // Surface the real error so we can fix fast
    const msg = e?.message || String(e);
    return res.status(500).json({ error: msg, stage });
  }
}
