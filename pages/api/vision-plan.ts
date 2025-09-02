// /pages/api/vision-plan.ts
// Images-only planner with optional TradingView/Gyazo image URL fetch.
// Uploads: m15 (execution), h1 (context), h4 (HTF), optional calendar.
// You can also pass m15Url / h1Url / h4Url (TV/Gyazo direct image or page link).
// -----------------------------------------------------------------------------
// NEW:
//   • Two-stage support (without breaking existing callers)
//       - mode=full (default): full card as before
//       - mode=fast: use full analysis (images + calendar + headlines (6 of 12)), but
//                    OUTPUT ONLY: Quick Plan (+ Option 2) + Management + trailing ai_meta
//       - mode=expand&cache=<id>: reuse cached images from the prior fast call and return
//                    ONLY the remaining sections (Full Breakdown, X-ray, Candidate Scores,
//                    Final Table). Final card = identical to legacy full card.
//   • Headlines: fetch 12; embed 6 into model prompt (fetch behavior unchanged).
//   • Image downscale (uploads + links): sharp @ max 1280px, JPEG ~70%, strip metadata,
//     best-effort ≤ ~600 KB each, preserve readability (OHLC/levels/text).
//   • Keep your original enforcement micro-passes & output structure.
// -----------------------------------------------------------------------------

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";
import sharp from "sharp";

// ---------- config ----------
export const config = {
  api: { bodyParser: false, sizeLimit: "25mb" },
};

type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// ---------- small utils ----------
const IMG_MAX_BYTES = 12 * 1024 * 1024; // safety cap

const MAX_W = 1280;          // as requested
const JPEG_Q = 70;           // ~70%
const TARGET_MAX = 600 * 1024; // ~≤600 KB best-effort

const now = () => Date.now();
const dt = (t: number) => `${Date.now() - t}ms`;

function uuid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function dataUrlSizeBytes(s: string | null | undefined): number {
  if (!s) return 0;
  const i = s.indexOf(",");
  if (i < 0) return 0;
  const b64 = s.slice(i + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

// in-memory cache (processed images) for Stage-2 expand; TTL ~3 minutes
type CacheEntry = {
  exp: number;
  instrument: string;
  m15: string; h1: string; h4: string;
  calendar?: string | null;
  headlinesText?: string | null; // 6-line prompt text already formatted
};
const CACHE = new Map<string, CacheEntry>();

function setCache(entry: Omit<CacheEntry, "exp">): string {
  const key = uuid();
  CACHE.set(key, { ...entry, exp: Date.now() + 3 * 60 * 1000 });
  return key;
}
function getCache(key: string | undefined | null): CacheEntry | null {
  if (!key) return null;
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { CACHE.delete(key); return null; }
  return e;
}

// ---------- formidable helpers ----------
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

// ---------- image processing ----------
async function toJpeg(buf: Buffer, width = MAX_W, quality = JPEG_Q): Promise<Buffer> {
  return sharp(buf)
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality, progressive: true, mozjpeg: true })
    .toBuffer();
}

async function processToDataUrl(buf: Buffer): Promise<string> {
  // try JPEG @ 70 first, then slightly lower if still heavy
  let q = JPEG_Q;
  let out = await sharp(buf)
    .rotate()
    .resize({ width: MAX_W, withoutEnlargement: true })
    .jpeg({ quality: q, progressive: true, mozjpeg: true })
    .toBuffer();

  if (out.byteLength > TARGET_MAX) {
    q = 64;
    out = await toJpeg(buf, MAX_W, q);
  }
  if (out.byteLength > TARGET_MAX) {
    q = 58;
    out = await toJpeg(buf, MAX_W, q);
  }

  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p = file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;
  const raw = await fs.readFile(p);
  const out = await processToDataUrl(raw);
  if (process.env.NODE_ENV !== "production") {
    console.log(`[vision-plan] file processed size=${dataUrlSizeBytes(out)}B`);
  }
  return out;
}

// ---------- tradingview/gyazo link → dataURL ----------
function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}
function absoluteUrl(base: string, maybe: string) {
  try { return new URL(maybe, base).toString(); } catch { return maybe; }
}
function htmlFindOgImage(html: string): string | null {
  const re1 = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;
  const m1 = html.match(re1);
  if (m1?.[1]) return m1[1];
  const re2 = /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i;
  const m2 = html.match(re2);
  if (m2?.[1]) return m2[1];
  return null;
}
function looksLikeImageUrl(u: string) {
  const s = String(u || "").split("?")[0] || "";
  return /\.(png|jpe?g|webp|gif)$/i.test(s);
}
async function fetchWithTimeout(url: string, ms: number) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        "user-agent": "TradePlanApp/1.0",
        accept: "text/html,application/xhtml+xml,application/xml,image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    return r;
  } finally {
    clearTimeout(id);
  }
}
async function downloadAndProcess(url: string): Promise<string | null> {
  const r = await fetchWithTimeout(url, 8000);
  if (!r || !r.ok) return null;
  const ct = String(r.headers.get("content-type") || "").toLowerCase();
  const mime = ct.split(";")[0].trim();
  const ab = await r.arrayBuffer();
  const raw = Buffer.from(ab);
  if (raw.byteLength > IMG_MAX_BYTES) return null;

  if (mime.startsWith("image/")) {
    const out = await processToDataUrl(raw);
    if (process.env.NODE_ENV !== "production") {
      console.log(`[vision-plan] link processed size=${dataUrlSizeBytes(out)}B from ${url}`);
    }
    return out;
  }

  // HTML page → og:image
  const html = raw.toString("utf8");
  const og = htmlFindOgImage(html);
  if (!og) return null;
  const resolved = absoluteUrl(url, og);
  const r2 = await fetchWithTimeout(resolved, 8000);
  if (!r2 || !r2.ok) return null;
  const ab2 = await r2.arrayBuffer();
  const raw2 = Buffer.from(ab2);
  if (raw2.byteLength > IMG_MAX_BYTES) return null;
  const out2 = await processToDataUrl(raw2);
  if (process.env.NODE_ENV !== "production") {
    console.log(`[vision-plan] og:image processed size=${dataUrlSizeBytes(out2)}B from ${resolved}`);
  }
  return out2;
}

async function linkToDataUrl(link: string): Promise<string | null> {
  if (!link) return null;
  try {
    if (looksLikeImageUrl(link)) return await downloadAndProcess(link);
    return await downloadAndProcess(link); // page → og:image
  } catch {
    return null;
  }
}

// ---------- headlines: fetch 12; embed 6 ----------
async function fetchedHeadlines(req: NextApiRequest, instrument: string): Promise<{ items: any[]; promptText: string | null }> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(instrument)}&hours=48&max=12&_t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    const lines = items.slice(0, 6).map((it: any) => {
      const s = typeof it?.sentiment?.score === "number" ? it.sentiment.score : null;
      const lab = s == null ? "neu" : s > 0.05 ? "pos" : s < -0.05 ? "neg" : "neu";
      const t = String(it?.title || "").slice(0, 200);
      const src = it?.source || "";
      const when = it?.ago || "";
      return `• ${t} — ${src}, ${when} — ${lab}`;
    }).join("\n");
    return { items, promptText: lines || null };
  } catch {
    return { items: [], promptText: null };
  }
}

// ---------- refusal & ai_meta helpers ----------
function refusalLike(s: string) {
  const t = (s || "").toLowerCase();
  if (!t) return false;
  return /\b(can'?t|cannot)\s+assist\b|\bnot able to comply\b|\brefuse/i.test(t);
}
function extractAiMeta(text: string) {
  if (!text) return null;
  const fences = [/```ai_meta\s*({[\s\S]*?})\s*```/i, /```json\s*({[\s\S]*?})\s*```/i];
  for (const re of fences) {
    const m = text.match(re);
    if (m && m[1]) {
      try { return JSON.parse(m[1]); } catch {}
    }
  }
  return null;
}
function needsPendingLimit(aiMeta: any): boolean {
  const et = String(aiMeta?.entryType || "").toLowerCase();
  if (et !== "market") return false;
  const bp = aiMeta?.breakoutProof || {};
  const ok = !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
  return !ok;
}
function invalidOrderRelativeToPrice(aiMeta: any): string | null {
  const o = String(aiMeta?.entryOrder || "").toLowerCase();
  const dir = String(aiMeta?.direction || "").toLowerCase();
  const z = aiMeta?.zone || {};
  const p = Number(aiMeta?.currentPrice);
  const zmin = Number(z?.min);
  const zmax = Number(z?.max);
  if (!isFinite(p) || !isFinite(zmin) || !isFinite(zmax)) return null;
  if (o === "sell limit" && dir === "short") { if (Math.max(zmin, zmax) <= p) return "sell-limit-below-price"; }
  if (o === "buy limit" && dir === "long")  { if (Math.min(zmin, zmax) >= p) return "buy-limit-above-price"; }
  return null;
}

// ---------- OpenAI call ----------
async function callOpenAI(messages: any[]) {
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: OPENAI_MODEL, messages }),
  });
  const json = await rsp.json().catch(() => ({} as any));
  if (!rsp.ok) throw new Error(`OpenAI vision request failed: ${rsp.status} ${JSON.stringify(json)}`);
  const out =
    json?.choices?.[0]?.message?.content ??
    (Array.isArray(json?.choices?.[0]?.message?.content)
      ? json.choices[0].message.content.map((c: any) => c?.text || "").join("\n")
      : "");
  return String(out || "");
}

// ---------- prompts ----------
function systemCore(instrument: string) {
  return [
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
    "Instrument is " + instrument + ". Keep instrument alignment.",
  ].join("\n");
}

function buildUserPartsBase(args: {
  instrument: string; dateStr: string;
  m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
}) {
  const parts: any[] = [
    { type: "text", text: `Instrument: ${args.instrument}\nDate: ${args.dateStr}` },
    { type: "text", text: "HTF 4H Chart:" },
    { type: "image_url", image_url: { url: args.h4 } },
    { type: "text", text: "Context 1H Chart:" },
    { type: "image_url", image_url: { url: args.h1 } },
    { type: "text", text: "Execution 15M Chart:" },
    { type: "image_url", image_url: { url: args.m15 } },
  ];
  if (args.calendarDataUrl) {
    parts.push({ type: "text", text: "Economic Calendar Image:" });
    parts.push({ type: "image_url", image_url: { url: args.calendarDataUrl } });
  }
  if (args.headlinesText) {
    parts.push({ type: "text", text: `Recent headlines snapshot (used for bias, list hidden in stage 1):\n${args.headlinesText}` });
  }
  return parts;
}

// FULL card (legacy)
function messagesFull(args: {
  instrument: string; dateStr: string;
  m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
}) {
  const system = [
    systemCore(args.instrument),
    "",
    "OUTPUT format:",
    "Quick Plan (Actionable)",
    "",
    "• Direction: Long | Short | Stay Flat",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger: (ex: Limit pullback / zone touch)",
    "• Entry: <min–max> or specific level",
    "• Stop Loss: <level> (based on PA: behind swing/OB/SR; step to the next zone if too tight)",
    "• Take Profit(s): TP1 <level> / TP2 <level>",
    "• Conviction: <0–100>%",
    "• Setup: <Chosen Strategy>",
    "• Short Reasoning: <1–2 lines>",
    "• Option 2 (Market): Show when allowed; else print 'Not available (missing confirmation)'.",
    "",
    "Full Breakdown",
    "• Technical View (HTF + Intraday): 4H/1H/15m structure",
    "• Fundamental View (Calendar + Sentiment + Headlines):",
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
    `| ${args.instrument} | ... | ... | ... | ... | ... | ... |`,
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

  return [
    { role: "system", content: system },
    { role: "user", content: buildUserPartsBase(args) },
  ];
}

// FAST Stage-1: Quick Plan (+Option 2) + Management + ai_meta (headlines/calendar USED)
function messagesFastStage1(args: {
  instrument: string; dateStr: string;
  m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
}) {
  const system = [
    systemCore(args.instrument),
    "",
    "OUTPUT ONLY the following (nothing else):",
    "Quick Plan (Actionable)",
    "",
    "• Direction: Long | Short | Stay Flat",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger:",
    "• Entry:",
    "• Stop Loss: (price-action based; if first zone too tight, step to next)",
    "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%",
    "• Setup:",
    "• Short Reasoning:",
    "• Option 2 (Market): Show when allowed; else print 'Not available (missing confirmation)'.",
    "",
    "Management",
    "- Turn the plan into a brief, actionable playbook (filled/not filled, trail/move to BE, invalidation behaviors).",
    "",
    "At the very end, append ONLY a fenced JSON block labeled ai_meta as specified below.",
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

  return [
    { role: "system", content: system },
    { role: "user", content: buildUserPartsBase(args) },
  ];
}

// Stage-2 Expand: ONLY the remaining sections (no Quick Plan), keep levels consistent
function messagesExpandStage2(args: {
  instrument: string; dateStr: string;
  m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
  aiMetaHint?: any;
}) {
  const system = [
    systemCore(args.instrument),
    "",
    "Expand ONLY the remaining sections (do NOT repeat 'Quick Plan (Actionable)' or 'Management').",
    "Keep Entry/SL/TP consistent with ai_meta_hint unless a direct contradiction is visible; if so, explain in 1 line.",
    "",
    "Sections to output:",
    "Full Breakdown",
    "• Technical View (HTF + Intraday): 4H/1H/15m structure",
    "• Fundamental View (Calendar + Sentiment + Headlines):",
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
    `| ${args.instrument} | ... | ... | ... | ... | ... | ... |`,
    "",
    "Append NOTHING after these sections (no ai_meta here).",
  ].join("\n");

  const userParts = buildUserPartsBase(args);
  if (args.aiMetaHint) {
    userParts.push({ type: "text", text: `ai_meta_hint:\n${JSON.stringify(args.aiMetaHint, null, 2)}` });
  }
  return [
    { role: "system", content: system },
    { role: "user", content: userParts },
  ];
}

// ---------- enforcement (original micro-passes) ----------
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
async function fixOrderVsPrice(instrument: string, text: string, aiMeta: any) {
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

    // mode selection (default FULL to avoid breaking existing callers)
    const urlMode = String((req.query.mode as string) || "").toLowerCase();
    let mode: "full" | "fast" | "expand" = urlMode === "fast" ? "fast" : urlMode === "expand" ? "expand" : "full";

    // expand path: reuse cached images; no need for multipart
    if (mode === "expand") {
      const cacheKey = String(req.query.cache || "").trim();
      const c = getCache(cacheKey);
      if (!c) {
        return res.status(400).json({ ok: false, reason: "Expand failed: cache expired or not found." });
      }
      const dateStr = new Date().toISOString().slice(0, 10);
      const messages = messagesExpandStage2({
        instrument: c.instrument,
        dateStr,
        m15: c.m15, h1: c.h1, h4: c.h4,
        calendarDataUrl: c.calendar || undefined,
        headlinesText: c.headlinesText || undefined,
        aiMetaHint: null, // we could accept a posted ai_meta hint later if you want
      });
      const text = await callOpenAI(messages);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ok: true, text, meta: { instrument: c.instrument, cacheKey } });
    }

    if (!isMultipart(req)) {
      return res.status(400).json({
        ok: false,
        reason:
          "Use multipart/form-data with files: m15, h1, h4 (PNG/JPG/WEBP) and optional 'calendar'. Or pass m15Url/h1Url/h4Url (TradingView/Gyazo links). Also include 'instrument' field.",
      });
    }

    // parse
    const tParse = now();
    const { fields, files } = await parseMultipart(req);
    if (process.env.NODE_ENV !== "production") {
      console.log(`[vision-plan] parsed in ${dt(tParse)}`);
    }

    const instrument = String(fields.instrument || fields.code || "EURUSD").toUpperCase().replace(/\s+/g, "");
    const requestedMode = String(fields.mode || "").toLowerCase();
    if (requestedMode === "fast") mode = "fast";
    if (requestedMode === "expand") mode = "expand"; // ignored here (expand needs cache key path above)

    // Files (if provided)
    const m15f = pickFirst(files.m15);
    const h1f = pickFirst(files.h1);
    const h4f = pickFirst(files.h4);
    const calF = pickFirst(files.calendar);

    // URLs (optional)
    const m15Url = String(pickFirst(fields.m15Url) || "").trim();
    const h1Url  = String(pickFirst(fields.h1Url)  || "").trim();
    const h4Url  = String(pickFirst(fields.h4Url)  || "").trim();

    // Build images (prefer file; else fetch link) and process with sharp
    const tImg = now();
    const [m15FromFile, h1FromFile, h4FromFile, calUrl] = await Promise.all([
      fileToDataUrl(m15f),
      fileToDataUrl(h1f),
      fileToDataUrl(h4f),
      calF ? fileToDataUrl(calF) : Promise.resolve(null),
    ]);
    const [m15FromUrl, h1FromUrl, h4FromUrl] = await Promise.all([
      m15FromFile ? Promise.resolve(null) : linkToDataUrl(m15Url),
      h1FromFile ? Promise.resolve(null) : linkToDataUrl(h1Url),
      h4FromFile ? Promise.resolve(null) : linkToDataUrl(h4Url),
    ]);
    const m15 = m15FromFile || m15FromUrl;
    const h1  = h1FromFile  || h1FromUrl;
    const h4  = h4FromFile  || h4FromUrl;

    if (process.env.NODE_ENV !== "production") {
      console.log(`[vision-plan] images ready ${dt(tImg)} (m15=${dataUrlSizeBytes(m15)}B, h1=${dataUrlSizeBytes(h1)}B, h4=${dataUrlSizeBytes(h4)}B, cal=${dataUrlSizeBytes(calUrl)}B)`);
    }

    if (!m15 || !h1 || !h4) {
      return res.status(400).json({
        ok: false,
        reason: "Provide all three charts: m15, h1, h4 — either as files or valid TradingView/Gyazo direct image links.",
      });
    }

    // Headlines: fetch 12; embed 6 into prompt (fetch behavior unchanged)
    const tNews = now();
    const { items: headlineItems, promptText: headlinesText } = await fetchedHeadlines(req, instrument);
    if (process.env.NODE_ENV !== "production") {
      console.log(`[vision-plan] news fetched ${dt(tNews)} (items=${headlineItems.length})`);
    }

    const dateStr = new Date().toISOString().slice(0, 10);

    // ---------- Stage 1 (fast) or Full ----------
    let text = "";
    let aiMeta: any = null;

    if (mode === "fast") {
      // Ask ONLY for Quick Plan + Management + ai_meta, but USING headlines/calendar/images.
      const messages = messagesFastStage1({
        instrument, dateStr,
        m15, h1, h4,
        calendarDataUrl: calUrl || undefined,
        headlinesText: headlinesText || undefined,
      });
      text = await callOpenAI(messages);
      aiMeta = extractAiMeta(text);

      // enforcement passes (same as base)
      if (aiMeta && needsPendingLimit(aiMeta)) {
        text = await rewriteAsPending(instrument, text);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
      const bp = aiMeta?.breakoutProof || {};
      const hasProof = !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
      if (String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout") && !hasProof) {
        text = await normalizeBreakoutLabel(text);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
      if (aiMeta) {
        const bad = invalidOrderRelativeToPrice(aiMeta);
        if (bad) {
          text = await fixOrderVsPrice(instrument, text, aiMeta);
          aiMeta = extractAiMeta(text) || aiMeta;
        }
      }

      // Prepare cache for Stage-2 expand (reuse processed images + headlines text)
      const cacheKey = setCache({
        instrument,
        m15, h1, h4,
        calendar: calUrl || null,
        headlinesText: headlinesText || null,
      });

      if (!text || refusalLike(text)) {
        return res.status(200).json({
          ok: true,
          text: fallbackCard(instrument),
          meta: { instrument, mode, cacheKey, headlinesCount: headlineItems.length, fallbackUsed: true, aiMeta: extractAiMeta(fallbackCard(instrument)) },
        });
      }

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        text,
        meta: { instrument, mode, cacheKey, headlinesCount: headlineItems.length, fallbackUsed: false, aiMeta },
      });
    }

    // FULL (legacy)
    const messages = messagesFull({
      instrument, dateStr,
      m15, h1, h4,
      calendarDataUrl: calUrl || undefined,
      headlinesText: headlinesText || undefined,
    });
    text = await callOpenAI(messages);
    aiMeta = extractAiMeta(text);

    // enforcement passes (same as base)
    if (aiMeta && needsPendingLimit(aiMeta)) {
      text = await rewriteAsPending(instrument, text);
      aiMeta = extractAiMeta(text) || aiMeta;
    }
    const bp = aiMeta?.breakoutProof || {};
    const hasProof = !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
    if (String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout") && !hasProof) {
      text = await normalizeBreakoutLabel(text);
      aiMeta = extractAiMeta(text) || aiMeta;
    }
    if (aiMeta) {
      const bad = invalidOrderRelativeToPrice(aiMeta);
      if (bad) {
        text = await fixOrderVsPrice(instrument, text, aiMeta);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    if (!text || refusalLike(text)) {
      return res.status(200).json({
        ok: true,
        text: fallbackCard(instrument),
        meta: { instrument, mode, headlinesCount: headlineItems.length, fallbackUsed: true, aiMeta: extractAiMeta(fallbackCard(instrument)) },
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text,
      meta: { instrument, mode, headlinesCount: headlineItems.length, fallbackUsed: false, aiMeta },
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}

// ---------- fallback (unchanged style) ----------
function fallbackCard(instrument: string) {
  return [
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
    "• Option 2 (Market): Not available (missing confirmation).",
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
        breakoutProof: { bodyCloseBeyond: false, retestHolds: false, sfpReclaim: false },
        candidateScores: [],
        note: "Fallback used due to refusal/empty output.",
      },
      null,
      2
    ),
    "```",
  ].join("\n");
}
