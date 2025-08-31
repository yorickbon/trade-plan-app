// /pages/api/vision-plan.ts
// Images-only planner (tournament style). Upload: m15 (execution), h1 (context), h4 (HTF), optional calendar.
// Returns a human Quick Plan card AND a fenced JSON block labeled ```json ai_meta …```.
//
// ─── Build/Runtime assumptions ──────────────────────────────────────────────
// • Next.js API route
// • OPENAI_API_KEY in env
// • Uses Chat Completions with GPT-5 (vision-capable)
// • No bodyParser (multipart via formidable)

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";

// ─── API Route Config ───────────────────────────────────────────────────────
export const config = {
  api: { bodyParser: false, sizeLimit: "25mb" },
};

// ─── Types ─────────────────────────────────────────────────────────────────
type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

// ─── Env ───────────────────────────────────────────────────────────────────
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// ─── Helpers: dynamic formidable (SSG-friendly) ────────────────────────────
async function getFormidable() {
  const mod = await import("formidable");
  return mod.default || mod;
}

function isMultipart(req: NextApiRequest) {
  return (
    String(req.headers["content-type"] || "").includes("multipart/form-data")
  );
}

async function parseMultipart(req: NextApiRequest): Promise<{
  fields: Record<string, any>;
  files: Record<string, any>;
}> {
  const formidable = await getFormidable();
  const form = formidable({
    multiples: false,
    maxFileSize: 25 * 1024 * 1024,
  });
  return new Promise((resolve, reject) => {
    form.parse(req as any, (err: any, fields: any, files: any) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const filePath =
    file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!filePath) return null;
  const buf = await fs.readFile(filePath);
  const mime = file.mimetype || "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host =
    (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}

// ─── Headlines fetch (keeps same behavior; instrument-first) ───────────────
async function fetchHeadlines(req: NextApiRequest, instrument: string) {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?symbols=${encodeURIComponent(instrument)}`;
    const r = await fetch(url, { cache: "no-store" });
    const j: any = await r.json();
    const items = Array.isArray(j?.items) ? j.items : [];
    // Title only snapshot (keeps UI small); caller may join with "\n"
    return items
      .slice(0, 12)
      .map((it: any) =>
        typeof it?.title === "string" ? it.title.slice(0, 200) : ""
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Refusal/JSON helpers ──────────────────────────────────────────────────
function refusalLike(text: string) {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  return /unable to assist|cannot assist|cannot help|can't help|refuse|not able to comply|policy/.test(
    t
  );
}

// extract fenced JSON block from ```json ai_meta or ```json
function extractAiMeta(text: string): any | null {
  if (!text) return null;
  const fences = [
    /```json\s+ai_meta\s*([\s\S]*?)```/i,
    /```json\s*([\s\S]*?)```/i,
    /<ai_meta>([\s\S]*?)<\/ai_meta>/i, // lenient fallback
  ];
  for (const re of fences) {
    const m = text.match(re);
    if (m && m[1]) {
      try {
        return JSON.parse(m[1]);
      } catch {
        // ignore parse error and continue
      }
    }
  }
  return null;
}

function looksLikeJsonOnly(text: string): boolean {
  const t = (text || "").trim();
  return (
    /^```json/i.test(t) ||
    (!/Quick Plan\s*\(Actionable\)/i.test(t) && /"selectedStrategy"\s*:/i.test(t))
  );
}

// require Market only with proof
function marketAllowedFromProof(meta: any): boolean {
  const bp = meta?.breakoutProof || {};
  return !!(bp.bodyCloseBeyond && (bp.retestHolds || bp.sfpReclaim));
}

// sanity check order vs current price (only if model provided both)
function invalidOrderRelativeToPrice(meta: any): string | null {
  if (!meta) return "missing ai_meta";
  const dir = String(meta.direction || "").toLowerCase();
  const order = String(meta.entryOrder || "").toLowerCase();
  const p = Number(meta.currentPrice);
  const z = meta.zone;
  const zmin = Number(z?.min);
  const zmax = Number(z?.max);
  if (!Number.isFinite(p) || !Number.isFinite(zmin) || !Number.isFinite(zmax))
    return null;

  if (order.includes("sell") && zmax < p) return "sell-limit-below-price";
  if (order.includes("buy") && zmin > p) return "buy-limit-above-price";
  return null;
}

// synthesize a full card from ai_meta when model returns only JSON
function synthesizeCardFromMeta(instr: string, m: any): string {
  const dir = m?.direction ?? "Flat";
  const entryType = m?.entryType ?? "Pending";
  const entryOrder = m?.entryOrder ?? "";
  const zoneStr = m?.zone
    ? typeof m.zone === "object"
      ? `${m.zone.min ?? "?"} – ${m.zone.max ?? "?"}`
      : String(m.zone)
    : "—";
  const stop = m?.stop ?? "—";
  const tp1 = m?.tp1 ?? "—";
  const tp2 = m?.tp2 ?? "—";
  const conv =
    m?.candidateScores?.[0]?.score ??
    (typeof m?.conviction === "number" ? m.conviction : 50);
  const strat = m?.selectedStrategy ?? "Unknown";
  const bop = m?.breakoutProof || {};
  const proof = [
    bop.bodyCloseBeyond ? "body-close-beyond" : null,
    bop.retestHolds ? "retest-holds" : null,
    bop.sfpReclaim ? "SFP-reclaim" : null,
  ]
    .filter(Boolean)
    .join(", ") || "n/a";

  const lines: string[] = [
    "### Quick Plan (Actionable):",
    `- **Instrument:** ${instr}`,
    `- **Direction:** ${dir}`,
    `- **Entry:** ${entryType}${entryOrder ? ` (${entryOrder})` : ""}${
      m?.zone ? ` @ ${zoneStr}` : ""
    }`,
    `- **Stop Loss:** ${stop}`,
    `- **Take Profit(s):** TP1 ${tp1} / TP2 ${tp2}`,
    `- **Conviction:** ${conv}%`,
    `- **Setup:** ${strat}`,
    "",
    "### Proof / Notes",
    `- Breakout proof: ${proof}`,
  ];

  if (m?.marketAllowed) {
    // optional Market option, a touch lower conviction
    const mkConv =
      typeof conv === "number" ? Math.max(0, Number(conv) - 5) : 45;
    const mPrice =
      Number.isFinite(Number(m?.currentPrice)) && m.currentPrice != null
        ? String(m.currentPrice)
        : "Market";
    lines.push(
      "",
      "**Option 2 (Market):**",
      `- Entry: ${mPrice}`,
      `- Stop: ${stop}`,
      `- TP1 / TP2: ${tp1} / ${tp2}`,
      `- Conviction: ${mkConv}%`
    );
  }

  return lines.join("\n");
}

// ─── OpenAI Chat (GPT-5 vision) ─────────────────────────────────────────────
async function callOpenAI(messages: any[]) {
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL, // "gpt-5"
      messages,
      // GPT-5 requires max_completion_tokens (not max_tokens); temperature default only
      max_completion_tokens: 1400,
    }),
  });

  const json = await rsp.json().catch(() => ({} as any));
  if (!rsp.ok) {
    const msg = json?.error?.message || "OpenAI error";
    throw new Error(`OpenAI vision failed (${rsp.status}): ${msg}`);
  }
  return json?.choices?.[0]?.message?.content || "";
}

// ─── Prompt construction ───────────────────────────────────────────────────
function tournamentMessages(args: {
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
  } = args;

  const system = [
    "You are a professional discretionary price-action trader.",
    "Use ONLY the three chart images provided (15m execution, 1H context, 4H HTF) and optional calendar image.",
    "Do NOT fabricate numeric candles. Read structure directly from the images.",
    "Run a small tournament of strategy candidates (both directions when valid):",
    " • Pullback to OB/FVG/SR (with fib confluence), Breakout+Retest, SFP/liquidity grab+reclaim, Range reversion, TL/Channel retest.",
    "Score each candidate with a rubric: HTF alignment(30), LTF structure/trigger(30), clean path to target(10), stop validity(10), fundamentals(10), ‘no FOMO’ penalty(-10).",
    "",
    "MARKET ENTRY RULE:",
    " • Allow Market only when there is explicit breakout proof: a large body CLOSE beyond the level AND a successful RETEST that HOLDS (or a clean SFP reclaim).",
    " • Otherwise prefer Pending Limit at OB/FVG/SR confluence.",
    "",
    "OUTPUT FORMAT (exact):",
    "### Quick Plan (Actionable):",
    "- **Instrument:** {instrument}",
    "- **Direction:** Long | Short | Stay flat",
    "- **Entry:** Pending @ zone min–max (with order type) OR Market (only if proof)",
    "- **Stop Loss:** …",
    "- **Take Profit(s):** TP1 … / TP2 …",
    "- **Conviction:** …%",
    "- **Setup:** Chosen strategy",
    "",
    "### Full Breakdown:",
    "- **Technical View (HTF + Intraday)** …",
    "- **Fundamental View (Calendar + Sentiment)** …",
    "- **Tech vs Fundy Alignment:** Match | Mismatch (+why)",
    "- **Conditional Scenarios:** …",
    "- **Invalidation:** …",
    "",
    "### Candidate Scores (tournament): one line per candidate",
    "",
    "At the end, append a fenced JSON block labeled `ai_meta` with:",
    "```json ai_meta",
    "{",
    '  "selectedStrategy": string,',
    '  "entryType": "Pending" | "Market",',
    '  "entryOrder": "Sell Limit" | "Buy Limit" | "Sell Stop" | "Buy Stop" | "Market",',
    '  "direction": "Long" | "Short" | "Flat",',
    '  "currentPrice": number | null,',
    '  "zone": { "min": number, "max": number, "tf": "15m" | "1H" | "4H", "type": "OB" | "FVG" | "SR" | "Other" } | null,',
    '  "stop": number | null,',
    '  "tp1": number | null,',
    '  "tp2": number | null,',
    '  "breakoutProof": { "bodyCloseBeyond": boolean, "retestHolds": boolean, "sfpReclaim": boolean },',
    '  "candidateScores": [{ "name": string, "score": number, "reason": string }],',
    '  "marketAllowed": boolean',
    "}",
    "```",
  ].join("\n");

  // Compose one multimodal user message
  const parts: any[] = [
    { type: "text", text: `Date: ${dateStr}\nInstrument: ${instrument}\n\nAnalyze these charts:` },
    { type: "text", text: "4H Chart:" },
    { type: "image_url", image_url: { url: h4 } },
    { type: "text", text: "1H Chart:" },
    { type: "image_url", image_url: { url: h1 } },
    { type: "text", text: "15m Chart (execution):" },
    { type: "image_url", image_url: { url: m15 } },
  ];

  if (calendarDataUrl) {
    parts.push({ type: "text", text: "Economic Calendar Image:" });
    parts.push({ type: "image_url", image_url: { url: calendarDataUrl } });
  }

  if (headlinesText && headlinesText.trim()) {
    parts.push({
      type: "text",
      text: `Recent headlines snapshot:\n${headlinesText}`,
    });
  }

  const messages = [
    { role: "system", content: system },
    { role: "user", content: parts },
  ];

  return messages;
}

async function askTournament(params: {
  instrument: string;
  dateStr: string;
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
  m15: string;
  h1: string;
  h4: string;
}) {
  const msgs = tournamentMessages(params);
  const text = await callOpenAI(msgs);
  const aiMeta = extractAiMeta(text) || null;
  return { text, aiMeta };
}

async function rewriteToPending(instrument: string, text: string) {
  // Minimal rewrite request: keep tournament content but force Pending Limit
  const system =
    "Rewrite the trade card as PENDING (no Market). Keep tournament section and ai_meta.";
  const messages = [
    { role: "system", content: system },
    { role: "user", content: [{ type: "text", text: text }] },
  ];
  return callOpenAI(messages);
}

async function normalizeMislabeledBreakout(text: string) {
  const system =
    "If the setup is labeled 'Breakout + Retest' but there is no explicit proof (body close + retest holds or SFP reclaim), rename to 'Pullback (OB/FVG confluence)' and ensure PENDING Limit.";
  const messages = [
    { role: "system", content: system },
    { role: "user", content: [{ type: "text", text }] },
  ];
  return callOpenAI(messages);
}

// ─── Handler ───────────────────────────────────────────────────────────────
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Ok | Err>
) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, reason: "Method not allowed" });
    }
    if (!isMultipart(req)) {
      return res.status(400).json({
        ok: false,
        reason:
          "Use multipart/form-data with files m15,h1,h4 (PNG/JPG) and optional calendar, plus 'instrument'.",
      });
    }
    if (!OPENAI_API_KEY) {
      return res
        .status(400)
        .json({ ok: false, reason: "Missing OPENAI_API_KEY" });
    }

    // Parse form-data
    const { fields, files } = await parseMultipart(req);
    const instrument = String(fields.instrument || fields.code || "EURUSD")
      .toUpperCase()
      .replace("/", "");

    const fM15 = files.m15;
    const fH1 = files.h1;
    const fH4 = files.h4;
    const fCal = files.calendar;

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

    // Headlines snapshot (instrument-first; keep behavior minimal)
    const titles = await fetchHeadlines(req, instrument);
    const headlinesText = titles.length ? titles.join("\n") : "";

    // Build date string
    const dateStr = new Date().toISOString().slice(0, 10);

    // 1) Tournament call
    let { text, aiMeta } = await askTournament({
      instrument,
      dateStr,
      calendarDataUrl: calUrl || undefined,
      headlinesText: headlinesText || undefined,
      m15: m15Url,
      h1: h1Url,
      h4: h4Url,
    });

    // If GPT-5 returned only ai_meta JSON, synthesize a card so UI stays intact
    if (looksLikeJsonOnly(text)) {
      const synthesized = synthesizeCardFromMeta(instrument, aiMeta || {});
      text = [
        synthesized.trim(),
        "",
        "```json ai_meta",
        JSON.stringify(aiMeta || {}, null, 2),
        "```",
      ].join("\n");
    }

    // refresh meta in case we rewrote text above
    aiMeta = extractAiMeta(text) || aiMeta || null;

    // 2) Market-only enforcement: if Market shown without proof, rewrite to Pending
    if (aiMeta?.entryType === "Market" && !marketAllowedFromProof(aiMeta)) {
      const rewritten = await rewriteToPending(instrument, text);
      text = rewritten || text;
      aiMeta = extractAiMeta(text) || aiMeta;
    }

    // 3) If labeled Breakout+Retest but no proof, normalize to Pullback
    if (aiMeta?.selectedStrategy) {
      const label = String(aiMeta.selectedStrategy).toLowerCase();
      const bp = aiMeta?.breakoutProof || {};
      const hasProof = !!(bp.bodyCloseBeyond && (bp.retestHolds || bp.sfpReclaim));
      if (/breakout/.test(label) && !hasProof) {
        const rewritten = await normalizeMislabeledBreakout(text);
        text = rewritten || text;
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // 4) Sanity check order vs current price (if model provided both)
    const bad = invalidOrderRelativeToPrice(aiMeta);
    if (bad) {
      // annotate (non-fatal)
      text =
        text +
        `\n\n> Note: order/price relation looks off (${bad}). Consider adjusting the zone relative to current price.`;
    }

    // 5) Refusal/empty fallback
    if (!text || refusalLike(text)) {
      const fallback = [
        "### Quick Plan (Actionable):",
        `- **Instrument:** ${instrument}`,
        "- **Direction:** Stay Flat",
        "- **Entry:** Pending after a clean trigger (OB/FVG/SR confluence).",
        "- **Stop Loss:** Beyond invalidation with buffer.",
        "- **Take Profit(s):** Prior swing/liquidity, then trail.",
        "- **Conviction:** 30%",
        "- **Setup:** Wait-for-trigger",
        "",
        "### Detected Structures (X-ray):",
        "- 4H: –",
        "- 1H: –",
        "- 15m: –",
        "",
        "```json ai_meta",
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
            marketAllowed: false,
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
          headlinesCount: titles.length,
          strategySelection: false,
          rewritten: false,
          fallbackUsed: true,
          aiMeta: extractAiMeta(fallback),
        },
      });
    }

    // Success
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text,
      meta: {
        instrument,
        hasCalendar: !!calUrl,
        headlinesCount: titles.length,
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
