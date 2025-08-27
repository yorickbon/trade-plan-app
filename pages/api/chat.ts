// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ error: "Missing OPENAI_API_KEY" });

    const {
      instrument, // { code: 'EURUSD', currencies: ['EUR','USD'] }
      date,       // 'YYYY-MM-DD'
      calendar = [],      // [{date, time, country, currency, impact, title, ...}]
      headlines = [],     // [{title, url, source, seen, ...}]
      candles = null,     // { h4: Candle[], h1: Candle[], m15: Candle[] }
      question = "",      // user message
    } = req.body || {};

    const trimmed = {
      instrument,
      date,
      calendar: Array.isArray(calendar) ? calendar.slice(0, 40) : [],
      headlines: Array.isArray(headlines) ? headlines.slice(0, 40) : [],
      candles: candles ? {
        h4: Array.isArray(candles.h4) ? candles.h4.slice(-200) : [],
        h1: Array.isArray(candles.h1) ? candles.h1.slice(-200) : [],
        m15: Array.isArray(candles.m15) ? candles.m15.slice(-200) : [],
      } : { h4: [], h1: [], m15: [] },
      question: String(question || "").slice(0, 2000),
    };

    const system = [
      "You are a trading assistant who must NEVER guess.",
      "You have 4H/1H/15M OHLCV arrays (objects with at least t/o/h/l/c).",
      "Bias/confirmation rules: 15m = execution, 1h & 4h = confirmation.",
      "Identify BOS + retest, pullback to 0.62± (fib 61.8–70.5 zone), FVG/OB confluence.",
      "Prefer entries AWAY from current price unless a well-defined retest is occurring.",
      "Respect economic calendar and recent macro headlines; if high-impact in ±90m, recommend NO TRADE.",
      "Always return precise levels (entry, SL, TP1, TP2), invalidation, and timeframe alignment.",
      "If something is missing, explicitly say so rather than inventing.",
    ].join(" ");

    const user = `Context:
Instrument: ${JSON.stringify(trimmed.instrument)}
Date: ${trimmed.date}

Calendar (truncated): ${JSON.stringify(trimmed.calendar)}
Headlines (truncated): ${JSON.stringify(trimmed.headlines)}

Candles (last ~200 each, truncated):
H4: ${JSON.stringify(trimmed.candles.h4?.slice(-60) ?? [])}
H1: ${JSON.stringify(trimmed.candles.h1?.slice(-120) ?? [])}
M15: ${JSON.stringify(trimmed.candles.m15?.slice(-120) ?? [])}

Trader question: ${trimmed.question}`;

    const rsp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!rsp.ok) {
      const txt = await rsp.text().catch(() => "");
      throw new Error(`OpenAI chat failed: ${rsp.status} ${txt}`);
    }
    const json = await rsp.json();
    const answer = json.choices?.[0]?.message?.content ?? "(no answer)";

    // modest client-side caching hint
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ answer });
  } catch (err: any) {
    console.error("chat error", err);
    return res.status(500).json({ error: err?.message || "chat failed" });
  }
}
