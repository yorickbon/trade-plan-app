// /pages/api/vision-plan.ts
// Vision-only planner (images). Numeric engine is intentionally NOT used.
// Accepts multipart form-data with files: m15, h1, h4 (required), calendar (optional)

import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs/promises";
import path from "path";

export const config = {
  api: { bodyParser: false },
};

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

type AnyObj = Record<string, any>;

// ---------- helpers ----------
function first<T>(v: T | T[] | undefined | null): T | undefined {
  if (!v) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

async function fileToDataUrl(f: any): Promise<string> {
  const p = f?.filepath || f?.filepath?.toString?.();
  const mimetype = f?.mimetype || "image/png";
  if (!p) throw new Error("Missing uploaded file path");
  const buf = await fs.readFile(p);
  const base64 = buf.toString("base64");
  return `data:${mimetype};base64,${base64}`;
}

function parseNum(x: any): number | undefined {
  const n = typeof x === "number" ? x : parseFloat(String(x ?? "").replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function coerceDirectionFromOrder(order: string | undefined): "Long" | "Short" | undefined {
  const o = (order || "").toLowerCase();
  if (o.includes("buy")) return "Long";
  if (o.includes("sell")) return "Short";
  return undefined;
}

function fixPendingSide(json: AnyObj): AnyObj {
  const cp = parseNum(json?.currentPrice);
  const order = String(json?.entryOrder || json?.order_type || "");
  const dirFromOrder = coerceDirectionFromOrder(order);
  if (dirFromOrder && json?.direction && json.direction !== dirFromOrder) {
    json.direction = dirFromOrder;
    json.note = (json.note ? json.note + " " : "") + "Direction coerced to match order type.";
  }
  if (!cp) return json;

  // Pull entry from either single number or zone
  const zmin = parseNum(json?.zone?.min);
  const zmax = parseNum(json?.zone?.max);
  const entry = parseNum(json?.entry) ?? (zmin && zmax ? (zmin + zmax) / 2 : undefined);

  const isLimitBuy  = order.toLowerCase().includes("buy limit");
  const isLimitSell = order.toLowerCase().includes("sell limit");

  // Never Buy-Limit above market; never Sell-Limit below market
  if (isLimitBuy && entry && entry > cp) {
    // Move to breakout path or shift zone below cp
    const adj = +(cp - Math.max(1, cp * 0.002)).toFixed(2);
    json.entry = adj;
    if (json.zone) json.zone.min = Math.min(json.zone.min ?? adj, adj);
    if (json.zone) json.zone.max = Math.min(json.zone.max ?? adj, adj);
    json.note = (json.note ? json.note + " " : "") +
      "Buy-Limit was above current price; shifted below current price.";
  }
  if (isLimitSell && entry && entry < cp) {
    const adj = +(cp + Math.max(1, cp * 0.002)).toFixed(2);
    json.entry = adj;
    if (json.zone) json.zone.min = Math.max(json.zone.min ?? adj, adj);
    if (json.zone) json.zone.max = Math.max(json.zone.max ?? adj, adj);
    json.note = (json.note ? json.note + " " : "") +
      "Sell-Limit was below current price; shifted above current price.";
  }

  // If “Flat” but an entry exists, set direction from order
  if ((json.direction === "Flat" || json.direction === "Stay Flat") &&
      (json.entry || json.zone) && dirFromOrder) {
    json.direction = dirFromOrder;
    json.note = (json.note ? json.note + " " : "") + "Flat + entry is invalid; direction set from order.";
  }
  return json;
}

// ---------- API ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });

    const form = formidable({ multiples: false });
    const { fields, files } = await new Promise<{ fields: formidable.Fields; files: formidable.Files }>(
      (resolve, reject) => form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })))
    );

    const f15  = first<any>((files as AnyObj)?.m15);
    const f1h  = first<any>((files as AnyObj)?.h1);
    const f4h  = first<any>((files as AnyObj)?.h4);
    const fcal = first<any>((files as AnyObj)?.calendar);

    if (!f15 || !f1h || !f4h) {
      return res.status(400).json({ ok: false, reason: "Upload m15, h1, h4 images (calendar optional)." });
    }

    const img15 = await fileToDataUrl(f15);
    const img1h = await fileToDataUrl(f1h);
    const img4h = await fileToDataUrl(f4h);
    const imgCal = fcal ? await fileToDataUrl(fcal) : undefined;

    const instrument = String(fields.instrument || fields.symbol || "").toUpperCase() || "BTCUSD";

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ----- Vision prompt (tighter breakout rules + tournament weighting) -----
    const sys = [
      "You are a professional trader building a plan from chart screenshots.",
      "ALWAYS run a tournament of candidates and pick ONE winner:",
      " 1) Pullback to 1H SUPPLY/DEMAND in 4H+1H trend direction (preferred).",
      " 2) Break + Retest (ONLY if BOTH hold: 1H body closes beyond the swing AND a 15m retest rejects).",
      " 3) SFP Reclaim.",
      " 4) FVG Fill.",
      " 5) Range Reversion.",
      "Scoring: if 4H and 1H are both bearish, LONG candidates are penalized hard (and vice-versa).",
      "Read the current price from the 15m chart axis.",
      "NEVER output a Sell-Limit below current price or a Buy-Limit above current price.",
      "If you can't place a valid limit, prefer Break+Retest or Market.",
      "Return strict JSON only (no prose) with fields:",
      "{",
      '  "instrument": "BTCUSD",',
      '  "direction": "Long|Short|Stay Flat",',
      '  "selectedStrategy": "name",',
      '  "entryType": "Pending|Market|None",',
      '  "entryOrder": "Buy Limit|Sell Limit|Buy Stop|Sell Stop|Market|None",',
      '  "currentPrice": number,',
      '  "zone": { "min": number, "max": number, "tf": "15m|1h|4h", "type": "Supply|Demand|SR|FVG|SFP|BreakRetest" } | null,',
      '  "entry": number | null,',
      '  "stop": number | null,',
      '  "tp1": number | null,',
      '  "tp2": number | null,',
      '  "conviction": number,',
      '  "reason": "one-liner",',
      '  "breakoutProof": { "bodyCloseBeyond": boolean, "retestHolds": boolean, "sfpReclaim": boolean },',
      '  "candidateScores": [{ "name": string, "score": number, "reason": string }],',
      '  "note": string | null',
      "}",
      "Rules:",
      "- Pending order direction must match order type (Buy=Long, Sell=Short).",
      "- Breakout requires BOTH confirmations; if missing, score it low.",
      "- If calendar shows no events, fundamentals are neutral; don't overrule HTF structure.",
    ].join("\n");

    const userText =
      `Instrument: ${instrument}\n` +
      `Images: 4H, 1H, 15M${imgCal ? ", calendar" : ""} provided. Build one actionable setup.\n` +
      `Prefer selling rips in a 4H/1H downtrend and buying dips in a 4H/1H uptrend.`;

    const content: any[] = [
      { type: "text", text: userText },
      { type: "image_url", image_url: { url: img4h } },
      { type: "image_url", image_url: { url: img1h } },
      { type: "image_url", image_url: { url: img15 } },
    ];
    if (imgCal) content.push({ type: "image_url", image_url: { url: imgCal } });

    const resp = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: sys },
        { role: "user", content },
      ],
    });

    const raw = resp.choices?.[0]?.message?.content?.trim() || "{}";
    let json: AnyObj;
    try {
      json = JSON.parse(raw);
    } catch {
      // Some models wrap JSON in ``` blocks—strip them
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      json = JSON.parse(cleaned);
    }

    // Server-side sanity guards (direction/order alignment, pending side correctness)
    json = fixPendingSide(json);

    // Build a friendly card text
    const dir = json.direction || "Stay Flat";
    const orderType = json.entryOrder || json.entryType || "None";
    const card =
      `### Quick Plan (Actionable): ${instrument}\n` +
      `- **Direction:** ${dir}\n` +
      (orderType && orderType !== "None" ? `- **Entry:** ${orderType}${json.zone?.min && json.zone?.max ? ` @ ${json.zone.min} – ${json.zone.max}` : (json.entry ? ` @ ${json.entry}` : "")}\n` : "") +
      (json.stop ? `- **Stop Loss:** ${json.stop}\n` : "") +
      (json.tp1 || json.tp2 ? `- **Take Profit(s):** ${json.tp1 ? `TP1: ${json.tp1}` : ""}${json.tp2 ? ` / TP2: ${json.tp2}` : ""}\n` : "") +
      (Number.isFinite(json.conviction) ? `- **Conviction:** ${Math.round(json.conviction)}%\n` : "") +
      `- **Setup:** ${json.selectedStrategy || "N/A"}\n` +
      `- **Short Reasoning:** ${json.reason || ""}\n`;

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text: card,
      meta: json,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}
