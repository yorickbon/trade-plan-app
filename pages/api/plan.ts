// /pages/api/vision-plan.ts
// Images-only Trade Plan generator with multi-strategy candidate scoring.
// Strong anti-chase rules: prefer Pending pullback/retest; allow Market ONLY on clean breakout+retest.
// Post-check: if output uses "Entry: Market" without explicit breakout+retest proof, auto-rewrite to Pending@Confluence.
// Accepts multipart/form-data with files: m15, h1, h4 (required), calendar (optional).

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";

export const config = {
  api: {
    bodyParser: false, // formidable parses multipart
    sizeLimit: "25mb",
  },
};

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5"; // recommended
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

// ───────────────── helpers ─────────────────

async function getFormidable() {
  const mod: any = await import("formidable");
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
      const score =
        typeof it?.sentiment?.score === "number" ? it.sentiment.score : null;
      return `• ${String(it?.title || "").slice(0, 200)}${
        score !== null ? ` (${score >= 0.05 ? "pos" : score <= -0.05 ? "neg" : "neu"})` : ""
      }`;
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

// ─────────────── Prompt builders ───────────────

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
  const policyHeader = [
    educationalRetry
      ? "You are providing an educational market analysis, NOT financial advice."
      : "You are a meticulous trading analyst.",
    "Use ONLY the provided images for technicals. Never fabricate numeric candles.",
    // ── Anti-chase policy ──
    "SELECTION RULES:",
    "• Prefer PENDING entries (limit at confluence or retest) over Market.",
    "• Allow Entry: Market ONLY if BOTH are explicitly present in your reasoning: (A) a decisive BODY CLOSE beyond the key level, AND (B) a successful RETEST that HOLDS (or a clear SFP-reclaim).",
    "• If those proofs are not present, automatically choose a Pending entry at the best confluence zone (OB/FVG/Fib/SR flip).",
    "• When 4H/1H are bearish and 15m is basing under a 1H supply/OB, BOOST pullback-short over breakout.",
    "• Stops must be price-action based (beyond invalidation). If the first stop is too tight (wick risk), escalate to the next structural extreme with a small buffer.",
    "• Do NOT reject low RR setups; reflect with lower conviction instead.",
  ].join(" ");

  const userTextHeader = [
    "Act as my Trade Plan Assistant.",
    "Use ONLY the provided chart IMAGES for technicals. Do NOT use numeric candles.",
    "Estimate zones from image scales if exact prices are not fully visible; describe levels via structure (OB/FVG/SR/swing anchors).",
    `Instrument: ${instrument}.`,
    "",
    "=== ANALYSIS TASKS ===",
    "1) Multi-TF (4H→1H→15m): trend (HH/HL vs LH/LL), BOS/CHOCH, OB/Supply-Demand, FVGs, SR flip, range bounds, equal highs/lows (liquidity), clear swings.",
    "2) Generate candidates on 15m (both directions where valid):",
    "   • Pullback Confluence (OB + FVG + Fib 0.50–0.62–0.705)",
    "   • Breakout & Retest (body close beyond level + clean retest that holds)",
    "   • Liquidity Sweep / SFP & Reclaim",
    "   • Range Reversion",
    "   • SR Flip",
    "   • Trendline/Channel Break & Retest, Double top/bottom + neckline, Compression/triangle, Flag/pennant (when obvious).",
    "3) Stops: PA-based only; beyond invalidation structure. Escalate to the next structural extreme if needed (small buffer).",
    "4) Fundamentals overlay: use headlines text; if calendar image provided, warn on ±90m window (no blackout).",
    "5) Scoring (0–100): HTF align 25, trigger quality 20, confluence 20, stop validity 15, path to target 10, macro fit 5, ±90m penalty ≤5.",
    "6) Choose TOP candidate by score. If all weak, still print a plan and mark low conviction.",
    "",
    "=== OUTPUT FORMAT (exact structure) ===",
    "Quick Plan (Actionable):",
    "• Direction: Long / Short / Stay Flat",
    "• Entry: Pending @ … (or Market ONLY if you explicitly prove breakout+retest as per rules)",
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
    "• Conditional Scenarios: ...",
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
    "Final Table Summary:",
    "Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction %",
    "",
    "Append:",
    "Chosen Strategy: <name>",
    "Alt Candidates (scores): <name – score/100, …>",
  ].join("\n");

  const userContent: any[] = [
    { type: "text", text: userTextHeader },
    { type: "text", text: "4H Chart:" },
    { type: "image_url", image_url: { url: dataUrls.h4 } },
    { type: "text", text: "1H Chart:" },
    { type: "image_url", image_url: { url: dataUrls.h1 } },
    { type: "text", text: "15M Chart:" },
    { type: "image_url", image_url: { url: dataUrls.m15 } },
  ];

  if (calendarDataUrl) {
    userContent.push({ type: "text", text: "Economic Calendar Image:" });
    userContent.push({ type: "image_url", image_url: { url: calendarDataUrl } });
  }
  if (headlinesText && headlinesText.trim()) {
    userContent.push({
      type: "text",
      text: "Recent headlines snapshot:\n" + headlinesText,
    });
  }

  const messages = [
    { role: "system", content: policyHeader },
    { role: "user", content: userContent },
  ];

  return messages;
}

async function callOpenAI(messages: any[], temperature = 0.18) {
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature,
      messages,
    }),
  });
  if (!rsp.ok) {
    const t = await rsp.text().catch(() => "");
    throw new Error(`OpenAI vision request failed: ${rsp.status} ${t}`);
  }
  const json = await rsp.json();
  const text = (json?.choices?.[0]?.message?.content || "").trim();
  return text;
}

async function askVision(params: {
  instrument: string;
  dataUrls: { m15: string; h1: string; h4: string };
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
}): Promise<string> {
  const messages1 = buildMessages({ ...params, educationalRetry: false });
  let text = await callOpenAI(messages1, 0.18);
  if (refusalLike(text)) {
    const messages2 = buildMessages({ ...params, educationalRetry: true });
    text = await callOpenAI(messages2, 0.22);
  }
  return text;
}

// Post-check for unwanted Market entries (no explicit breakout+retest proof)
function needsPendingRewrite(txt: string): boolean {
  const t = (txt || "").toLowerCase();
  if (!/entry:\s*market/.test(t)) return false;
  // allow market only if these clues appear:
  const hasClose = /(body\s+close|decisive\s+close|strong\s+close)\s+(above|below)/.test(t);
  const hasRetestHold = /(retest\s+that\s+holds|held\s+on\s+retest|successful\s+retest|reclaim\s+and\s+hold)/.test(t);
  const hasSfpReclaim = /(sfp\s+reclaim|sweep\s+and\s+reclaim|liquidity\s+sweep\s+and\s+reclaim)/.test(t);
  const allowed = hasClose && (hasRetestHold || hasSfpReclaim);
  return !allowed;
}

async function rewriteToPending(instrument: string, text: string) {
  const messages = [
    {
      role: "system",
      content:
        "Rewrite the given trade card to use a PENDING pullback/retest entry at the best confluence zone (OB/FVG/Fib/SR flip). Do NOT use 'Entry: Market'. Keep the structure and tone. Keep stops price-action based beyond invalidation. If exact numbers are unclear, use precise zone descriptions anchored to the image structures. Keep the same instrument and scenario. Keep conviction realistic.",
    },
    {
      role: "user",
      content: [
        `Instrument: ${instrument}`,
        "Rewrite this card (no market entries):",
        "```",
        text,
        "```",
      ].join("\n"),
    },
  ];

  const out = await callOpenAI(messages, 0.15);
  return out || text;
}

// ─────────────── handler ───────────────

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
          "Use multipart/form-data with files m15,h1,h4 (optional calendar) and optional text field 'instrument'.",
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

    if (!fM15 || !fH1 || !fH4) {
      return res
        .status(400)
        .json({ ok: false, reason: "Please upload all three charts: m15, h1, h4 (PNG/JPG)." });
    }

    const [m15Url, h1Url, h4Url, calUrl] = await Promise.all([
      fileToDataUrl(fM15),
      fileToDataUrl(fH1),
      fileToDataUrl(fH4),
      fCal ? fileToDataUrl(fCal) : Promise.resolve(null),
    ]);

    if (!m15Url || !h1Url || !h4Url) {
      return res
        .status(400)
        .json({ ok: false, reason: "Could not read one or more uploaded images" });
    }

    const headlinesList = await fetchHeadlines(req, instrument);
    const headlinesText = headlinesList.length ? headlinesList.join("\n") : null;

    // 1) Primary pass (scoring + anti-chase rules in prompt)
    let text = await askVision({
      instrument,
      dataUrls: { m15: m15Url, h1: h1Url, h4: h4Url },
      calendarDataUrl: calUrl || undefined,
      headlinesText,
    });

    // 2) Post-check: if it still used 'Entry: Market' without proof, rewrite to pending
    let pendingRewritten = false;
    if (needsPendingRewrite(text)) {
      text = await rewriteToPending(instrument, text);
      pendingRewritten = true;
    }

    // 3) Final safety: refusal fallback
    if (refusalLike(text)) {
      const fallback = [
        "Quick Plan (Actionable):",
        "• Direction: Stay Flat (low conviction)",
        "• Entry: Pending @ confluence (OB/FVG/SR) after a clean signal",
        "• Stop Loss: Beyond the invalidation structure with small buffer",
        "• Take Profit(s): Prior swing/liquidity, then trail",
        "• Conviction: 30%",
        "• Setup: Await valid trigger (images inconclusive)",
        "• Short Reasoning: The images did not clearly show decisive structure; wait for either a clean pullback rejection or a true breakout & retest.",
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
        "Final Table Summary:",
        "Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction %",
        `${instrument} | Neutral | Wait for trigger | Structure-based | Prior swing | Next liquidity | 30%`,
        "",
        "Chosen Strategy: Await valid trigger",
        "Alt Candidates (scores): none",
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
          pendingRewritten: false,
          fallbackUsed: true,
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
        pendingRewritten,
        fallbackUsed: false,
      },
    });
  } catch (err: any) {
    return res
      .status(200)
      .json({ ok: false, reason: err?.message || "vision plan failed" });
  }
}
