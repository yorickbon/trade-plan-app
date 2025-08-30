// pages/api/vision-plan.ts
// Images-only Trade Plan generator (NO numeric fallback).
// Expects multipart/form-data with files: m15, h1, h4 (required), calendar (optional), and an optional text field "instrument".
// Returns a multiline Trade Card + meta. Uses OpenAI vision (gpt-4o-mini by default).

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";

// IMPORTANT: we disable Next's bodyParser to handle multipart uploads.
export const config = {
  api: {
    bodyParser: false,
    sizeLimit: "12mb", // per file max, enforced in formidable too
  },
};

type Json = Record<string, any>;

// Lazy import to avoid type issues if formidable types not present
async function getFormidable() {
  // @ts-ignore
  const formidable = await import("formidable");
  // @ts-ignore
  return formidable.default || formidable;
}

async function parseMultipart(req: NextApiRequest): Promise<{
  fields: Record<string, any>;
  files: {
    m15?: any;
    h1?: any;
    h4?: any;
    calendar?: any;
  };
}> {
  const formidable = await getFormidable();

  const form = formidable({
    multiples: false,
    maxFiles: 4,
    maxFileSize: 12 * 1024 * 1024, // 12MB
    filter: (part: any) => {
      const nameOk = ["m15", "h1", "h4", "calendar"].includes(part.name);
      const mimeOk =
        typeof part.mimetype === "string" &&
        part.mimetype.startsWith("image/");
      return nameOk && mimeOk;
    },
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

async function fileToDataUrl(file: any): Promise<string> {
  const filepath = file?.filepath || file?.path; // formidable v3 vs v2
  const mimetype = file?.mimetype || "image/png";
  if (!filepath || !fs.existsSync(filepath)) {
    throw new Error("Uploaded file path not found.");
  }
  const buff = await fs.promises.readFile(filepath);
  const b64 = buff.toString("base64");
  return `data:${mimetype};base64,${b64}`;
}

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
    // Try to give model some recent context; keep it compact.
    // If instrument not provided, we still fetch generic USD/EUR risk tone.
    const qs = new URLSearchParams({
      symbols: instrument ? instrument : "USD,EUR,BTC,XAU",
      hours: process.env.HEADLINES_SINCE_HOURS || "48",
      max: process.env.HEADLINES_MAX || "10",
    }).toString();

    const res = await fetch(`${origin}/api/news?${qs}`);
    if (!res.ok) return "";
    const json = (await res.json()) as Json;
    const items = Array.isArray(json.items) ? json.items.slice(0, 10) : [];
    if (!items.length) return "";

    const lines: string[] = [];
    for (const it of items) {
      const t = typeof it.title === "string" ? it.title : "";
      const d =
        typeof it.description === "string" && it.description
          ? ` — ${it.description}`
          : "";
      if (t) lines.push(`• ${t}${d}`.slice(0, 240)); // limit length per item
    }
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
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured.");
  }

  const model = getModel();

  // Build a single user message containing text + 3-4 images.
  const content: any[] = [];

  content.push({
    type: "text",
    text:
      `Act as my Trade Plan Assistant. ` +
      `Use ONLY the provided chart IMAGES to derive technical zones and structure. ` +
      `Do NOT use numeric candles or any external data. ` +
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
      `Final Table Summary (single line):\n` +
      `Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction %\n\n` +
      `Rules:\n` +
      `• Derive zones/levels only from the images (4H, 1H, 15M). Be precise.\n` +
      `• If headlines are provided below, use them for fundamentals. If not, keep fundy section minimal.\n` +
      `• If a calendar image is provided, read it to infer bias and create a warning window (no blackout).\n` +
      `• Never fabricate numbers; if uncertain, mark low conviction and explain briefly.`,
  });

  // Add images in HTF → LTF order
  content.push({ type: "text", text: "4H Chart:" });
  content.push({ type: "image_url", image_url: { url: h4DataUrl } });
  content.push({ type: "text", text: "1H Chart:" });
  content.push({ type: "image_url", image_url: { url: h1DataUrl } });
  content.push({ type: "text", text: "15M Chart:" });
  content.push({ type: "image_url", image_url: { url: m15DataUrl } });

  if (calendarDataUrl) {
    content.push({ type: "text", text: "Economic Calendar Image:" });
    content.push({ type: "image_url", image_url: { url: calendarDataUrl } });
  }

  if (headlinesText && headlinesText.trim().length > 0) {
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
          "You are a meticulous trading analyst. Use ONLY provided images for technicals. Be concise, structured, and precise.",
      },
      {
        role: "user",
        content,
      },
    ],
  };

  const resp = await fetch(
    (process.env.OPENAI_API_BASE || "https://api.openai.com/v1") +
      "/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
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
  const text =
    data?.choices?.[0]?.message?.content?.trim() ||
    "No content returned from model.";
  return text;
}

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
      (typeof fields.instrument === "string" && fields.instrument) ||
      undefined;

    const required: Array<["m15" | "h1" | "h4", any]> = [
      ["m15", files.m15],
      ["h1", files.h1],
      ["h4", files.h4],
    ];
    const missing = required.filter(([_, f]) => !f);
    if (missing.length > 0) {
      return res.status(400).json({
        error:
          "Missing required chart images. Please upload all: m15, h1, h4 (PNG/JPG).",
        missing: missing.map(([name]) => name),
      });
    }

    // Convert to data URLs for OpenAI vision
    const [m15DataUrl, h1DataUrl, h4DataUrl] = await Promise.all([
      fileToDataUrl(files.m15),
      fileToDataUrl(files.h1),
      fileToDataUrl(files.h4),
    ]);
    const calendarDataUrl = files.calendar
      ? await fileToDataUrl(files.calendar)
      : undefined;

    // Optional: fetch recent headlines from our own /api/news (kept short)
    const headlinesText = await fetchHeadlinesText(req, instrument);

    // Call OpenAI vision with images + optional headlines and calendar image
    const planText = await callOpenAIVision({
      instrument,
      m15DataUrl,
      h1DataUrl,
      h4DataUrl,
      calendarDataUrl,
      headlinesText,
    });

    // We expose a minimal meta for debugging. Calendar warning tuning will be refined in calendar.ts later step.
    const meta = {
      instrument: instrument || null,
      usedVision: true,
      inputs: {
        m15: { size: fs.existsSync(files.m15?.filepath) ? fs.statSync(files.m15.filepath).size : undefined },
        h1: { size: fs.existsSync(files.h1?.filepath) ? fs.statSync(files.h1.filepath).size : undefined },
        h4: { size: fs.existsSync(files.h4?.filepath) ? fs.statSync(files.h4.filepath).size : undefined },
        calendar: files.calendar
          ? {
              size: fs.existsSync(files.calendar?.filepath)
                ? fs.statSync(files.calendar.filepath).size
                : undefined,
            }
          : null,
      },
      // Placeholder: set by model text today; we’ll add programmatic warning in a later calendar.ts update.
      warningWindow: false,
    };

    return res.status(200).json({ text: planText, meta });
  } catch (err: any) {
    const msg =
      typeof err?.message === "string" ? err.message : "Unknown server error.";
    return res.status(500).json({ error: msg });
  }
}
