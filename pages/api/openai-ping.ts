// pages/api/openai-ping.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";

function extractResponseText(rr: any): string {
  // Try SDK convenience field:
  if (rr && typeof rr.output_text === "string") return rr.output_text;

  // Fallback: walk the output array structure
  try {
    const out0 = rr?.output?.[0];
    const content = out0?.content ?? out0?.message?.content;

    if (Array.isArray(content)) {
      // Find a text-like item
      const textPart =
        content.find((c: any) => typeof c?.text === "string") ||
        content.find((c: any) => c?.type === "output_text" && typeof c?.text === "string") ||
        content.find((c: any) => typeof c?.value === "string");

      if (textPart?.text) return textPart.text;
      if (textPart?.value) return textPart.value;
    }

    if (typeof content === "string") return content;
  } catch {
    // ignore
  }
  return "";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const defaultModel = (process.env.OPENAI_MODEL || "gpt-4o").trim();
    const altModel = (process.env.OPENAI_MODEL_ALT || "gpt-4o-mini").trim();
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    const isGpt5 = defaultModel.toLowerCase().includes("gpt-5");

    let reply = "";
    let usedModel = defaultModel;

    if (isGpt5) {
      // ▶ GPT-5: Responses API (no temperature override; use max_output_tokens)
      const rr = await client.responses.create({
        model: defaultModel,
        input: "Reply with exactly: pong",
        max_output_tokens: 16,
      });
      reply = extractResponseText(rr) || "";
      usedModel = (rr as any)?.model || defaultModel;
    } else {
      // ▶ Other models: Chat Completions
      const r = await client.chat.completions.create({
        model: defaultModel,
        messages: [
          { role: "system", content: "Reply with exactly: pong" },
          { role: "user", content: "ping" },
        ],
        max_tokens: 16,
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
