// /pages/api/vision-plan.ts
// Images-only planner: m15 (execution), 1H + 4H context, optional calendar image.
// Base kept as-is; minimal additions:
//  - Force GPT-5 compatibility (max_completion_tokens) so it completes consistently.
//  - Add Option 2 (Market) when breakout proof exists; otherwise Pending only.
//  - If model returns JSON-only ai_meta, synthesize a readable card around it (no strategy change).
//  - Keep your backfill for currentPrice; keep sanity checks/rewrite only when needed.

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";

export const config = {
  api: { bodyParser: false, sizeLimit: "25mb" },
};

type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-2025-08-07";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// ---------- helpers (unchanged style + small additions) ----------

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
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}

async function fetchedHeadlines(req: NextApiRequest, instrument: string) {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(
      instrument
    )}&hours=48&max=12&t=${Date.now()}`;
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
        return `• ${t} — ${src}${when ? `, ${when}` : ""} — ${lab}`;
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
  // look for ```ai_meta ...``` or ```json ... ```
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

// detect JSON-only replies so we can synthesize a readable card (no strategy change)
function looksJsonOnly(text: string): boolean {
  const t = (text || "").trim();
  return /^```(json|ai_meta)/i.test(t) || (!/Quick Plan\s*\(Actionable\)/i.test(t) && /"selectedStrategy"\s*:/.test(t));
}

// Market entry allowed only if proof of breakout+retest (or SFP reclaim)
function needsPendingLimit(aiMeta: any): boolean {
  const et = String(aiMeta?.entryType || "").toLowerCase(); // "market" | "pending"
  if (et !== "market") return false;
  const bp = aiMeta?.breakoutProof || {};
  const ok =
    bp?.bodyCloseBeyond === true &&
    (bp?.retestHolds === true || bp?.sfpReclaim === true);
  return !ok; // if not proven, require Pending
}

// invalid Buy/Sell Limit vs current price and zone
function invalidOrderRelativeToPrice(aiMeta: any): string | null {
  const o = String(aiMeta?.entryOrder || "").toLowerCase(); // buy limit / sell limit
  const dir = String(aiMeta?.direction || "").toLowerCase(); // long / short / flat
  const z = aiMeta?.zone || {};
  const p = Number(aiMeta?.currentPrice);
  const zmin = Number(z?.min);
  const zmax = Number(z?.max);
  if (!isFinite(p) || !isFinite(zmin) || !isFinite(zmax)) return null;

  if (o === "sell limit" && dir === "short") {
    // zone must be ABOVE current price (pullback into supply)
    if (Math.max(zmin, zmax) <= p) return "sell-limit-below-price";
  }
  if (o === "buy limit" && dir === "long") {
    // zone must be BELOW current price (pullback into demand)
    if (Math.min(zmin, zmax) >= p) return "buy-limit-above-price";
  }
  return null;
}

// build a minimal readable card from ai_meta (used ONLY if model returns JSON-only)
function synthesizeCardFromMeta(instrument: string, m: any): string {
  const dir = m?.direction ?? "Flat";
  const et = m?.entryType ?? "Pending";
  const eo = m?.entryOrder ? ` (${m.entryOrder})` : "";
  const zone =
    m?.zone && typeof m.zone === "object"
      ? `${m.zone.min ?? "?"} – ${m.zone.max ?? "?"}`
      : m?.zone ?? "—";
  const stop = m?.stop ?? "—";
  const tp1 = m?.tp1 ?? "—";
  const tp2 = m?.tp2 ?? "—";
  const conv =
    m?.candidateScores?.[0]?.score ??
    (typeof m?.conviction === "number" ? m.conviction : 50);
  const strat = m?.selectedStrategy ?? "Unknown";

  const lines: string[] = [
    "Quick Plan (Actionable)",
    "",
    `• Direction: ${dir}`,
    `• Order Type: ${m?.entryOrder || et}`,
    `• Trigger: ${et === "Market" ? "Break & Retest proof" : "Limit pullback / zone touch"}`,
    `• Entry: ${m?.currentPrice && et === "Market" ? String(m.currentPrice) : zone}`,
    `• Stop Loss: ${stop}`,
    `• Take Profit(s): TP1 ${tp1} / TP2 ${tp2}`,
    `• Conviction: ${conv}%`,
    `• Setup: ${strat}`,
    `• Short Reasoning: Synthesized from ai_meta.`,
    "",
  ];

  // If marketAllowed is present, add Option 2 (Market)
  if (m?.marketAllowed) {
    const mConv = Math.max(0, Number(conv) - 5);
    const mPrice = Number.isFinite(Number(m?.currentPrice)) ? String(m.currentPrice) : "Market";
    lines.push(
      "Option 2 (Market)",
      `• Entry: ${mPrice}`,
      `• Stop Loss: ${stop}`,
      `• Take Profit(s): TP1 ${tp1} / TP2 ${tp2}`,
      `• Conviction: ${mConv}%`,
      ""
    );
  }

  return lines.join("\n");
}

// --- OpenAI call (chat/completions with vision parts). GPT-5 compatibility.
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
      // GPT-5: use max_completion_tokens, no custom temperature
      max_completion_tokens: 1100,
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
    "Perform VISUAL price-action analysis from the images (no numeric candles).",
    "Multi-timeframe alignment: 15m execution, 1H context, 4H HTF.",
    "Run a small tournament and pick ONE best setup (test both sides if valid):",
    "- Pullback to OB/FVG/SR confluence, Breakout+Retest, SFP/liquidity-grab+reclaim, Range reversion, TL/channel retest, Double-tap.",
    "Scoring rubric (0–100): Structure trend(25), 15m trigger(25), HTF context(15), Clean path(10), Stop validity(10), Fundamentals(10), No-chase penalty(5).",
    "",
    // Market handling (explicit):
    "Market order is OPTIONAL and allowed ONLY with explicit proof:",
    "  • Large body CLOSE beyond the level AND a successful RETEST that HOLDS, OR",
    "  • Clean SFP reclaim.",
    "If no proof, prefer a Pending LIMIT at OB/FVG/SR on the correct side of price.",
    "Stops just beyond invalidation (swing/zone) with small buffer. RR may be <1.5R if structure justifies it.",
    "Use calendar/headlines for bias overlay if provided.",
    "",
    "OUTPUT format (exact headings, keep concise):",
    "Quick Plan (Actionable)",
    "• Direction: Long | Short | Stay Flat",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger: (e.g., Limit pullback / zone touch or Break & Retest)",
    "• Entry: <min–max> or a specific level (Market only if proof shown)",
    "• Stop Loss: <level>",
    "• Take Profit(s): TP1 <level> / TP2 <level>",
    "• Conviction: <0–100>%",
    "• Setup: <Chosen Strategy>",
    "• Short Reasoning: <1–2 lines>",
    "",
    "Full Breakdown",
    "• Technical View (HTF + Intraday): 4H / 1H / 15m structure",
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
    // REQUIRE ai_meta and Option 2 when allowed
    "At the very end, append a fenced JSON block labeled ai_meta with ALL fields present:",
    "```ai_meta",
    `{ "selectedStrategy": string,`,
    `  "entryType": "Pending" | "Market",`,
    `  "entryOrder": "Sell Limit" | "Buy Limit" | "Sell Stop" | "Buy Stop" | "Market",`,
    `  "direction": "Long" | "Short" | "Flat",`,
    `  "currentPrice": number,  // REQUIRED: approx last price from 15m; do NOT return null`,
    `  "zone": { "min": number, "max": number, "tf": "15m" | "1H" | "4H", "type": "OB" | "FVG" | "SR" | "Other" },`,
    `  "stop": number, "tp1": number, "tp2": number,`,
    `  "breakoutProof": { "bodyCloseBeyond": boolean, "retestHolds": boolean, "sfpReclaim": boolean },`,
    `  "candidateScores": [{ "name": string, "score": number, "reason": string }],`,
    `  "marketAllowed": boolean // set true ONLY if proof exists`,
    `}`,
    "```",
    "",
    // Also instruct the model to include Option 2 when allowed (so we avoid rewrites)
    "If marketAllowed is true, include an extra short section titled 'Option 2 (Market)' with Entry (currentPrice), SL, TP1/TP2 and Conviction (~5% lower than Pending).",
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

// Tiny backfill: if currentPrice is missing, ask model for a single number from the 15m image
async function backfillCurrentPrice(instrument: string, imgs: { m15: string; h1: string; h4: string; cal?: string | null }) {
  const messages = [
    {
      role: "system",
      content:
        "Return ONLY a number (no words): the approximate current/last traded price read from the 15m chart image. If unreadable, give your best numeric estimate from visible levels. No commas, no currency symbols.",
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Instrument: ${instrument}` },
        { type: "text", text: "15m Chart (execution):" },
        { type: "image_url", image_url: { url: imgs.m15 } },
      ],
    },
  ];
  const txt = (await callOpenAI(messages)).trim();
  const m = txt.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// If ai_meta says marketAllowed but the card forgot to include "Option 2 (Market)", append it.
function appendMarketOptionIfMissing(text: string, aiMeta: any): string {
  if (!aiMeta?.marketAllowed) return text;
  if (/Option 2\s*\(Market\)/i.test(text)) return text; // already there
  const stop = aiMeta?.stop ?? "—";
  const tp1 = aiMeta?.tp1 ?? "—";
  const tp2 = aiMeta?.tp2 ?? "—";
  const baseConv =
    aiMeta?.candidateScores?.[0]?.score ??
    (typeof aiMeta?.conviction === "number" ? aiMeta.conviction : 50);
  const mConv = Math.max(0, Number(baseConv) - 5);
  const entry =
    Number.isFinite(Number(aiMeta?.currentPrice)) && aiMeta.currentPrice != null
      ? String(aiMeta.currentPrice)
      : "Market";

  // append right before the fenced ai_meta block if present
  const block = [
    "",
    "Option 2 (Market)",
    `• Entry: ${entry}`,
    `• Stop Loss: ${stop}`,
    `• Take Profit(s): TP1 ${tp1} / TP2 ${tp2}`,
    `• Conviction: ${mConv}%`,
    "",
  ].join("\n");

  const idx = text.search(/```(?:ai_meta|json)/i);
  if (idx >= 0) {
    return text.slice(0, idx) + block + text.slice(idx);
  }
  return text + block;
}

// ---------- handler (base kept; only minimal logic added) ----------

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
          "Use multipart/form-data with files: m15, h1, h4 (PNG/JPG) and optional 'calendar'. Include 'instrument' field from the dropdown.",
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

    const [m15, h1, h4, calUrl] = await Promise.all([
      fileToDataUrl(m15f),
      fileToDataUrl(h1f),
      fileToDataUrl(h4f),
      calF ? fileToDataUrl(calF) : Promise.resolve(null),
    ]);

    if (!m15 || !h1 || !h4) {
      return res
        .status(400)
        .json({ ok: false, reason: "Upload all three charts: m15, h1, h4 (PNG/JPG)." });
    }

    const headlinesText = await fetchedHeadlines(req, instrument);
    const dateStr = new Date().toISOString().slice(0, 10);

    // 1) Tournament pass
    const tourMsgs = tournamentMessages({
      instrument,
      dateStr,
      calendarDataUrl: calUrl || undefined,
      headlinesText: headlinesText || undefined,
      m15,
      h1,
      h4,
    });
    let text = await callOpenAI(tourMsgs);

    // If JSON-only, synthesize readable card (prevents “ai_meta only” screens)
    if (looksJsonOnly(text)) {
      const metaFromJson = extractAiMeta(text) || {};
      const card = synthesizeCardFromMeta(instrument, metaFromJson);
      text = [card, "", "```ai_meta", JSON.stringify(metaFromJson, null, 2), "```"].join("\n");
    }

    let aiMeta = extractAiMeta(text);

    // 1a) Backfill currentPrice if missing
    if (!aiMeta || !Number.isFinite(Number(aiMeta.currentPrice))) {
      const cp = await backfillCurrentPrice(instrument, { m15, h1, h4, cal: calUrl || undefined });
      if (Number.isFinite(cp)) {
        aiMeta = { ...(aiMeta || {}), currentPrice: Number(cp) };
      }
    }

    // 2) Force Pending if Market without proof (rewrite only if needed)
    if (aiMeta && needsPendingLimit(aiMeta)) {
      const messages = [
        {
          role: "system",
          content:
            "Rewrite the trade card as PENDING LIMIT (no Market) unless explicit breakout proof is present (body close beyond + retest holds or SFP reclaim). Keep tournament and X-ray.",
        },
        { role: "user", content: `Instrument: ${instrument}\n\n${text}` },
      ];
      text = await callOpenAI(messages);
      aiMeta = extractAiMeta(text) || aiMeta;
      if (!Number.isFinite(Number(aiMeta.currentPrice)) && Number.isFinite(Number(aiMeta?.currentPrice))) {
        aiMeta.currentPrice = Number(aiMeta.currentPrice);
      }
    }

    // 3) Enforce order vs current price (Sell Limit above / Buy Limit below)
    if (aiMeta) {
      const bad = invalidOrderRelativeToPrice(aiMeta);
      if (bad) {
        const messages = [
          {
            role: "system",
            content:
              "Adjust ONLY the LIMIT zone so it’s on the correct side of current price (Sell Limit above price into supply; Buy Limit below price into demand). Keep format and all other sections untouched.",
          },
          {
            role: "user",
            content:
              `Instrument: ${instrument}\n` +
              `Current Price: ${aiMeta.currentPrice}\n` +
              `Provided Zone: ${JSON.stringify(aiMeta.zone)}\n\n` +
              `Card:\n${text}\n\n` +
              `Fix only the LIMIT side/entry.`,
          },
        ];
        text = await callOpenAI(messages);
        aiMeta = extractAiMeta(text) || aiMeta;
        if (!Number.isFinite(Number(aiMeta.currentPrice)) && Number.isFinite(Number(aiMeta?.currentPrice))) {
          aiMeta.currentPrice = Number(aiMeta.currentPrice);
        }
      }
    }

    // 4) If marketAllowed but card forgot to show Option 2, append it (no rewrite needed)
    if (aiMeta?.marketAllowed) {
      text = appendMarketOptionIfMissing(text, aiMeta);
    }

    // 5) Fallback if refusal/empty
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
              breakoutProof: {
                bodyCloseBeyond: false,
                retestHolds: false,
                sfpReclaim: false,
              },
              candidateScores: [],
              note: "Fallback used due to refusal/empty output.",
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
          headlinesCount: headlinesText ? headlinesText.length : 0,
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
