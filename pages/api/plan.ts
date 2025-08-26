// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

// ---------- helpers ----------
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const hasKey = !!process.env.OPENAI_API_KEY;

const safeStringify = (obj: unknown, max = 5000) => {
  try {
    const s = JSON.stringify(obj, null, 2);
    return s.length > max ? s.slice(0, max) + "…(truncated)" : s;
  } catch {
    return "[unserializable]";
  }
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// ---------- handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }
  if (!hasKey) {
    console.error("OPENAI_API_KEY missing");
    return res.status(500).json({ error: "Server not configured (missing OPENAI_API_KEY)" });
  }

  try {
    const { instrument, date, debug } = (req.body || {}) as {
      instrument?: string;
      date?: string;
      debug?: boolean;
    };

    if (!instrument || !date) {
      return res.status(400).json({ error: "instrument and date are required" });
    }

    // Minimal system — we’ll expand after candles are wired in
    const system = `
You are a strict trading assistant. 
Return a concise trade note based ONLY on intraday context (no fantasy levels). 
If you’re uncertain, say "No Trade".
Keep it short, 2–3 lines.
`;

    const user = {
      instrument,
      date,
      note: "Produce a brief trade idea or 'No Trade'.",
    };

    // --- LOG request going out ---
    console.log("[plan] request", { model: MODEL, instrument, date });

    const rsp = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
      temperature: 0.3,
    });

    const reply = rsp.choices?.[0]?.message?.content?.trim() || "No response";

    // --- LOG raw response (truncated) ---
    if (debug) {
      console.log("[plan] raw openai response", safeStringify(rsp, 8000));
    } else {
      console.log("[plan] reply", reply);
    }

    return res.status(200).json({
      instrument,
      date,
      model: MODEL,
      reply,
    });
  } catch (err: any) {
    // Full error into logs; tidy message to client
    console.error("[plan] ERROR", safeStringify(err, 8000));
    return res
      .status(500)
      .json({ error: err?.message || "Connection error." });
  }
}
