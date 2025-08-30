// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ error: "Missing OPENAI_API_KEY" });

    const body = typeof req.body === "string" ? safeParse(req.body) : (req.body || {});
    const {
      instrument = "",
      date = "",
      calendar = [],
      headlines = [],
      candles = { h4: [], h1: [], m15: [] }, // may be empty for vision-only flow (that’s OK)
      question = "",
      planText = "",
    } = body;

    // Trim + cap sizes
    const data = {
      instrument: String(instrument || "").toUpperCase().slice(0, 20),
      date: String(date || "").slice(0, 20),
      calendar: Array.isArray(calendar) ? calendar.slice(0, 40) : [],
      headlines: Array.isArray(headlines) ? headlines.slice(0, 40) : [],
      candles: candles && typeof candles === "object"
        ? {
            h4: Array.isArray(candles.h4) ? candles.h4.slice(-120) : [],
            h1: Array.isArray(candles.h1) ? candles.h1.slice(-160) : [],
            m15: Array.isArray(candles.m15) ? candles.m15.slice(-160) : [],
          }
        : { h4: [], h1: [], m15: [] },
      planText: String(planText || "").slice(0, 12000),
      question: String(question || "").slice(0, 4000),
    };

    // ── Conversational but anchored system rules (images-only OK) ──
    const system = [
      "You are a trading copilot. Speak naturally and answer ANY question the user asks.",
      "Anchor responses to the provided Trade Plan text (planText). Do NOT change its numbers unless the user explicitly asks to recalc.",
      "If candles are missing, never invent OHLCV; rely on planText + headlines + calendar.",
      "Respect macro context. If a high-impact event is within ±90m, issue a short warning but still provide guidance (no blackout).",
      "If the user asks about BOS/CHOCH/OB/FVG/fibs/liquidity/ATR/stops/TP logic, explain clearly and practically.",
      "If the user asks a general question (not strictly about the plan), still answer openly, and relate back to the plan where relevant.",
      "Never refuse with 'No answer'. If something is unknown, say so briefly and suggest how to get it.",
    ].join(" ");

    // Build a compact user message
    const headlinesList = data.headlines
      .map((h: any) => `- ${String(h?.title || "").slice(0, 160)}${h?.source ? ` (${h.source})` : ""}`)
      .join("\n");

    const calList = data.calendar
      .map((e: any) => {
        const t = e?.time || e?.date || "";
        const imp = e?.impact || e?.importance || "";
        const cur = e?.currency || e?.country || "";
        return `- ${String(e?.title || "Event").slice(0, 120)} | ${cur} | ${imp} | ${t}`;
      })
      .join("\n");

    const user = [
      data.instrument ? `Instrument: ${data.instrument}` : "",
      data.date ? `Date: ${data.date}` : "",
      "",
      "Trade Plan (verbatim):",
      "```",
      data.planText || "(none provided)",
      "```",
      "",
      "Headlines:",
      headlinesList || "(none)",
      "",
      "Calendar:",
      calList || "(none)",
      "",
      "Candles provided? H4:",
      data.candles.h4.length ? "yes" : "no",
      ", H1:", data.candles.h1.length ? "yes" : "no",
      ", M15:", data.candles.m15.length ? "yes" : "no",
      "",
      "User question:",
      data.question,
      "",
      "Answer style:",
      "- Be direct, helpful, and conversational.",
      "- Use the plan’s structure/levels as the baseline; when giving explanations, tie back to the plan.",
      "- If the user asks 'what would raise conviction?', list concrete, observable confirmations.",
    ].filter(Boolean).join("\n");

    // Call OpenAI (chat.completions)
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
      // Return HTTP 200 with error text so the UI never sees 401/500 and can display a message
      return res.status(200).json({ answer: `I hit an upstream error (${rsp.status}). ${txt.slice(0, 300)}` });
    }

    const json = await rsp.json();
    const answer = json?.choices?.[0]?.message?.content ?? "I couldn’t generate a reply there.";

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ answer });
  } catch (err: any) {
    return res.status(200).json({ answer: `Local error: ${err?.message || "chat failed"}` });
  }
}

function safeParse(s: string) {
  try { return JSON.parse(s); } catch { return {}; }
}
