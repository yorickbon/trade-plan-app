// /pages/api/vision-plan.ts
// Images-only Trade Plan generator with multi-strategy candidate scoring.
// Accepts multipart/form-data with files: m15, h1, h4 (required), calendar (optional).

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";

export const config = {
  api: {
    bodyParser: false, // we handle multipart via formidable
    sizeLimit: "25mb",
  },
};

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
// NOTE: default to gpt-4o-mini (works with text+image_url in chat.completions)
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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

// ─────────────── OpenAI Vision via Chat Completions ───────────────

async function askVision(params: {
  instrument: string;
  dataUrls: { m15: string; h1: string; h4: string };
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
}): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const { instrument, dataUrls, calendarDataUrl, headlinesText } = params;

  const userContent: any[] = [
    {
      type: "text",
      text: [
        "Act as my Trade Plan Assistant.",
        "Use ONLY the provided chart IMAGES for technicals. Do NOT use numeric candles. Never fabricate values.",
        `Instrument: ${instrument}.`,
        "",
        "=== ANALYSIS TASKS ===",
        "1) Multi-timeframe structure (4H → 1H → 15m): identify trend (HH/HL vs LH/LL), BOS/CHOCH, key supply/demand (OB), FVGs, SR flip zones, range bounds, equal highs/lows/liquidity, obvious swing points.",
        "2) Generate candidates on 15m execution (BOTH directions where valid):",
        "   • Pullback Confluence (OB + FVG + Fib 0.50–0.62–0.705)",
        "   • Breakout & Retest (range/structure edge; body close beyond, clean retest)",
        "   • Liquidity Sweep / SFP & Reclaim (fake-out through EQH/EQL/swing, then reclaim)",
        "   • Range Reversion (fade edges when range is dominant)",
        "   • SR Flip (prior S→R or R→S; test/hold becomes trigger)",
        "   • Trendline/Channel Break & Retest (if clearly visible)",
        "   • Double top/bottom + neckline break/retest (classic where obvious)",
        "   • Compression/triangle break (where obvious)",
        "   • Momentum push + shallow pullback (flag/pennant if seen)",
        "For each candidate, define Entry/SL/TP1/TP2 from the image levels.",
        "",
        "3) Stops are PRICE-ACTION BASED ONLY:",
        "   • Primary: just beyond the invalidation structure (zone edge, sweep wick, broken/retest level, or last opposing swing).",
        "   • If the first stop is too tight (wick risk), escalate to the NEXT structural extreme (second swing, full OB extreme, or HTF/1H boundary).",
        "   • Add a SMALL buffer relative to the immediate swing/zone size (NOT ATR).",
        "",
        "4) Fundamentals overlay:",
        "   • If headlines provided below, use them for bias only; do not invent facts.",
        "   • If a calendar image is provided, read it and issue a ±90m WARNING (no blackout) if applicable.",
        "",
        "5) Scoring (0–100) for each candidate (use these exact weights):",
        "   • HTF alignment (4H+1H) .......... 25",
        "   • Trigger quality (15m) .......... 20",
        "   • Confluence (OB/FVG/Fib/SR/Liq) . 20",
        "   • Stop validity (PA-based) ........ 15",
        "   • Path to target (opp. struct.) ... 10",
        "   • Macro fit (headlines tone) ...... 5",
        "   • Event risk penalty (±90m) ....... −0..5 (warning-only; still print plan)",
        "   NOTE: Do NOT reject a candidate because RR < 1.5R. RR is not a hard filter.",
        "",
        "6) Choose the TOP candidate by score. If all are weak, still choose one and mark conviction low.",
        "",
        "=== OUTPUT FORMAT (exact structure) ===",
        "Quick Plan (Actionable):",
        "• Direction: Long / Short / Stay Flat",
        "• Entry: Market / Pending @ ...",
        "• Stop Loss: ...",
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
        "• Surprise Risk (unscheduled headlines, politics, CB comments): ...",
        "• Invalidation: ...",
        "• One-liner Summary: ...",
        "",
        "Advanced Reasoning (Pro-Level Context):",
        "• Priority Bias (based on fundamentals)",
        "• Structure Context (retracements, fibs, supply/demand zones)",
        "• Confirmation Logic (e.g., wait for news release, candle confirmation, OB touch)",
        "• How fundamentals strengthen or weaken this technical setup",
        "• Scenario Planning (pre-news vs post-news breakout conviction)",
        "",
        "News Event Watch:",
        "• Upcoming/Recent events to watch and why",
        "",
        "Notes:",
        "• Any extra execution notes",
        "",
        "Final Table Summary:",
        "Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction %",
        "",
        "Append at the end:",
        "Chosen Strategy: <one of the candidates you scored>",
        "Alt Candidates (scores): <name – score/100, …>",
        "",
        "Rules:",
        "• Use ONLY the 4H/1H/15m images for levels. If something is ambiguous on the image, note low confidence.",
        "• Stops must be price-action based as above. No ATR cutoffs. Do not reject low RR setups; reflect with conviction.",
      ].join("\n"),
    },
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

  const rsp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.15,
      messages: [
        {
          role: "system",
          content:
            "You are a meticulous trading analyst. Use ONLY provided images for technicals. Generate multiple PA candidates, score them, choose the best, and print the plan. Be precise. Never invent numeric candles.",
        },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!rsp.ok) {
    const t = await rsp.text().catch(() => "");
    throw new Error(`OpenAI vision request failed: ${rsp.status} ${t}`);
  }
  const json = await rsp.json();
  return (json?.choices?.[0]?.message?.content || "").trim();
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

    const text = await askVision({
      instrument,
      dataUrls: { m15: m15Url, h1: h1Url, h4: h4Url },
      calendarDataUrl: calUrl || undefined,
      headlinesText,
    });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text,
      meta: {
        instrument,
        hasCalendar: !!calUrl,
        headlinesCount: headlinesList.length,
        strategySelection: true,
      },
    });
  } catch (err: any) {
    return res
      .status(200)
      .json({ ok: false, reason: err?.message || "vision plan failed" });
  }
}
