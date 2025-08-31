// /pages/api/vision-plan.ts
// Images-only planner: pick the best idea by scoring multiple strategies.
// Upload: m15 (execution), h1 (context), h4 (HTF), optional calendar.
// Keeps your existing style, fixes roles + image parts for chat/completions.
//
// UPDATE:
// 1) Option 2 (Market) line is always visible under "Quick Plan (Actionable)"
//    - Shows "Market entry..." if strategy has confirmation
//    - Else "Not available (missing confirmation...)"
// 2) After use, all uploaded temp images are deleted (fs.unlink)

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";

export const config = {
  api: { bodyParser: false, sizeLimit: "25mb" },
};

type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// ---------- helpers ----------

async function getFormidable() {
  const mod: any = await import("formidable");
  return mod.default || mod;
}

function isMultipart(req: NextApiRequest) {
  const t = String(req.headers["content-type"] || "");
  return t.includes("multipart/form-data");
}

async function parseMultipart(req: NextApiRequest) {
  const formidable = await getFormidable();
  const form = formidable({
    multiples: false,
    maxFiles: 25,
    maxFileSize: 25 * 1024 * 1024,
  });
  return new Promise<{ fields: Record<string, any>; files: Record<string, any> }>(
    (resolve, reject) => {
      form.parse(req as any, (err: any, fields: any, files: any) => {
        if (err) return reject(err);
        resolve({ fields, files });
      });
    }
  );
}

function pickFirst<T = any>(x: T | T[] | undefined | null): T | null {
  if (!x) return null;
  return Array.isArray(x) ? (x[0] ?? null) : (x as any);
}

// pull a best-effort temp file path from formidable's File object
function filePathFromUpload(file: any): string | null {
  if (!file) return null;
  return (
    file.filepath ||
    file.path ||
    file._writeStream?.path ||
    file.originalFilepath ||
    null
  );
}

async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p = filePathFromUpload(file);
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

async function fetchedHeadlines(req: NextApiRequest, instrument: string) {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(
      instrument
    )}&hours=48&max=12`;
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    const lines = items
      .slice(0, 12)
      .map((it: any) => {
        const s = typeof it?.sentiment?.score === "number" ? it.sentiment.score : null;
        const lab = s == null ? "neu" : s > 0.05 ? "pos" : s < -0.05 ? "neg" : "neu";
        const t = String(it?.title || "").slice(0, 200);
        const src = it?.source || "";
        const when = it?.ago || "";
        return `• ${t} — ${src}, ${when} — ${lab}`;
      })
      .join("\n");
    return lines || null;
  } catch {
    return null;
  }
}

function refusalLike(s: string) {
  const t = (s || "").toLowerCase();
  if (!t) return false;
  return /\b(can'?t|cannot)\s+assist\b|\bnot able to comply\b|\brefuse/i.test(t);
}

// fenced JSON extractor for trailing ai_meta
function extractAiMeta(text: string) {
  if (!text) return null;
  // look for ```json ... ``` or ```ai_meta ... ```
  const fences = [/```ai_meta\s*({[\s\S]*?})\s*```/i, /```json\s*({[\s\S]*?})\s*```/i];
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

// OpenAI call (chat/completions, vision content parts)
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
    }),
  });
  const json = await rsp.json().catch(() => ({} as any));
  if (!rsp.ok) {
    throw new Error(
      `OpenAI vision request failed: ${rsp.status} ${JSON.stringify(json)}`
    );
  }
  const out =
    json?.choices?.[0]?.message?.content ??
    (Array.isArray(json?.choices?.[0]?.message?.content)
      ? json.choices[0].message.content.map((c: any) => c?.text || "").join("\n")
      : "");
  return String(out || "");
}

// ---------- prompt builders ----------

function tournamentMessages(params: {
  instrument: string;
  dateStr: string;
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
  m15: string;
  h1: string;
  h4: string;
}) {
  const {
    instrument,
    dateStr,
    calendarDataUrl,
    headlinesText,
    m15,
    h1,
    h4,
  } = params;

  const system = [
    "You are a professional discretionary trader.",
    "Perform **visual** price-action market analysis from the images (no numeric candles).",
    "Multi-timeframe alignment: 15m execution, 1H context, 4H HTF.",
    "Tournament mode: score candidates (Long/Short where valid):",
    "- Pullback to OB/FVG/SR confluence, Breakout+Retest, SFP/Liquidity grab+reclaim, Range reversion, TL/channel retest, double-tap when clean.",
    "Scoring rubric (0–100): Structure trend(25), 15m trigger quality(25), HTF context(15), Clean path to target(10), Stop validity(10), Fundamentals/Headlines(10), 'No chase' penalty(5).",
    "Market entry allowed only when **explicit proof** per strategy; otherwise label EntryType: Pending and use Buy/Sell Limit zone.",
    "Stops just beyond invalidation (swing/zone) with small buffer. RR can be < 1.5R if structure says so.",
    "Use calendar/headlines as bias overlay if provided.",
    "",
    "OUTPUT format:",
    "Quick Plan (Actionable)",
    "",
    "• Direction: Long | Short | Stay Flat",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger: (ex: Limit pullback / zone touch)",
    "• Entry: <min–max> or specific level",
    "• Stop Loss: <level>",
    "• Take Profit(s): TP1 <level> / TP2 <level>",
    "• Conviction: <0–100>%",
    "• Setup: <Chosen Strategy>",
    "• Short Reasoning: <1–2 lines>",
    "",
    "Full Breakdown",
    "• Technical View (HTF + Intraday): 4H/1H/15m structure",
    "• Fundamental View (Calendar + Sentiment):",
    "• Tech vs Fundy Alignment: Match | Mismatch (+why)",
    "• Conditional Scenarios:",
    "• Surprise Risk:",
    "• Invalidation:",
    "• One-liner Summary:",
    "",
    "Detected Structures (X-ray):",
    "• 4H:",
    "• 1H:",
    "• 15m:",
    "",
    "Candidate Scores (tournament):",
    "- name — score — reason",
    "",
    "Final Table Summary:",
    "| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |",
    `| ${instrument} | ... | ... | ... | ... | ... | ... |`,
    "",
    "At the very end, append a fenced JSON block labeled ai_meta with:",
    "```ai_meta",
    `{ "selectedStrategy": string,`,
    `  "entryType": "Pending" | "Market",`,
    `  "entryOrder": "Sell Limit" | "Buy Limit" | "Sell Stop" | "Buy Stop" | "Market",`,
    `  "direction": "Long" | "Short" | "Flat",`,
    `  "currentPrice": number | null,`,
    `  "zone": { "min": number, "max": number, "tf": "15m" | "1H" | "4H", "type": "OB" | "FVG" | "SR" | "Other" },`,
    `  "stop": number, "tp1": number, "tp2": number,`,
    `  "prevSwingHigh": number | null, "prevSwingLow": number | null,`,
    `  "srAbove": number[] | null, "srBelow": number[] | null,`,
    `  "proof": {`,
    `    "breakout": { "bodyCloseBeyond": boolean, "retestHolds": boolean, "sfpReclaim": boolean },`,
    `    "pullback": { "rejectionCloseInZone": boolean, "impulseAway": boolean },`,
    `    "range": { "sfpAtEdge": boolean, "acceptanceInRange": boolean },`,
    `    "trendline": { "tlBreakClose": boolean, "tlRetestHold": boolean },`,
    `    "sfp": { "sweepConfirmed": boolean, "reclaimClose": boolean },`,
    `    "bos": { "htfBos": boolean, "ltfMomentumClose": boolean }`,
    `  },`,
    `  "candidateScores": [{ "name": string, "score": number, "reason": string }]}`,
    "```",
  ].join("\n");

  const userParts: any[] = [
    { type: "text", text: `Instrument: ${instrument}\nDate: ${dateStr}` },
    { type: "text", text: "HTF 4H Chart:" },
    { type: "image_url", image_url: { url: h4 } },
    { type: "text", text: "Context 1H Chart:" },
    { type: "image_url", image_url: { url: h1 } },
    { type: "text", text: "Execution 15M Chart:" },
    { type: "image_url", image_url: { url: m15 } },
  ];

  if (calendarDataUrl) {
    userParts.push({ type: "text", text: "Economic Calendar Image:" });
    userParts.push({ type: "image_url", image_url: { url: calendarDataUrl } });
  }
  if (headlinesText) {
    userParts.push({
      type: "text",
      text: `Recent headlines snapshot:\n${headlinesText}`,
    });
  }

  return [
    { role: "system", content: system },
    { role: "user", content: userParts },
  ];
}

async function askTournament(args: {
  instrument: string;
  dateStr: string;
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
  m15: string;
  h1: string;
  h4: string;
}) {
  const messages = tournamentMessages(args);
  const text = await callOpenAI(messages);
  const aiMeta = extractAiMeta(text);
  return { text, aiMeta };
}

// ---------- local Option 2 helpers (no extra model calls) ----------

// Check if strategy has enough confirmation to allow Market (Option 2)
function strategyAllowsMarket(aiMeta: any): boolean {
  if (!aiMeta) return false;
  const name = String(aiMeta?.selectedStrategy || aiMeta?.setup || "").toLowerCase();

  const proof = aiMeta?.proof || {};
  const breakout = proof?.breakout || aiMeta?.breakoutProof || {};
  const pullback = proof?.pullback || {};
  const range = proof?.range || {};
  const trendline = proof?.trendline || {};
  const sfp = proof?.sfp || {};
  const bos = proof?.bos || {};

  if (name.includes("breakout")) {
    return !!(breakout?.bodyCloseBeyond === true &&
      (breakout?.retestHolds === true || breakout?.sfpReclaim === true));
  }
  if (name.includes("pullback") || name.includes("ob") || name.includes("fvg") || name.includes("sr")) {
    return !!(pullback?.rejectionCloseInZone === true && pullback?.impulseAway === true);
  }
  if (name.includes("range")) {
    return !!(range?.sfpAtEdge === true && range?.acceptanceInRange === true);
  }
  if (name.includes("trendline") || name.includes("channel")) {
    return !!(trendline?.tlBreakClose === true && trendline?.tlRetestHold === true);
  }
  if (name.includes("sfp") || name.includes("liquidity")) {
    return !!(sfp?.sweepConfirmed === true && sfp?.reclaimClose === true);
  }
  if (name.includes("bos") || name.includes("continuation")) {
    return !!(bos?.htfBos === true && bos?.ltfMomentumClose === true);
  }

  // Fallback: breakout-style test if unknown
  return !!(breakout?.bodyCloseBeyond === true &&
    (breakout?.retestHolds === true || breakout?.sfpReclaim === true));
}

// Insert Option 2 line under "Quick Plan (Actionable)" robustly
function ensureOption2Line(text: string, allows: boolean, convMinus5: number): string {
  if (!text) return text;
  const lines = text.split(/\n/);

  // find "Quick Plan (Actionable)" line
  let qpIdx = lines.findIndex((l) => /quick plan\s*\(actionable\)/i.test(l));
  if (qpIdx === -1) {
    // no explicit header; append at top
    const optLine = allows
      ? `• Option 2 (Market): Market entry (post-confirmation). SL/TPs same as Option 1. Conviction ~${convMinus5}%`
      : `• Option 2 (Market): Not available (missing confirmation for this setup).`;
    return `${optLine}\n` + text;
  }

  // try to place after "Conviction:" if present, else after header or after Short Reasoning
  let insertAt = -1;
  for (let i = qpIdx + 1; i < Math.min(lines.length, qpIdx + 40); i++) {
    const li = lines[i] || "";
    if (/^\s*•\s*Conviction\s*:/i.test(li)) {
      insertAt = i + 1;
      break;
    }
    // stop if next major section
    if (/^\s*Full Breakdown/i.test(li) || /^\s*##\s+/.test(li)) break;
  }
  if (insertAt === -1) insertAt = qpIdx + 1;

  const opt2 = allows
    ? `• Option 2 (Market): Market entry (post-confirmation). SL/TPs same as Option 1. Conviction ~${convMinus5}%`
    : `• Option 2 (Market): Not available (missing confirmation for this setup).`;

  // avoid duplicate insertions
  const already = lines.some((l) => /option\s*2\s*\(market\)/i.test(l));
  if (already) return text;

  lines.splice(insertAt, 0, opt2);
  return lines.join("\n");
}

// ---------- handler ----------

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Ok | Err>
) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });
    if (!isMultipart(req)) {
      return res.status(400).json({
        ok: false,
        reason:
          "Use multipart/form-data with files: m15, h1, h4 (PNG/JPG) and optional 'calendar'. Also include 'instrument' field.",
      });
    }

    const { fields, files } = await parseMultipart(req);
    const instrument = String(fields.instrument || fields.code || "EURUSD")
      .toUpperCase()
      .replace(/\s+/g, "");

    const m15f = pickFirst(files.m15);
    const h1f = pickFirst(files.h1);
    const h4f = pickFirst(files.h4);
    const calF = pickFirst(files.calendar);

    // Remember file paths for cleanup
    const tempPaths = [m15f, h1f, h4f, calF].map((f) => filePathFromUpload(f)).filter(Boolean) as string[];

    const [m15, h1, h4, calUrl] = await Promise.all([
      fileToDataUrl(m15f),
      fileToDataUrl(h1f),
      fileToDataUrl(h4f),
      calF ? fileToDataUrl(calF) : Promise.resolve(null),
    ]);

    if (!m15 || !h1 || !h4) {
      // best-effort cleanup even on early return
      await Promise.all(
        tempPaths.map((p) => fs.unlink(p).catch(() => {}))
      );
      return res
        .status(400)
        .json({ ok: false, reason: "Upload all three charts: m15, h1, h4 (PNG/JPG)." });
    }

    const headlinesText = await fetchedHeadlines(req, instrument);
    const dateStr = new Date().toISOString().slice(0, 10);

    // 1) Tournament pass
    let { text, aiMeta } = await askTournament({
      instrument,
      dateStr,
      calendarDataUrl: calUrl || undefined,
      headlinesText: headlinesText || undefined,
      m15,
      h1,
      h4,
    });

    // 2) Always show Option 2 line (Market or Not available)
    const allows = strategyAllowsMarket(aiMeta);
    // try to read "Conviction: 64%" from the card; fall back to 60
    let convPct = 60;
    try {
      const m = text.match(/Conviction:\s*([0-9]{1,3})\s*%/i);
      if (m) convPct = Math.max(0, Math.min(100, parseInt(m[1], 10)));
    } catch {}
    const opt2Conv = Math.max(0, convPct - 5);
    text = ensureOption2Line(text, allows, opt2Conv);

    // 3) Fallback if refusal/empty
    if (!text || refusalLike(text)) {
      const fallback =
        [
          "Quick Plan (Actionable)",
          "",
          "• Direction: Stay Flat (low conviction).",
          "• Order Type: Pending",
          "• Trigger: Confluence (OB/FVG/SR) after a clean trigger.",
          "• Entry: zone below/above current (structure based).",
          "• Stop Loss: beyond invalidation with small buffer.",
          "• Take Profit(s): Prior swing/liquidity; then trail.",
          "• Conviction: 30%",
          "• Setup: Await valid trigger (images inconclusive).",
          "• Option 2 (Market): Not available (missing confirmation for this setup).",
          "",
          "Full Breakdown",
          "• Technical View: Indecisive; likely range.",
          "• Fundamental View: Mixed; keep size conservative.",
          "• Tech vs Fundy Alignment: Mixed.",
          "• Conditional Scenarios: Break+retest for continuation; SFP & reclaim for reversal.",
          "• Surprise Risk: Headlines; CB speakers.",
          "• Invalidation: Opposite-side body close beyond range edge.",
          "• One-liner Summary: Stand by for a clean trigger.",
          "",
          "Detected Structures (X-ray):",
          "• 4H: –",
          "• 1H: –",
          "• 15m: –",
          "",
          "Candidate Scores (tournament):",
          "–",
          "",
          "Final Table Summary:",
          `| Instrument | Bias   | Entry Zone | SL  | TP1 | TP2 | Conviction % |`,
          `| ${instrument} | Neutral | Wait for trigger | Structure-based | Prior swing | Next liquidity | 30% |`,
          "",
          "```ai_meta",
          JSON.stringify(
            {
              selectedStrategy: "Await valid trigger",
              entryType: "Pending",
              entryOrder: "Pending",
              direction: "Flat",
              currentPrice: null,
              zone: null,
              stop: null,
              tp1: null,
              tp2: null,
              proof: {},
              candidateScores: [],
              note: "Fallback used due to refusal/empty output.",
            },
            null,
            2
          ),
          "```",
        ].join("\n");

      // cleanup temp files before returning
      await Promise.all(tempPaths.map((p) => fs.unlink(p).catch(() => {})));

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        text: fallback,
        meta: {
          instrument,
          hasCalendar: !!calUrl,
          headlinesCount: headlinesText ? headlinesText.length : 0,
          strategySelection: false,
          rewritten: false,
          fallbackUsed: true,
          aiMeta: extractAiMeta(fallback),
        },
      });
    }

    // cleanup temp files before final response
    await Promise.all(tempPaths.map((p) => fs.unlink(p).catch(() => {})));

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text,
      meta: {
        instrument,
        hasCalendar: !!calUrl,
        headlinesCount: headlinesText ? headlinesText.length : 0,
        strategySelection: true,
        rewritten: false,
        fallbackUsed: false,
        aiMeta,
      },
    });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      reason: err?.message || "vision-plan failed",
    });
  }
}
