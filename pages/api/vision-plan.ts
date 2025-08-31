// /pages/api/vision-plan.ts
// Images-only planner (15m execution + 1h + 4h + optional calendar).
// Upload keys: m15, h1, h4, calendar (optional). Field 'instrument' comes from your UI dropdown.
// Produces 1 trade card by scoring multiple strategy candidates.

// ---------- imports ----------
import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";

// ---------- API config ----------
export const config = {
  api: { bodyParser: false, sizeLimit: "25mb" },
};

// ---------- env ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-2025-08-07";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// ---------- types ----------
type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

// ---------- helpers ----------
async function getFormidable() {
  const mod: any = await import("formidable");
  return mod.default || mod;
}

function isMultipart(req: NextApiRequest) {
  const ct = String(req.headers["content-type"] || "");
  return ct.includes("multipart/form-data");
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

function pickFirst<T = any>(x: T | T[] | undefined | null): T | null {
  if (!x) return null;
  return Array.isArray(x) ? (x[0] ?? null) : (x as any);
}

async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const filePath = file.filepath || file._writeStream?.path || file.originalFilepath || file.path;
  if (!filePath) return null;
  const buf = await fs.readFile(filePath);
  const mime = file.mimetype || "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}

async function fetchedHeadlines(req: NextApiRequest, instrument: string): Promise<any[]> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(instrument)}&hours=48max=12`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json();
    const items = Array.isArray(j?.items) ? j.items : [];
    return items.slice(0, 12).map((it: any) => {
      const s = typeof it?.sentiment?.score === "number" ? it.sentiment.score : null;
      const lab = s == null ? "neu" : s > 0.05 ? "pos" : s < -0.05 ? "neg" : "neu";
      return `• ${String(it?.title || "").slice(0, 200)} (${lab})`;
    });
  } catch {
    return [];
  }
}

function refusalLike(txt: string) {
  const t = (txt || "").toLowerCase();
  if (t.length < 50) return false;
  return /unable to assist|cannot assist|cannot help|can't help|refuse|not able to comply/i.test(t);
}

// extract fenced JSON block labeled ai_meta, or a bare ```json block
function extractAiMeta(text: string): any | null {
  if (!text) return null;
  const fences = [
    /```ai_meta\s*\n([\s\S]*?)```/i,
    /```json\s*\n([\s\S]*?)```/i,
    /```meta\s*\n([\s\S]*?)```/i,
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

// Only allow Market if proof exists; otherwise force pending limit.
function aMetaDemandsPending(aiMeta: any): boolean {
  const entryType = String(aiMeta?.entryType || aiMeta?.entryOrder || "").toLowerCase();
  if (!entryType.includes("market")) return false;
  const bp = aiMeta?.breakoutProof || {};
  const ok = bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true);
  return !ok;
}

// strict price sanity (sell limit must be above price; buy limit below price)
// and block Market without proof.
function invalidOrderRelativeToPrice(aiMeta: any): string | null {
  if (!aiMeta) return "missing ai_meta";

  const side = String(aiMeta.direction || "").toLowerCase();
  const order = String(aiMeta.entryOrder || aiMeta.entryType || "").toLowerCase();
  const p = Number(aiMeta.currentPrice);
  const z = aiMeta.zone || {};
  const zmin = Number(z.min);
  const zmax = Number(z.max);

  if (!Number.isFinite(p)) return "missing current price";

  if (order.includes("market")) {
    const bp = aiMeta.breakoutProof || {};
    const ok = bp.bodyCloseBeyond === true && (bp.retestHolds === true || bp.sfpReclaim === true);
    return ok ? null : "market-without-proof";
  }

  if (!Number.isFinite(zmin) || !Number.isFinite(zmax) || zmin > zmax) return "invalid zone";
  const avg = (zmin + zmax) / 2;

  if (side === "short" || side === "sell") return avg > p ? null : "sell-limit-below-price";
  if (side === "long" || side === "buy") return avg < p ? null : "buy-limit-above-price";
  return "unknown direction";
}

// ---------- OpenAI ----------
async function callOpenAI(messages: any[]) {
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,            // gpt-5-2025-08-07
      messages,
      max_completion_tokens: 1100,    // GPT-5 uses max_completion_tokens (not max_tokens)
    }),
  });
  const json = await rsp.json().catch(() => ({} as any));
  if (!rsp.ok) throw new Error(json?.error?.message || `OpenAI error ${rsp.status}`);
  return String(json?.choices?.[0]?.message?.content ?? "");
}

// ---------- prompts ----------
function tournamentMessages(params: {
  instrument: string;
  dataUrls: { m15: string; h1: string; h4: string; cal?: string | null };
  headlinesText: string | null;
}) {
  const { instrument, dataUrls, headlinesText } = params;

  const system =
    [
      "You are a professional discretionary trader. Produce educational market analysis (NOT financial advice).",
      "Inputs are ONLY chart images for technicals + optional calendar image + a brief headlines snapshot.",
      "No numeric OHLC; infer structure visually (trend, BOS/CHOCH, OB/FB/IB/FVG, S/R, sweeps, range bounds, etc.).",
      "",
      "TOURNAMENT MODE:",
      "Consider multiple strategy candidates (both directions when valid):",
      "- Pullback to OB/FVG/SR, Liquidity sweep reclaim, Breakout+Retest, SFP/liquidity grab+reclaim, Range reversion, trendline/channel retest, or Double-tap.",
      "Score each candidate 0..100 via: HTF alignment(30), Execution clarity(15), Confluence quality(15), Clean path to target(10), Stop validity(10), Fundamentals tilt(10), 'no FOMO' penalty(10).",
      "Pick the top candidate and produce ONE trade card.",
      "",
      "RULES:",
      "• MARKET only if you can explicitly prove breakout: BODY CLOSE beyond the level AND a successful RETEST that HOLDS (or SFP reclaim). Otherwise convert to Pending Limit zone.",
      "• Pending limits must be sided correctly: SELL above current price / BUY below current price.",
      "• If a candidate says 'Breakout + Retest' but proof is weak, normalize to Pullback (OB/FVG/SR) and keep conservative risk.",
      "• Stops: use structure-based (beyond invalidation swing/zone) with small buffer. If too tight, escalate to next structure.",
      "• TP: nearest liquidity/swing/imbalance. Provide TP1 and TP2.",
      "• If calendar image implies elevated risk near 90m, WARN in 'News Event Watch' (do not blackout).",
      "",
      "OUTPUT (exact order):",
      "Quick Plan (Actionable)",
      "• Direction: Long / Short / Stay flat",
      "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
      "• Trigger: Reason/zone touch",
      "• Entry: <min> – <max> (or Market only if proof shown)",
      "• Stop Loss: <beyond which structure>",
      "• Take Profit(s): TP1 <..> / TP2 <..>",
      "• Conviction: <percent>",
      "• Setup: <Chosen Strategy>",
      "• Short Reasoning: ...",
      "",
      "Full Breakdown",
      "• Technical View (HTF + Intraday):",
      "• Fundamental View (Calendar + Sentiment):",
      "• Tech vs Fundy Alignment: Match / Mismatch (+ why)",
      "• Conditional Scenarios:",
      "• Surprise Risk:",
      "• Invalidation:",
      "• One-liner Summary:",
      "",
      "Detected Structures (X-ray):",
      "• 4H: ...",
      "• 1H: ...",
      "• 15m: ...",
      "",
      "Candidate Scores (tournament): one-liners with name + score.",
      "",
      "Final Table Summary:",
      `| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |`,
      `| ${instrument} | ... | ... | ... | ... | ... | ... |`,
      "",
      "At the very end, append a fenced JSON block labeled ai_meta with:",
      "```ai_meta",
      "{",
      `  "selectedStrategy": string,`,
      `  "entryType": "Pending" | "Market",`,
      `  "entryOrder": "Buy Limit" | "Sell Limit" | "Buy Stop" | "Sell Stop" | "Market",`,
      `  "direction": "Long" | "Short" | "Flat",`,
      `  "currentPrice": number | null,`,
      `  "zone": { "min": number, "max": number, "tf": "15m" | "1H" | "4H", "type": "OB" | "FVG" | "SR" | "Other" },`,
      `  "stop": number | null,`,
      `  "tp1": number | null,`,
      `  "tp2": number | null,`,
      `  "breakoutProof": { "bodyCloseBeyond": boolean, "retestHolds": boolean, "sfpReclaim": boolean },`,
      "}",
      "```",
    ].join("\n");

  const content: any[] = [
    { type: "text", text: system },
    { role: "user", content: [{ type: "text", text: `Instrument: ${instrument}` }] },
    { role: "user", content: [{ type: "text", text: "4H Chart:" }, { type: "image_url", image_url: { url: dataUrls.h4 } }] },
    { role: "user", content: [{ type: "text", text: "1H Chart:" }, { type: "image_url", image_url: { url: dataUrls.h1 } }] },
    { role: "user", content: [{ type: "text", text: "15m Chart (execution):" }, { type: "image_url", image_url: { url: dataUrls.m15 } }] },
  ];

  if (dataUrls.cal) {
    content.push({
      role: "user",
      content: [
        { type: "text", text: "Economic Calendar Image (optional):" },
        { type: "image_url", image_url: { url: dataUrls.cal } },
      ],
    });
  }
  if (headlinesText && headlinesText.trim()) {
    content.push({
      role: "user",
      content: [{ type: "text", text: "Recent macro headlines (24–48h):\n" + headlinesText }],
    });
  }

  return [
    { role: "system", content: system },
    ...content,
  ];
}

async function rewriteAsPending(instrument: string, text: string, aiMeta: any) {
  const messages = [
    {
      role: "system",
      content:
        "Rewrite the trade card as PENDING Limit (no Market). Keep tournament section and X-ray.",
    },
    {
      role: "user",
      content: `Instrument: ${instrument}\n\nRewrite this card as Pending Limit only:\n\n${text}`,
    },
  ];
  return await callOpenAI(messages);
}

async function normalizeSetupToPullbackIfNoBreakout(text: string) {
  const messages = [
    {
      role: "system",
      content:
        "If 'Breakout + Retest' is claimed but there is no explicit proof (body close beyond + retest holds or SFP reclaim), rename the setup to Pullback (OB/FVG/SR) and ensure Pending Limit zone. Keep the rest.",
    },
    { role: "user", content: text },
  ];
  return await callOpenAI(messages);
}

// Fabricate a conservative wait-for-trigger fallback (used only on refusal/empty output)
function conservativeFallback(instrument: string, headlinesList: string[], aiMeta?: any) {
  const fallback =
    [
      "Quick Plan (Actionable)",
      "• Direction: Stay Flat (low conviction).",
      "• Entry: Pending @ confluence (OB/FVG/SR) after a clean trigger.",
      "• Stop Loss: beyond invalidation with small buffer.",
      "• Take Profit(s): Prior swing / liquidity, then trail.",
      "• Conviction: 30%",
      "• Setup: Wait/valid trigger (images inconclusive).",
      "",
      "Full Breakdown:",
      "• Technical View: Indecisive; likely range.",
      "• Fundamental View: Mixed; keep size conservative.",
      "• Tech vs Fundy Alignment: Mixed.",
      "• Conditional Scenarios: Break & retest for continuation; SFP & reclaim for reversal.",
      "• Surprise Risk: Headlines; CB speakers.",
      "• Invalidation: Opposite-side body close beyond range edge.",
      "• One-liner Summary: Stand by for a clean trigger.",
      "",
      "Detected Structures (X-ray):",
      "• 4H: –",
      "• 1H: –",
      "• 15m: –",
      "",
      "Final Table Summary:",
      `| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |`,
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
          breakoutProof: { bodyCloseBeyond: false, retestHolds: false, sfpReclaim: false },
        },
        null,
        2
      ),
      "```",
    ].join("\n");

  return fallback;
}

// ---------- handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!isMultipart(req)) {
      return res
        .status(400)
        .json({ ok: false, reason: "Use multipart/form-data with files m15,h1,h4 (PNG/JPG) and optional calendar." });
    }
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    // --- parse form ---
    const { fields, files } = await parseMultipart(req);
    const instrument = String(fields.instrument || fields.code || "EURUSD").toUpperCase().replace("/", "");

    const fM15 = pickFirst(files.m15);
    const fH1 = pickFirst(files.h1);
    const fH4 = pickFirst(files.h4);
    const fCal = pickFirst(files.calendar);

    const [m15Url, h1Url, h4Url, calUrl] = await Promise.all([
      fileToDataUrl(fM15),
      fileToDataUrl(fH1),
      fileToDataUrl(fH4),
      fCal ? fileToDataUrl(fCal) : Promise.resolve(null),
    ]);

    if (!m15Url || !h1Url || !h4Url) {
      return res
        .status(400)
        .json({ ok: false, reason: "Upload all three charts: m15, h1, h4 (PNG/JPG)." });
    }

    const headlinesList = await fetchedHeadlines(req, instrument);
    const headlinesText = headlinesList.length ? headlinesList.join("\n") : null;

    // --- tournament pass ---
    const messages = tournamentMessages({
      instrument,
      dataUrls: { m15: m15Url, h1: h1Url, h4: h4Url, cal: calUrl },
      headlinesText,
    });

    let text = await callOpenAI(messages);
    let aiMeta = extractAiMeta(text);

    // 1) Convert Market → Pending if proof missing
    if (aMetaDemandsPending(aiMeta)) {
      text = await rewriteAsPending(instrument, text, aiMeta);
      aiMeta = extractAiMeta(text) || aiMeta;
    }

    // 2) If labeled Breakout+Retest but no proof -> normalize to Pullback
    if (aiMeta?.selectedStrategy && /breakout/i.test(String(aiMeta.selectedStrategy))) {
      const bp = aiMeta?.breakoutProof || {};
      const ok = bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true);
      if (!ok) {
        text = await normalizeSetupToPullbackIfNoBreakout(text);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // 3) Enforce order vs current price sanity
    if (aiMeta) {
      const reason = invalidOrderRelativeToPrice(aiMeta);
      if (reason) {
        text = await rewriteAsPending(instrument, text, aiMeta);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // 4) Fallback if model refused or output empty
    if (!text || refusalLike(text)) {
      const fb = conservativeFallback(instrument, headlinesList, aiMeta);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        text: fb,
        meta: {
          instrument,
          hasCalendar: !!calUrl,
          headlinesCount: headlinesList.length,
          strategySelection: false,
          rewritten: false,
          fallbackUsed: true,
          aiMeta: extractAiMeta(fb),
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
        headlinesCount: headlinesList.length,
        strategySelection: true,
        rewritten: false,
        fallbackUsed: false,
        aiMeta,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}
