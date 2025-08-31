// /pages/api/vision-plan.ts
// Images-only planner: pick the best idea by scoring multiple strategies.
// Upload: m15 (execution), h1 (context), h4 (HTF), optional calendar.
// BASE PRESERVED. Minimal additions ONLY:
// 1) Option 2 — Market (independent conviction) when breakout-proof OR already-at-entry.
// 2) Small guard to ALWAYS deliver an actionable idea (never "Stay Flat").
//    If model returns JSON-only/empty: synthesize full card from ai_meta (same sections).

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
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// ---------- helpers (BASE) ----------

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
    )}&hours=48&max=12`;
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
        return `• ${t} — ${src}, ${when} — ${lab}`;
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

// ---------- Option 2 (minimal additions) ----------

// breakout proof rule for Market (kept exactly as requested)
function hasBreakoutProof(aiMeta: any): boolean {
  const bp = aiMeta?.breakoutProof || {};
  return !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
}

// allow Market also if we are already inside the entry zone (tiny tolerance)
function alreadyAtEntry(aiMeta: any): boolean {
  const p = Number(aiMeta?.currentPrice);
  const z = aiMeta?.zone || {};
  const zmin = Number(z?.min);
  const zmax = Number(z?.max);
  if (!isFinite(p) || !isFinite(zmin) || !isFinite(zmax)) return false;
  const tol = Math.abs(p) * 0.0005; // ~0.05%
  const lo = Math.min(zmin, zmax) - tol;
  const hi = Math.max(zmin, zmax) + tol;
  return p >= lo && p <= hi;
}

// if model chose Market but no proof, force Pending (your existing rule)
function needsPendingLimit(aiMeta: any): boolean {
  const et = String(aiMeta?.entryType || "").toLowerCase();
  if (et !== "market") return false;
  return !hasBreakoutProof(aiMeta);
}

// sanity: Sell Limit must be above / Buy Limit below current price
function invalidOrderRelativeToPrice(aiMeta: any): string | null {
  const o = String(aiMeta?.entryOrder || "").toLowerCase();
  const dir = String(aiMeta?.direction || "").toLowerCase();
  const z = aiMeta?.zone || {};
  const p = Number(aiMeta?.currentPrice);
  const zmin = Number(z?.min);
  const zmax = Number(z?.max);
  if (!isFinite(p) || !isFinite(zmin) || !isFinite(zmax)) return null;

  if (o === "sell limit" && dir === "short") {
    if (Math.max(zmin, zmax) <= p) return "sell-limit-below-price";
  }
  if (o === "buy limit" && dir === "long") {
    if (Math.min(zmin, zmax) >= p) return "buy-limit-above-price";
  }
  return null;
}

// parse "Conviction: 62%"
function parseConvictionPercent(text: string): number | null {
  const m = text.match(/Conviction:\s*~?\s*(\d{1,3})\s*%/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// inject Option 2 — Market before "Full Breakdown"
function injectOption2Market(text: string, aiMeta: any, convPending: number): string {
  const cp = Number(aiMeta?.currentPrice);
  const stop = aiMeta?.stop ?? "Same as Option 1";
  const tp1 = aiMeta?.tp1 ?? "Same as Option 1";
  const tp2 = aiMeta?.tp2 ?? "Same as Option 1";

  // independent conviction: pending ± small bonuses, capped
  let convMarket = convPending;
  if (hasBreakoutProof(aiMeta)) convMarket += 5;
  if (alreadyAtEntry(aiMeta)) convMarket += 3;
  convMarket = Math.max(0, Math.min(95, convMarket));

  const option = [
    "",
    "Option 2 — Market",
    `• Order Type: Market`,
    `• Entry: ${Number.isFinite(cp) ? cp : "current price"}`,
    `• Stop Loss: ${typeof stop === "number" ? stop : String(stop)}`,
    `• Take Profit(s): TP1 ${typeof tp1 === "number" ? tp1 : String(tp1)} / TP2 ${typeof tp2 === "number" ? tp2 : String(tp2)}`,
    `• Conviction: ${convMarket}%`,
  ].join("\n");

  const idx = text.search(/(^|\n)Full Breakdown/i);
  if (idx !== -1) return text.slice(0, idx) + "\n" + option + "\n" + text.slice(idx);
  return text + "\n" + option;
}

// upsert ai_meta fence after edits
function upsertAiMetaFence(text: string, aiMeta: any) {
  const block = "```ai_meta\n" + JSON.stringify(aiMeta, null, 2) + "\n```";
  if (/```ai_meta[\s\S]*?```/i.test(text)) return text.replace(/```ai_meta[\s\S]*?```/i, block);
  return text.trim() + "\n\n" + block;
}

// ---------- OpenAI call (BASE) ----------

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
      max_completion_tokens: 1600, // stability only
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

// ---------- prompt builders (BASE + one line to always give a trade idea) ----------

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
    "Perform **visual** price-action market analysis from the images (no numeric candles).",
    "Multi-timeframe alignment: 15m execution, 1H context, 4H HTF.",
    "Tournament mode: score candidates (Long/Short where valid):",
    "- Pullback to OB/FVG/SR confluence, Breakout+Retest, SFP/Liquidity grab+reclaim, Range reversion, TL/channel retest, double-tap when clean.",
    "Scoring rubric (0–100): Structure trend(25), 15m trigger quality(25), HTF context(15), Clean path to target(10), Stop validity(10), Fundamentals/Headlines(10), 'No chase' penalty(5).",
    "Market entry allowed only when **explicit proof**: body close beyond level **and** retest holds (or SFP reclaim). Otherwise label EntryType: Pending and use Buy/Sell Limit zone.",
    "Stops just beyond invalidation (swing/zone) with small buffer. RR can be < 1.5R if structure says so.",
    "Use calendar/headlines as bias overlay if provided.",
    "",
    "**IMPORTANT: Always output at least ONE actionable trade idea (Long or Short). Do NOT return a 'Stay Flat' plan. If conviction is low, mark it low but still provide the setup.**",
    "",
    "OUTPUT format:",
    "Quick Plan (Actionable)",
    "",
    "• Direction: Long | Short | Stay Flat",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger: (ex: Limit pullback / zone touch)",
    "• Entry: <min–max> or specific level",
    "• Stop Loss: <level>",
    "• Take Profit(s): TP1 <level> / TP2 <level>",
    "• Conviction: <0–100>%",
    "• Setup: <Chosen Strategy>",
    "• Short Reasoning: <1–2 lines>",
    "",
    "Full Breakdown",
    "• Technical View (HTF + Intraday): 4H/1H/15m structure",
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
    "At the very end, append a fenced JSON block labeled ai_meta with:",
    "```ai_meta",
    `{ "selectedStrategy": string,`,
    `  "entryType": "Pending" | "Market",`,
    `  "entryOrder": "Sell Limit" | "Buy Limit" | "Sell Stop" | "Buy Stop" | "Market",`,
    `  "direction": "Long" | "Short" | "Flat",`,
    `  "currentPrice": number | null,`,
    `  "zone": { "min": number, "max": number, "tf": "15m" | "1H" | "4H", "type": "OB" | "FVG" | "SR" | "Other" },`,
    `  "stop": number, "tp1": number, "tp2": number,`,
    `  "breakoutProof": { "bodyCloseBeyond": boolean, "retestHolds": boolean, "sfpReclaim": boolean },`,
    `  "candidateScores": [{ "name": string, "score": number, "reason": string }]}`,
    "```",
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

async function askTournament(args: {
  instrument: string;
  dateStr: string;
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
  m15: string;
  h1: string;
  h4: string;
}) {
  const messages = tournamentMessages(args);
  const text = await callOpenAI(messages);
  const aiMeta = extractAiMeta(text);
  return { text, aiMeta };
}

// rewrite card -> Pending limit (no Market) when proof missing (BASE)
async function rewriteAsPending(instrument: string, text: string) {
  const messages = [
    {
      role: "system",
      content:
        "Rewrite the trade card as PENDING (no Market) into a clean Buy/Sell LIMIT zone at OB/FVG/SR confluence if breakout proof is missing. Keep tournament section and X-ray.",
    },
    {
      role: "user",
      content: `Instrument: ${instrument}\n\n${text}\n\nRewrite strictly to Pending.`,
    },
  ];
  return callOpenAI(messages);
}

// normalize mislabeled Breakout+Retest without proof -> Pullback (BASE)
async function normalizeBreakoutLabel(text: string) {
  const messages = [
    {
      role: "system",
      content:
        "If 'Breakout + Retest' is claimed but proof is not shown (body close + retest hold or SFP reclaim), rename setup to 'Pullback (OB/FVG/SR)' and leave rest unchanged.",
    },
    { role: "user", content: text },
  ];
  return callOpenAI(messages);
}

// fix Buy/Sell Limit vs current price and zone (BASE)
async function fixOrderVsPrice(instrument: string, text: string, aiMeta: any) {
  const reason = invalidOrderRelativeToPrice(aiMeta);
  if (!reason) return text;

  const messages = [
    {
      role: "system",
      content:
        "Adjust the LIMIT zone so that: Sell Limit is an ABOVE-price pullback into supply; Buy Limit is a BELOW-price pullback into demand. Keep all other content & sections.",
    },
    {
      role: "user",
      content: `Instrument: ${instrument}\n\nCurrent Price: ${aiMeta?.currentPrice}\nProvided Zone: ${JSON.stringify(
        aiMeta?.zone
      )}\n\nCard:\n${text}\n\nFix only the LIMIT zone side and entry, keep format.`,
    },
  ];
  return callOpenAI(messages);
}

// synthesize full card (same sections) if model returns JSON-only/empty
function synthesizeCardFromMeta(instrument: string, aiMeta: any, headlinesText?: string | null) {
  const dir = aiMeta?.direction === "Short" ? "Short" : "Long";
  const order = aiMeta?.entryOrder || "Pending";
  const zone =
    aiMeta?.zone && typeof aiMeta.zone === "object"
      ? `${aiMeta.zone.min ?? "—"} – ${aiMeta.zone.max ?? "—"}`
      : "—";
  const stop = aiMeta?.stop ?? "—";
  const tp1 = aiMeta?.tp1 ?? "—";
  const tp2 = aiMeta?.tp2 ?? "—";

  return [
    "Quick Plan (Actionable)",
    "",
    `• Direction: ${dir}`,
    `• Order Type: ${order}`,
    "• Trigger: Structure confluence (OB/FVG/SR/Fib/BOS)",
    `• Entry: ${zone}`,
    `• Stop Loss: ${stop}`,
    `• Take Profit(s): TP1 ${tp1} / TP2 ${tp2}`,
    "• Conviction: 55%",
    `• Setup: ${aiMeta?.selectedStrategy || "Tournament winner"}`,
    "• Short Reasoning: Synthesized from ai_meta.",
    "",
    "Full Breakdown",
    "• Technical View (HTF + Intraday): Based on 4H/1H/15m images.",
    `• Fundamental View (Calendar + Sentiment): ${headlinesText ? "Recent headlines included." : "—"}`,
    "• Tech vs Fundy Alignment: —",
    "• Conditional Scenarios: —",
    "• Surprise Risk: —",
    "• Invalidation: —",
    "• One-liner Summary: —",
    "",
    "Detected Structures (X-ray):",
    "• 4H: —",
    "• 1H: —",
    "• 15m: —",
    "",
    "Candidate Scores (tournament):",
    "- —",
    "",
    "Final Table Summary:",
    "| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |",
    `| ${instrument} | ${dir} | ${zone} | ${stop} | ${tp1} | ${tp2} | 55% |`,
  ].join("\n");
}

// ---------- handler (BASE + minimal) ----------

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
          "Use multipart/form-data with files: m15, h1, h4 (PNG/JPG) and optional 'calendar'. Also include 'instrument' field.",
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

    // 1) Tournament pass (BASE)
    let { text, aiMeta } = await askTournament({
      instrument,
      dateStr,
      calendarDataUrl: calUrl || undefined,
      headlinesText: headlinesText || undefined,
      m15,
      h1,
      h4,
    });

    // If output was JSON-only/empty -> synthesize readable card with same sections
    if ((!text || /^```(?:ai_meta|json)/i.test(text.trim())) && aiMeta) {
      text = synthesizeCardFromMeta(instrument, aiMeta, headlinesText || "");
      text = upsertAiMetaFence(text, aiMeta);
    }

    // 2) Force Pending if Market without proof (BASE rule kept)
    if (aiMeta && needsPendingLimit(aiMeta)) {
      text = await rewriteAsPending(instrument, text);
      aiMeta = extractAiMeta(text) || aiMeta;
    }

    // 3) Normalize mislabeled Breakout+Retest if no proof (BASE)
    const bp = aiMeta?.breakoutProof || {};
    const hasProof =
      !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
    if (String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout") && !hasProof) {
      text = await normalizeBreakoutLabel(text);
      aiMeta = extractAiMeta(text) || aiMeta;
    }

    // 4) Sanity: zone vs price (BASE)
    if (aiMeta) {
      const bad = invalidOrderRelativeToPrice(aiMeta);
      if (bad) {
        text = await fixOrderVsPrice(instrument, text, aiMeta);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // 5) Add Option 2 — Market when allowed; give its own conviction
    if (aiMeta) {
      const allowMarket = hasBreakoutProof(aiMeta) || alreadyAtEntry(aiMeta);
      const convPending = parseConvictionPercent(text) ?? 55;
      if (allowMarket) {
        text = injectOption2Market(text, aiMeta, convPending);
      } else {
        const anchor = /(^|\n)Full Breakdown/i;
        const line = `\n*Market withheld:* Needs breakout proof or price at entry zone.\n`;
        text = anchor.test(text) ? text.replace(anchor, `${line}$&`) : text + line;
      }
      text = upsertAiMetaFence(text, aiMeta);
    }

    // 6) Final guard: never return flat/empty. If model still tried to go "Stay Flat",
    //    we synthesize a low-conviction directional idea from ai_meta.
    if (/Direction:\s*Stay\s*Flat/i.test(text) && aiMeta) {
      text = synthesizeCardFromMeta(instrument, aiMeta, headlinesText || "");
      text = upsertAiMetaFence(text, aiMeta);
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
