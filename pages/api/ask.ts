// pages/api/ask.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { question, planText, headlines, calendar } =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (!question) return res.status(400).json({ error: "question required" });

    const system = `
You are a trading assistant. Answer strictly using the provided Trade Card, Headlines, and Calendar.
If something is unknown, say so. Be concise, tactical, and specific.`.trim();

    const context = {
      planText: planText || "",
      headlines: Array.isArray(headlines) ? headlines : [],
      calendar: Array.isArray(calendar) ? calendar : [],
    };

    const rsp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: "Context:\n" + JSON.stringify(context) },
        { role: "user", content: "Question: " + question },
      ],
    });

    const answer = rsp.choices[0]?.message?.content?.trim() || "No answer.";
    return res.status(200).json({ answer });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
