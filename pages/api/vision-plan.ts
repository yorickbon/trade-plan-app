// /pages/api/vision-plan.ts
//
// Images-only planner (m15 execution, h1 context, h4 HTF; optional calendar).
// Produces a tournament-scored trade card. If breakout proof exists,
// prints BOTH: Option 1 (Pending Limit) AND Option 2 (Market).
//
// Env: OPENAI_API_KEY (required), OPENAI_MODEL (default "gpt-5"),
//      OPENAI_API_BASE (default https://api.openai.com/v1)
import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";

export const config = { api: { bodyParser: false, sizeLimit: "25mb" } };

type Ok = { ok: true; text: string; meta: any };
type Err = { ok: false; reason: string };

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// ---------- multipart helpers ----------
async function getFormidable() {
  const mod = await import("formidable");
  return mod.default || mod;
}
function isMultipart(req: NextApiRequest) {
  const ct = String(req.headers["content-type"] || "");
  return ct.includes("multipart/form-data");
}
async function parseMultipart(req: NextApiRequest) {
  const formidable = await getFormidable();
  const form = formidable({
    multiples: false,
    maxFiles: 4,
    maxFileSize: 25 * 1024 * 1024,
    allowEmptyFiles: false,
  });
  return new Promise<{ fields: Record<string, any>; files: Record<string, any> }>(
    (resolve, reject) => {
      form.parse(req, (err: any, fields: any, files: any) => {
        if (err) return reject(err);
        resolve({ fields, files });
      });
    }
  );
}
function pickFirst(v: any) { return Array.isArray(v) ? v[0] ?? null : v ?? null; }
async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p = file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;
  const buf = await fs.readFile(p);
  const mime = file.mimetype || "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}

// ---------- news snapshot (optional) ----------
async function fetchHeadlinesText(req: NextApiRequest, instrument: string) {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(instrument)}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    return items.slice(0, 12)
      .map((x: any) => `• ${String(x?.title || "").slice(0, 140)} — ${String(x?.sentiment || "neutral")}`)
      .join("\n");
  } catch { return null; }
}

// ---------- openai ----------
function modelWantsTempOne(model: string) { return /^gpt-5/i.test(model); }
async function callOpenAI(messages: any[], maxTokens = 1200) {
  const payload: any = { model: OPENAI_MODEL, messages };
  if (modelWantsTempOne(OPENAI_MODEL)) payload.max_completion_tokens = maxTokens;
  else { payload.temperature = 0.2; payload.max_tokens = maxTokens; }
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload),
  });
  const txt = await rsp.text();
  if (!rsp.ok) throw new Error(`OpenAI failed ${rsp.status}: ${txt}`);
  const json = JSON.parse(txt);
  return String(json.choices?.[0]?.message?.content ?? "").trim();
}

// ---------- parsing / proof ----------
function extractAiMeta(text: string): any | null {
  const re = /```json\s*ai_meta\s*([\s\S]*?)```/i;
  const m = re.exec(text || "");
  if (m?.[1]) { try { return JSON.parse(m[1]); } catch {} }
  return null;
}
function hasMarketProof(aiMeta: any): boolean {
  const bp = aiMeta?.breakoutProof || {};
  return !!(bp?.bodyCloseBeyond && (bp?.retestHolds || bp?.sfpReclaim));
}
function looksLikePlan(t: string) {
  return /Quick Plan \(Actionable\)/i.test(t) || /Option 1 — Pending Limit/i.test(t);
}

// ---------- prompts ----------
function outputContract() {
  return `
OUTPUT (exact order):
"Quick Plan (Actionable)"

If breakout proof present, print BOTH options:

Option 1 — Pending Limit
• Direction: Long | Short
• Entry: Pending @ <zone min – zone max>
• Stop Loss: <price or logic>
• Take Profit(s): TP1 <price> / TP2 <price>
• Conviction: <percent>
• Setup: <chosen strategy>
• Short Reasoning: <1–2 lines>

Option 2 — Market Order
• Direction: Long | Short
• Entry: Market (only if body close confirmed + retest holds / SFP reclaim)
• Stop Loss: <price or logic>
• Take Profit(s): TP1 <price> / TP2 <price>
• Conviction: <percent lower than option 1>
• Setup: <same or adjusted>
• Short Reasoning: <1–2 lines>

If proof NOT present, print only "Option 1 — Pending Limit".

"Full Breakdown"
• Technical View (HTF + Intraday)
• Fundamental View (Calendar + Sentiment)
• Tech vs Fundy Alignment
• Conditional Scenarios
• Surprise Risk
• Invalidation
• One-liner Summary

"Detected Structures (X-ray):"
• 4H: ...
• 1H: ...
• 15m: ...

"Candidate Scores (tournament):"
• <Strategy> – <score>/100 – <why>

"Final Table Summary:"
| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |

Append a fenced JSON block named ai_meta:
\`\`\`json ai_meta
{
  "selectedStrategy": "string",
  "entryType": "Pending" | "Pending+Market",
  "direction": "Long" | "Short" | "Flat",
  "zone": { "min": number, "max": number, "tf": "15m" | "1H" | "4H", "type": "OB" | "FVG" | "SR" | "Other" },
  "stop": number | null,
  "tp1": number | null,
  "tp2": number | null,
  "breakoutProof": { "bodyCloseBeyond": boolean, "retestHolds": boolean, "sfpReclaim": boolean },
  "candidateScores": [ { "name": "string", "score": number } ],
  "marketAllowed": boolean
}
\`\`\`
`.trim();
}

function tournamentMessages(params: {
  instrument: string;
  m15: string; h1: string; h4: string; cal?: string | null;
  headlinesText?: string | null;
}) {
  const { instrument, m15, h1, h4, cal, headlinesText } = params;
  const sys =
    "You are a professional discretionary price-action trader. " +
    "Analyze the uploaded 4H/1H/15m images (no numeric candles). Consider headlines/calendar context. " +
    "Score multiple strategies (Breakout+Retest, Pullback to OB/FVG/SR, SFP & reclaim, Range reversion) and choose the best. " +
    "Use price-action stops. If breakout proof exists (body close beyond level AND retest holds, or SFP->reclaim), also provide a Market option with slightly lower conviction; otherwise only Pending Limit. " +
    "Conservative numbers; crypto can be rounded to nearest 5–25.";
  const content: any[] = [
    { type: "text", text: `Instrument: ${instrument}` },
    { type: "text", text: "4H Chart:" }, { type: "image_url", image_url: { url: h4 } },
    { type: "text", text: "1H Chart:" }, { type: "image_url", image_url: { url: h1 } },
    { type: "text", text: "15m Chart:" }, { type: "image_url", image_url: { url: m15 } },
  ];
  if (cal) { content.push({ type: "text", text: "Economic Calendar:" }); content.push({ type: "image_url", image_url: { url: cal } }); }
  if (headlinesText && headlinesText.trim()) content.push({ type: "text", text: "Headlines Snapshot:\n" + headlinesText.slice(0, 2000) });
  content.push({ type: "text", text: outputContract() });
  return [
    { role: "system", content: sys },
    { role: "user", content },
  ];
}

function strictTemplateMessages(params: {
  instrument: string; m15: string; h1: string; h4: string; cal?: string | null; headlinesText?: string | null;
}) {
  // Second pass if first came back empty/off-template
  const { instrument, m15, h1, h4, cal, headlinesText } = params;
  const content: any[] = [
    { type: "text", text: `Return ONLY the formatted plan. Instrument: ${instrument}` },
    { type: "text", text: "4H Chart:" }, { type: "image_url", image_url: { url: h4 } },
    { type: "text", text: "1H Chart:" }, { type: "image_url", image_url: { url: h1 } },
    { type: "text", text: "15m Chart:" }, { type: "image_url", image_url: { url: m15 } },
    { type: "text", text: outputContract() },
  ];
  if (cal) { content.splice(3, 0, { type: "text", text: "Economic Calendar:" }, { type: "image_url", image_url: { url: cal } }); }
  if (headlinesText && headlinesText.trim()) content.splice(3, 0, { type: "text", text: "Headlines Snapshot:\n" + headlinesText.slice(0, 2000) });
  return [
    { role: "system", content: "Write the plan in the exact template. No preface, no extra commentary." },
    { role: "user", content },
  ];
}

// ---------- handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });
    if (!isMultipart(req)) {
      return res.status(400).json({
        ok: false,
        reason: "Use multipart/form-data with files m15,h1,h4 (PNG/JPG). Optional file 'calendar'. Optional field 'instrument'.",
      });
    }

    const { fields, files } = await parseMultipart(req);
    const instrument = String(fields.instrument || fields.code || "BTCUSD").toUpperCase().replace("/", "");
    const m15File = pickFirst(files.m15);
    const h1File  = pickFirst(files.h1);
    const h4File  = pickFirst(files.h4);
    const calFile = pickFirst(files.calendar);

    const [m15, h1, h4, cal] = await Promise.all([
      fileToDataUrl(m15File), fileToDataUrl(h1File), fileToDataUrl(h4File), fileToDataUrl(calFile),
    ]);
    if (!m15 || !h1 || !h4) return res.status(400).json({ ok: false, reason: "Upload all three charts: m15, h1, h4." });

    const headlinesText = await fetchHeadlinesText(req, instrument);

    // pass 1
    let text = await callOpenAI(tournamentMessages({ instrument, m15, h1, h4, cal, headlinesText }), 1200);

    // pass 2 (strict) if missing
    if (!looksLikePlan(text)) {
      text = await callOpenAI(strictTemplateMessages({ instrument, m15, h1, h4, cal, headlinesText }), 900);
    }

    // ensure ai_meta present
    let aiMeta = extractAiMeta(text) || {};
    const marketAllowed = hasMarketProof(aiMeta);
    if (aiMeta && typeof aiMeta === "object") aiMeta.marketAllowed = !!marketAllowed;

    if (!extractAiMeta(text)) {
      const minimal = {
        selectedStrategy: aiMeta?.selectedStrategy || "Unknown",
        entryType: marketAllowed ? "Pending+Market" : "Pending",
        direction: aiMeta?.direction || "Flat",
        zone: aiMeta?.zone || null, stop: aiMeta?.stop ?? null,
        tp1: aiMeta?.tp1 ?? null, tp2: aiMeta?.tp2 ?? null,
        breakoutProof: aiMeta?.breakoutProof || { bodyCloseBeyond: false, retestHolds: false, sfpReclaim: false },
        candidateScores: aiMeta?.candidateScores || [], marketAllowed,
      };
      text = text.trim() + `\n\n\`\`\`json ai_meta\n${JSON.stringify(minimal, null, 2)}\n\`\`\`\n`;
      aiMeta = minimal;
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text,
      meta: { instrument, hasCalendar: !!cal, headlinesCount: headlinesText ? headlinesText.split("\n").length : 0, aiMeta },
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}
