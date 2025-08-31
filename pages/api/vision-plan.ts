// /pages/api/vision-plan.ts
// Images-only planner (tournament style).
// Upload files: m15 (execution), h1 (context), h4 (HTF), optional calendar.
// Chooses the best trade idea by scoring multiple strategy candidates,
// then applies safety/consistency rewrites (no market without proof,
// no backwards limit orders, etc).

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";

// ----- Next API config (multipart uploads) -----
export const config = {
  api: { bodyParser: false, sizeLimit: "25mb" },
};

// ----- Types -----
type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

// ----- Env -----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-2025-08-07";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// ----- Helpers -----
async function getFormidable() {
  const mod: any = await import("formidable");
  return mod.default || mod;
}

function isMultipart(req: NextApiRequest) {
  return String(req.headers["content-type"] || "").includes("multipart/form-data");
}

async function parseMultipart(req: NextApiRequest): Promise<{ fields: Record<string, any>, files: Record<string, any> }> {
  const formidable = await getFormidable();
  const form = formidable({
    multiples: false,
    maxFieldsSize: 25 * 1024 * 1024,
  });
  return await new Promise((resolve, reject) => {
    form.parse(req, (err: any, fields: any, files: any) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

function pickFirst<T = any>(x: any): T | null {
  if (!x) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const path = file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!path) return null;
  const buf = await fs.readFile(path);
  const mime = file.mimetype || "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}

async function fetchHeadlines(req: NextApiRequest, instrument: string) {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(instrument)}&hours=48&max=12`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json();
    const items: any[] = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
    // Reduce to short lines "title — sentiment"
    return items.slice(0, 12).map((it: any) => {
      const s = typeof it?.sentiment?.score === "number" ? it.sentiment.score : null;
      const tag = s == null ? "neu" : s > 0.05 ? "pos" : s < -0.05 ? "neg" : "neu";
      return `${String(it?.title || "").slice(0, 200)} (${tag})`;
    });
  } catch {
    return [];
  }
}

function refusalLike(text: string) {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  return /(unable to assist|cannot assist|cannot help|can't help|refuse|not able to comply)/i.test(t);
}

// extract fenced JSON block ```json ... ```
function extractAiMeta(text: string) {
  if (!text) return null;
  const fences = [
    /```json\s*([\s\S]*?)```/i,
    /```ai_meta\s*([\s\S]*?)```/i,
  ];
  for (const re of fences) {
    const m = text.match(re);
    if (m && m[1]) {
      try {
        return JSON.parse(m[1]);
      } catch {}
    }
  }
  return null;
}

// Market only if BODY CLOSE + (RETEST HOLDS or SFP RECLAIM)
function aMetaDemandsPending(aiMeta: any): boolean {
  if (!aiMeta) return true;
  const entryType = String(aiMeta.entryType || "").toLowerCase();
  if (entryType !== "market") return false;
  const bp = aiMeta.breakoutProof || {};
  const ok = bp.bodyCloseBeyond === true && (bp.retestHolds === true || bp.sfpReclaim === true);
  return !ok;
}

// PRICE-SIDE sanity: Sell limit must be above current price, Buy limit below.
// Market requires breakout proof (checked above).
function invalidOrderRelativeToPrice(aiMeta: any): string | null {
  if (!aiMeta) return "missing ai_meta";

  const side = String(aiMeta.direction || "").toLowerCase();             // long | short
  const order = String(aiMeta.entryOrder || aiMeta.entryType || "").toLowerCase(); // buy/sell limit | market
  const p = Number(aiMeta.currentPrice);
  const zone = aiMeta.zone || {};
  const zmin = Number(zone.min);
  const zmax = Number(zone.max);

  if (!Number.isFinite(p)) return "missing current price";

  if (order.includes("market")) {
    const bp = aiMeta.breakoutProof || {};
    const ok = bp.bodyCloseBeyond === true && (bp.retestHolds === true || bp.sfpReclaim === true);
    return ok ? null : "market-without-proof";
  }

  if (!Number.isFinite(zmin) || !Number.isFinite(zmax) || zmin > zmax) return "invalid zone";
  const avg = (zmin + zmax) / 2;

  if (side === "short" || side === "sell") {
    if (!(avg > p)) return "sell-limit-below-price";
  } else if (side === "long" || side === "buy") {
    if (!(avg < p)) return "buy-limit-above-price";
  } else {
    return "unknown direction";
  }
  return null;
}

// ---------- OpenAI (GPT-5) ----------
async function callOpenAI(messages: any[]) {
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      max_completion_tokens: 1100, // GPT-5 uses max_completion_tokens
    }),
  });
  const json = await rsp.json().catch(() => ({} as any));
  if (!rsp.ok) throw new Error(json?.error?.message || `OpenAI error ${rsp.status}`);
  return String(json?.choices?.[0]?.message?.content ?? "");
}

// ---------- Prompt builders ----------
function tournamentMessages(opts: {
  instrument: string;
  datalist: { m15: string; h1: string; h4: string; calUrl?: string | null };
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
}) {
  const { instrument, datalist, headlinesText } = opts;

  const system =
`You are a professional discretionary price-action trader.
Use ONLY the uploaded chart images for technicals (m15 execution, 1H context, 4H HTF).
If a calendar image is provided, note relevant risks; otherwise infer from headlines.
Return a single, crisp trade plan in the exact format and include a final fenced JSON 'ai_meta'.`;

  const outputSpec =
`OUTPUT (exact order):
Quick Plan (Actionable)
- Direction: Long | Short | Stay Flat
- Entry: "Market" OR "Pending @ <min–max>" (use numeric zone when Pending)
- Stop Loss: (beyond which structure)
- Take Profit(s): TP1 | TP2
- Conviction: % (30–90)
- Setup: <Chosen Strategy>
- Short Reasoning: <1–2 lines>

Full Breakdown:
- Technical View (HTF + Intraday)
- Fundamental View (Calendar + Sentiment)
- Tech vs Fundy Alignment: Match | Mismatch (why)
- Conditional Scenarios (include opposite-side idea if relevant)
- Surprise Risk
- Invalidation
- One-liner Summary

News Event Watch:
- Items (if calendar/headlines provided)

Detected Structures (X-ray):
- 4H: OB/FVG/SR/range/trend/swing map …
- 1H: OB/FVG/SR/range/trend/swing map …
- 15m: OB/FVG/SR/range/trend/swing map …

Candidate Scores (tournament):
- List 3–5 named candidates with scores and 1-line reason.

Final Table Summary:
| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |

At the very end, append:
\`\`\`json
{
  "selectedStrategy": "<string>",
  "entryType": "Pending" | "Market",
  "entryOrder": "Sell Limit" | "Buy Limit" | "Sell Stop" | "Buy Stop" | "Market",
  "direction": "Long" | "Short" | "Flat",
  "currentPrice": number | null,
  "zone": { "min": number, "max": number, "tf": "15m" | "1H" | "4H", "type": "OB" | "FVG" | "SR" | "Other" },
  "stop": number | null,
  "tp1": number | null,
  "tp2": number | null,
  "breakoutProof": { "bodyCloseBeyond": boolean, "retestHolds": boolean, "sfpReclaim": boolean },
  "candidateScores": [{ "name": string, "score": number, "reason": string }],
  "note": "Why this candidate won"
}
\`\`\``;

  const content: any[] = [];
  content.push({ type: "text", text: system });
  content.push({ type: "text", text: `Instrument: ${instrument}` });

  // Attach images (order matters: m15, h1, h4)
  content.push({ type: "text", text: "M15 Chart:" });
  content.push({ type: "image_url", image_url: { url: datalist.m15 } });
  content.push({ type: "text", text: "1H Chart:" });
  content.push({ type: "image_url", image_url: { url: datalist.h1 } });
  content.push({ type: "text", text: "4H Chart:" });
  content.push({ type: "image_url", image_url: { url: datalist.h4 } });

  if (datalist.calUrl) {
    content.push({ type: "text", text: "Economic Calendar Image:" });
    content.push({ type: "image_url", image_url: { url: datalist.calUrl } });
  }

  if (headlinesText && headlinesText.trim().length) {
    content.push({ type: "text", text: `Recent headlines snapshot:\n${headlinesText}` });
  }

  content.push({ type: "text", text: outputSpec });

  return [
    { role: "system", content: "You return a single decisive card for one instrument." },
    { role: "user", content },
  ];
}

async function rewriteAsPending(instrument: string, originalText: string, aiMeta: any) {
  const messages = [
    {
      role: "system",
      content:
        "Rewrite the trade card as PENDING limit (OB/FVG/SR confluence). No Market unless proof exists. Keep tournament items and X-ray.",
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Instrument: ${instrument}` },
        { type: "text", text: "Original card:" },
        { type: "text", text: originalText },
        { type: "text", text: "If direction is Short, pending zone must be above current price. If Long, pending zone must be below current price." },
      ],
    },
  ];
  return await callOpenAI(messages);
}

async function normalizeSetupToPullbackIfNoBreakout(text: string) {
  const messages = [
    {
      role: "system",
      content:
        "If 'Breakout + Retest' is claimed but there is no explicit proof (body close beyond level AND retest holds OR SFP reclaim), rename setup to Pullback (OB/FVG confluence) and keep Pending Limit zone.",
    },
    { role: "user", content: [{ type: "text", text: text }] },
  ];
  return await callOpenAI(messages);
}

async function fixOrderVsPrice(instrument: string, originalText: string, aiMeta: any) {
  const reason = invalidOrderRelativeToPrice(aiMeta) || "fix-price-side";
  const guide =
`CASE: ${reason}
RULES:
• For SHORT: choose nearest valid 15m supply/SR above current and output a zone.
• For LONG: choose nearest valid 15m demand/SR below current and output a zone.
• Keep same direction, keep invalidations, preserve Candidate Scores & X-ray.
• Return full card in the same format with a corrected zone.`;

  const messages = [
    { role: "system", content: "Adjust entry zone to satisfy price-relation rules." },
    {
      role: "user",
      content: [
        { type: "text", text: guide },
        { type: "text", text: `Instrument: ${instrument}` },
        { type: "text", text: `Current card (fix zone only):\n\n${originalText}` },
      ],
    },
  ];
  return await callOpenAI(messages);
}

// ---------- Handler ----------
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Ok | Err>
) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });

  try {
    if (!isMultipart(req)) {
      return res.status(400).json({
        ok: false,
        reason: "Use multipart/form-data with files m15,h1,h4 (optional calendar) and field 'instrument'.",
      });
    }
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    const { fields, files } = await parseMultipart(req);
    const instrument = String(fields.instrument || "").toUpperCase().replace(/\s+/g, "") || "EURUSD";

    const fM15 = pickFirst(files.m15);
    const fH1  = pickFirst(files.h1);
    const fH4  = pickFirst(files.h4);
    const fCal = pickFirst(files.calendar);

    const [m15Url, h1Url, h4Url, calUrl] = await Promise.all([
      fileToDataUrl(fM15),
      fileToDataUrl(fH1),
      fileToDataUrl(fH4),
      fileToDataUrl(fCal),
    ]);

    if (!m15Url || !h1Url || !h4Url) {
      return res.status(400).json({
        ok: false,
        reason: "Upload all three charts: m15, h1, h4 (PNG/JPG).",
      });
    }

    const headlinesList = await fetchHeadlines(req, instrument);
    const headlinesText = headlinesList.length ? headlinesList.join("\n") : null;

    // 1) Tournament pass
    const tourText = await callOpenAI(
      tournamentMessages({
        instrument,
        datalist: { m15: m15Url, h1: h1Url, h4: h4Url, calUrl },
        headlinesText,
      })
    );

    let text = tourText;
    let aiMeta = extractAiMeta(text) || {};

    // 2) If Market without proof -> rewrite to Pending
    if (aMetaDemandsPending(aiMeta)) {
      text = await rewriteAsPending(instrument, text, aiMeta);
      aiMeta = extractAiMeta(text) || aiMeta;
    }

    // 3) If mislabeled Breakout+Retest without proof -> normalize to Pullback
    {
      const bp = aiMeta.breakoutProof || {};
      const ok = bp.bodyCloseBeyond === true && (bp.retestHolds === true || bp.sfpReclaim === true);
      const saysBreakout = /Breakout\s*\+\s*Retest/i.test(text);
      if (!ok && saysBreakout) {
        text = await normalizeSetupToPullbackIfNoBreakout(text);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // 4) Enforce order vs current price (Sell Limit above / Buy Limit below) & Market proof
    {
      const reason = invalidOrderRelativeToPrice(aiMeta);
      if (reason) {
        text = await fixOrderVsPrice(instrument, text, aiMeta);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // 5) Fallbacks
    if (!text || refusalLike(text)) {
      const fallback =
`Quick Plan (Actionable)
- Direction: Stay Flat (low conviction)
- Entry: Pending @ confluence (OB/FVG/SR) after a clean trigger
- Stop Loss: Beyond invalidation with small buffer
- Take Profit(s): Prior swing/liquidity, then trail
- Conviction: 30%
- Setup: Await valid trigger (images inconclusive)

Full Breakdown:
- Technical View: Indecisive; likely range.
- Fundamental View: Mixed; keep risk conservative.
- Tech vs Fundy Alignment: Mixed.
- Conditional Scenarios: Break & retest for continuation; SFP & reclaim for reversal.
- Surprise Risk: Headlines; CB speakers.
- Invalidation: Opposite-side body close beyond range edge.
- One-liner Summary: Stand by for a clean trigger.

Detected Structures (X-ray):
- 4H: —
- 1H: —
- 15m: —

Candidate Scores (tournament):
- — 

Final Table Summary:
| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |
| ${instrument} | Neutral | Wait for trigger | Structure-based | Prior swing | Next liquidity | 30% |

\`\`\`json
{
  "selectedStrategy": "Await valid trigger",
  "entryType": "Pending",
  "entryOrder": "Pending",
  "direction": "Flat",
  "currentPrice": null,
  "zone": null,
  "stop": null,
  "tp1": null,
  "tp2": null,
  "breakoutProof": { "bodyCloseBeyond": false, "retestHolds": false, "sfpReclaim": false },
  "candidateScores": [],
  "note": "Fallback used due to refusal/empty output."
}
\`\`\``;

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        text: fallback,
        meta: {
          instrument,
          hasCalendar: !!calUrl,
          headlinesCount: headlinesList.length,
          rewritten: false,
          fallbackUsed: true,
          aiMeta: extractAiMeta(fallback),
        },
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text,
      meta: {
        instrument,
        hasCalendar: !!calUrl,
        headlinesCount: headlinesList.length,
        rewritten: true,
        fallbackUsed: false,
        aiMeta,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}
