// pages/api/vision-plan.ts
// Images-only Trade Plan generator (NO numeric fallback).
// Expects multipart/form-data with files: m15, h1, h4 (required), calendar (optional), and optional text field "instrument".
// Returns your multiline Trade Card + a small meta block. Uses OpenAI vision (gpt-4o-mini by default).

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";

// Disable Next body parsing so we can read multipart
export const config = {
  api: {
    bodyParser: false,
    sizeLimit: "12mb",
  },
};

type Json = Record<string, any>;

// ---- multipart parsing ----
async function getFormidable() {
  // dynamic import keeps build light
  const mod: any = await import("formidable");
  return mod.default || mod;
}

async function parseMultipart(req: NextApiRequest): Promise<{
  fields: Record<string, any>;
  files: { m15?: any; h1?: any; h4?: any; calendar?: any };
}> {
  const formidable = await getFormidable();
  const form = formidable({
    multiples: false,
    maxFiles: 4,
    maxFileSize: 12 * 1024 * 1024,
    filter: (part: any) =>
      ["m15", "h1", "h4", "calendar"].includes(part.name) &&
      typeof part.mimetype === "string" &&
      part.mimetype.startsWith("image/"),
  });

  return new Promise((resolve, reject) => {
    form.parse(req as any, (err: any, fields: any, files: any) => {
      if (err) return reject(err);
      resolve({
        fields,
        files: {
          m15: Array.isArray(files.m15) ? files.m15[0] : files.m15,
          h1: Array.isArray(files.h1) ? files.h1[0] : files.h1,
          h4: Array.isArray(files.h4) ? files.h4[0] : files.h4,
          calendar: Array.isArray(files.calendar)
            ? files.calendar[0]
            : files.calendar,
        },
      });
    });
  });
}

function getFilePath(file: any) {
  return file?.filepath || file?.path || undefined; // v3 vs v2
}

async function fileToDataUrl(file: any): Promise<string> {
  const fp = getFilePath(file);
  const mimetype = file?.mimetype || "image/png";
  if (!fp || !fs.existsSync(fp)) throw new Error("Uploaded file not found.");
  const b = await fs.promises.readFile(fp);
  return `data:${mimetype};base64,${b.toString("base64")}`;
}

// ---- helpers ----
function getOrigin(req: NextApiRequest): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string) ||
    (process.env.VERCEL ? "https" : "http");
  const host = req.headers.host || "localhost:3000";
  return `${proto}://${host}`;
}

async function fetchHeadlinesText(req: NextApiRequest, instrument?: string) {
  try {
    const origin = getOrigin(req);
    const qs = new URLSearchParams({
      symbols: instrument || "USD,EUR,BTC,XAU",
      hours: process.env.HEADLINES_SINCE_HOURS || "48",
      max: process.env.HEADLINES_MAX || "10",
    }).toString();
    const r = await fetch(`${origin}/api/news?${qs}`);
    if (!r.ok) return "";
    const j = (await r.json()) as Json;
    const items: any[] = Array.isArray(j.items) ? j.items.slice(0, 10) : [];
    const lines = items
      .map((it) => {
        const t = typeof it.title === "string" ? it.title : "";
        const d =
          typeof it.description === "string" && it.description
            ? ` — ${it.description}`
            : "";
        return t ? `• ${`${t}${d}`.slice(0, 240)}` : "";
      })
      .filter(Boolean);
    return lines.join("\n");
  } catch {
    return "";
  }
}

function getModel(): string {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

async function callOpenAIVision(params: {
  instrument?: string;
  m15DataUrl: string;
  h1DataUrl: string;
  h4DataUrl: string;
  calendarDataUrl?: string;
  headlinesText?: string;
}): Promise<string> {
  const { instrument, m15DataUrl, h1DataUrl, h4DataUrl, calendarDataUrl, headlinesText } =
    params;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured.");

  const model = getModel();

  const content: any[] = [
    {
      type: "text",
      text:
        `Act as my Trade Plan Assistant.\n` +
        `Use ONLY the provided chart IMAGES to derive technical zones and structure. Do NOT use numeric candles or external data.\n` +
        `Instrument: ${instrument ?? "Unknown"}.\n\n` +
        `Return the plan in this exact structure:\n` +
        `Quick Plan (Actionable):\n` +
        `• Direction: Long / Short / Stay Flat\n` +
        `• Entry: Market / Pending @ ...\n` +
        `• Stop Loss: ...\n` +
        `• Take Profit(s): TP1 / TP2 …\n` +
        `• Conviction: %\n` +
        `• Short Reasoning: ...\n\n` +
        `Full Breakdown:\n` +
        `• Technical View (HTF + Intraday)\n` +
        `• Fundamental View (Calendar + Sentiment)\n` +
        `• Tech vs Fundy Alignment: Match / Mismatch (why)\n` +
        `• Conditional Scenarios\n` +
        `• Surprise Risk (unscheduled headlines, politics, central bank)\n` +
        `• Invalidation\n` +
        `• One-liner Summary\n\n` +
        `Advanced Reasoning (Pro-Level Context):\n` +
        `• Priority Bias (based on fundamentals)\n` +
        `• Structure Context (retracements, fibs, supply/demand zones)\n` +
        `• Confirmation Logic (e.g., wait for news release, candle confirmation, OB touch)\n` +
        `• How fundamentals strengthen or weaken this technical setup\n` +
        `• Scenario Planning (pre-news vs post-news breakout conviction)\n\n` +
        `News Event Watch:\n` +
        `• Upcoming/Recent events to watch and why\n\n` +
        `Notes:\n` +
        `• Any extra execution notes\n\n` +
        `Final Table Summary (single line): Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction %\n\n` +
        `Rules:\n` +
        `• Derive zones/levels only from the images (4H, 1H, 15M). Be precise.\n` +
        `• If headlines are provided below, use them for fundamentals. If not, keep fundy section minimal.\n` +
        `• If a calendar image is provided, read it to infer bias and create a warning window (no blackout).\n` +
        `• Never fabricate numbers; if uncertain, mark low conviction and explain briefly.`,
    },
    { type: "text", text: "4H Chart:" },
    { type: "image_url", image_url: { url: h4DataUrl } },
    { type: "text", text: "1H Chart:" },
    { type: "image_url", image_url: { url: h1DataUrl } },
    { type: "text", text: "15M Chart:" },
    { type: "image_url", image_url: { url: m15DataUrl } },
  ];

  if (calendarDataUrl) {
    content.push({ type: "text", text: "Economic Calendar Image:" });
    content.push({ type: "image_url", image_url: { url: calendarDataUrl } });
  }
  if (headlinesText && headlinesText.trim()) {
    content.push({
      type: "text",
      text:
        "Recent headlines (last 24–48h) to inform sentiment and News Event Watch:\n" +
        headlinesText,
    });
  }

  const payload = {
    model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You are a meticulous trading analyst. Use ONLY provided images for technicals. Be structured and precise.",
      },
      { role: "user", content },
    ],
  };

  const resp = await fetch(
    (process.env.OPENAI_API_BASE || "https://api.openai.com/v1") +
      "/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${errTxt}`);
  }

  const data = (await resp.json()) as Json;
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// ---- handler ----
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Json>
) {
  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ error: "Method not allowed. Use POST multipart/form-data." });
  }

  try {
    const { fields, files } = await parseMultipart(req);
    const instrument =
      (typeof fields.instrument === "string" && fields.instrument) || undefined;

    const required = [
      ["m15", files.m15],
      ["h1", files.h1],
      ["h4", files.h4],
    ].filter(([_, f]) => !f);

    if (required.length) {
      return res.status(400).json({
        error:
          "Missing required chart images. Please upload all: m15, h1, h4 (PNG/JPG).",
        missing: required.map(([name]) => name),
      });
    }

    const [m15DataUrl, h1DataUrl, h4DataUrl] = await Promise.all([
      fileToDataUrl(files.m15),
      fileToDataUrl(files.h1),
      fileToDataUrl(files.h4),
    ]);
    const calendarDataUrl = files.calendar
      ? await fileToDataUrl(files.calendar)
      : undefined;

    const headlinesText = await fetchHeadlinesText(req, instrument);
    const planText = await callOpenAIVision({
      instrument,
      m15DataUrl,
      h1DataUrl,
      h4DataUrl,
      calendarDataUrl,
      headlinesText,
    });

    const size = (f: any) => {
      const fp = getFilePath(f);
      try {
        return fp && fs.existsSync(fp) ? fs.statSync(fp).size : undefined;
      } catch {
        return undefined;
      }
    };

    const meta = {
      instrument: instrument || null,
      usedVision: true,
      inputs: {
        m15: { size: size(files.m15) },
        h1: { size: size(files.h1) },
        h4: { size: size(files.h4) },
        calendar: files.calendar ? { size: size(files.calendar) } : null,
      },
      warningWindow: false, // calendar warning fine-tuning will come in calendar.ts update
    };

    return res.status(200).json({ text: planText, meta });
  } catch (err: any) {
    return res.status(500).json({
      error:
        typeof err?.message === "string" ? err.message : "Unknown server error.",
    });
  }
}
