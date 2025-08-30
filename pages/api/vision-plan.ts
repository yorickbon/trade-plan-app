// /pages/api/vision-plan.ts
// Images-only planner with multi-strategy "tournament" selection.
// - Generates multiple candidate strategies, scores them, and selects the best.
// - Anti-chase: MARKET only if body close + retest (or SFP reclaim) is proven.
// - Zones (min–max), not single prices.
// - Order sanity: Sell Limit must be ABOVE current price; Buy Limit BELOW.
// - Auto-rewrites invalid outputs.
// - Returns card text + ai_meta for debugging.

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
const OPENAI_API_BASE =
  process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// ───────────── helpers ─────────────
async function getFormidable() {
  const mod: any = await import("formidable");
  return mod.default || mod;
}
function isMultipart(req: NextApiRequest) {
  return String(req.headers["content-type"] || "").includes("multipart/form-data");
}
async function parseMultipart(req: NextApiRequest) {
  const formidable = await getFormidable();
  const form = formidable({ multiples: false, maxFileSize: 25 * 1024 * 1024 });
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
  return Array.isArray(x) ? (x[0] ?? null) : x;
}
async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p =
    file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;
  const buf = await fs.readFile(p);
  const mime = file.mimetype || "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host =
    (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}
async function fetchHeadlines(req: NextApiRequest, instrument: string) {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(
      instrument
    )}&hours=48&max=10`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json();
    const items = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
    return items.slice(0, 10).map((it: any) => {
      const s = typeof it?.sentiment?.score === "number" ? it.sentiment.score : null;
      const tag = s === null ? "neu" : s >= 0.05 ? "pos" : s <= -0.05 ? "neg" : "neu";
      return `• ${String(it?.title || "").slice(0, 200)} (${tag})`;
    });
  } catch {
    return [];
  }
}

function refusalLike(txt: string) {
  const t = (txt || "").toLowerCase();
  return (
    !t ||
    t.length < 40 ||
    /unable to assist|cannot assist|can't assist|cannot help|can't help|i can’t help|refuse|not able to comply/.test(
      t
    )
  );
}

// extract fenced JSON block (```ai_meta ...``` or ```json ...```)
function extractAiMeta(text: string) {
  const fences = [
    /```ai_meta\s*([\s\S]*?)```/i,
    /```json\s*([\s\S]*?)```/i,
    /```([\s\S]*?)```/i,
  ];
  for (const re of fences) {
    const m = text.match(re);
    if (m && m[1]) {
      try {
        return JSON.parse(m[1]);
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function aiMetaDemandsPending(aiMeta: any): boolean {
  if (!aiMeta) return true; // conservative
  const entryType = String(aiMeta.entryType || "").toLowerCase();
  if (entryType !== "market") return false;
  const bp = aiMeta.breakoutProof || {};
  const ok = bp.bodyCloseBeyond === true && (bp.retestHolds === true || bp.sfpReclaim === true);
  return !ok;
}

function invalidOrderRelativeToPrice(aiMeta: any): string | null {
  // returns reason string if inconsistent, else null
  if (!aiMeta) return "missing ai_meta";
  const dir = String(aiMeta.direction || "").toLowerCase();
  const ord = String(aiMeta.entryOrder || "").toLowerCase();
  const zone = aiMeta.zone || {};
  const p = Number(aiMeta.currentPrice);
  const zmin = Number(zone.min);
  const zmax = Number(zone.max);
  if (!isFinite(p) || !isFinite(zmin) || !isFinite(zmax)) return "missing zone/price";

  if (dir === "short" && ord === "sell limit") {
    if (Math.max(zmin, zmax) <= p) return "sell-limit-below-price";
  }
  if (dir === "long" && ord === "buy limit") {
    if (Math.min(zmin, zmax) >= p) return "buy-limit-above-price";
  }
  return null;
}

// ───────────── OpenAI ─────────────
async function callOpenAI(messages: any[], temperature = 0.18) {
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: OPENAI_MODEL, temperature, messages }),
  });
  if (!rsp.ok) {
    const t = await rsp.text().catch(() => "");
    throw new Error(`OpenAI vision request failed: ${rsp.status} ${t}`);
  }
  const json = await rsp.json();
  return (json?.choices?.[0]?.message?.content || "").trim();
}

function buildMessages({
  instrument,
  dataUrls,
  calendarDataUrl,
  headlinesText,
  educationalRetry = false,
}: {
  instrument: string;
  dataUrls: { m15: string; h1: string; h4: string };
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
  educationalRetry?: boolean;
}) {
  const policy = [
    educationalRetry
      ? "You provide educational market analysis (NOT financial advice)."
      : "You are a meticulous price-action trading analyst.",
    "Use ONLY the provided images for technicals; do not invent numeric candles.",
    "",
    "ENTRY POLICY:",
    "• Generate multiple candidate strategies (tournament).",
    "• MARKET entry ONLY if you explicitly prove BOTH: a decisive BODY CLOSE beyond level AND a successful RETEST that HOLDS (or a clear SFP-reclaim).",
    "• Otherwise prefer LIMIT entries into OB/FVG/SR confluence; always output a zone (min–max).",
    "• Stops are PA-based beyond invalidation; if first is too tight (wick risk), escalate to next structural extreme + buffer.",
    "• Format prices with thousands separators where natural (e.g., 109,800).",
  ].join(" ");

  const userText = [
    `Instrument: ${instrument}`,
    "",
    "TASKS:",
    "0) Read the 4H/1H/15m images. Do NOT use external candles.",
    "1) Multi-timeframe structure: trend, BOS/CHOCH, sweeps, OB (supply/demand), FVGs, SR flips, range bounds, swing map.",
    "2) Generate candidates (both directions if valid):",
    "   - Pullback to OB/Demand/Supply (with FVG/Fib confluence, SR flip)",
    "   - Breakout + Retest (only with body close + retest hold OR SFP reclaim)",
    "   - SFP / Liquidity grab + reclaim",
    "   - Range reversion (edge to mid / opposite edge)",
    "   - Optional if clean: TL/Channel retest, Double top/bottom + neckline, Breaker/QML",
    "3) Score each candidate (0–100) using:",
    "   HTF alignment 30, Trigger proof 20, Confluence 15, Clean path to target 10, Stop validity 10, Fundamentals 10, ±90m news penalty ≤5.",
    "4) Pick the HIGHEST SCORE candidate and build the Trade Card.",
    "5) Fundamentals: use headlines and calendar (if image provided). WARN on ±90m; do not blackout.",
    "",
    "OUTPUT (exact order):",
    "Quick Plan (Actionable):",
    "• Direction: Long / Short / Stay Flat",
    "• Entry: Pending @ <zone min–max> (Sell/Buy Limit preferred) — use Market ONLY if you proved body-close + retest hold or SFP-reclaim",
    "• Stop Loss: … (beyond which structure?)",
    "• Take Profit(s): TP1 / TP2 …",
    "• Conviction: %",
    "• Setup: <Chosen Strategy>",
    "• Short Reasoning: ...",
    "",
    "Full Breakdown:",
    "• Technical View (HTF + Intraday): ...",
    "• Fundamental View (Calendar + Sentiment): ...",
    "• Tech vs Fundy Alignment: Match / Mismatch (why)",
    "• Conditional Scenarios: include opposite-side idea if relevant",
    "• Surprise Risk: ...",
    "• Invalidation: ...",
    "• One-liner Summary: ...",
    "",
    "Advanced Reasoning (Pro-Level Context): ...",
    "",
    "News Event Watch: ...",
    "",
    "Notes: ...",
    "",
    "Detected Structures (X-ray):",
    "• 4H: OB/FVG/SR/range/sweeps/swing map ...",
    "• 1H: OB/FVG/SR/range/sweeps/swing map ...",
    "• 15m: OB/FVG/SR/range/sweeps/swing map ...",
    "",
    "Candidate Scores: (list each candidate you evaluated with name, score, and one-line reason)",
    "",
    "Final Table Summary:",
    "Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction %",
    "",
    "At the very end, APPEND a fenced JSON block labeled ai_meta with:",
    `{
  "selectedStrategy": string,
  "entryType": "Pending" | "Market",
  "entryOrder": "Sell Limit" | "Buy Limit" | "Sell Stop" | "Buy Stop" | "Market",
  "direction": "Long" | "Short" | "Flat",
  "currentPrice": number,
  "zone": { "min": number, "max": number, "tf": "15m" | "1H" | "4H", "type": "OB" | "FVG" | "SR" | "Other" },
  "stop": number, "tp1": number, "tp2": number,
  "breakoutProof": { "bodyCloseBeyond": boolean, "retestHolds": boolean, "sfpReclaim": boolean },
  "candidateScores": [{ "name": string, "score": number, "reason": string }],
  "note": "one line on why this was chosen"
}`,
  ].join("\n");

  const content: any[] = [
    { type: "text", text: userText },
    { type: "text", text: "4H Chart:" },
    { type: "image_url", image_url: { url: dataUrls.h4 } },
    { type: "text", text: "1H Chart:" },
    { type: "image_url", image_url: { url: dataUrls.h1 } },
    { type: "text", text: "15M Chart:" },
    { type: "image_url", image_url: { url: dataUrls.m15 } },
  ];
  if (calendarDataUrl) {
    content.push({ type: "text", text: "Economic Calendar Image:" });
    content.push({ type: "image_url", image_url: { url: calendarDataUrl } });
  }
  if (headlinesText && headlinesText.trim()) {
    content.push({ type: "text", text: "Recent headlines snapshot:\n" + headlinesText });
  }

  const messages = [
    { role: "system", content: policy },
    { role: "user", content },
  ];
  return messages;
}

async function askVision(params: {
  instrument: string;
  dataUrls: { m15: string; h1: string; h4: string };
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
}): Promise<{ text: string; aiMeta: any }> {
  const m1 = buildMessages({ ...params, educationalRetry: false });
  let text = await callOpenAI(m1, 0.18);
  if (refusalLike(text)) {
    const m2 = buildMessages({ ...params, educationalRetry: true });
    text = await callOpenAI(m2, 0.22);
  }
  const aiMeta = extractAiMeta(text);
  return { text, aiMeta };
}

async function rewriteAsPending(instrument: string, text: string) {
  const messages = [
    {
      role: "system",
      content:
        "Rewrite the trade card as PENDING Limit @ OB/FVG/SR confluence (zone min–max). No Market unless proof exists. Keep X-ray & Candidate Scores.",
    },
    {
      role: "user",
      content: `Instrument: ${instrument}\nRewrite this card as Pending Limit:\n\`\`\`\n${text}\n\`\`\``,
    },
  ];
  return await callOpenAI(messages, 0.15);
}

async function normalizeSetupIfNoBreakout(text: string) {
  const messages = [
    {
      role: "system",
      content:
        "If 'Breakout + Retest' is claimed but no explicit proof (body close + retest hold OR SFP reclaim), rename to Pullback (OB/FVG confluence) and ensure Entry is a Pending Limit zone.",
    },
    { role: "user", content: text },
  ];
  return await callOpenAI(messages, 0.12);
}

async function fixOrderVsPrice(instrument: string, text: string, aiMeta: any) {
  const reason = invalidOrderRelativeToPrice(aiMeta);
  if (!reason) return text;

  const sideHint =
    reason === "sell-limit-below-price"
      ? "For SHORT + Sell Limit, zone must be ABOVE current price. Pick nearest valid 1H/15m supply/OB above price and output a min–max zone."
      : "For LONG + Buy Limit, zone must be BELOW current price. Pick nearest valid 1H/15m demand/OB below price and output a min–max zone.";

  const messages = [
    {
      role: "system",
      content: [
        "Fix entry/order to respect PA rules:",
        sideHint,
        "Keep PA-based stops; keep X-ray & Candidate Scores. Format with thousands separators.",
      ].join(" "),
    },
    {
      role: "user",
      content: `Instrument: ${instrument}\nFix this card:\n\`\`\`\n${text}\n\`\`\``,
    },
  ];
  return await callOpenAI(messages, 0.14);
}

// ───────────── handler ─────────────
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Ok | Err>
) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!isMultipart(req))
      return res.status(400).json({
        ok: false,
        reason:
          "Use multipart/form-data with files m15,h1,h4 (optional calendar) and optional field 'instrument'.",
      });
    if (!OPENAI_API_KEY)
      return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    const { fields, files } = await parseMultipart(req);
    const instrument = String(fields.instrument || fields.code || "EURUSD")
      .toUpperCase()
      .replace(/\s+/g, "");

    const fM15 = pickFirst(files.m15);
    const fH1 = pickFirst(files.h1);
    const fH4 = pickFirst(files.h4);
    const fCal = pickFirst(files.calendar);
    if (!fM15 || !fH1 || !fH4)
      return res
        .status(400)
        .json({ ok: false, reason: "Upload all three charts: m15, h1, h4 (PNG/JPG)." });

    const [m15Url, h1Url, h4Url, calUrl] = await Promise.all([
      fileToDataUrl(fM15),
      fileToDataUrl(fH1),
      fileToDataUrl(fH4),
      fCal ? fileToDataUrl(fCal) : Promise.resolve(null),
    ]);
    if (!m15Url || !h1Url || !h4Url)
      return res
        .status(400)
        .json({ ok: false, reason: "Could not read one or more uploaded images" });

    const headlinesList = await fetchHeadlines(req, instrument);
    const headlinesText = headlinesList.length ? headlinesList.join("\n") : null;

    // 1) Primary pass → multi-strategy tournament inside model
    let { text, aiMeta } = await askVision({
      instrument,
      dataUrls: { m15: m15Url, h1: h1Url, h4: h4Url },
      calendarDataUrl: calUrl || undefined,
      headlinesText,
    });

    // 2) If Market without valid proof → rewrite to Pending
    if (aiMetaDemandsPending(aiMeta)) {
      text = await rewriteAsPending(instrument, text);
      aiMeta = extractAiMeta(text) || aiMeta;
    }

    // 3) Normalize misleading setups (Breakout+Retest without proof → Pullback)
    const bp = aiMeta?.breakoutProof || {};
    const breakoutOK = bp?.bodyCloseBeyond && (bp?.retestHolds || bp?.sfpReclaim);
    if (!breakoutOK && /Breakout\s*\+\s*Retest/i.test(text)) {
      text = await normalizeSetupIfNoBreakout(text);
      aiMeta = extractAiMeta(text) || aiMeta;
    }

    // 4) Enforce order vs current price (Sell Limit above / Buy Limit below)
    if (aiMeta) {
      const reason = invalidOrderRelativeToPrice(aiMeta);
      if (reason) {
        text = await fixOrderVsPrice(instrument, text, aiMeta);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // 5) Fallback if the model refused
    if (refusalLike(text)) {
      const fallback = [
        "Quick Plan (Actionable):",
        "• Direction: Stay Flat (low conviction)",
        "• Entry: Pending @ confluence (OB/FVG/SR) after a clean signal",
        "• Stop Loss: Beyond the invalidation structure with small buffer",
        "• Take Profit(s): Prior swing/liquidity, then trail",
        "• Conviction: 30%",
        "• Setup: Await valid trigger (images inconclusive)",
        "",
        "Full Breakdown:",
        "• Technical View: Indecisive; likely range.",
        "• Fundamental View: Mixed; keep size conservative.",
        "• Tech vs Fundy Alignment: Mixed",
        "• Conditional Scenarios: Break & retest for continuation; SFP & reclaim for reversal.",
        "• Surprise Risk: Headlines; CB speakers.",
        "• Invalidation: Opposite-side body close beyond range edge.",
        "• One-liner Summary: Stand by for a clean trigger.",
        "",
        "Detected Structures (X-ray):",
        "• 4H: —",
        "• 1H: —",
        "• 15m: —",
        "",
        "Candidate Scores:",
        "• —",
        "",
        "Final Table Summary:",
        "Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction %",
        `${instrument} | Neutral | Wait for trigger | Structure-based | Prior swing | Next liquidity | 30%`,
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
            breakoutProof: {
              bodyCloseBeyond: false,
              retestHolds: false,
              sfpReclaim: false,
            },
            candidateScores: [],
            note: "Fallback used due to refusal/empty output",
          },
          null,
          2
        ),
        "```",
      ].join("\n");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        text: fallback,
        meta: {
          instrument,
          hasCalendar: !!calUrl,
          headlinesCount: headlinesList.length,
          strategySelection: false,
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
        strategySelection: true,
        rewritten: true,
        fallbackUsed: false,
        aiMeta: aiMeta || null,
      },
    });
  } catch (err: any) {
    return res
      .status(200)
      .json({ ok: false, reason: err?.message || "vision plan failed" });
  }
}
