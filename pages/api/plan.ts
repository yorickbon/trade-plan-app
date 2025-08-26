// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { instrument, date } = req.body;

    if (!instrument || !date) {
      return res.status(400).json({ error: "Missing instrument or date" });
    }

    // Basic test prompt
    const rsp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a trading assistant. Reply briefly.",
        },
        {
          role: "user",
          content: `Generate a quick trade note for ${instrument} on ${date}`,
        },
      ],
    });

    const reply = rsp.choices[0]?.message?.content || "No response";

    res.status(200).json({ instrument, date, reply });
  } catch (err: any) {
    console.error("Plan API Error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}
