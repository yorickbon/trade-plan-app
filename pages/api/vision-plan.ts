// /pages/api/vision-plan.ts
// Images-only planner: pick the best idea by scoring multiple strategies.
// Upload: m15 (execution), h1 (context), h4 (HTF), optional calendar.
// Keeps your existing style, fixes image parts for chat/completions, and adds:
// - Dual options (Pending vs Market) with independent conviction
// - Market allowed for ALL strategies if: breakout-proof OR already-at-entry
// - Tiny 15m vision backfill for currentPrice
// - Zone vs price sanity (adjust zone only)
// - Synthesis if model returns JSON-only (keeps all sections incl. X-ray & Tournament)

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

// ---------- helpers ----------

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

// breakout proof gate
function hasBreakoutProof(aiMeta: any): boolean {
  const bp = aiMeta?.breakoutProof || {};
  return !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
}

// if output asked for Market but no proof -> require Pending
function needsPendingLimit(aiMeta: any): boolean {
  const et = String(aiMeta?.entryType || "").toLowerCase();
  if (et !== "market") return false;
  return !hasBreakoutProof(aiMeta);
}

// invalid Buy/Sell Limit vs current price and zone
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

// already-at-entry check for Market option (any strategy)
function alreadyAtEntry(aiMeta: any): boolean {
  const p = Number(aiMeta?.currentPrice);
  const z = aiMeta?.zone || {};
  const zmin = Number(z?.min);
  const zmax = Number(z?.max);
  if (!isFinite(p) || !isFinite(zmin) || !isFinite(zmax)) return false;
  // tiny buffer relative to price to account for ticks; ~0.05%
  const buf = Math.abs(p) * 0.0005;
  const lo = Math.min(zmin, zmax) - buf;
  const hi = Math.max(zmin, zmax) + buf;
  return p >= lo && p <= hi;
}

// Replace / append fenced ai_meta with updated one
function upsertAiMetaFence(text: string, aiMeta: any) {
  const block = "```ai_meta\n" + JSON.stringify(aiMeta, null, 2) + "\n```";
  if (!text) return block;
  if (/```ai_meta[\s\S]*?```/i.test(text)) {
    return text.replace(/```ai_meta[\s\S]*?```/i, block);
  }
  return [text.trim(), "", block].join("\n");
}

// Does the text have a human-readable card (not only code fences)?
function hasReadableCard(text: string) {
  if (!text) return false;
  const noFences = text.replace(/```[\s\S]*?```/g, "").trim();
  return /Quick Plan|Full Breakdown|Final Table Summary|Detected Structures|Candidate Scores/i.test(
    noFences
  );
}

// Parse "Conviction: 62%" from the card
function parseConvictionPercent(text: string): number | null {
  const m = text.match(/Conviction:\s*~?\s*(\d{1,3})\s*%/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// Inject/Update Fundamental & Headline Snapshot on top
function withFundamentalSnapshot(text: string, snapshot?: string | null) {
  if (!snapshot) return text;
  const block =
    "Fundamental & Headline Snapshot\n" +
    (snapshot?.trim() ? snapshot.trim() + "\n" : "") +
    "\n";
  if (/^Fundamental\s*&\s*Headline Snapshot/i.test(text.trim())) return text; // already present
  return block + text;
}

// Insert Option 2 — Market with its own conviction
function injectOption2Market(text: string, aiMeta: any, convPending: number): string {
  const cp = Number(aiMeta?.currentPrice);
  const stop = aiMeta?.stop ?? "Same as Option 1";
  const tp1 = aiMeta?.tp1 ?? "Same as Option 1";
  const tp2 = aiMeta?.tp2 ?? "Same as Option 1";

  // heuristics: if breakout-proof -> +5; if already-at-entry -> +3; cap 95
  let bonus = 0;
  if (hasBreakoutProof(aiMeta)) bonus += 5;
  if (alreadyAtEntry(aiMeta)) bonus += 3;
  const convMarket = Math.max(0, Math.min(95, convPending + bonus));

  const option = [
    "",
    "Option 2 — Market",
    `• Order Type: Market`,
    `• Entry: ${Number.isFinite(cp) ? cp : "current price"}`,
    `• Stop Loss: ${typeof stop === "number" ? stop : String(stop)}`,
    `• Take Profit(s): TP1 ${typeof tp1 === "number" ? tp1 : String(tp1)} / TP2 ${typeof tp2 === "number" ? tp2 : String(tp2)}`,
    `• Conviction: ${convMarket}%`,
  ].join("\n");

  // Place just before "Full Breakdown"
  const idx = text.search(/(^|\n)Full Breakdown/i);
  if (idx !== -1) {
    return text.slice(0, idx) + "\n" + option + "\n" + text.slice(idx);
  }
  return text + "\n" + option;
}

// tiny vision call to backfill current price from the 15m image only
async function backfillCurrentPriceFromM15(m15: string): Promise<number | null> {
  try {
    const messages: any[] = [
      {
        role: "system",
        content:
          "You read prices from a single chart image. Reply with ONLY a number (no units, no words). If unclear, reply null.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Return only the latest traded price visible on this 15m chart. If unreadable, reply null." },
          { type: "image_url", image_url: { url: m15 } as any },
        ],
      },
    ];
    const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        max_completion_tokens: 64,
      }),
    });
    const json = await rsp.json().catch(() => ({} as any));
    if (!rsp.ok) return null;
    const out =
      json?.choices?.[0]?.message?.content ??
      (Array.isArray(json?.choices?.[0]?.message?.content)
        ? json.choices[0].message.content.map((c: any) => c?.text || "").join("\n")
        : "");
    const s = String(out || "").trim();
    if (!s || /^null$/i.test(s)) return null;
    const num = Number(s.replace(/[^\d.\-]/g, ""));
    return Number.isFinite(num) ? num : null;
  } catch {
    return null;
  }
}

// Create a full card from ai_meta (keeps all your sections)
function synthesizeCardFromMeta(instrument: string, aiMeta: any, snapshot?: string | null) {
  const dir = aiMeta?.direction ?? "Flat";
  const order = aiMeta?.entryOrder ?? "Pending";
  const zone =
    aiMeta?.zone && typeof aiMeta.zone === "object"
      ? `${aiMeta.zone.min ?? "…"} – ${aiMeta.zone.max ?? "…"}`
      : "—";
  const stop = aiMeta?.stop ?? "—";
  const tp1 = aiMeta?.tp1 ?? "—";
  const tp2 = aiMeta?.tp2 ?? "—";
  const conv = 50;

  const base =
    [
      "Quick Plan (Actionable)",
      "",
      `• Direction: ${dir}`,
      `• Order Type: ${order}`,
      `• Trigger: Structure-based trigger (OB/FVG/SR/Fib/BOS)`,
      `• Entry: ${zone}`,
      `• Stop Loss: ${stop}`,
      `• Take Profit(s): TP1 ${tp1} / TP2 ${tp2}`,
      `• Conviction: ${conv}%`,
      `• Setup: ${aiMeta?.selectedStrategy || "Images-driven setup"}`,
      `• Short Reasoning: —`,
      "",
      "Full Breakdown",
      "• Technical View (HTF + Intraday): Based on 4H/1H/15m images.",
      "• Fundamental View (Calendar + Sentiment): Headlines snapshot considered.",
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
      "Advanced Reasoning (Pro-Level Context)",
      "• Priority Bias: —",
      "• Structure Context: —",
      "• Confirmation Logic: —",
      "• Fundies vs Techs: —",
      "• Scenario Planning: —",
      "",
      "Notes",
      "—",
      "",
      "Final Table Summary:",
      "| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |",
      `| ${instrument} | ${dir} | ${zone} | ${stop} | ${tp1} | ${tp2} | ${conv}% |`,
    ].join("\n");

  return withFundamentalSnapshot(base, snapshot || null);
}

// ---------- OpenAI caller ----------

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
      max_completion_tokens: 1600, // stability as agreed
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
    "Perform visual price-action market analysis from the images only (no numeric candles fetched).",
    "Multi-timeframe alignment: 15m execution, 1H context, 4H HTF.",
    "Tournament mode: create candidates for these strategies and score them (0–100):",
    "- BOS continuation (break + retest), Pullback to Fibs (0.382/0.5/0.618/0.786) with confluence, OB/FVG/Structure retest, Range breakout (incl. ORB), Liquidity grab/SFP + reclaim, SR flip, EMA momentum as tie-breaker, Trendline break + retest, Breaker/momentum blocks, Post-news reaction.",
    "Scoring rubric (0–100): Structure trend(25), 15m trigger quality(25), HTF context(15), Clean path to target(10), Stop validity(10), Fundamentals/Headlines(10), 'No chase' penalty(5).",
    "Market entry (Option 2) rules: allowed for ANY strategy when either (a) explicit breakout proof exists (body close beyond + retest holds OR SFP reclaim), or (b) price is already at the proposed entry zone (tiny tolerance). Otherwise only Pending.",
    "Stops just beyond invalidation with a small buffer.",
    "Use calendar/headlines as bias overlay if provided.",
    "",
    "OUTPUT format (must include ALL sections exactly in this order):",
    "Fundamental & Headline Snapshot",
    "",
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
    "Advanced Reasoning (Pro-Level Context)",
    "• Priority Bias:",
    "• Structure Context:",
    "• Confirmation Logic:",
    "• How fundamentals strengthen/weakens the setup:",
    "• Scenario Planning:",
    "",
    "Notes",
    "—",
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
    `  "candidateScores": [{ "name": string, "score": number, "reason": string }],`,
    `  "convictionPending": number | null,`,
    `  "convictionMarket": number | null }`,
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

// rewrite card -> Pending limit (no Market) when proof missing
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

// normalize mislabeled Breakout+Retest without proof -> Pullback
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

// fix Buy/Sell Limit level direction vs current price
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

// ---------- handler ----------

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

    // 1) Tournament pass
    let { text, aiMeta } = await askTournament({
      instrument,
      dateStr,
      calendarDataUrl: calUrl || undefined,
      headlinesText: headlinesText || undefined,
      m15,
      h1,
      h4,
    });

    // Ensure fundamental snapshot header exists (front-load headlines)
    text = withFundamentalSnapshot(text, headlinesText || "");

    // 1a) If JSON-only or missing readable card -> synthesize base card with all sections
    if ((!hasReadableCard(text) || /^```(?:ai_meta|json)/i.test(text.trim())) && aiMeta) {
      text = synthesizeCardFromMeta(instrument, aiMeta, headlinesText || "");
      text = upsertAiMetaFence(text, aiMeta);
    }

    // 1b) Backfill currentPrice if missing
    if (aiMeta && !(Number.isFinite(Number(aiMeta.currentPrice)))) {
      const backfilled = await backfillCurrentPriceFromM15(m15);
      if (backfilled != null) {
        aiMeta.currentPrice = backfilled;
        text = upsertAiMetaFence(text, aiMeta);
      }
    }

    // 2) Force Pending if Market without breakout proof
    if (aiMeta && needsPendingLimit(aiMeta)) {
      text = await rewriteAsPending(instrument, text);
      aiMeta = extractAiMeta(text) || aiMeta;
    }

    // 3) Normalize mislabeled Breakout+Retest if no proof
    if (aiMeta) {
      const hasProof = hasBreakoutProof(aiMeta);
      if (String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout") && !hasProof) {
        text = await normalizeBreakoutLabel(text);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // 4) Enforce order vs current price (Sell Limit above / Buy Limit below)
    if (aiMeta) {
      const bad = invalidOrderRelativeToPrice(aiMeta);
      if (bad) {
        text = await fixOrderVsPrice(instrument, text, aiMeta);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // 5) Dual options (independent convictions)
    if (aiMeta) {
      // Conviction for Option 1 (Pending) parsed from card or ai_meta.convictionPending or 50
      let convPending = parseConvictionPercent(text) ?? Number(aiMeta?.convictionPending);
      if (!Number.isFinite(convPending as any)) convPending = 50;

      // Decide if Option 2 (Market) is allowed:
      const allowMarket = hasBreakoutProof(aiMeta) || alreadyAtEntry(aiMeta);

      if (allowMarket) {
        text = injectOption2Market(text, aiMeta, convPending as number);
      } else {
        // Add a one-liner explaining absence of Market
        const anchor = /(^|\n)Full Breakdown/i;
        const line = `\n*Market withheld:* Needs breakout proof or price at entry zone.\n`;
        if (anchor.test(text)) text = text.replace(anchor, `${line}$&`);
        else text += line;
      }
    }

    // 6) Fallback if refusal/empty
    if (!text || refusalLike(text)) {
      const fallback = synthesizeCardFromMeta(instrument, aiMeta || {}, headlinesText || "");
      const fallbackMeta = {
        selectedStrategy: aiMeta?.selectedStrategy || "Await valid trigger",
        entryType: "Pending",
        entryOrder: "Pending",
        direction: aiMeta?.direction || "Flat",
        currentPrice: aiMeta?.currentPrice ?? null,
        zone: aiMeta?.zone ?? null,
        stop: aiMeta?.stop ?? null,
        tp1: aiMeta?.tp1 ?? null,
        tp2: aiMeta?.tp2 ?? null,
        breakoutProof: {
          bodyCloseBeyond: false,
          retestHolds: false,
          sfpReclaim: false,
        },
        candidateScores: aiMeta?.candidateScores || [],
        convictionPending: 30,
        convictionMarket: null,
        note: "Fallback used due to refusal/empty output.",
      };
      return res.status(200).json({
        ok: true,
        text: upsertAiMetaFence(fallback, fallbackMeta),
        meta: {
          instrument,
          hasCalendar: !!calUrl,
          headlinesCount: headlinesText ? headlinesText.length : 0,
          strategySelection: false,
          rewritten: false,
          fallbackUsed: true,
          aiMeta: fallbackMeta,
        },
      });
    }

    // Ensure we always return the ai_meta fence reflecting any updates
    if (aiMeta) {
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
