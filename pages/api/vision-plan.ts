// /pages/api/vision-plan.ts
// Images-only planner with accuracy-first image handling + single-pass enforcement.
// HQ mode (default ON) preserves digit/axis clarity for the vision model:
// - Width: 1280px, mild sharpen()
// - JPEG q≈82; if large, try WebP q≈90/82 (OpenAI supports webp)
// - Best-effort cap ~≤900 KB per image (keeps numerals crisp)
// Fast mode (VISION_HQ=0) keeps the previous 1100px/q≈68/≤450 KB pipeline.
//
// Headlines: fetch 12; embed only 6 into the model prompt.
// Output sections & logic remain EXACTLY the same (Quick Plan, Full Breakdown, X-ray, Candidate Scores, Final Table, ai_meta).

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";
import sharp from "sharp";
import {
  getCurrencyStrengthIntraday,
  getCotBiasBrief,
  formatStrengthLine,
  formatCotLine,
  parseInstrumentCurrencies,
} from "../../lib/sentiment-lite";

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
const VISION_HQ = process.env.VISION_HQ === "0" ? false : true; // default ON

// ---------- small utils ----------
function now() { return Date.now(); }
function dt(from: number) { return `${Date.now() - from}ms`; }

const IMG_MAX_BYTES = 12 * 1024 * 1024; // safety cap when fetching remote images

// HQ (accuracy-first)
const HQ_MAX_WIDTH = 1280;
const HQ_JPEG_Q = 82;
const HQ_WEBP_Q1 = 90;
const HQ_WEBP_Q2 = 82;
const HQ_TARGET_MAX = 900 * 1024; // ~≤900 KB best-effort

// Fast (previous)
const FAST_MAX_WIDTH = 1100;
const FAST_JPEG_Q = 68;
const FAST_MIN_Q = 50;
const FAST_TARGET_MAX = 450 * 1024; // ~≤450 KB

function looksLikeImageUrl(u: string) {
  const s = String(u || "").split("?")[0] || "";
  return /\.(png|jpe?g|webp|gif)$/i.test(s);
}

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

function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      signal: ac.signal,
      redirect: "follow",
      headers: {
        "user-agent": "TradePlanApp/1.0",
        ...(init?.headers || {}),
      },
    });
  } finally {
    clearTimeout(id);
  }
}

// Estimate bytes of a data URL (for logging)
function dataUrlSizeBytes(s: string | null | undefined): number {
  if (!s) return 0;
  const i = s.indexOf(",");
  if (i < 0) return 0;
  const b64 = s.slice(i + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

// ---------- Headlines (fetch 12; embed 6 into prompt) ----------
function formatHeadlines(items: any[], max = 6): string {
  const rows: string[] = [];
  for (const it of (items || []).slice(0, max)) {
    const s = typeof it?.sentiment?.score === "number" ? it.sentiment.score : null;
    const lab = s == null ? "neu" : s > 0.05 ? "pos" : s < -0.05 ? "neg" : "neu";
    const t = String(it?.title || "").slice(0, 200);
    const src = it?.source || "";
    const when = it?.ago || "";
    rows.push(`• ${t} — ${src}, ${when} — ${lab}`);
  }
  return rows.join("\n");
}

async function fetchedHeadlinesItems(req: NextApiRequest, instrument: string) {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(
      instrument
    )}&hours=48&max=12&_t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    return items;
  } catch {
    return [];
  }
}

// ---------- Accuracy-first and Fast pipelines ----------
type ImgOut = { buffer: Buffer; mime: "image/jpeg" | "image/webp" };

async function toJpeg(buf: Buffer, width: number, quality: number): Promise<Buffer> {
  return sharp(buf).rotate().resize({ width, withoutEnlargement: true }).sharpen()
    .jpeg({ quality, progressive: true, mozjpeg: true }).toBuffer();
}
async function toWebp(buf: Buffer, width: number, quality: number): Promise<Buffer> {
  return sharp(buf).rotate().resize({ width, withoutEnlargement: true }).sharpen()
    .webp({ quality, effort: 4 }).toBuffer();
}

async function processAccurate(buf: Buffer): Promise<ImgOut> {
  // Try JPEG q≈82 first
  let out = await toJpeg(buf, HQ_MAX_WIDTH, HQ_JPEG_Q);
  let mime: ImgOut["mime"] = "image/jpeg";

  if (out.byteLength > HQ_TARGET_MAX) {
    // Try WebP high quality
    const webp1 = await toWebp(buf, HQ_MAX_WIDTH, HQ_WEBP_Q1);
    if (webp1.byteLength <= HQ_TARGET_MAX) {
      out = webp1; mime = "image/webp";
    } else {
      const webp2 = await toWebp(buf, HQ_MAX_WIDTH, HQ_WEBP_Q2);
      // choose smallest among candidates; prefer webp if smaller
      const best = [ {b: out, m: "image/jpeg" as const}, {b: webp1, m: "image/webp" as const}, {b: webp2, m: "image/webp" as const} ]
        .sort((x,y)=>x.b.byteLength - y.b.byteLength)[0];
      out = best.b; mime = best.m;
    }
  }
  return { buffer: out, mime };
}

async function processFast(buf: Buffer): Promise<ImgOut> {
  // pass 1
  let q = FAST_JPEG_Q;
  let out = await toJpeg(buf, FAST_MAX_WIDTH, q);
  if (out.byteLength > FAST_TARGET_MAX && q > FAST_MIN_Q + 10) {
    q = Math.max(FAST_MIN_Q + 10, FAST_JPEG_Q - 10);
    out = await toJpeg(buf, FAST_MAX_WIDTH, q);
  }
  if (out.byteLength > FAST_TARGET_MAX && q > FAST_MIN_Q) {
    q = FAST_MIN_Q;
    out = await toJpeg(buf, FAST_MAX_WIDTH, q);
  }
  return { buffer: out, mime: "image/jpeg" };
}

async function processBufferToDataUrl(buf: Buffer): Promise<string> {
  const { buffer, mime } = VISION_HQ ? await processAccurate(buf) : await processFast(buf);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function fileToProcessedDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p = file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;
  const raw = await fs.readFile(p);
  const dataUrl = await processBufferToDataUrl(raw);
  if (process.env.NODE_ENV !== "production") {
    console.log(`[vision-plan] file processed size=${dataUrlSizeBytes(dataUrl)}B (hq=${VISION_HQ})`);
  }
  return dataUrl;
}

// ---------- TV page → og:image resolver ----------
function htmlFindOgImage(html: string): string | null {
  const re1 = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;
  const m1 = html.match(re1);
  if (m1?.[1]) return m1[1];
  const re2 = /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i;
  const m2 = html.match(re2);
  if (m2?.[1]) return m2[1];
  return null;
}
function absoluteUrl(base: string, maybe: string) {
  try { return new URL(maybe, base).toString(); } catch { return maybe; }
}

// ---------- 2-minute in-memory cache for processed chart URLs ----------
type ImgCacheEntry = { exp: number; dataUrl: string };
const imgCache = new Map<string, ImgCacheEntry>();
function getCachedDataUrl(key: string): string | null {
  const e = imgCache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { imgCache.delete(key); return null; }
  return e.dataUrl;
}
function setCachedDataUrl(key: string, dataUrl: string, ttlMs = 120_000) {
  imgCache.set(key, { exp: Date.now() + ttlMs, dataUrl });
}

// Download remote image and convert to data URL (3s timeout, size capped)
async function downloadImageAsDataUrl(url: string): Promise<string | null> {
  const r = await fetchWithTimeout(url, 3000, {
    headers: { accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
  });
  if (!r.ok) return null;
  const ab = await r.arrayBuffer();
  const raw = Buffer.from(ab);
  if (raw.byteLength > IMG_MAX_BYTES) return null;
  const dataUrl = await processBufferToDataUrl(raw);
  if (process.env.NODE_ENV !== "production") {
    console.log(`[vision-plan] chart processed size=${dataUrlSizeBytes(dataUrl)}B from ${url} (hq=${VISION_HQ})`);
  }
  return dataUrl;
}

// Resolve any chart link (direct image or TV page) into a processed data URL.
async function chartLinkToDataUrl(link: string): Promise<{ dataUrl: string | null; mode: "direct" | "page-fallback" | "fail" }> {
  if (!link) return { dataUrl: null, mode: "fail" };
  const cached = getCachedDataUrl(link);
  if (cached) return { dataUrl: cached, mode: "direct" };

  if (looksLikeImageUrl(link)) {
    const data = await downloadImageAsDataUrl(link);
    if (data) { setCachedDataUrl(link, data); return { dataUrl: data, mode: "direct" }; }
    return { dataUrl: null, mode: "fail" };
  }

  // TV page fallback: fetch page (3s) → og:image → fetch image (3s) → downscale
  try {
    const page = await fetchWithTimeout(link, 3000);
    if (!page.ok) return { dataUrl: null, mode: "fail" };
    const html = await page.text();
    const og = htmlFindOgImage(html);
    if (!og) return { dataUrl: null, mode: "fail" };
    const imgUrl = absoluteUrl(link, og);
    const data = await downloadImageAsDataUrl(imgUrl);
    if (data) { setCachedDataUrl(link, data); return { dataUrl: data, mode: "page-fallback" }; }
    return { dataUrl: null, mode: "fail" };
  } catch {
    return { dataUrl: null, mode: "fail" };
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

// ---------- OpenAI call (unchanged) ----------
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

// ---------- prompt builders (unchanged structure) ----------
function tournamentMessages(params: {
  instrument: string;
  dateStr: string;
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
  sentimentText?: string | null;
  m15: string;
  h1: string;
  h4: string;
}) {
  const { instrument, dateStr, calendarDataUrl, headlinesText, sentimentText, m15, h1, h4 } = params;

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
    userParts.push({ type: "text", text: `Recent headlines snapshot:\n${headlinesText}` });
  }
  if (sentimentText) {
    userParts.push({ type: "text", text: sentimentText });
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
  sentimentText?: string | null;
  m15: string;
  h1: string;
  h4: string;
}) {
  const messages = tournamentMessages(args);
  const text = await callOpenAI(messages);
  const aiMeta = extractAiMeta(text);
  return { text, aiMeta };
}

// ---------- SINGLE-PASS ENFORCEMENT ----------
async function enforceCardConstraints(instrument: string, text: string, aiMeta: any) {
  const system =
    "Enforce the following constraints on the provided trade card while preserving format and ALL sections (Quick Plan, Full Breakdown, X-ray, Candidate Scores, Final Table). " +
    "Only adjust what the rules require; keep bullets, tables, and wording otherwise stable. Update the trailing ai_meta to match any changes.\n\n" +
    "Constraints:\n" +
    "1) Market entry allowed ONLY when breakoutProof.bodyCloseBeyond=true AND (retestHolds=true OR sfpReclaim=true). If missing, rewrite to Pending with a Buy/Sell Limit zone at OB/FVG/SR confluence.\n" +
    "2) If the setup claims 'Breakout + Retest' but the above proof is missing, rename the setup to 'Pullback (OB/FVG/SR)'.\n" +
    "3) Order sanity: Sell Limit must be ABOVE current price (pullback into supply). Buy Limit must be BELOW current price (pullback into demand). If violated, adjust only the LIMIT zone and entry (do not change the whole thesis).\n" +
    "Do NOT remove sections. Do NOT change the instrument. Keep Option 2 (Market) visibility rule. Preserve numbers unless a change is required by these constraints.";

  const user =
    `Instrument: ${instrument}\n` +
    `ai_meta (as parsed):\n${JSON.stringify(aiMeta || {}, null, 2)}\n\n` +
    `Card:\n${text}\n\n` +
    `Apply the constraints above and return the FULL corrected card with the same section headers and a final \`\`\`ai_meta\`\`\` block.`;

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  return callOpenAI(messages);
}

// ---------- sentiment with strict global budget ----------
async function buildSentimentTextWithBudget(instrument: string, budgetMs = 600): Promise<string | null> {
  const start = now();

  const task = (async () => {
    const [csm, cot] = await Promise.all([
      getCurrencyStrengthIntraday({ range: "1d", interval: "15m", ttlSec: 120, timeoutMs: budgetMs }),
      getCotBiasBrief({ ttlSec: 86400, timeoutMs: budgetMs }),
    ]);
    const csmLine = formatStrengthLine(csm);
    const { base, quote } = parseInstrumentCurrencies(instrument);
    const cotLine = formatCotLine(cot, [base || "", quote || ""].filter(Boolean));
    const parts = [csmLine, cotLine].filter(Boolean);
    if (!parts.length) return null;
    return `Sentiment Snapshot:\n${parts.map((p) => `• ${p}`).join("\n")}`;
  })();

  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs));
  const result = await Promise.race([task, timeout]);

  if (process.env.NODE_ENV !== "production") {
    console.log(`[vision-plan] sentiment ${result ? "ok" : "skipped"} in ${dt(start)}`);
  }
  return (result as string) || null;
}

// ---------- handler ----------
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Ok | Err>
) {
  const tAll = now();
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });
    if (!isMultipart(req)) {
      return res.status(400).json({
        ok: false,
        reason:
          "Use multipart/form-data with files: m15, h1, h4 (PNG/JPG/WEBP) and optional 'calendar'. Or pass m15Url/h1Url/h4Url (chart links). Include 'instrument'.",
      });
    }

    const tParse = now();
    const { fields, files } = await parseMultipart(req);
    if (process.env.NODE_ENV !== "production") {
      console.log(`[vision-plan] parse ${dt(tParse)} (hq=${VISION_HQ})`);
    }

    const instrument = String(fields.instrument || fields.code || "EURUSD")
      .toUpperCase()
      .replace(/\s+/g, "");

    // Files (if provided)
    const m15f = pickFirst(files.m15);
    const h1f = pickFirst(files.h1);
    const h4f = pickFirst(files.h4);
    const calF = pickFirst(files.calendar);

    // URLs (optional)
    const m15UrlRaw = String(pickFirst(fields.m15Url) || "").trim();
    const h1UrlRaw  = String(pickFirst(fields.h1Url)  || "").trim();
    const h4UrlRaw  = String(pickFirst(fields.h4Url)  || "").trim();

    // Build images: ALWAYS produce processed data URLs for charts (files or links)
    const tImages = now();
    const [m15FromFile, h1FromFile, h4FromFile, calUrl] = await Promise.all([
      m15f ? fileToProcessedDataUrl(m15f) : Promise.resolve(null),
      h1f ? fileToProcessedDataUrl(h1f) : Promise.resolve(null),
      h4f ? fileToProcessedDataUrl(h4f) : Promise.resolve(null),
      calF ? fileToProcessedDataUrl(calF) : Promise.resolve(null),
    ]);

    const [m15FromLink, h1FromLink, h4FromLink] = await Promise.all([
      m15FromFile ? Promise.resolve({ dataUrl: m15FromFile, mode: "direct" as const }) : chartLinkToDataUrl(m15UrlRaw),
      h1FromFile  ? Promise.resolve({ dataUrl: h1FromFile,  mode: "direct" as const }) : chartLinkToDataUrl(h1UrlRaw),
      h4FromFile  ? Promise.resolve({ dataUrl: h4FromFile,  mode: "direct" as const }) : chartLinkToDataUrl(h4UrlRaw),
    ]);

    const m15 = m15FromFile || m15FromLink.dataUrl;
    const h1  = h1FromFile  || h1FromLink.dataUrl;
    const h4  = h4FromFile  || h4FromLink.dataUrl;

    if (process.env.NODE_ENV !== "production") {
      const m15Size = dataUrlSizeBytes(m15);
      const h1Size  = dataUrlSizeBytes(h1);
      const h4Size  = dataUrlSizeBytes(h4);
      const calSize = dataUrlSizeBytes(calUrl || "");
      console.log(
        `[vision-plan] images prepared ${dt(tImages)} ` +
        `(m15=${m15FromFile ? "file" : m15FromLink.mode}:${m15Size}B, ` +
        `h1=${h1FromFile ? "file" : h1FromLink.mode}:${h1Size}B, ` +
        `h4=${h4FromFile ? "file" : h4FromLink.mode}:${h4Size}B; ` +
        `calendar=${calUrl ? calSize + "B" : "none"})`
      );
    }

    if (!m15 || !h1 || !h4) {
      const missing: string[] = [];
      if (!m15) missing.push("m15");
      if (!h1)  missing.push("h1");
      if (!h4)  missing.push("h4");
      return res.status(400).json({
        ok: false,
        reason:
          `Could not resolve ${missing.join(", ")} chart link(s). Use a direct image URL (.png/.jpg/.webp like Gyazo/TV export) or upload the snapshot.`,
      });
    }

    // Headlines: fetch 12; embed only 6
    const tNews = now();
    const items = await fetchedHeadlinesItems(req, instrument);
    const headlinesPromptText = items.length ? formatHeadlines(items, 6) : null;
    if (process.env.NODE_ENV !== "production") {
      console.log(`[vision-plan] news fetched in ${dt(tNews)} (items=${items.length})`);
    }

    // Sentiment: strict ~600ms budget; skip if slow
    const tSent = now();
    const sentimentText = await buildSentimentTextWithBudget(instrument, 600);
    if (process.env.NODE_ENV !== "production") {
      console.log(`[vision-plan] sentiment stage ${dt(tSent)} (included=${!!sentimentText})`);
    }

    const dateStr = new Date().toISOString().slice(0, 10);

    // 1) Tournament pass (all sections/format unchanged)
    const tAI = now();
    let { text, aiMeta } = await askTournament({
      instrument,
      dateStr,
      calendarDataUrl: calUrl || undefined,
      headlinesText: headlinesPromptText || undefined, // <= only 6 in prompt
      sentimentText: sentimentText || undefined,        // <= compact, optional
      m15, h1, h4,
    });
    if (process.env.NODE_ENV !== "production") {
      console.log(`[vision-plan] openai main completed in ${dt(tAI)}`);
    }

    // 2) Single-pass enforcement (only if needed)
    const bp = aiMeta?.breakoutProof || {};
    const hasProof = !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
    const breakoutNamed = String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout");
    const pendingNeeded = needsPendingLimit(aiMeta);
    const badOrder = invalidOrderRelativeToPrice(aiMeta);

    if (pendingNeeded || (breakoutNamed && !hasProof) || badOrder) {
      const tFix = now();
      text = await enforceCardConstraints(instrument, text, aiMeta);
      aiMeta = extractAiMeta(text) || aiMeta;
      if (process.env.NODE_ENV !== "production") {
        console.log(`[vision-plan] enforcement pass in ${dt(tFix)} (pendingNeeded=${pendingNeeded}, breakoutNoProof=${breakoutNamed && !hasProof}, badOrder=${!!badOrder})`);
      }
    }

    // 3) Fallback if refusal/empty
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
              breakoutProof: { bodyCloseBeyond: false, retestHolds: false, sfpReclaim: false },
              candidateScores: [],
              note: "Fallback used due to refusal/empty output.",
            },
            null,
            2
          ),
          "```",
        ].join("\n");

      if (process.env.NODE_ENV !== "production") {
        console.log(`[vision-plan] TOTAL ${dt(tAll)} (fallback)`);
      }

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        text: fallback,
        meta: {
          instrument,
          hasCalendar: !!calUrl,
          headlinesCount: items.length,
          strategySelection: false,
          rewritten: false,
          fallbackUsed: true,
          aiMeta: extractAiMeta(fallback),
        },
      });
    }

    if (process.env.NODE_ENV !== "production") {
      console.log(`[vision-plan] TOTAL ${dt(tAll)} (success)`);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text,
      meta: {
        instrument,
        hasCalendar: !!calUrl,
        headlinesCount: items.length,
        strategySelection: true,
        rewritten: false,
        fallbackUsed: false,
        aiMeta,
      },
    });
  } catch (err: any) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[vision-plan] TOTAL ${dt(tAll)} (error): ${err?.message || err}`);
    }
    return res.status(500).json({
      ok: false,
      reason: err?.message || "vision-plan failed",
    });
  }
}
