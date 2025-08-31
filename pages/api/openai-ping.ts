import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const defaultModel = (process.env.OPENAI_MODEL || "gpt-4o").trim();
    const altModel = (process.env.OPENAI_MODEL_ALT || "gpt-4o-mini").trim();
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    const isGpt5 = defaultModel.toLowerCase().includes("gpt-5");

    // We’ll return "pong" either way.
    let reply = "";
    let usedModel = defaultModel;

    if (isGpt5) {
      // ▶ GPT-5 path: use Responses API (no temperature override; use max_output_tokens)
      const rr = await client.responses.create({
        model: defaultModel,
        input: "Reply with exactly: pong",
        max_output_tokens: 16,
      });
      // Unified text accessor:
      // @ts-expect-error: output_text is available at runtime in openai v4+
      reply = rr.output_text ?? "";
      // @ts-expect-error: model can be present on the response
      usedModel = (rr as any).model || defaultModel;
    } else {
      // ▶ Non-GPT-5 path: use Chat Completions (classic)
      const r = await client.chat.completions.create({
        model: defaultModel,
        messages: [
          { role: "system", content: "Reply with exactly: pong" },
          { role: "user", content: "ping" },
        ],
        max_tokens: 16,
        // temperature omitted for broad compatibility
      });
      reply = r.choices?.[0]?.message?.content ?? "";
      usedModel = r.model || defaultModel;
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      defaultModel,
      altModel,
      usedModel,
      reply,
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
