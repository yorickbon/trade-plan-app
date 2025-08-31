import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const defaultModel = (process.env.OPENAI_MODEL || "gpt-4o").trim();
    const altModel = (process.env.OPENAI_MODEL_ALT || "gpt-4o-mini").trim();

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    const messages = [
      { role: "system", content: "Reply with exactly: pong" },
      { role: "user", content: "ping" },
    ];

    // Build payload compatible with both model families
    const payload: Record<string, any> = { model: defaultModel, messages };

    // GPT-5 requires max_completion_tokens and does not accept temperature overrides
    if (defaultModel.toLowerCase().includes("gpt-5")) {
      payload.max_completion_tokens = 16;
    } else {
      // Non–GPT-5 models (e.g., gpt-4o) use max_tokens; temperature is OK
      payload.max_tokens = 16;
      // you can omit temperature entirely; leaving it out for simplicity/compat
    }

    const r = await client.chat.completions.create(payload);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      defaultModel,
      altModel,
      usedModel: r.model, // what OpenAI actually served
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
