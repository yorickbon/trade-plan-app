// /pages/api/vision-plan.ts
// Images-only Trade Plan generator (NO numeric fallback).
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
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

type Json = Record<string, any>;
type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

/* ───────────────── helpers ───────────────── */

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

/* ─────────────── OpenAI Vision (Responses API) ─────────────── */

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
      type: "input_text",
      text: [
        "Act as my Trade Plan Assistant.",
        "Use ONLY the provided chart IMAGES to derive technical zones and structure. Do NOT use numeric candles.",
        `Instrument: ${instrument}.`,
        "",
        "Return the plan in this exact structure:",
        "Quick Plan (Actionable):",
        "• Direction: Long / Short / Stay Flat",
        "• Entry: Market / Pending @ …",
        "• Stop Loss: …",
        "• Take Profit(s): TP1 / TP2 …",
        "• Conviction: %",
        "• Short Reasoning: …",
        "",
        "Full Breakdown:",
        "• Technical View (HTF + Intraday)",
        "• Fundamental View (Calendar + Sentiment)",
        "• Tech vs Fundy Alignment: Match / Mismatch (why)",
        "• Conditional Scenarios",
        "• Surprise Risk (unscheduled headlines, politics, central bank comments)",
        "• Invalidation",
        "• One-liner Summary",
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
        "Final Table Summary (single line): Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction %",
        "",
        "Rules:",
        "• Derive zones/levels only from the images (4H, 1H, 15M). Be precise.",
        "• If headlines are provided below, use them for fundamentals.",
        "• If a calendar image is provided, read it to infer bias and create a warning window (no blackout).",
        "• Never fabricate numbers; if uncertain, mark low conviction and explain briefly.",
      ].join("\n"),
    },
    { type: "input_text", text: "4H Chart:" },
    { type: "input_image", image_url: { url: dataUrls.h4 } },
    { type: "input_text", text: "1H Chart:" },
    { type: "input_image", image_url: { url: dataUrls.h1 } },
    { type: "input_text", text: "15M Chart:" },
    { type: "input_image", image_url: { url: dataUrls.m15 } },
  ];

  if (calendarDataUrl) {
    userContent.push({ type: "input_text", text: "Economic Calendar Image:" });
    userContent.push({ type: "input_image", image_url: { url: calendarDataUrl } });
  }
  if (headlinesText && headlinesText.trim()) {
    userContent.push({
      type: "input_text",
      text: "Recent headlines snapshot:\n" + headlinesText,
    });
  }

  const resp = await fetch(
    (process.env.OPENAI_API_BASE || "https://api.openai.com/v1") + "/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: "You are a meticulous trading analyst. Use ONLY provided images for technicals. Be structured and precise." }],
          },
          {
            role: "user",
            content: userContent,
          },
        ],
      }),
    }
  );

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI vision request failed: ${resp.status} ${txt}`);
  }
  const data = (await resp.json()) as Json;
  // Responses API convenience field:
  return (data?.output_text ||
          data?.output?.[0]?.content?.[0]?.text ||
          "").trim();
}

/* ─────────────── handler ─────────────── */

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
      },
    });
  } catch (err: any) {
    return res
      .status(200)
      .json({ ok: false, reason: err?.message || "vision plan failed" });
  }
}
