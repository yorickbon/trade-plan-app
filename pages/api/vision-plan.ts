// /pages/api/vision-plan.ts
// Images-only planner with optional TradingView image URL fetch.
// Uploads: m15 (execution), h1 (context), h4 (HTF), optional calendar image.
// Or pass m15Url / h1Url / h4Url (TradingView “Copy link to image”).
// Changes: (1) Headlines: fetch 12, embed 6. (2) Hybrid-fast image handling: pass-through small direct image URLs; downscale otherwise. (3) Inject compact CSM/COT with strict timeouts & caching.
// All output sections & logic remain unchanged.

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

function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
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

// ---------- Image handling (hybrid fast path) ----------
const IMG_MAX_BYTES = 12 * 1024 * 1024; // 12MB route safety cap
const PASS_THROUGH_MAX = 1_200_000;     // if remote image is <= ~1.2MB, pass URL directly
const TARGET_MAX_WIDTH = 1280;
const TARGET_QUALITY_START = 72; // ~70%
const TARGET_MIN_QUALITY = 50;
const TARGET_MAX_BYTES = 600 * 1024; // target ~≤600 KB best-effort

function isLikelyImageUrl(url: string) {
  return /\.(png|jpe?g|webp)$/i.test(url.split("?")[0] || "");
}

async function headInfo(url: string): Promise<{ isImage: boolean; length: number | null; ctype: string }> {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!r.ok) return { isImage: false, length: null, ctype: "" };
    const ctype = String(r.headers.get("content-type") || "").toLowerCase();
    const clen = r.headers.get("content-length");
    const length = clen ? parseInt(clen, 10) : null;
    return { isImage: ctype.startsWith("image/"), length: isFinite(length as any) ? (length as number) : null, ctype };
  } catch {
    return { isImage: isLikelyImageUrl(url), length: null, ctype: "" };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("Image fetch timeout")), ms);
    p.then((v) => { clearTimeout(id); resolve(v); }).catch((e) => { clearTimeout(id); reject(e); });
  });
}

async function fetchBuffer(url: string): Promise<{ buf: Buffer; mime: string } | null> {
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; TradePlanBot/1.0; +https://trade-plan-app.vercel.app)",
      accept: "text/html,application/xhtml+xml,application/xml,image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  });
  if (!r.ok) return null;
  const ctype = String(r.headers.get("content-type") || "").toLowerCase();
  const mime = ctype.split(";")[0].trim() || "image/png";
  const ab = await r.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.byteLength > IMG_MAX_BYTES) throw new Error("Image too large");
  return { buf, mime };
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

function absoluteUrl(base: string, maybe: string) {
  try { return new URL(maybe, base).toString(); } catch { return maybe; }
}

async function bufferToJpeg(buf: Buffer): Promise<Buffer> {
  // Convert to JPEG, strip metadata, progressive encode, limit width
  let quality = TARGET_QUALITY_START;
  let out = await sharp(buf)
    .rotate()
    .resize({ width: TARGET_MAX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality, progressive: true, mozjpeg: true })
    .toBuffer();

  while (out.byteLength > TARGET_MAX_BYTES && quality > TARGET_MIN_QUALITY) {
    quality -= 5;
    out = await sharp(buf)
      .rotate()
      .resize({ width: TARGET_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality, progressive: true, mozjpeg: true })
      .toBuffer();
  }
  return out;
}

async function fileToProcessedDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p = file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;
  const raw = await fs.readFile(p);
  const jpeg = await bufferToJpeg(raw);
  const data = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  if (process.env.NODE_ENV !== "production") {
    console.log(`[vision-plan] calendar processed size=${jpeg.byteLength}B`);
  }
  return data;
}

async function tvLinkToImageUrlOrDataUrl(link: string): Promise<{ url: string | null; mode: "pass" | "downscale" | "html-fallback" | "unknown" }> {
  if (!link) return { url: null, mode: "unknown" };
  try {
    const head = await headInfo(link);
    if (head.isImage && (head.length == null || head.length <= PASS_THROUGH_MAX)) {
      if (process.env.NODE_ENV !== "production") {
        console.log(`[vision-plan] TV link pass-through (${head.length ?? "?"} bytes): ${link}`);
      }
      return { url: link, mode: "pass" };
    }

    // Not a direct/acceptable image → fetch and try to convert
    const first = await withTimeout(fetchBuffer(link), 12000);
    if (!first) return { url: null, mode: "unknown" };

    if (first.mime.toLowerCase().startsWith("image/")) {
      const jpeg = await bufferToJpeg(first.buf);
      if (process.env.NODE_ENV !== "production") {
        console.log(`[vision-plan] TV link downscale -> ${jpeg.byteLength}B: ${link}`);
      }
      return { url: `data:image/jpeg;base64,${jpeg.toString("base64")}`, mode: "downscale" };
    }

    // HTML page: extract og:image
    const html = first.buf.toString("utf8");
    const og = htmlFindOgImage(html);
    if (!og) return { url: null, mode: "unknown" };
    const resolved = absoluteUrl(link, og);
    const second = await withTimeout(fetchBuffer(resolved), 12000);
    if (!second || !second.mime.toLowerCase().startsWith("image/")) return { url: null, mode: "unknown" };
    const jpeg2 = await bufferToJpeg(second.buf);
    if (process.env.NODE_ENV !== "production") {
      console.log(`[vision-plan] TV link html→image downscale -> ${jpeg2.byteLength}B: ${link}`);
    }
    return { url: `data:image/jpeg;base64,${jpeg2.toString("base64")}`, mode: "html-fallback" };
  } catch {
    return { url: null, mode: "unknown" };
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

// ---------- OpenAI ----------
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

// ---------- prompt builders (structure unchanged) ----------
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

// --- label corrections / guard-rails (unchanged) ---
async function rewriteAsPending(instrument: string, text: string) {
  const messages = [
    { role: "system", content: "Rewrite the trade card as PENDING (no Market) into a clean Buy/Sell LIMIT zone at OB/FVG/SR confluence if breakout proof is missing. Keep tournament section and X-ray." },
    { role: "user", content: `Instrument: ${instrument}\n\n${text}\n\nRewrite strictly to Pending.` },
  ];
  return callOpenAI(messages);
}

async function normalizeBreakoutLabel(text: string) {
  const messages = [
    { role: "system", content: "If 'Breakout + Retest' is claimed but proof is not shown (body close + retest hold or SFP reclaim), rename setup to 'Pullback (OB/FVG/SR)' and leave rest unchanged." },
    { role: "user", content: text },
  ];
  return callOpenAI(messages);
}

async function fixOrderVsPrice(instrument: string, text: string, aiMeta: any) {
  const messages = [
    { role: "system", content: "Adjust the LIMIT zone so that: Sell Limit is an ABOVE-price pullback into supply; Buy Limit is a BELOW-price pullback into demand. Keep all other content & sections." },
    { role: "user", content: `Instrument: ${instrument}\n\nCurrent Price: ${aiMeta?.currentPrice}\nProvided Zone: ${JSON.stringify(aiMeta?.zone)}\n\nCard:\n${text}\n\nFix only the LIMIT zone side and entry, keep format.` },
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
          "Use multipart/form-data with files: m15, h1, h4 (optional) and 'calendar' (optional). Or pass m15Url/h1Url/h4Url (TradingView image links). Include 'instrument'.",
      });
    }

    const { fields, files } = await parseMultipart(req);
    const instrument = String(fields.instrument || fields.code || "EURUSD").toUpperCase().replace(/\s+/g, "");

    // Files (if provided)
    const m15f = pickFirst(files.m15);
    const h1f = pickFirst(files.h1);
    const h4f = pickFirst(files.h4);
    const calF = pickFirst(files.calendar);

    // URLs (optional; TradingView "Copy link to image")
    const m15Url = String(pickFirst(fields.m15Url) || "").trim();
    const h1Url = String(pickFirst(fields.h1Url) || "").trim();
    const h4Url = String(pickFirst(fields.h4Url) || "").trim();

    // Build chart images:
    // - prefer file if given → downscale
    // - else TV link with hybrid fast path: HEAD→pass-through small images; else fetch+downscale (HTML og:image handled)
    const [m15FromFile, h1FromFile, h4FromFile] = await Promise.all([
      m15f ? fileToProcessedDataUrl(m15f) : Promise.resolve(null),
      h1f ? fileToProcessedDataUrl(h1f) : Promise.resolve(null),
      h4f ? fileToProcessedDataUrl(h4f) : Promise.resolve(null),
    ]);

    const [m15FromUrl, h1FromUrl, h4FromUrl] = await Promise.all([
      m15FromFile ? Promise.resolve({ url: null, mode: "unknown" as const }) : tvLinkToImageUrlOrDataUrl(m15Url),
      h1FromFile ? Promise.resolve({ url: null, mode: "unknown" as const }) : tvLinkToImageUrlOrDataUrl(h1Url),
      h4FromFile ? Promise.resolve({ url: null, mode: "unknown" as const }) : tvLinkToImageUrlOrDataUrl(h4Url),
    ]);

    const m15 = m15FromFile || m15FromUrl.url;
    const h1  = h1FromFile  || h1FromUrl.url;
    const h4  = h4FromFile  || h4FromUrl.url;

    // Calendar: if provided, always downscale
    const calUrl = calF ? await fileToProcessedDataUrl(calF) : null;

    if (!m15 || !h1 || !h4) {
      return res.status(400).json({ ok: false, reason: "Provide all three charts: m15, h1, h4 — either as files or valid TradingView image links." });
    }

    // Headlines: fetch 12 for UI, embed only 6 into prompt
    const items = await fetchedHeadlinesItems(req, instrument);
    const headlinesPromptText = items.length ? formatHeadlines(items, 6) : null;

    // Sentiment: strict budget (fast-fail & cache)
    let sentimentText: string | null = null;
    try {
      const [csm, cot] = await Promise.all([
        getCurrencyStrengthIntraday({ range: "1d", interval: "15m", ttlSec: 120, timeoutMs: 1200 }),
        getCotBiasBrief({ ttlSec: 86400, timeoutMs: 1200 }),
      ]);
      const csmLine = formatStrengthLine(csm);
      const { base, quote } = parseInstrumentCurrencies(instrument);
      const cotLine = formatCotLine(cot, [base || "", quote || ""].filter(Boolean));
      const parts = [csmLine, cotLine].filter(Boolean);
      if (parts.length) {
        sentimentText = `Sentiment Snapshot:\n${parts.map(p => `• ${p}`).join("\n")}`;
      }
    } catch {
      sentimentText = null;
    }

    const dateStr = new Date().toISOString().slice(0, 10);

    // 1) Tournament pass (unchanged structure)
    let { text, aiMeta } = await askTournament({
      instrument,
      dateStr,
      calendarDataUrl: calUrl || undefined,
      headlinesText: headlinesPromptText || undefined,
      sentimentText: sentimentText || undefined,
      m15, h1, h4,
    });

    // 2) Force Pending if Market without proof
    if (aiMeta && needsPendingLimit(aiMeta)) {
      text = await rewriteAsPending(instrument, text);
      aiMeta = extractAiMeta(text) || aiMeta;
    }

    // 3) Normalize mislabeled Breakout+Retest when no proof
    const bp = aiMeta?.breakoutProof || {};
    const hasProof = !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
    if (String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout") && !hasProof) {
      text = await normalizeBreakoutLabel(text);
      aiMeta = extractAiMeta(text) || aiMeta;
    }

    // 4) Enforce order sanity (Sell Limit above / Buy Limit below current price)
    if (aiMeta) {
      const bad = invalidOrderRelativeToPrice(aiMeta);
      if (bad) {
        text = await fixOrderVsPrice(instrument, text, aiMeta);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // 5) Fallback if refusal/empty (unchanged)
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
        debug: (process.env.NODE_ENV !== "production") ? {
          m15Mode: m15FromFile ? "file-downscale" : (m15FromUrl?.mode || "pass?"),
          h1Mode:  h1FromFile  ? "file-downscale" : (h1FromUrl?.mode  || "pass?"),
          h4Mode:  h4FromFile  ? "file-downscale" : (h4FromUrl?.mode  || "pass?"),
        } : undefined,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}
