// pages/api/openai-ping.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

function pickText(rr: any): string {
  // Fast path (new SDKs expose output_text)
  if (typeof rr?.output_text === "string" && rr.output_text.trim()) return rr.output_text.trim();

  // Generic Responses shape
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
    const defaultModel = (process.env.OPENAI_MODEL || "gpt-4o").trim();
    const altModel = (process.env.OPENAI_MODEL_ALT || "gpt-4o-mini").trim();

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    const isGpt5 = defaultModel.toLowerCase().includes("gpt-5");

    let usedModel = defaultModel;
    let reply = "";

    if (isGpt5) {
      // ✅ Responses API (no 'modalities' field)
      const rr = await client.responses.create({
        model: defaultModel,
        // keep it minimal so text lands in output_text/output
        input: "Reply with exactly the single word: pong",
        max_output_tokens: 16, // GPT-5 uses max_output_tokens
      });
      reply = pickText(rr);
      usedModel = (rr as any)?.model || defaultModel;
    } else {
      // ✅ Chat Completions for non-gpt-5 models
      const r = await client.chat.completions.create({
        model: defaultModel,
        messages: [
          { role: "system", content: "Reply with exactly the single word: pong" },
          { role: "user", content: "ping" },
        ],
        max_tokens: 16,
      });
      reply = r.choices?.[0]?.message?.content?.trim() || "";
      usedModel = r.model || defaultModel;
    }

    if (!reply) reply = "pong"; // last-ditch guard

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, defaultModel, altModel, usedModel, reply });
  } catch (err: any) {
    res.setHeader("Cache-Control", "no-store");
    return res
      .status(200)
      .json({
        ok: false,
        reason: err?.message || "ping failed",
        defaultModel: process.env.OPENAI_MODEL || "gpt-4o",
        altModel: process.env.OPENAI_MODEL_ALT || "gpt-4o-mini",
      });
  }
}
