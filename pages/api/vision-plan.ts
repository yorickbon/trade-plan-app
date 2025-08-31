// /pages/api/vision-plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import formidable from "formidable";
import fs from "fs";
import OpenAI from "openai";

export const config = {
  api: { bodyParser: false },
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- helpers ----------
function synthesizeQuickPlan(aiMeta: any): string {
  if (!aiMeta) return "No plan could be generated.";

  const dir =
    aiMeta.direction ||
    aiMeta.bias ||
    "Unknown";

  const entryVal =
    aiMeta.entry ||
    aiMeta.pendingEntry ||
    aiMeta.entryPrice ||
    aiMeta.limitEntry ||
    "Pending @ …";

  const sl =
    aiMeta.stopLoss ||
    aiMeta.sl ||
    aiMeta.stop ||
    "—";

  const tp1 =
    aiMeta.takeProfit1 ||
    aiMeta.tp1 ||
    "—";

  const tp2 =
    aiMeta.takeProfit2 ||
    aiMeta.tp2 ||
    "—";

  const conv =
    typeof aiMeta.conviction === "number"
      ? `${aiMeta.conviction}%`
      : (typeof aiMeta.convictionPct === "number" ? `${aiMeta.convictionPct}%` : "—");

  const reason =
    aiMeta.shortReasoning ||
    aiMeta.reason ||
    aiMeta.summary ||
    "Not provided.";

  // Option 2 (Market) rule:
  // bodyCloseBeyond === true AND (retestHolds === true OR sfpReclaim === true)
  let marketLine = "";
  if (aiMeta?.bodyCloseBeyond && (aiMeta?.retestHolds || aiMeta?.sfpReclaim)) {
    const baseConv = typeof aiMeta.conviction === "number" ? aiMeta.conviction :
                     (typeof aiMeta.convictionPct === "number" ? aiMeta.convictionPct : 0);
    marketLine = `• Entry Option 2: Market (Conviction ~${Math.max(0, Math.round(baseConv - 5))}%)`;
  } else {
    marketLine = `• Market withheld: breakout proof missing (needs bodyCloseBeyond + retestHolds or sfpReclaim).`;
  }

  return [
    "## Quick Plan (Actionable)",
    `• Direction: ${dir}`,
    `• Entry Option 1: ${entryVal}`,
    marketLine,
    `• Stop Loss: ${sl}`,
    `• Take Profits: TP1 ${tp1} / TP2 ${tp2}`,
    `• Conviction: ${conv}`,
    `• Short Reasoning: ${reason}`,
  ].join("\n");
}

/** Keep Buy Limit below price / Sell Limit above price; nudge entry only */
function enforceZoneSanity(aiMeta: any) {
  if (!aiMeta || typeof aiMeta.currentPrice !== "number") return aiMeta;
  const p = aiMeta.currentPrice;

  // normalize potential entry keys to aiMeta.entryPrice (but do NOT overwrite original data except for sanity nudging)
  const entryKey =
    "entryPrice" in aiMeta ? "entryPrice" :
    "limitEntry" in aiMeta ? "limitEntry" :
    "pendingEntry" in aiMeta ? "pendingEntry" :
    "entry" in aiMeta ? "entry" : "entryPrice";

  const v = Number(aiMeta[entryKey]);
  if (!Number.isFinite(v)) return aiMeta;

  const dir = String(aiMeta.direction || aiMeta.bias || "").toLowerCase();
  if (dir.includes("buy")) {
    if (v >= p) aiMeta[entryKey] = Number((p * 0.999).toFixed(5)); // nudge just below
  } else if (dir.includes("sell")) {
    if (v <= p) aiMeta[entryKey] = Number((p * 1.001).toFixed(5)); // nudge just above
  }
  return aiMeta;
}

/** Try to parse a fenced ```ai_meta ... ``` block or raw JSON */
function extractAiMeta(text: string): any | null {
  if (!text) return null;

  // fenced block: ```ai_meta\n{...}\n```
  const m = /```ai_meta[\r\n]+([\s\S]*?)```/i.exec(text);
  if (m && m[1]) {
    const raw = m[1].trim();
    try {
      return JSON.parse(raw);
    } catch {
      // try to salvage the first {...}
      const brace = /\{[\s\S]*\}/.exec(raw);
      if (brace) {
        try { return JSON.parse(brace[0]); } catch {}
      }
    }
  }

  // plain JSON
  if (text.trim().startsWith("{")) {
    try { return JSON.parse(text.trim()); } catch {}
  }
  return null;
}

/** Tiny 15m-only backfill to get current numeric price from the chart image */
async function backfillCurrentPrice(file15mPath: string): Promise<number | null> {
  try {
    const rsp = await client.chat.completions.create({
      model: "gpt-5-2025-08-07",
      max_completion_tokens: 200,
      messages: [
        {
          role: "system",
          content:
            'You are a trading assistant. Look ONLY at the 15m chart image. Return JSON like {"price": 1234.56}. Nothing else.',
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url:
                  "data:image/png;base64," +
                  fs.readFileSync(file15mPath).toString("base64"),
              },
            },
          ],
        },
      ],
      // (no temperature per requirements)
    });

    const txt = rsp.choices?.[0]?.message?.content?.trim() || "";
    const brace = /\{[\s\S]*\}/.exec(txt);
    if (!brace) return null;
    const j = JSON.parse(brace[0]);
    return typeof j.price === "number" ? j.price : null;
  } catch {
    return null;
  }
}

// ---------- main handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, reason: "Method not allowed" });
  }

  const form = formidable({ multiples: true });

  // NOTE: use loose 'any' for formidable typings to avoid version mismatch issues in build
  form.parse(req, async (err: Error | null, fields: any, files: any) => {
    if (err) return res.status(500).json({ ok: false, reason: "Form parse failed" });

    try {
      const instr = String(fields.instrument || "EURUSD");

      // files.images may be a single file or an array
      const raw = (files && (files.images as any)) || [];
      const fileArray: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

      // Build OpenAI messages (single holistic call; tightened prompt, same sections)
      const messages: any[] = [
        {
          role: "system",
          content: `You are GPT-5 acting as a professional trading assistant.

ALWAYS output a full markdown trade plan with these exact sections:

## Quick Plan (Actionable)
- Direction, Entries (Pending + Market if proof exists), Stop Loss, TP1/TP2, Conviction %, Short Reasoning

## Full Breakdown
## Advanced Reasoning
## News Event Watch
## Notes
## Summary Table

Also append a fenced JSON block at the end like:
\`\`\`ai_meta
{ ... }
\`\`\`

If you only return JSON, the server will synthesize the readable card. Keep responses concise and actionable.`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Instrument: ${instr}. Generate a complete plan from these images.` },
            ...fileArray.map((f) => ({
              type: "image_url",
              image_url: {
                url:
                  "data:image/png;base64," +
                  fs.readFileSync(f.filepath).toString("base64"),
              },
            })),
          ],
        },
      ];

      const rsp = await client.chat.completions.create({
        model: "gpt-5-2025-08-07",
        max_completion_tokens: 3000,
        messages,
        // (no temperature per requirements)
      });

      let outTxt = rsp.choices?.[0]?.message?.content?.trim() || "";
      let aiMeta = extractAiMeta(outTxt);

      // Backfill currentPrice if missing and we have a 15m file
      if (aiMeta && (aiMeta.currentPrice == null || isNaN(Number(aiMeta.currentPrice)))) {
        const f15 = fileArray.find((f) =>
          String(f.originalFilename || f.newFilename || f.filepath || "")
            .toLowerCase()
            .includes("15")
        );
        if (f15) {
          const price = await backfillCurrentPrice(f15.filepath);
          if (typeof price === "number" && Number.isFinite(price)) {
            aiMeta.currentPrice = price;
          }
        }
      }

      // Enforce Buy/Sell limit sanity by nudging entry only
      aiMeta = enforceZoneSanity(aiMeta);

      // Synthesize readable card if model returned JSON-only or missed the Quick Plan section
      const hasQuickPlan = /##\s*Quick Plan/i.test(outTxt);
      if (aiMeta && (!hasQuickPlan || outTxt.trim().startsWith("{"))) {
        const quick = synthesizeQuickPlan(aiMeta);
        outTxt = `${quick}\n\n---\n\n\`\`\`ai_meta\n${JSON.stringify(aiMeta, null, 2)}\n\`\`\``;
      }

      return res.json({ ok: true, text: outTxt });
    } catch (e: any) {
      return res.status(500).json({ ok: false, reason: e?.message || "vision-plan error" });
    }
  });
}
