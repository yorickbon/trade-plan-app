// /pages/api/openai-ping.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const defaultModel = process.env.OPENAI_MODEL || "gpt-4o";
    const altModel = process.env.OPENAI_MODEL_ALT || "gpt-4o-mini";
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    // Small, deterministic ping that works with GPT-5 (uses max_completion_tokens)
    const r = await client.chat.completions.create({
      model: defaultModel,
      temperature: 0,
      max_completion_tokens: 32, // give GPT-5 enough space
      messages: [
        { role: "system", content: "Reply with just the word: pong" },
        { role: "user", content: "ping" },
      ],
    });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      defaultModel,
      altModel,
      usedModel: r.model,        // what OpenAI actually served
      id: r.id,
      reply: r.choices?.[0]?.message?.content ?? "",
    });
  } catch (err: any) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: false,
      reason: err?.message || "ping failed",
      defaultModel: process.env.OPENAI_MODEL || "gpt-4o",
      altModel: process.env.OPENAI_MODEL_ALT || "gpt-4o-mini",
    });
  }
}
