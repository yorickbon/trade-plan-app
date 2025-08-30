// /pages/api/vision-plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";

export const config = {
  api: {
    bodyParser: false,           // we parse multipart via formidable
    sizeLimit: "25mb",
  },
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

type Ok = {
  ok: true;
  text: string;
  conviction?: number;
  meta?: any;
};
type Err = { ok: false; reason: string };

// ───────────────────────── helpers ─────────────────────────

async function getFormidable() {
  // dynamic import keeps build small and avoids type headaches
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
    multiples: true,
    maxFileSize: 25 * 1024 * 1024,
  });
  return new Promise<{ fields: Record<string, any>; files: Record<string, any> }>((resolve, reject) => {
    form.parse(req as any, (err: any, fields: any, files: any) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

function pickFirst<T = any>(x: T | T[] | undefined | null): T | null {
  if (!x) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  // formidable v2/v3 use .filepath (sometimes .path); support both
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

// pull a few headlines to give the model macro context (titles only)
async function fetchHeadlines(req: NextApiRequest, instrument: string) {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(instrument)}&hours=48&max=10`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json();
    const items = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
    return items.slice(0, 10).map((it: any) => ({
      title: String(it?.title || "").slice(0, 200),
      source: it?.source || "",
      sentiment: typeof it?.sentiment?.score === "number" ? it.sentiment.score : null,
    }));
  } catch {
    return [];
  }
}

// OpenAI Vision call (images only for levels/zones)
async function askVision({
  instrument,
  dataUrls,
  calendarDataUrl,
  headlines,
}: {
  instrument: string;
  dataUrls: { m15: string; h1: string; h4: string };
  calendarDataUrl?: string | null;
  headlines: Array<{ title: string; source?: string; sentiment?: number | null }>;
}): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const content: any[] = [
    {
      type: "input_text",
      text: [
        "You are my Trade Plan Assistant.",
        "IMPORTANT: Use ONLY the chart screenshots for technical levels (zones/entries/SL/TP).",
        "Completely ignore any numeric OHLC arrays — you do NOT have them.",
        "Use multi-timeframe logic: 4H trend/context, 1H structure, 15M execution.",
        "Calendar image (if provided) gives actual vs forecast; use it for bias but do not invent numbers.",
        "Headlines (provided as short titles) give macro sentiment.",
        "Always return my template exactly.",
        "",
        "Template:",
        "Quick Plan (Actionable):",
        "• Direction: Long / Short / Stay Flat",
        "• Entry: Market / Pending @ …",
        "• Stop Loss: …",
        "• Take Profit(s): TP1 … / TP2 …",
        "• Conviction: %",
        "• Short Reasoning: …",
        "",
        "Full Breakdown:",
        "• Technical View (HTF + Intraday): …",
        "• Fundamental View (Calendar + Sentiment): …",
        "• Tech vs Fundy Alignment: Match / Mismatch (why)",
        "• Conditional Scenarios: …",
        "• Surprise Risk (unscheduled headlines, politics, central bank comments): …",
        "• Invalidation: …",
        "• One-liner Summary: …",
        "",
        "Advanced Reasoning (Pro-Level Context):",
        "• Priority Bias (based on fundamentals): …",
        "• Structure Context (retracements, fibs, supply/demand zones): …",
        "• Confirmation Logic (e.g., wait for news release, candle confirmation, OB touch): …",
        "• How fundamentals strengthen or weaken this technical setup: …",
        "• Scenario Planning (pre-news vs post-news breakout conviction): …",
        "",
        `Instrument: ${instrument}. Make levels precise from the images. If clarity is low, clearly mark 'low conviction' but still provide a plan.`,
      ].join("\n"),
    },
    { type: "input_text", text: "4H Chart:" },
    { type: "input_image", image_url: { url: dataUrls.h4 } },
    { type: "input_text", text: "1H Chart:" },
    { type: "input_image", image_url: { url: dataUrls.h1 } },
    { type: "input_text", text: "15M Chart (execution):" },
    { type: "input_image", image_url: { url: dataUrls.m15 } },
  ];

  if (calendarDataUrl) {
    content.push({ type: "input_text", text: "Economic Calendar (today/yesterday):" });
    content.push({ type: "input_image", image_url: { url: calendarDataUrl } });
  }

  if (headlines.length) {
    content.push({
      type: "input_text",
      text:
        "Recent headline snapshot (title • optional sentiment):\n" +
        headlines
          .map((h) => `• ${h.title}${typeof h.sentiment === "number" ? ` (${h.sentiment >= 0.05 ? "pos" : h.sentiment <= -0.05 ? "neg" : "neu"})` : ""}`)
          .join("\n")
          .slice(0, 2500),
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
      temperature: 0.2,
      messages: [
        { role: "system", content: "You are a precise trading assistant. Never invent numeric OHLC data; derive levels only from the provided images." },
        { role: "user", content },
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

// ───────────────────────── handler ─────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!isMultipart(req)) return res.status(400).json({ ok: false, reason: "Use multipart/form-data with images m15,h1,h4 (optional calendar)" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    const { fields, files } = await parseMultipart(req);

    const instrument = String(fields.instrument || fields.code || "EURUSD").toUpperCase().replace(/\s+/g, "");
    const fM15 = pickFirst(files.m15);
    const fH1 = pickFirst(files.h1);
    const fH4 = pickFirst(files.h4);
    const fCal = pickFirst(files.calendar);

    if (!fM15 || !fH1 || !fH4) {
      return res.status(400).json({ ok: false, reason: "Please upload all three charts: m15, h1, h4" });
    }

    const [m15Url, h1Url, h4Url, calUrl] = await Promise.all([
      fileToDataUrl(fM15),
      fileToDataUrl(fH1),
      fileToDataUrl(fH4),
      fCal ? fileToDataUrl(fCal) : Promise.resolve(null),
    ]);

    if (!m15Url || !h1Url || !h4Url) {
      return res.status(400).json({ ok: false, reason: "Could not read one or more uploaded images" });
    }

    // headlines for context (titles only)
    const headlines = await fetchHeadlines(req, instrument);

    const text = await askVision({
      instrument,
      dataUrls: { m15: m15Url, h1: h1Url, h4: h4Url },
      calendarDataUrl: calUrl || undefined,
      headlines,
    });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text,
      meta: {
        instrument,
        hasCalendar: !!calUrl,
        headlinesCount: headlines.length,
      },
    });
  } catch (err: any) {
    console.error("vision-plan error:", err?.message || err);
    return res.status(200).json({ ok: false, reason: err?.message || "vision plan failed" });
  }
}
