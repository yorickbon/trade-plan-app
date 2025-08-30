// /pages/api/ask.ts
import type { NextApiRequest, NextApiResponse } from "next";

function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}

function parseBody(req: NextApiRequest) {
  try {
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    return req.body || {};
  } catch {
    return {};
  }
}

// Try to capture symbols like "EURUSD", "XAU/USD", "BTCUSD" from the card text
function extractInstrument(planText?: string): string | undefined {
  if (!planText) return undefined;
  const m =
    planText.match(/Symbol:\s*([A-Z0-9/.\-]+)/i) ||
    planText.match(/\b(?:Instrument|Pair)\s*[:=]\s*([A-Z0-9/.\-]{6,12})/i);
  const raw = m?.[1]?.toUpperCase().replace(/\s+/g, "");
  if (!raw) return undefined;
  return raw.includes("/") ? raw.replace("/", "") : raw;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { question = "", planText = "", headlines = [], calendar = [] } = parseBody(req);
    const instrument = extractInstrument(planText);

    // We include the rendered plan text as context so the model answers
    // specifically about *this* setup without changing any numbers.
    const enrichedQuestion = [
      "We are discussing this trade plan text (do NOT change its numbers; use it only as context):",
      planText ? String(planText).slice(0, 6000) : "(no plan text provided)",
      "",
      "User question:",
      String(question).slice(0, 2000),
    ].join("\n");

    const payload = {
      instrument,
      date: new Date().toISOString().slice(0, 10),
      calendar: Array.isArray(calendar) ? calendar.slice(0, 40) : [],
      headlines: Array.isArray(headlines) ? headlines.slice(0, 40) : [],
      candles: null,                 // ChatDock Q&A does not use numeric candles
      question: enrichedQuestion,
    };

    const base = originFromReq(req);
    const rsp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await rsp.json().catch(() => ({} as any));
    if (!rsp.ok) {
      return res.status(500).json({ error: json?.error || `Proxy failed (${rsp.status})` });
    }
    // Pass through the LLM’s answer for the dock
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ answer: json?.answer || "(no answer)" });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "ask failed" });
  }
}
