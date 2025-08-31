// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

function pickText(rr: any): string {
  if (typeof rr?.output_text === "string" && rr.output_text.trim()) return rr.output_text.trim();
  const out = rr?.output ?? [];
  for (const item of out) {
    const content = item?.content ?? item?.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === "string" && part.text.trim()) return part.text.trim();
        if (typeof part?.value === "string" && part.value.trim()) return part.value.trim();
        if (typeof part === "string" && part.trim()) return part.trim();
      }
    } else if (typeof content === "string" && content.trim()) {
      return content.trim();
    }
  }
  return "";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { instrument, date, calendar = [], headlines = [], candles = null, question = "" } =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const planContext = question; // you’re already enriching question upstream

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    const defaultModel = (process.env.OPENAI_MODEL || "gpt-4o").trim();
    const isGpt5 = defaultModel.toLowerCase().includes("gpt-5");

    let answer = "";
    if (isGpt5) {
      const rr = await client.responses.create({
        model: defaultModel,
        // simple text input; GPT-5 doesn’t need messages
        input:
          `You are TradePlan ChatDock. Answer *only* about this trade context.\n\n` +
          `Instrument: ${instrument || "(unknown)"} on ${date || ""}\n` +
          `Calendar items: ${Array.isArray(calendar) ? calendar.length : 0}\n` +
          `Headlines: ${Array.isArray(headlines) ? headlines.length : 0}\n\n` +
          `Q:\n${planContext}`,
        max_output_tokens: 600,
      });
      answer = pickText(rr);
    } else {
      const r = await client.chat.completions.create({
        model: defaultModel,
        messages: [
          { role: "system", content: "You are TradePlan ChatDock. Be concise and specific." },
          {
            role: "user",
            content:
              `Instrument: ${instrument || "(unknown)"} / Date: ${date || ""}\n` +
              `Calendar items: ${Array.isArray(calendar) ? calendar.length : 0}\n` +
              `Headlines: ${Array.isArray(headlines) ? headlines.length : 0}\n\n` +
              `Q:\n${planContext}`,
          },
        ],
        max_tokens: 600,
      });
      answer = r.choices?.[0]?.message?.content?.trim() || "";
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ answer: answer || "(no answer)" });
  } catch (err: any) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ error: err?.message || "chat failed" });
  }
}
