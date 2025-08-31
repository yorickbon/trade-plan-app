// /pages/api/openai-ping.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const defaultModel = process.env.OPENAI_MODEL || "gpt-4o";
    const altModel = process.env.OPENAI_MODEL_ALT || "gpt-4o-mini";

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    // Do a 1-token no-op chat to see which model actually runs
    const r = await client.chat.completions.create({
      model: defaultModel,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      defaultModel,
      altModel,
      usedModel: r.model, // what OpenAI actually served
      id: r.id,
    });
  } catch (err: any) {
    return res.status(200).json({
      ok: false,
      reason: err?.message || "ping failed",
      defaultModel: process.env.OPENAI_MODEL || "gpt-4o",
      altModel: process.env.OPENAI_MODEL_ALT || "gpt-4o-mini",
    });
  }
}
