// /pages/api/vision-plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import formidable from "formidable";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

export const config = {
  api: { bodyParser: false },
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- helpers ----------
function synthesizeQuickPlan(aiMeta: any): string {
  if (!aiMeta) return "No plan could be generated.";
  const dir = aiMeta.direction || "Unknown";
  const entry = aiMeta.entry || "Pending @ …";
  const sl = aiMeta.stopLoss || "—";
  const tp1 = aiMeta.takeProfit1 || "—";
  const tp2 = aiMeta.takeProfit2 || "—";
  const conv = aiMeta.conviction ? `${aiMeta.conviction}%` : "—";
  const reason = aiMeta.shortReasoning || "Not provided.";

  let marketLine = "";
  if (aiMeta.bodyCloseBeyond && (aiMeta.retestHolds || aiMeta.sfpReclaim)) {
    marketLine = `• Entry Option 2: Market (Conviction ~${Math.max(
      0,
      (aiMeta.conviction || 0) - 5
    )}%)`;
  } else {
    marketLine = `• Market withheld: breakout proof missing (needs bodyCloseBeyond + retestHolds or sfpReclaim).`;
  }

  return [
    "## Quick Plan (Actionable)",
    `• Direction: ${dir}`,
    `• Entry Option 1: ${entry}`,
    marketLine,
    `• Stop Loss: ${sl}`,
    `• Take Profits: TP1 ${tp1} / TP2 ${tp2}`,
    `• Conviction: ${conv}`,
    `• Short Reasoning: ${reason}`,
  ].join("\n");
}

// Ensure numeric price sanity
function enforceZoneSanity(aiMeta: any) {
  if (!aiMeta || typeof aiMeta.currentPrice !== "number") return aiMeta;
  const p = aiMeta.currentPrice;
  if (aiMeta.direction?.toLowerCase().includes("buy")) {
    if (typeof aiMeta.entryPrice === "number" && aiMeta.entryPrice >= p) {
      aiMeta.entryPrice = p * 0.999; // nudge just below
    }
  } else if (aiMeta.direction?.toLowerCase().includes("sell")) {
    if (typeof aiMeta.entryPrice === "number" && aiMeta.entryPrice <= p) {
      aiMeta.entryPrice = p * 1.001; // nudge just above
    }
  }
  return aiMeta;
}

async function backfillCurrentPrice(file15mPath: string): Promise<number | null> {
  try {
    const rsp = await client.chat.completions.create({
      model: "gpt-5-2025-08-07",
      max_completion_tokens: 200,
      messages: [
        {
          role: "system",
          content:
            "You are a trading assistant. Look ONLY at the 15m chart image. Return the current numeric price visible on the chart as JSON: {\"price\": 1234.56}.",
        },
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: { url: "data:image/png;base64," + fs.readFileSync(file15mPath).toString("base64") },
            },
          ],
        },
      ],
      temperature: 0,
    });
    const txt = rsp.choices[0]?.message?.content?.trim() || "";
    const j = JSON.parse(txt.match(/\{[^}]+\}/)?.[0] || "{}");
    return typeof j.price === "number" ? j.price : null;
  } catch {
    return null;
  }
}

// ---------- main handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });

  const form = formidable({ multiples: true });
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ ok: false, reason: "Form parse failed" });

    try {
      const instr = String(fields.instrument || "EURUSD");
      const fileArray: formidable.File[] = []
        .concat(files?.images || [])
        .filter((f: any) => f && f.filepath);

      // Build OpenAI messages
      const messages: any[] = [
        {
          role: "system",
          content: `You are GPT-5 acting as a professional trading assistant. 
You must ALWAYS return a markdown trade plan with these sections:

## Quick Plan (Actionable)
- Direction, Entries (Pending + Market if proof exists), Stop Loss, TP1/TP2, Conviction %, Short Reasoning

## Full Breakdown
## Advanced Reasoning
## News Event Watch
## Notes
## Summary Table

Also return a fenced JSON block \`\`\`ai_meta { ... }\`\`\` at the end.

If model-only JSON is produced, that’s okay — the server will synthesize the readable card.`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Instrument: ${instr}. Generate full trade plan.` },
            ...fileArray.map((f) => ({
              type: "input_image",
              image_url: {
                url: "data:image/png;base64," + fs.readFileSync(f.filepath).toString("base64"),
              },
            })),
          ],
        },
      ];

      const rsp = await client.chat.completions.create({
        model: "gpt-5-2025-08-07",
        max_completion_tokens: 3000,
        messages,
      });

      let outTxt = rsp.choices[0]?.message?.content?.trim() || "";
      let aiMeta: any = null;

      // Extract ai_meta if present
      try {
        const metaMatch = outTxt.match(/```ai_meta([\s\S]+?)```/);
        if (metaMatch) {
          aiMeta = JSON.parse(metaMatch[1]);
        } else {
          // if entire output is JSON
          if (outTxt.startsWith("{")) aiMeta = JSON.parse(outTxt);
        }
      } catch {
        aiMeta = null;
      }

      // Backfill currentPrice if missing
      if (aiMeta && (aiMeta.currentPrice == null || isNaN(aiMeta.currentPrice))) {
        const f15 = fileArray.find((f) => f.originalFilename?.includes("15"));
        if (f15) {
          const price = await backfillCurrentPrice(f15.filepath);
          if (price) aiMeta.currentPrice = price;
        }
      }

      aiMeta = enforceZoneSanity(aiMeta);

      // Synthesize card if needed
      if (aiMeta && (!outTxt.includes("Quick Plan") || outTxt.startsWith("{"))) {
        const quick = synthesizeQuickPlan(aiMeta);
        outTxt = `${quick}\n\n---\n\n\`\`\`ai_meta\n${JSON.stringify(aiMeta, null, 2)}\n\`\`\``;
      }

      res.json({ ok: true, text: outTxt });
    } catch (e: any) {
      res.status(500).json({ ok: false, reason: e?.message || "vision-plan error" });
    }
  });
}
