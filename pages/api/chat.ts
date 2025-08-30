// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ error: "Missing OPENAI_API_KEY" });

    const {
      instrument,            // e.g. 'EURUSD'
      date,                  // 'YYYY-MM-DD'
      calendar = [],         // [{date,time,country,currency,impact,title,...}]
      headlines = [],        // [{title,url,source,...}]
      candles = null,        // { h4: Candle[], h1: Candle[], m15: Candle[] } | null
      question = "",         // user message
      planText = "",         // <<< the generated trade plan text (vision or numeric)
    } = (typeof req.body === "string" ? safeParse(req.body) : req.body) || {};

    // Trim inputs (avoid token bloat + keep latency low)
    const trimmed = {
      instrument: String(instrument || "").toUpperCase().slice(0, 20),
      date: String(date || "").slice(0, 20),
      calendar: Array.isArray(calendar) ? calendar.slice(0, 40) : [],
      headlines: Array.isArray(headlines) ? headlines.slice(0, 40) : [],
      candles: candles
        ? {
            h4: Array.isArray(candles.h4) ? candles.h4.slice(-120) : [],
            h1: Array.isArray(candles.h1) ? candles.h1.slice(-160) : [],
            m15: Array.isArray(candles.m15) ? candles.m15.slice(-160) : [],
          }
        : { h4: [], h1: [], m15: [] },
      planText: String(planText || "").slice(0, 8000),
      question: String(question || "").slice(0, 2000),
    };

    // --- System rules ---
    // Note: WARNING-ONLY for ±90m events; never force "NO TRADE".
    const system = [
      "You are a trading assistant who must NEVER guess.",
      "You are given a Trade Plan text (\"planText\"). Treat it as the baseline truth for levels and logic.",
      "Do NOT change the plan's numbers (entry, SL, TP1, TP2) unless the user explicitly asks for an update.",
      "If candles are missing or empty, rely on planText + headlines + calendar (do NOT invent OHLCV).",
      "Bias/confirmation rules: 15m = execution, 1h & 4h = confirmation (only if candles provided).",
      "Identify BOS + retest, pullback to 0.62± (fib 61.8–70.5), and FVG/OB confluence when applicable.",
      "Prefer entries AWAY from current price unless a well-defined retest is occurring.",
      "Respect economic calendar and recent macro headlines; if high-impact is within ±90m, ISSUE A WARNING but STILL provide guidance.",
      "Always give precise, practical explanations tied to the given planText and the user's question.",
      "If something is missing, say so explicitly rather than inventing.",
    ].join(" ");

    // --- Build a compact user prompt ---
    const headlinesList = trimmed.headlines
      .map((h: any) =>
        `- ${String(h?.title || "").slice(0, 160)}${h?.source ? ` (${h.source})` : ""}`
      )
      .slice(0, 12)
      .join("\n");

    const calList = trimmed.calendar
      .map((e: any) => {
        const t = e?.time || e?.date || "";
        const imp = e?.impact || e?.importance || "";
        const cur = e?.currency || e?.country || "";
        return `- ${String(e?.title || "Event").slice(0, 120)} | ${cur} | ${imp} | ${t}`;
      })
      .slice(0, 20)
      .join("\n");

    const user = [
      `Instrument: ${JSON.stringify(trimmed.instrument)}`,
      trimmed.date ? `Date: ${trimmed.date}` : "",
      "",
      "Trade Plan (planText):",
      "```",
      trimmed.planText || "(none provided)",
      "```",
      "",
      "Headlines (truncated):",
      headlinesList || "(none)",
      "",
      "Calendar (truncated):",
      calList || "(none)",
      "",
      "Candles provided? ",
      `H4: ${Array.isArray(trimmed.candles.h4) && trimmed.candles.h4.length ? "yes" : "no"},`,
      ` H1: ${Array.isArray(trimmed.candles.h1) && trimmed.candles.h1.length ? "yes" : "no"},`,
      ` M15: ${Array.isArray(trimmed.candles.m15) && trimmed.candles.m15.length ? "yes" : "no"}.`,
      "",
      "User question:",
      trimmed.question,
      "",
      "Answer requirements:",
      "- Ground your answer in the planText. Explain the why behind its levels and logic.",
      "- If asked about conviction or news impact, use the headlines/calendar above to justify.",
      "- If asked to modify levels, first state that you will keep the original numbers unless explicitly authorized to recalc; if the user confirms, outline how you'd update them.",
    ].filter(Boolean).join("\n");

    const rsp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
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
    const answer = json?.choices?.[0]?.message?.content ?? "No answer.";

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ answer });
  } catch (err: any) {
    console.error("chat error", err);
    return res.status(500).json({ error: err?.message || "chat failed" });
  }
}

function safeParse(s: string) {
  try { return JSON.parse(s); } catch { return {}; }
}
