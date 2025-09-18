// /pages/api/vision-plan.ts
/**
 * OCR-first calendar (image priority) — improved acceptance of pre-release rows
 * - Accepts forecast-vs-previous (no actual yet) to derive expected bias.
 * - Only shows "Calendar provided, but no relevant info for <INSTRUMENT>." when OCR has zero rows for the pair’s currencies.
 * - Keeps API calendar fallback, but OCR should satisfy most cases now.
 * - Preserves section enforcement, consistency guard, conviction (0–100, no hard caps), caching, and provenance.
 * - Adds scalping mode (query/body field `scalping=true|1|on|yes`) and optional 1m chart.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";
import sharp from "sharp";

// ---------- config ----------
export const config = { api: { bodyParser: false, sizeLimit: "25mb" } };

type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

const VP_VERSION = "2025-09-18-vp-AtoL-rc1";

// ---------- OpenAI / Model pick ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const DEFAULT_MODEL = process.env.OPENAI_MODEL_ALT || "gpt-4o";
const ALT_MODEL     = process.env.OPENAI_MODEL     || "gpt-5";

function pickModelFromFields(req: NextApiRequest, fields?: Record<string, any>) {
  const raw = String((fields?.model as string) || (req.query.model as string) || "").trim().toLowerCase();
  if (raw.startsWith("gpt-5"))  return ALT_MODEL || "gpt-5";
  if (raw.startsWith("gpt-4o")) return DEFAULT_MODEL || "gpt-4o";
  return DEFAULT_MODEL || "gpt-4o";
}

// ---------- market data keys ----------
const TD_KEY = process.env.TWELVEDATA_API_KEY || "";
const FH_KEY = process.env.FINNHUB_API_KEY || process.env.FINNHUB_APT_KEY || "";
const POLY_KEY = process.env.POLYGON_API_KEY || "";

// ---------- small utils ----------
const IMG_MAX_BYTES = 12 * 1024 * 1024;
const BASE_W = 1280;
const MAX_W = 1500;
const TARGET_MIN = 420 * 1024;
const TARGET_MAX = 1200 * 1024;

function uuid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function dataUrlSizeBytes(s: string | null | undefined): number {
  if (!s) return 0;
  const i = s.indexOf(","); if (i < 0) return 0;
  const b64 = s.slice(i + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}
// tolerant numeric parser for %, K/M/B, commas, Unicode minus, and OCR suffixes like "m/m", "y/y", "mom", "yoy"
function parseNumberLoose(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;

  let s = String(v).trim().toLowerCase();
  if (!s || s === "n/a" || s === "na" || s === "-" || s === "—") return null;

  // Normalize unicode and strip common noise the OCR calendar produces
  s = s.replace(/\u2212/g, "-");      // Unicode minus → hyphen
  s = s.replace(/[()\u00A0]/g, "");   // parentheses & non-breaking spaces
  s = s.replace(/,/g, "");            // thousands separators
  s = s.replace(/\s+/g, "");          // all spaces

  // Drop common econ qualifiers that trail numbers (do not change the value):
  // e.g. "0.4%m/m", "1.2%y/y", "0.2mom", "0.2yoy", "q/q", "sa", "nsa"
  s = s.replace(/(m\/m|y\/y|q\/q|mom|yoy|qoq|sa|nsa)$/i, "");
  s = s.replace(/(m\/m|y\/y|q\/q|mom|yoy|qoq|sa|nsa)(?=%|$)/ig, "");

  // Allow leading "+" and trailing percent
  let mult = 1;
  if (s.endsWith("%")) { s = s.slice(0, -1); }

  // Suffix multipliers
  if (s.endsWith("k")) { mult = 1_000; s = s.slice(0, -1); }
  else if (s.endsWith("m")) { mult = 1_000_000; s = s.slice(0, -1); }
  else if (s.endsWith("b")) { mult = 1_000_000_000; s = s.slice(0, -1); }

  // If there's still trailing non-numeric junk (e.g., "0.4pp"), strip it safely
  s = s.replace(/[^0-9eE+.\-]+$/g, "");

  const n = parseFloat(s);
  return Number.isFinite(n) ? n * mult : null;
}


// --- keep label and sign consistent for fundamentals ---
function signFromLabel(label?: string): -1 | 0 | 1 {
  const s = (label || "").toLowerCase();
  if (s === "bullish") return 1;
  if (s === "bearish") return -1;
  return 0; // neutral / unknown
}


// ---------- in-memory image cache ----------
type CacheEntry = {
  exp: number;
  instrument: string;
  m5?: string | null;
  m15: string;
  h1: string;
  h4: string;
  calendar?: string | null;
  headlinesText?: string | null;
  sentimentText?: string | null;
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

// ---------- CSM cache (15 min) ----------
type CsmSnapshot = { tsISO: string; ranks: string[]; scores: Record<string, number>; ttl: number; };
let CSM_CACHE: CsmSnapshot | null = null;

// ---------- formidable helpers ----------
async function getFormidable() { const mod: any = await import("formidable"); return mod.default || mod; }
function isMultipart(req: NextApiRequest) { const t = String(req.headers["content-type"] || ""); return t.includes("multipart/form-data"); }
async function parseMultipart(req: NextApiRequest) {
  const formidable = await getFormidable();
  const form = formidable({ multiples: false, maxFiles: 25, maxFileSize: 25 * 1024 * 1024 });
  return new Promise<{ fields: Record<string, any>; files: Record<string, any> }>((resolve, reject) => {
    form.parse(req as any, (err: any, fields: any, files: any) => { if (err) return reject(err); resolve({ fields, files }); });
  });
}
function pickFirst<T = any>(x: T | T[] | undefined | null): T | null { if (!x) return null; return Array.isArray(x) ? (x[0] ?? null) : (x as any); }

// ---------- image processing ----------
async function toJpeg(buf: Buffer, width: number, quality: number): Promise<Buffer> {
  // Mild sharpening + normalize improves text/line clarity on uploaded charts without bloating size
  return sharp(buf)
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .normalize()             // expands contrast range; helps tiny markings/labels
    .sharpen(0.6)            // gentle sharpening; avoids halos
    .jpeg({ quality, progressive: true, mozjpeg: true })
    .toBuffer();
}

async function processAdaptiveToDataUrl(buf: Buffer): Promise<string> {
  let width = BASE_W, quality = 74;
  let out = await toJpeg(buf, width, quality);
  let guard = 0;
  while (out.byteLength < TARGET_MIN && guard < 4) {
    quality = Math.min(quality + 6, 88);
    if (quality >= 82 && width < MAX_W) width = Math.min(width + 100, MAX_W);
    out = await toJpeg(buf, width, quality);
    guard++;
  }
  if (out.byteLength < TARGET_MIN && (quality < 88 || width < MAX_W)) {
    quality = Math.min(quality + 4, 88); width = Math.min(width + 100, MAX_W);
    out = await toJpeg(buf, width, quality);
  }
  if (out.byteLength > TARGET_MAX) { const q2 = Math.max(72, quality - 6); out = await toJpeg(buf, width, q2); }
  if (out.byteLength > IMG_MAX_BYTES) throw new Error("image too large after processing");
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}
async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p = file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;
  const raw = await fs.readFile(p);
  const out = await processAdaptiveToDataUrl(raw);
  if (process.env.NODE_ENV !== "production") console.log(`[vision-plan] file processed size=${dataUrlSizeBytes(out)}B`);
  return out;
}

// ---------- tradingview/gyazo link → dataURL ----------
function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}
function absoluteUrl(base: string, maybe: string) { try { return new URL(maybe, base).toString(); } catch { return maybe; } }
function htmlFindOgImage(html: string): string | null {
  const re1 = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;
  const m1 = html.match(re1); if (m1?.[1]) return m1[1];
  const re2 = /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i;
  const m2 = html.match(re2); if (m2?.[1]) return m2[1];
  return null;
}
function looksLikeImageUrl(u: string) { const s = String(u || "").split("?")[0] || ""; return /\.(png|jpe?g|webp|gif)$/i.test(s); }
async function fetchWithTimeout(url: string, ms: number) { return fetch(url, { signal: AbortSignal.timeout(ms), redirect: "follow" }); }
async function downloadAndProcess(url: string): Promise<string | null> {
  const r = await fetchWithTimeout(url, 8000);
  if (!r || !r.ok) return null;
  const ct = String(r.headers.get("content-type") || "").toLowerCase();
  const mime = ct.split(";")[0].trim();
  const ab = await r.arrayBuffer();
  const raw = Buffer.from(ab);
  if (raw.byteLength > IMG_MAX_BYTES) return null;

  if (mime.startsWith("image/")) {
    const out = await processAdaptiveToDataUrl(raw);
    if (process.env.NODE_ENV !== "production") console.log(`[vision-plan] link processed size=${dataUrlSizeBytes(out)}B from ${url}`);
    return out;
  }
  const html = raw.toString("utf8");
  const og = htmlFindOgImage(html); if (!og) return null;
  const resolved = absoluteUrl(url, og);
  const r2 = await fetchWithTimeout(resolved, 8000);
  if (!r2 || !r2.ok) return null;
  const ab2 = await r2.arrayBuffer();
  const raw2 = Buffer.from(ab2);
  if (raw2.byteLength > IMG_MAX_BYTES) return null;
  const out2 = await processAdaptiveToDataUrl(raw2);
  if (process.env.NODE_ENV !== "production") console.log(`[vision-plan] og:image processed size=${dataUrlSizeBytes(out2)}B from ${resolved}`);
  return out2;
}
async function linkToDataUrl(link: string): Promise<string | null> {
  if (!link) return null;
  try {
    if (looksLikeImageUrl(link)) return await downloadAndProcess(link);
    return await downloadAndProcess(link);
  } catch {
    return null;
  }
}

// ---------- Headlines ----------
type AnyHeadline = {
  title?: string;
  description?: string;
  source?: string;
  published_at?: string;
  ago?: string;
  sentiment?: { score?: number } | null;
} & Record<string, any>;

type HeadlineBias = {
  label: "bullish" | "bearish" | "neutral" | "unavailable";
  avg: number | null;
  count: number;
};

function headlinesToPromptLines(items: AnyHeadline[], limit = 6): string | null {
  const take = (items || []).slice(0, limit);
  if (!take.length) return null;
  const lines = take.map((it: AnyHeadline) => {
    const s = typeof it?.sentiment?.score === "number" ? (it.sentiment!.score as number) : null;
    const lab = s == null ? "neu" : s > 0.05 ? "pos" : s < -0.05 ? "neg" : "neu";
    const t = String(it?.title || "").slice(0, 200);
    const src = it?.source || "";
    const when = it?.ago || "";
    return `• ${t} — ${src}${when ? `, ${when}` : ""} — lab:${lab};`;
  });
  return lines.join("\n");
}

function computeHeadlinesBias(items: AnyHeadline[]): HeadlineBias {
  if (!Array.isArray(items) || items.length === 0) return { label: "unavailable", avg: null, count: 0 };
  const scores = items.map(h => typeof h?.sentiment?.score === "number" ? Number(h.sentiment!.score) : null).filter(v => Number.isFinite(v)) as number[];
  if (scores.length === 0) return { label: "unavailable", avg: null, count: 0 };
  const avg = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  const label = avg > 0.05 ? "bullish" : avg < -0.05 ? "bearish" : "neutral";
  return { label, avg, count: scores.length };
}

async function fetchedHeadlinesViaServer(req: NextApiRequest, instrument: string): Promise<{ items: AnyHeadline[]; promptText: string | null; provider: string }> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(instrument)}&hours=48&max=12&_t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    const items: AnyHeadline[] = Array.isArray(j?.items) ? j.items : [];
    const provider = String(j?.provider || "unknown");
    return { items, promptText: headlinesToPromptLines(items, 6), provider };
  } catch {
    return { items: [], promptText: null, provider: "unknown" };
  }
}

// ---------- ai_meta + sanity helpers ----------
function extractAiMeta(text: string) {
  if (!text) return null;
  const fences = [/\nai_meta\s*({[\s\S]*?})\s*\n/i, /\njson\s*({[\s\S]*?})\s*\n/i];
  for (const re of fences) { const m = text.match(re); if (m && m[1]) { try { return JSON.parse(m[1]); } catch {} } }
  return null;
}
function invalidOrderRelativeToPrice(aiMeta: any): string | null {
  // Backward-compatible: read order type from either 'orderType' or legacy 'entryOrder'
  const oRaw = String(aiMeta?.orderType || aiMeta?.entryOrder || "").toLowerCase();
  const dir = String(aiMeta?.direction || "").toLowerCase();
  const z = aiMeta?.zone || {};
  const p = Number(aiMeta?.currentPrice);
  const zmin = Number(z?.min);
  const zmax = Number(z?.max);

  if (!isFinite(p) || !isFinite(zmin) || !isFinite(zmax) || !oRaw) return null;

  // Normalize zone bounds
  const lo = Math.min(zmin, zmax);
  const hi = Math.max(zmin, zmax);

  // Limit order sanity:
  // - Long + Buy Limit should be BELOW price (tap/retest). If zone entirely ABOVE price → invalid.
  // - Short + Sell Limit should be ABOVE price. If zone entirely BELOW price → invalid.
  if (oRaw === "buy limit" && dir === "long") {
    if (lo >= p) return "buy-limit-above-price";
  }
  if (oRaw === "sell limit" && dir === "short") {
    if (hi <= p) return "sell-limit-below-price";
  }

  // Stop order sanity (breakout/BOS semantics):
  // - Long + Buy Stop should be ABOVE price. If zone entirely BELOW price → invalid.
  // - Short + Sell Stop should be BELOW price. If zone entirely ABOVE price → invalid.
  if (oRaw === "buy stop" && dir === "long") {
    if (hi <= p) return "buy-stop-below-price";
  }
  if (oRaw === "sell stop" && dir === "short") {
    if (lo >= p) return "sell-stop-above-price";
  }

  return null;
}


// ---------- CSM (intraday) ----------
const G8 = ["USD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD"];
const USD_PAIRS = ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDJPY", "USDCHF", "USDCAD"];
type Series = { t: number[]; c: number[] };

function kbarReturn(closes: number[], k: number): number | null {
  if (!closes || closes.length <= k) return null;
  const a = closes[closes.length - 1];
  const b = closes[closes.length - 1 - k];
  if (!(a > 0) || !(b > 0)) return null;
  return Math.log(a / b);
}
async function tdSeries15(pair: string): Promise<Series | null> {
  if (!TD_KEY) return null;
  try {
    const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=15min&outputsize=30&apikey=${TD_KEY}&dp=6`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!Array.isArray(j?.values)) return null;
    const vals = [...j.values].reverse();
    const t = vals.map((v: any) => new Date(v.datetime).getTime() / 1000);
    const c = vals.map((v: any) => Number(v.close));
    if (!c.every((x: number) => isFinite(x))) return null;
    return { t, c };
  } catch { return null; }
}
async function fhSeries15(pair: string): Promise<Series | null> {
  if (!FH_KEY) return null;
  try {
    const sym = `OANDA:${pair.slice(0, 3)}_${pair.slice(3)}`;
    const to = Math.floor(Date.now() / 1000);
    const from = to - 60 * 60 * 6;
    const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(sym)}&resolution=15&from=${from}&to=${to}&token=${FH_KEY}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (j?.s !== "ok" || !Array.isArray(j?.c)) return null;
    const t: number[] = (j.t as number[]).map((x: number) => x);
    const c: number[] = (j.c as number[]).map((x: number) => Number(x));
    if (!c.every((x: number) => isFinite(x))) return null;
    return { t, c };
  } catch { return null; }
}
async function polySeries15(pair: string): Promise<Series | null> {
  if (!POLY_KEY) return null;
  try {
    const ticker = `C:${pair}`;
    const to = new Date();
    const from = new Date(to.getTime() - 6 * 60 * 60 * 1000);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/15/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&apiKey=${POLY_KEY}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!Array.isArray(j?.results)) return null;
    const t: number[] = j.results.map((x: any) => Math.floor(x.t / 1000));
    const c: number[] = j.results.map((x: any) => Number(x.c));
    if (!c.every((x: number) => isFinite(x))) return null;
    return { t, c };
  } catch { return null; }
}
async function fetchSeries15(pair: string): Promise<Series | null> {
  const td = await tdSeries15(pair); if (td) return td;
  const fh = await fhSeries15(pair); if (fh) return fh;
  const pg = await polySeries15(pair); if (pg) return pg;
  return null;
}
function computeCSMFromPairs(seriesMap: Record<string, Series | null>): CsmSnapshot | null {
  const weights = { r60: 0.6, r240: 0.4 };
  const curScore: Record<string, number> = Object.fromEntries(G8.map((c) => [c, 0]));
  for (const pair of USD_PAIRS) {
    const S = seriesMap[pair];
    if (!S || !Array.isArray(S.c) || S.c.length < 17) continue;
    const r60 = kbarReturn(S.c, 4) ?? 0;
    const r240 = kbarReturn(S.c, 16) ?? 0;
    const r = r60 * weights.r60 + r240 * weights.r240;
    const base = pair.slice(0, 3);
    const quote = pair.slice(3);
    curScore[base] += r;
    curScore[quote] -= r;
  }
  const vals = G8.map((c) => curScore[c]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
  const z: Record<string, number> = {};
  for (const c of G8) z[c] = (curScore[c] - mean) / sd;
  const ranks = [...G8].sort((a, b) => z[b] - z[a]);
  return { tsISO: new Date().toISOString(), ranks, scores: z, ttl: Date.now() + 15 * 60 * 1000 };
}
async function getCSM(): Promise<CsmSnapshot> {
  if (CSM_CACHE && Date.now() < CSM_CACHE.ttl) return CSM_CACHE;
  const seriesMap: Record<string, Series | null> = {};
  await Promise.all(USD_PAIRS.map(async (p) => { seriesMap[p] = await fetchSeries15(p); }));
  const snap = computeCSMFromPairs(seriesMap);
  if (!snap) { if (CSM_CACHE) return CSM_CACHE; throw new Error("CSM unavailable (fetch failed and no cache)."); }
  CSM_CACHE = snap;
  return snap;
}

// ---------- COT cue (optional via headlines) ----------
type CotCue = { method: "headline_fallback"; reportDate: null; summary: string; net: Record<string, number>; };
function detectCotCueFromHeadlines(headlines: AnyHeadline[]): CotCue | null {
  if (!Array.isArray(headlines) || !headlines.length) return null;
  const text = headlines.map(h => [h?.title || "", h?.description || ""].join(" ")).join(" • ").toLowerCase();
  const mentionsCot = /(commitments?\s+of\s+traders|cot|cftc)\b/.test(text);
  if (!mentionsCot) return null;
  const terms: Record<string, RegExp[]> = {
    USD: [/\b(us|u\.s\.|dollar|usd|greenback|dxy)\b/i],
    EUR: [/\b(euro|eur)\b/i],
    JPY: [/\b(yen|jpy)\b/i],
    GBP: [/\b(pound|sterling|gbp)\b/i],
    CAD: [/\b(canadian|loonie|cad)\b/i],
    AUD: [/\b(australian|aussie|aud)\b/i],
    CHF: [/\b(franc|chf)\b/i],
    NZD: [/\b(kiwi|new zealand|nzd)\b/i],
  };
  const net: Record<string, number> = {};
  let any = false;
  for (const [cur, regs] of Object.entries(terms)) {
    if (regs.some(re => re.test(text))) {
      const neg = new RegExp(`${regs[0].source}[\\s\\S]{0,60}?net\\s+short`, "i");
      const pos = new RegExp(`${regs[0].source}[\\s\\S]{0,60}?net\\s+long`, "i");
      if (neg.test(text)) { net[cur] = -1; any = true; continue; }
      if (pos.test(text)) { net[cur] = 1; any = true; continue; }
      const incShort = new RegExp(`${regs[0].source}[\\s\\S]{0,80}?(increase|added|boosted).{0,12}short`, "i");
      const incLong  = new RegExp(`${regs[0].source}[\\s\\S]{0,80}?(increase|added|boosted).{0,12}long`, "i");
      if (incShort.test(text)) { net[cur] = -1; any = true; continue; }
      if (incLong.test(text))  { net[cur] = 1;  any = true; continue; }
    }
  }
  if (!any) return null;
  const parts = Object.entries(net).map(([c, v]) => `${c}:${v > 0 ? "net long" : "net short"}`);
  return { method: "headline_fallback", reportDate: null, summary: `COT cues (headlines): ${parts.join(", ")}`, net };
}

// ---------- Sentiment snapshot ----------
type HeadlineBiasOut = { text: string; provenance: any };
function sentimentSummary(csm: CsmSnapshot, cotCue: CotCue | null, headlineBias: HeadlineBias): HeadlineBiasOut {
  const ranksLine = `CSM (60–240m): ${csm.ranks.slice(0, 4).join(" > ")} ... ${csm.ranks.slice(-3).join(" < ")}`;
  const hBiasLine = headlineBias.label === "unavailable"
    ? "Headlines bias (48h): unavailable"
    : `Headlines bias (48h): ${headlineBias.label}${headlineBias.avg != null ? ` (${headlineBias.avg.toFixed(2)})` : ""}`;
  const cotLine = cotCue ? `COT: ${cotCue.summary}` : "COT: no cues from headlines.";
  const prov = {
    csm_used: true, csm_time: csm.tsISO,
    cot_used: !!cotCue, cot_report_date: null as string | null, cot_error: cotCue ? null : "no cot cues", cot_method: cotCue ? cotCue.method : null,
    headlines_bias_label: headlineBias.label, headlines_bias_score: headlineBias.avg,
    cot_bias_summary: cotCue ? cotCue.summary : null,
  };
  return { text: `${ranksLine}\n${hBiasLine}\n${cotLine}`, provenance: prov };
}

// ---------- Calendar helpers (OCR + API fallback) ----------

/** OPTIONAL (PLUMBING ONLY, default OFF): explicit indicator polarity overrides.
 * Not used for sign unless you later flip a flag to enable it.
 * Kept here for future realism without touching core logic now. */
const INDICATOR_POLARITY_MAP: Array<{ re: RegExp; higherGood: boolean }> = [
  { re: /\b(core\s+)?cpi|ppi|inflation\b/i, higherGood: true },
  { re: /\b(gdp|industrial\s+production|manufacturing\s+production|durable\s+goods|retail\s+sales)\b/i, higherGood: true },
  { re: /\b(pmi|ism|confidence|sentiment|zew)\b/i, higherGood: true },
  { re: /\b(unemployment|jobless|initial\s+claims|continuing\s+claims)\b/i, higherGood: false },
  { re: /\b(nonfarm|nfp|employment\s+change|payrolls|jobs)\b/i, higherGood: true },
  { re: /\b(trade\s+balance|current\s+account)\b/i, higherGood: true },
  { re: /\b(interest\s+rate|rate\s+decision|refi\s+rate|deposit\s+facility|bank\s+rate|cash\s+rate|ocr)\b/i, higherGood: true },
];

/** INTERNAL: if we ever enable metric-aware polarity, this helper provides the mapping.
 * For now, we DO NOT use it for calendar sign; sign comes ONLY from actual vs forecast. */
function polarityHigherIsGood(title: string | null | undefined): boolean | null {
  const t = String(title || "").toLowerCase();
  for (const m of INDICATOR_POLARITY_MAP) if (m.re.test(t)) return m.higherGood;
  return null;
}

/** Evidence line — transparent comparisons; verdict strictly from actual vs forecast (if forecast present). */
function evidenceLine(it: any, cur: string): string | null {
  const a = parseNumberLoose(it.actual);
  const f = parseNumberLoose(it.forecast);
  const p = parseNumberLoose(it.previous);
  if (a == null || (f == null && p == null)) return null;

  // Comparisons for transparency only
  const comp: string[] = [];
  if (f != null) comp.push(a < f ? "< forecast" : a > f ? "> forecast" : "= forecast");
  if (p != null) comp.push(a < p ? "< previous" : a > p ? "> previous" : "= previous");

  // Verdict: STRICT actual vs forecast rule
  let verdict: "bullish" | "bearish" | "neutral" = "neutral";
  if (f != null) verdict = a > f ? "bullish" : a < f ? "bearish" : "neutral";

  const comps = comp.join(" and ");
  return `${cur} — ${it.title}: actual ${a}${comps ? " " + comps : ""} → ${verdict} ${cur}`;
}

// ---------- OpenAI core ----------
async function callOpenAI(model: string, messages: any[]) {
  const body: any = { model, messages };
  if (!/^gpt-5/i.test(model)) {
    body.temperature = 0;
  }

  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  const json = await rsp.json().catch(() => ({} as any));
  if (!rsp.ok) throw new Error(`OpenAI request failed: ${rsp.status} ${JSON.stringify(json)}`);
  const out =
    json?.choices?.[0]?.message?.content ??
    (Array.isArray(json?.choices?.[0]?.message?.content)
      ? json.choices[0].message.content.map((c: any) => c?.text || "").join("\n")
      : "");
  return String(out || "");
}

function tryParseJsonBlock(s: string): any | null {
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const raw = fence ? fence[1] : s;
  try { return JSON.parse(raw); } catch { return null; }
}

type OcrCalendarRow = {
  timeISO: string | null;
  title: string | null;
  currency: string | null;
  impact: "Low" | "Medium" | "High" | null;
  actual: number | string | null;
  forecast: number | string | null;
  previous: number | string | null;
};
type OcrCalendar = { items: OcrCalendarRow[] };

async function ocrCalendarFromImage(model: string, calendarDataUrl: string): Promise<OcrCalendar | null> {
  const sys = [
    "You are extracting ECONOMIC CALENDAR rows via image OCR.",
    "Return STRICT JSON only. DO NOT GUESS values. If unreadable/absent, use null.",
    "Fields per row: timeISO (ISO8601 if visible, else null), title, currency (e.g., USD, EUR), impact (Low|Medium|High), actual, forecast, previous."
  ].join("\n");
  const user = [
    { type: "text", text: "Extract rows as specified. JSON only. Schema: { items: OcrCalendarRow[] }" },
    { type: "image_url", image_url: { url: calendarDataUrl } },
  ];
  const msg = [{ role: "system", content: sys }, { role: "user", content: user } ];
  let text = await callOpenAI(model, msg);
  let parsed = tryParseJsonBlock(text);
  if (!parsed || !Array.isArray(parsed?.items)) {
    const msg2 = [
      { role: "system", content: sys + "\nREPLY WITH JSON ONLY. NO prose. If unsure, use nulls." },
      { role: "user", content: user },
    ];
    text = await callOpenAI(model, msg2);
    parsed = tryParseJsonBlock(text);
    if (!parsed || !Array.isArray(parsed?.items)) return null;
  }

  const items: OcrCalendarRow[] = (parsed.items as any[]).map((r) => ({
    timeISO: r?.timeISO && typeof r.timeISO === "string" ? r.timeISO : null,
    title: r?.title && typeof r.title === "string" ? r.title : null,
    currency: r?.currency && typeof r.currency === "string" ? r.currency.toUpperCase().slice(0,3) : null,
    impact: r?.impact && typeof r.impact === "string" ? (["low","medium","high"].includes(r.impact.toLowerCase()) ? (r.impact[0].toUpperCase()+r.impact.slice(1).toLowerCase()) as any : null) : null,
    actual: r?.actual ?? null,
    forecast: r?.forecast ?? null,
    previous: r?.previous ?? null,
  }));
  return { items };
}

// -------- Enhanced OCR analysis: STRICT pre-release handling + final bias rule --------
function analyzeCalendarOCR(ocr: OcrCalendar, pair: string): {
  biasLine: string | null;
  biasNote: string | null;
  warningMinutes: number | null;
  evidenceLines: string[];
  preReleaseOnly: boolean;
  rowsForDebug: {
    timeISO: string | null;
    title: string | null;
    currency: string | null;
    impact: any;
    actual: any;
    forecast: any;
    previous: any;
  }[];
} {
  const base = pair.slice(0, 3), quote = pair.slice(3);
  const nowMs = Date.now();
  const H72 = 72 * 3600 * 1000;

  const lines: string[] = [];
  const postRows: OcrCalendarRow[] = [];
  let hasActualOnlyRecent = false;

  const rowsForDebug = (ocr.items || []).slice(0, 3).map(r => ({
    timeISO: r.timeISO || null,
    title: r.title || null,
    currency: r.currency || null,
    impact: r.impact || null,
    actual: r.actual ?? null,
    forecast: r.forecast ?? null,
    previous: r.previous ?? null,
  }));

  let warn: number | null = null;

  for (const it of (ocr.items || [])) {
    const cur = (it?.currency || "").toUpperCase();
    if (!cur) continue;

    // High-impact upcoming event warning (≤60 minutes)
    if (it?.impact === "High" && it?.timeISO) {
      const tt = Date.parse(it.timeISO);
      if (isFinite(tt) && tt >= nowMs) {
        const mins = Math.floor((tt - nowMs) / 60000);
        if (mins <= 60) warn = warn == null ? mins : Math.min(warn, mins);
      }
    }

    const a = parseNumberLoose(it.actual);
    const f = parseNumberLoose(it.forecast);
    const p = parseNumberLoose(it.previous);

    // Only consider rows within last 72h when time is known; if time missing, allow but don't score far history
    const ts = it.timeISO ? Date.parse(it.timeISO) : NaN;
    const isWithin72h = isFinite(ts) ? ts <= nowMs && nowMs - ts <= H72 : true;
    if (!isWithin72h) continue;

    // Classification for post-release evidence & scoring
    if (a != null && (f != null || p != null)) {
      postRows.push({ ...it, actual: a, forecast: f, previous: p });
    } else if (a != null && f == null && p == null) {
      hasActualOnlyRecent = true;
    }
  }

  // If no post-result rows, STRICT pre-release behavior
  if (postRows.length === 0) {
    // Waiting state, do not compute expectation from forecast/previous
    const preLine = `Waiting for results (pre-release)${warn != null ? ` — high-impact event in ~${warn} min` : ""}.`;
    return {
      biasLine: preLine,
      biasNote: null,
      warningMinutes: warn,
      evidenceLines: [],
      preReleaseOnly: true,
      rowsForDebug,
    };
  }

  // --- Scoring setup for post-result rows ---
  const scoreByCur: Record<string, number> = {};
  const impactW: Record<string, number> = { Low: 0.5, Medium: 0.8, High: 1.0 };
  function add(cur: string, v: number) {
    scoreByCur[cur] = (scoreByCur[cur] ?? 0) + v;
  }

  for (const it of postRows) {
    const cur = (it.currency || "").toUpperCase();

    // Strict sign: actual vs forecast only. If no forecast for this row, skip scoring (still produce evidence).
    const fNum = it.forecast != null ? Number(it.forecast) : null;
    const aNum = Number(it.actual);
    const pNum = it.previous != null ? Number(it.previous) : null;

    // Evidence line (transparent)
    const ev = evidenceLine(it, cur);
    if (ev) lines.push(ev);

    if (fNum == null || !isFinite(aNum) || !isFinite(fNum)) continue;

    // Magnitude from percent surprise (capped), weighted by impact; previous can add a tiny modulation but never flips sign.
    const raw = (aNum - fNum) / Math.max(Math.abs(fNum), 1e-9);
    const clamped = Math.max(-0.25, Math.min(0.25, raw)); // limit ±25%
    const unsigned0to10 = Math.round((Math.abs(clamped) / 0.25) * 10);
    const w = impactW[it.impact as keyof typeof impactW] ?? 1.0;

    // Optional tiny modulation from previous, purely as strength seasoning (never sign):
    let mod = 1.0;
    if (pNum != null && isFinite(pNum)) {
      const cont = (aNum - pNum) / Math.max(Math.abs(pNum), 1e-9);
      if (Math.sign(cont) === Math.sign(clamped)) mod += 0.1; // continuity bump
    }

    const lineScore = Math.round(unsigned0to10 * w * mod);
    const signed = Math.sign(aNum - fNum) * lineScore; // sign ONLY from a-f

    add(cur, signed);
  }

  // Net per-currency and instrument bias — baseMinusQuote rule with strict labels
  const sumBase = Math.round(scoreByCur[base] ?? 0);
  const sumQuote = Math.round(scoreByCur[quote] ?? 0);
  const netInstr = sumBase - sumQuote;

  let instrLabel: "bullish" | "bearish" | "neutral";
  if (sumBase === 0 && sumQuote === 0) instrLabel = "neutral";
  else instrLabel = netInstr > 0 ? "bullish" : netInstr < 0 ? "bearish" : "neutral";

  const biasLine = `Calendar bias for ${pair}: ${instrLabel} (${base}:${sumBase >= 0 ? "+" : ""}${sumBase} / ${quote}:${sumQuote >= 0 ? "+" : ""}${sumQuote}, Net ${netInstr >= 0 ? "+" : ""}${netInstr}).`;
  const biasNote = `Per-currency totals → ${base}:${sumBase >= 0 ? "+" : ""}${sumBase}, ${quote}:${sumQuote >= 0 ? "+" : ""}${sumQuote}; Net = ${netInstr >= 0 ? "+" : ""}${netInstr} (Instrument bias: ${instrLabel})`;

  return {
    biasLine,
    biasNote,
    warningMinutes: warn,
    evidenceLines: lines,
    preReleaseOnly: false,
    rowsForDebug,
  };
}

// Helpers to determine instrument-relevant currencies for OCR usability checks
const CURRENCIES = new Set(G8);
function relevantCurrenciesFromInstrument(instr: string): string[] {
  const U = (instr || "").toUpperCase();
  const found = [...CURRENCIES].filter(c => U.includes(c));
  if (found.length) return found;
  // Minimal non-FX coverage → map instrument → USD relevance when appropriate
  if (/(XAUUSD|BTCUSD)/.test(U)) return ["USD"];
  if (/(US500|SPX|SP500|S&P)/.test(U)) return ["USD"];
  if (U.endsWith("USD") || U.startsWith("USD")) return ["USD"];
  return ["USD"];
}
function hasUsableFields(r: OcrCalendarRow): boolean {
  // ACCEPT:
  //  (1) actual present and (forecast or previous), OR
  //  (2) forecast and previous (pre-release expectation)
  const hasActualSet = r != null && r.actual != null && (r.forecast != null || r.previous != null);
  const hasPreRelease = r != null && r.actual == null && r.forecast != null && r.previous != null;
  return !!(hasActualSet || hasPreRelease);
}

// ---------- API calendar fallback ----------
async function fetchCalendarRaw(req: NextApiRequest, instrument: string): Promise<any | null> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/calendar?instrument=${encodeURIComponent(instrument)}&windowHours=120&_t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    const j: any = await r.json().catch(() => ({}));
    return j?.ok ? j : null;
  } catch { return null; }
}
function calendarShortText(resp: any, pair: string): string | null {
  if (!resp?.ok) return null;
  const instrBias = resp?.bias?.instrument;
  const parts: string[] = [];
  if (instrBias && instrBias.pair === pair) { parts.push(`Instrument bias: ${instrBias.label} (${instrBias.score})`); }
  const per = resp?.bias?.perCurrency || {};
  const base = pair.slice(0,3), quote = pair.slice(3);
  const b = per[base]?.label ? `${base}:${per[base].label}` : null;
  const q = per[quote]?.label ? `${quote}:${per[quote].label}` : null;
  if (b || q) parts.push(`Per-currency: ${[b,q].filter(Boolean).join(" / ")}`);
  if (!parts.length) parts.push("No strong calendar bias.");
  return `Calendar bias for ${pair}: ${parts.join("; ")}`;
}
function nearestHighImpactWithin(resp: any, minutes: number): number | null {
  if (!resp?.ok || !Array.isArray(resp?.items)) return null;
  const nowMs = Date.now(); let best: number | null = null;
  for (const it of resp.items) {
    if (String(it?.impact || "") !== "High") continue;
    const t = new Date(it.time).getTime();
    if (t >= nowMs) {
      const mins = Math.floor((t - nowMs) / 60000);
      if (mins <= minutes) { best = best == null ? mins : Math.min(best, mins); }
    }
  }
  return best;
}
function postResultBiasNote(resp: any, pair: string): string | null {
  if (!resp?.ok) return null;
  const base = pair.slice(0,3), quote = pair.slice(3);
  const per = resp?.bias?.perCurrency || {};
  const b = per[base]?.label || "neutral";
  const q = per[quote]?.label || "neutral";
  const instr = resp?.bias?.instrument?.label || null;
  const scores = resp?.bias?.instrument ? `(score ${resp.bias.instrument.score})` : "";
  const line = `Per-currency: ${base} ${b} vs ${quote} ${q}${instr ? `; Instrument bias: ${instr} ${scores}` : ""}`;
  return line;
}
function buildCalendarEvidence(resp: any, pair: string): string[] {
  if (!resp?.ok || !Array.isArray(resp?.items)) return [];
  const base = pair.slice(0,3), quote = pair.slice(3);
  const nowMs = Date.now(), lo = nowMs - 72*3600*1000;
  const done = resp.items.filter((it: any) => {
    const t = new Date(it.time).getTime();
    return t <= nowMs && t >= lo && (it.actual != null || it.forecast != null || it.previous != null) && (it.currency === base || it.currency === quote);
  }).slice(0, 12);
  const lines: string[] = [];
  for (const it of done) {
    const line = evidenceLine(it, it.currency || ""); if (line) lines.push(line);
  }
  return lines;
}
async function fetchCalendarForAdvisory(req: NextApiRequest, instrument: string): Promise<{
  text: string | null, status: "api" | "unavailable", provider: string | null,
  warningMinutes: number | null, advisoryText: string | null, biasNote: string | null,
  raw?: any | null, evidence?: string[] | null
}> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/calendar?instrument=${encodeURIComponent(instrument)}&windowHours=48&_t=${Date.now()}`
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    const j: any = await r.json().catch(() => ({}));
    if (j?.ok) {
      const t = calendarShortText(j, instrument) || `Calendar bias for ${instrument}: (no strong signal)`;
      const warn = nearestHighImpactWithin(j, 60);
      const bias = postResultBiasNote(j, instrument);
      const advisory = [
        warn != null ? `⚠️ High-impact event in ~${warn} min.` : null,
        bias ? `Recent result alignment: ${bias}.` : null
      ].filter(Boolean).join("\n");
      const rawFull = await fetchCalendarRaw(req, instrument);
      const evidence = rawFull ? buildCalendarEvidence(rawFull, instrument) : buildCalendarEvidence(j, instrument);
      return { text: t, status: "api", provider: String(j?.provider || "mixed"), warningMinutes: warn ?? null, advisoryText: advisory || null, biasNote: bias || null, raw: j, evidence };
    }
    return { text: "Calendar unavailable.", status: "unavailable", provider: null, warningMinutes: null, advisoryText: null, biasNote: null, raw: null, evidence: [] };
  } catch {
    return { text: "Calendar unavailable.", status: "unavailable", provider: null, warningMinutes: null, advisoryText: null, biasNote: null, raw: null, evidence: [] };
  }
}

// ---------- Composite bias (legacy for provenance only) ----------
function splitFXPair(instr: string): { base: string|null; quote: string|null } {
  const U = (instr || "").toUpperCase();
  if (U.length >= 6) {
    const base = U.slice(0,3), quote = U.slice(3,6);
    if (G8.includes(base) && G8.includes(quote)) return { base, quote };
  }
  return { base: null, quote: null };
}
function parseInstrumentBiasFromNote(biasNote: string | null | undefined): number {
  if (!biasNote) return 0;
  const m = biasNote.match(/instrument[^:]*:\s*(bullish|bearish|neutral)/i);
  if (m?.[1]) return m[1].toLowerCase() === "bullish" ? 1 : m[1].toLowerCase() === "bearish" ? -1 : 0;
  return 0;
}
function computeCSMInstrumentSign(csm: CsmSnapshot, instr: string): { sign: number; zdiff: number | null } {
  const { base, quote } = splitFXPair(instr);
  if (!base || !quote) return { sign: 0, zdiff: null };
  const zb = csm.scores[base], zq = csm.scores[quote];
  if (typeof zb !== "number" || typeof zq !== "number") return { sign: 0, zdiff: null };
  const diff = zb - zq; // >0 → base stronger → bullish instrument
  const sign = diff > 0.4 ? 1 : diff < -0.4 ? -1 : 0;
  return { sign, zdiff: diff };
}
function computeHeadlinesSign(hb: HeadlineBias): number {
  if (!hb) return 0;
  if (hb.label === "bullish") return 1;
  if (hb.label === "bearish") return -1;
  return 0;
}
function computeCompositeBias(args: {
  instrument: string;
  calendarBiasNote: string | null;
  headlinesBias: HeadlineBias;
  csm: CsmSnapshot;
  warningMinutes: number | null;
}) {
  const calSign = parseInstrumentBiasFromNote(args.calendarBiasNote);
  const hSign = computeHeadlinesSign(args.headlinesBias);
  const { sign: csmSign, zdiff } = computeCSMInstrumentSign(args.csm, args.instrument);

  const parts = [calSign !== 0 ? (calSign > 0 ? 1 : -1) : 0, hSign, csmSign];
  const pos = parts.some(s => s > 0);
  const neg = parts.some(s => s < 0);
  const align = (pos && !neg) || (neg && !pos);
  const conflict = pos && neg;

  // Retained only for provenance/debug (no conviction caps applied anymore)
  let cap = 70;
  if (conflict) cap = 35;
  if (args.warningMinutes != null) cap = Math.min(cap, 35);

  return { calendarSign: calSign, headlinesSign: hSign, csmSign, csmZDiff: zdiff, align, conflict, cap };
}

/** Derive COT instrument sign from headline cues (independent component).
 * Uses cotCue.net per-currency signals: +1 net long, -1 net short. Maps to pair via baseMinusQuote. */
function computeCOTInstrumentSign(cot: CotCue | null, instr: string): { sign: number; detail: string } {
  if (!cot || !cot.net) return { sign: 0, detail: "unavailable" };
  const { base, quote } = splitFXPair(instr);
  if (!base || !quote) return { sign: 0, detail: "non-fx or unavailable" };
  const b = typeof cot.net[base] === "number" ? cot.net[base] : 0;
  const q = typeof cot.net[quote] === "number" ? cot.net[quote] : 0;
  const diff = b - q; // >0 ⇒ bullish instrument; <0 ⇒ bearish
  const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0;
  const toWord = (s: number) => (s > 0 ? "bullish" : s < 0 ? "bearish" : "neutral");
  return { sign, detail: `COT ${toWord(b)} ${base} vs ${toWord(q)} ${quote} ⇒ ${toWord(sign)} ${instr}` };
}

/** Compute independent fundamentals components + final Fundamental Bias score/label (0–100).
 * Calendar, Headlines, CSM, COT are independent inputs. */
function computeIndependentFundamentals(args: {
  instrument: string;
  calendarSign: number;      // -1 / 0 / +1 (instrument-mapped)
  headlinesBias: HeadlineBias;
  csm: CsmSnapshot;
  cotCue: CotCue | null;
  warningMinutes: number | null;
}) {
  // Calendar component (independent)
  const S_cal = 50 + 50 * (args.calendarSign || 0);

  // Headlines component (independent)
  const S_head =
    args.headlinesBias.label === "bullish" ? 75 :
    args.headlinesBias.label === "bearish" ? 25 :
    args.headlinesBias.label === "neutral" ? 50 : 50;

  // CSM component (independent)
  const { base, quote } = splitFXPair(args.instrument);
  let S_csm = 50;
  let csmDiff: number | null = null;
  if (base && quote) {
    const zb = args.csm.scores[base];
    const zq = args.csm.scores[quote];
    if (typeof zb === "number" && typeof zq === "number") {
      csmDiff = zb - zq; // >0 ⇒ bullish instrument
      const clamped = Math.max(-2, Math.min(2, csmDiff));
      S_csm = 50 + 25 * (clamped / 2);
    }
  }

  // COT component (independent) as alignment bump around a neutral 50 anchor
  const { sign: cotSign, detail: cotDetail } = computeCOTInstrumentSign(args.cotCue, args.instrument);
  const cotBump = cotSign === 0 ? 0 : (cotSign > 0 ? +5 : -5);
  const S_cot = 50 + cotBump;

  // Weights (independent aggregation)
  const w_cal = 0.45, w_head = 0.20, w_csm = 0.30, w_cot = 0.05;
  const RawF = w_cal * S_cal + w_head * S_head + w_csm * S_csm + w_cot * S_cot;

  const proximityFlag = args.warningMinutes != null ? 1 : 0;
  const F = Math.max(0, Math.min(100, RawF * (1 - 0.25 * proximityFlag)));

  // Final label (keep sign logic consistent with majority direction)
  const compSigns = [
    args.calendarSign,
    computeHeadlinesSign(args.headlinesBias),
    computeCSMInstrumentSign(args.csm, args.instrument).sign,
    cotSign,
  ].filter((s) => s !== 0);

  let signNet = 0;
  if (compSigns.length) {
    const sum = compSigns.reduce((a, b) => a + b, 0);
    signNet = sum > 0 ? 1 : sum < 0 ? -1 : 0;
  }
  const label = signNet > 0 ? "bullish" : signNet < 0 ? "bearish" : (F > 55 ? "bullish" : F < 45 ? "bearish" : "neutral");

  // --- NEW: ensure internal sign matches the printed label when label is non-neutral ---
  let finalSign = signNet;
  if (finalSign === 0 && label !== "neutral") {
    finalSign = label === "bullish" ? 1 : -1;
  }

  return {
    components: {
      calendar: { sign: args.calendarSign, score: S_cal },
      headlines: { label: args.headlinesBias.label, score: S_head },
      csm: { diff: csmDiff, score: S_csm },
      cot: { sign: cotSign, detail: cotDetail, score: S_cot },
      proximity_penalty_applied: proximityFlag === 1
    },
    final: { score: F, label, sign: finalSign }
  };
}

/** Ensure a standardized “Fundamental Bias Snapshot” block appears under Full Breakdown.
 * Injects independent components (Calendar, Headlines, CSM, COT) + Final Fundamental Bias. */
function ensureFundamentalsSnapshot(
  text: string,
  args: {
    instrument: string;
    snapshot: {
      components: {
        calendar: { sign: number; score: number };
        headlines: { label: string; score: number };
        csm: { diff: number | null; score: number };
        cot: { sign: number; detail: string; score: number };
        proximity_penalty_applied: boolean;
      };
      final: { score: number; label: string; sign: number };
    };
    preReleaseOnly: boolean;
    calendarLine: string | null; // may be "Calendar bias for <PAIR>: ...", "Calendar unavailable.", etc.
  }
) {
  if (!text) return text;

  const hasFull = /Full\s*Breakdown/i.test(text);
  const hasSnapshot = /Fundamental\s*Bias\s*Snapshot/i.test(text);
  if (hasFull && hasSnapshot) return text;

  // Normalize Calendar line to always start with "Calendar:"
  let calLineNorm: string;
   if (args.preReleaseOnly) {
    calLineNorm = "Calendar: Pre-release only, no confirmed bias until data is out.";
  } else if (typeof args.calendarLine === "string" && args.calendarLine.trim()) {
    const raw = args.calendarLine.trim();
    if (/unavailable/i.test(raw)) {
      calLineNorm = "Calendar: unavailable.";
    } else if (/^Calendar\s*:/i.test(raw)) {
      // Already a "Calendar:" style line
      calLineNorm = raw.replace(/\.$/, "");
    } else if (/^Calendar\s*bias\s*for/i.test(raw)) {
      // Wrap instrument-level line
      calLineNorm = `Calendar: ${raw.replace(/\.$/, "")}`;
    } else {
      // Fallback to explicit wrapper
      calLineNorm = `Calendar: ${raw.replace(/\.$/, "")}`;
    }
  } else {
    calLineNorm = "Calendar: unavailable.";
  }


  const cotSignWord = args.snapshot.components.cot.sign > 0 ? "bullish"
                     : args.snapshot.components.cot.sign < 0 ? "bearish" : "neutral";
  const proxNote = args.snapshot.components.proximity_penalty_applied ? " (proximity penalty applied)" : "";

  const block =
`\nFundamental Bias Snapshot:
• ${calLineNorm}
• Headlines bias (48h): ${args.snapshot.components.headlines.label} (score ~${Math.round(args.snapshot.components.headlines.score)})
• CSM z-diff ${args.snapshot.components.csm.diff == null ? "(n/a)" : args.snapshot.components.csm.diff.toFixed(2)} ⇒ CSM score ~${Math.round(args.snapshot.components.csm.score)}
• COT: ${cotSignWord}; ${args.snapshot.components.cot.detail} (score ~${Math.round(args.snapshot.components.cot.score)})
• Final Fundamental Bias: ${args.snapshot.final.label} (score ~${Math.round(args.snapshot.final.score)})${proxNote}
`;

  if (hasFull) {
    return text.replace(/(Full\s*Breakdown[^\n]*\n)/i, `$1${block}`);
  }
  return `${text}\n${block}`;
}


// ---------- prompts (Updated per ALLOWED CHANGES A–E) ----------
function systemCore(
  instrument: string,
  calendarAdvisory?: { warningMinutes?: number | null; biasNote?: string | null },
  scalping?: boolean,
  scalpingHard?: boolean
) {
  const warn = (calendarAdvisory?.warningMinutes ?? null) != null ? calendarAdvisory!.warningMinutes : null;
  const bias = calendarAdvisory?.biasNote || null;

  const baseLines = [
    "You are a professional discretionary trader.",
    "STRICT NO-GUESS RULES:",
    "- Only mention **Calendar** if calendar_status === 'api' or calendar_status === 'image-ocr'.",
    "- Only mention **Headlines** if a headlines snapshot is provided.",
    "- Do not invent events, figures, or quotes. If something is missing, write 'unavailable'.",
    "- Treat **Calendar**, **Headlines/Articles**, **CSM**, and **COT** as **independent** fundamental components.",
    "- Never use the word 'mixed' for calendar verdicts — use bullish/bearish/neutral only.",
    "",
    "Execution clarity:",
    "- Prefer **Entry zones (min–max)** for OB/FVG/SR confluence; use a **single price** for tight breakout/trigger.",
    "- SL behind structure; TP1/TP2 with R multiples; BE rules; invalidation.",
    "",
    "Multi-timeframe roles (fixed):",
    "- 4H = HTF bias & key zones (trend, SD zones, macro S/R, structure).",
    "- 1H = context & setup construction (refine zones, structure state, trigger conditions).",
    "- 15m = execution map (exact entry zone or trigger level, invalidation, TP structure).",
    "- 5m (optional) = entry timing/confirmation only; do not let 5m override HTF bias.",
    "",
    "Strategy Tournament (broad library & scoring):",
    "- Evaluate these candidates by fit to visible charts (do not invent):",
    "  • Market Structure (BOS/CHOCH; continuation vs reversal)",
    "  • Order Blocks (OB) demand/supply; mitigations; breaker blocks",
    "  • Fair Value Gaps (FVG)/Imbalance; gap fills",
    "  • Support/Resistance (HTF + intraday), Round/Quarter levels, psych levels",
    "  • Trendline breaks + retests; channels; wedges; triangles",
    "  • Liquidity mechanics (sweeps/raids/stop hunts; equal highs/lows; session liquidity, kill zones)",
    "  • Pullbacks to OB/FVG/MA; Fib 0.382/0.5/0.618/0.786; EQ of range",
    "  • Moving averages (EMA21/50 regime/cross); momentum ignition/breakout",
    "  • RSI (regular/hidden divergence), MACD impulse, Bollinger squeeze/expansion",
    "  • Mean reversion / range rotations (prior day/week H/L, session opens)",
    "  • VWAP / Anchored VWAP (optional)",
    "- **MANDATES**:",
    "  • Consider **at least 5 candidates** on every run.",
    "  • Ensure **≥3 candidates are NOT liquidity-sweep/BOS** plays (e.g., OB/FVG pullback, TL break+retest, range rotation, mean reversion, MA momentum, VWAP, etc.).",
    "  • TRIGGERS MUST BE STRATEGY-SPECIFIC AND TIMEFRAME-SPECIFIC. Examples:",
    "    - OB/FVG confluence: 'Tap of 15m demand OB + 15m FVG fill → 5m CHOCH; entry on 5m retest of FVG midpoint.'",
    "    - Trendline break: 'Break of 1H descending TL → 15m retest + 5m BOS; entry on 5m break/retest of prior LH.'",
    "    - Range rotation: 'Reject 1H range high with 15m bearish engulfing; 5m sweep of minor high then BOS; sell stop below 5m BOS.'",
    "    - Momentum breakout: '1H squeeze resolves down; 15m base → 5m ignition; sell stop below ignition low after micro pullback.'",
    "    - VWAP: 'Failing above session VWAP; 5m sweep above VWAP then 1m BOS; entry on 1m retest; SL beyond sweep high.'",
    "- Score each candidate T_candidate = clamp( 0.5*HTF_fit(4H) + 0.3*Context_fit(1H) + 0.2*Trigger_fit(15m & optional 5m), 0, 100 ).",
    "- Penalize conflicts with HTF (-15 to -30). Reward multi-signal confluence (+10 to +20) and clean invalidation/asymmetric R:R (+5 to +15).",
    "- Pick TOP 1 as 'Option 1 (Primary)' and a DISTINCT runner-up for 'Option 2 (Alternative)'. Provide a compact tournament table (name — score — reason).",
    "",
    "Fundamentals Scoring (independent components; 0–100, no hard caps):",
    "- Compute independently:",
    "  • Calendar (instrument sign: bearish:-1 / neutral:0 / bullish:+1) ⇒ S_cal = 50 + 50*sign",
    "  • Headlines (48h) ⇒ S_head = 25 (bearish) / 50 (neutral/unavailable) / 75 (bullish)",
    "  • CSM diff = z(base) - z(quote) ⇒ S_csm = 50 + 25 * clamp(diff, -2, +2)/2",
    "  • COT cue (if present) ⇒ S_cot = 50 ± 5 (align:+5 / conflict:-5 / none:0)",
    "- Weights: w_cal=0.45, w_head=0.20, w_csm=0.30, w_cot=0.05",
    "- RawF = w_cal*S_cal + w_head*S_head + w_csm*S_csm + w_cot*S_cot",
    "- Proximity (≤60m high-impact) penalty: F = clamp(RawF * 0.75, 0, 100) when active.",
    "",
    "Conviction (0–100) from TECH & FUND alignment:",
    "- Compute T as the best tournament score (0–100).",
    "- Use the fundamentals F above (0–100).",
    "- Alignment bonus: +8 if technical primary direction matches the fundamentals net sign; else -8.",
    "- If a high-impact event is within ≤60 min, apply final scaling 15%: Conv = clamp( (0.55*T + 0.45*F + align) * (1 - 0.15*proximityFlag), 0, 100 ).",
    "",
    "Consistency rule:",
    "- If Calendar/Headlines/CSM align, say 'aligning'.",
    "- 'Tech vs Fundy Alignment' must be Match when aligned, Mismatch when conflicted.",
    "",
    `Keep instrument alignment with ${instrument}.`,
    warn !== null ? `\nCALENDAR WARNING: High-impact event within ~${warn} min. Avoid impulsive market entries right before release.` : "",
    bias ? `\nPOST-RESULT ALIGNMENT: ${bias}.` : "",
    "",
    "Calendar verdict rules:",
    "- Per event: compute verdict using domain direction (goodIfHigher); output only bullish/bearish/neutral.",
    "- Final calendar bias uses baseMinusQuote: net = baseSum - quoteSum; net>0 → bullish instrument; net<0 → bearish; only when BOTH currency sums are exactly 0 → neutral.",
    "- Mapping reminder (examples):",
    "  • USD bearish ⇒ XAUUSD bullish, EURUSD/GBPUSD bullish.",
    "  • USD bearish ⇒ USDJPY/USDCHF/USDCAD bearish.",
    "  • USD bullish ⇒ XAUUSD/EURUSD/GBPUSD bearish; USDJPY/USDCHF/USDCAD bullish.",
    "- Always state the instrument-level calendar line (e.g., 'Calendar bias for XAUUSD: bullish').",
    "- If no actuals in the last 72h for the pair’s currencies: 'Pre-release only, no confirmed bias until data is out.'",
    "",
    "Under **Fundamental View**, present **independent** lines:",
    "- Calendar: <instrument-level line or 'unavailable' / pre-release rule>",
    "- Headlines bias (48h): bullish/bearish/neutral (or 'unavailable')",
    "- CSM: z(base)-z(quote) diff value and interpretation",
    "- COT: bullish/bearish/neutral (or 'unavailable')",
    "- Then state: **Final Fundamental Bias: <label> (score ~X)**",
  ];

  const scalpingLines = !scalping ? [] : [
    "",
    "SCALPING MODE (guardrails only; sections unchanged):",
    "- Treat 4H/1H as guardrails; build setups on 15m, confirm timing on 5m (and 1m if provided). 1m must not override HTF bias.",
    "- Adjust candidate scoring weights: T_candidate = clamp( 0.35*HTF_fit(1H/4H) + 0.40*Context_fit(15m) + 0.25*Trigger_fit(5m & optional 1m), 0, 100 ).",
    "- Prefer session confluence (London/NY kill zones), OR prior day H/L, Asia range. Reward +10 for session confluence and clean invalidation (≤0.35× ATR15) with ≥1.8R potential.",
    "- Near red news ±30m: do not initiate new market orders; consider only pre-planned limit orders with structure protection.",
    "- Management suggestions may include: partial at 1R, BE after 1R, time-stop within ~20 min if no follow-through.",
    "- EMA 21/50 may be referenced; optional only.",
    "- VWAP may be referenced; if referenced, include vwap_used=true in ai_meta.",
    "- TIMEFRAME ATTRIBUTION FOR WORDING: Attribute sweeps to **5m**; CHOCH/BOS to **1m** when detected there.",
    "- TRIGGER WORDING RULE: 'Liquidity sweep on 5m; BOS on 1m (trigger on break/retest)'.",
    "",
    "ai_meta (append fields for downstream tools): include {'mode':'scalping', 'vwap_used': boolean if VWAP referenced, 'time_stop_minutes': 20, 'max_attempts': 3}."
  ];

  const scalpingHardLines = !scalpingHard ? [] : [
    "",
    "SCALPING HARD (enforced micro-structure entries):",
    "- Only produce a **scalping** trade or explicitly 'Stay Flat' if no compliant scalp exists.",
    "- Entry must be built from 15m structure with **5m confirmation**; if a 1m chart is provided, use 1m for timing confirmation.",
    "- Mandatory micro-structure: liquidity sweep or FVG/OB tap + immediate shift (CHOCH/BOS).",
    "- TIMEFRAME ATTRIBUTION FOR WORDING (MANDATORY): Sweeps credited to **5m**; CHOCH/BOS credited to **1m** if detected there (else 5m).",
    "- TRIGGER WORDING RULE (MANDATORY): 'Liquidity sweep on 5m; BOS on 1m (trigger on break/retest)'.",
    "- SL tight: behind the 1m/5m swing; typical 0.15×–0.40× ATR15.",
    "- Time-stop: 15 minutes; state explicitly.",
    "- Max attempts: 2; state explicitly.",
    "- Near red news ±20m: 'Stay Flat' unless a protected limit is resting.",
    "- EMA/VWAP optional only.",
    "",
    "ai_meta (override/add): set {'mode':'scalping-hard', 'time_stop_minutes': 15, 'max_attempts': 2} and include 'vwap_used' if VWAP is referenced."
  ];

  return [...baseLines, ...scalpingLines, ...scalpingHardLines].join("\n");
}

function buildUserPartsBase(args: {
  instrument: string;
  dateStr: string;
  m15: string; h1: string; h4: string;
  m5?: string | null;
  m1?: string | null;
  calendarDataUrl?: string | null;
  calendarText?: string | null;
  headlinesText?: string | null;
  sentimentText?: string | null;
  calendarAdvisoryText?: string | null;
  calendarEvidence?: string[] | null;
  debugOCRRows?: { timeISO: string | null; title: string | null; currency: string | null; impact: any; actual: any; forecast: any; previous: any }[] | null;
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
  if (args.m5) { parts.push({ type: "text", text: "Scalp 5M Chart" }); parts.push({ type: "image_url", image_url: { url: args.m5 } }); }
  if (args.m1) { parts.push({ type: "text", text: "Timing 1M Chart" }); parts.push({ type: "image_url", image_url: { url: args.m1 } }); }
  if (args.calendarDataUrl) { parts.push({ type: "text", text: "Economic Calendar Image:" }); parts.push({ type: "image_url", image_url: { url: args.calendarDataUrl } }); }
  if (!args.calendarDataUrl && args.calendarText) { parts.push({ type: "text", text: `Calendar snapshot:\n${args.calendarText}` }); }
  if (args.calendarAdvisoryText) { parts.push({ type: "text", text: `Calendar advisory:\n${args.calendarAdvisoryText}` }); }
  if (args.calendarEvidence && args.calendarEvidence.length) { parts.push({ type: "text", text: `Calendar fundamentals evidence:\n- ${args.calendarEvidence.join("\n- ")}` }); }
  if (args.headlinesText) { parts.push({ type: "text", text: `Headlines snapshot:\n${args.headlinesText}` }); }
  if (args.sentimentText) { parts.push({ type: "text", text: `Sentiment snapshot (server):\n${args.sentimentText}` }); }
  if (args.debugOCRRows && args.debugOCRRows.length) {
    const rows = args.debugOCRRows.map(r => `${r.timeISO ?? "n/a"} | ${r.currency ?? "??"} | ${r.title ?? "??"} | A:${r.actual ?? "?"} F:${r.forecast ?? "?"} P:${r.previous ?? "?"}`).join("\n");
    parts.push({ type: "text", text: `DEBUG OCR ROWS (first 3):\n${rows}` });
  }
  return parts;
}

// ---------- Message builders ----------
function messagesFull(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string; m5?: string | null; m1?: string | null;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  calendarAdvisory?: { warningMinutes?: number | null; biasNote?: string | null; advisoryText?: string | null; evidence?: string[] | null; debugRows?: any[] | null; preReleaseOnly?: boolean | null };
  provenance?: any;
  scalping?: boolean;
  scalpingHard?: boolean;
}) {

 const system = [
  systemCore(
    args.instrument,
    args.calendarAdvisory,
    args.scalping,
    args.scalpingHard
  ),
  "",
  "OUTPUT format (in this exact order):",
  "Quick Plan (Actionable)",
  "• Direction: Long | Short | Stay Flat",
  "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
  "• Trigger: (state timeframes explicitly, e.g., 'Liquidity sweep on 5m; BOS on 1m (trigger on break/retest)')",
  "• Entry (zone or single):",
  "• Stop Loss:",
  "• Take Profit(s): TP1 / TP2 (approx R multiples)",
  "• Conviction: <0–100>%",
  "• Setup:",
  "• Short Reasoning:",
  "",
  "Option 1 (Primary)",
  "• Direction: ...",
  "• Order Type: ...",
  "• Trigger:",
  "• Entry (zone or single):",
  "• Stop Loss:",
  "• Take Profit(s): TP1 / TP2",
  "• Conviction: <0–100>%",
  "• Why this is primary:",
  "",
  "Option 2 (Alternative)",
  "• Direction: ...",
  "• Order Type: ...",
  "• Trigger:",
  "• Entry (zone or single):",
  "• Stop Loss:",
  "• Take Profit(s): TP1 / TP2",
  "• Conviction: <0–100>%",
  "• Why this alternative:",
  "",
    "Full Breakdown",
  "• Technical View (HTF + Intraday): 4H/1H/15m structure (include 5m/1m if used)",
  "• Fundamental View:",
  "   - Calendar: explicit instrument-level calendar line (or 'Calendar: unavailable'). If pre-release, write exactly: 'Pre-release only, no confirmed bias until data is out.'",
  "   - Headlines bias (48h): bullish/bearish/neutral (or 'unavailable')",
  "   - CSM: z(base)-z(quote) diff and interpretation",
  "   - COT: bullish/bearish/neutral (or 'unavailable')",
  "   - Final Fundamental Bias: <label> (score ~X)",
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
  "• 5m (if used):",
  "• 1m (if used):",
  "",
  "Candidate Scores (tournament):",
  "- name — score — reason",
  "",
  "Final Table Summary:",
  `| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |`,
  `| ${args.instrument} | ... | ... | ... | ... | ... | ... |`,
  "",
  "Append a fenced JSON block labeled ai_meta at the very end.",
  "",
  "provenance_hint:",
  JSON.stringify(args.provenance || {}, null, 2),
].join("\n");


  return [
    { role: "system", content: system },
    { role: "user", content: buildUserPartsBase({
      instrument: args.instrument, dateStr: args.dateStr, m15: args.m15, h1: args.h1, h4: args.h4, m5: args.m5 || null, m1: args.m1 || null,
      calendarDataUrl: args.calendarDataUrl, calendarText: args.calendarText,
      headlinesText: args.headlinesText, sentimentText: args.sentimentText,
      calendarAdvisoryText: args.calendarAdvisory?.advisoryText || null,
      calendarEvidence: args.calendarAdvisory?.evidence || null,
      debugOCRRows: args.calendarAdvisory?.debugRows || null,
    }) },
  ];
}

function messagesFastStage1(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string; m5?: string | null; m1?: string | null;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  calendarAdvisory?: { warningMinutes?: number | null; biasNote?: string | null; advisoryText?: string | null; evidence?: string[] | null; debugRows?: any[] | null; preReleaseOnly?: boolean | null };
  provenance?: any;
  scalping?: boolean;
  scalpingHard?: boolean;
}) {

 const system = [
  systemCore(
    args.instrument,
    args.calendarAdvisory,
    args.scalping,
    args.scalpingHard
  ),
  "",
  "OUTPUT ONLY:",
  "Quick Plan (Actionable)",
  "• Direction: Long | Short | Stay Flat",
  "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
  "• Trigger: (state timeframes explicitly, e.g., 'Liquidity sweep on 5m; BOS on 1m (trigger on break/retest)')",
  "• Entry (zone or single):",
  "• Stop Loss:",
  "• Take Profit(s): TP1 / TP2",
  "• Conviction: <0–100>%",
  "• Setup:",
  "• Short Reasoning:",
  "",
  "Option 1 (Primary)",
  "• Direction: ...",
  "• Order Type: ...",
  "• Trigger:",
  "• Entry (zone or single):",
  "• Stop Loss:",
  "• Take Profit(s): TP1 / TP2",
  "• Conviction: <0–100>%",
  "• Why this is primary:",
  "",
  "Option 2 (Alternative)",
  "• Direction: ...",
  "• Order Type: ...",
  "• Trigger:",
  "• Entry (zone or single):",
  "• Stop Loss:",
  "• Take Profit(s): TP1 / TP2",
  "• Conviction: <0–100>%",
  "• Why this alternative:",
  "",
     "Management: Brief actionable playbook.",
  "",
  "Under Full Breakdown, include 'Fundamental Bias Snapshot' with Calendar, Headlines, CSM, COT, and the Final Fundamental Bias (score + label).",
  "",
  "Detected Structures (X-ray):",
  "• 4H: ...",
  "• 1H: ...",
  "• 15m: ...",
  "• 5m (if used): ...",
  "• 1m (if used): ...",
  "",
  "Candidate Scores (tournament):",
  "- name — score — reason",
  "",
  "Final Table Summary:",
  `| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |`,
  `| ${args.instrument} | ... | ... | ... | ... | ... | ... |`,
  "",
  "Append ONLY a fenced JSON block labeled ai_meta.",
  "",
  "provenance_hint:",
  JSON.stringify(args.provenance || {}, null, 2),
].join("\n");


  const parts = buildUserPartsBase({
    instrument: args.instrument, dateStr: args.dateStr, m15: args.m15, h1: args.h1, h4: args.h4, m5: args.m5 || null, m1: args.m1 || null,
    calendarDataUrl: args.calendarDataUrl,
    calendarText: !args.calendarDataUrl && args.calendarText ? args.calendarText : undefined,
    headlinesText: args.headlinesText || undefined,
    sentimentText: args.sentimentText || undefined,
    calendarAdvisoryText: args.calendarAdvisory?.advisoryText || null,
    calendarEvidence: args.calendarAdvisory?.evidence || null,
    debugOCRRows: args.calendarAdvisory?.debugRows || null,
  });

  return [{ role: "system", content: system }, { role: "user", content: parts }];
}

// ---------- Enforcement helpers (UPDATED) ----------

/** Utility: tolerant sign extractor for Direction lines. */
function _dirSignFromBlock(block: string): -1 | 0 | 1 {
  const m = block.match(/^\s*(?:[-•]\s*)?(?:\*\*)?\s*Direction\s*:\s*(Long|Short|Stay\s*Flat)/im);
  if (!m) return 0;
  const v = m[1].toLowerCase();
  if (v.startsWith("long")) return 1;
  if (v.startsWith("short")) return -1;
  return 0;
}

/** Utility: get core plan blocks. */
function _pickBlocks(doc: string) {
  const RE_QP = /(Quick\s*Plan\s*\(Actionable\)[\s\S]*?)(?=\n\s*Option\s*1|\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i;
  const RE_O1 = /(Option\s*1[\s\S]*?)(?=\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i;
  const RE_O2 = /(Option\s*2[\s\S]*?)(?=\n\s*Full\s*Breakdown|$)/i;
  const qp = doc.match(RE_QP)?.[0] || "";
  const o1 = doc.match(RE_O1)?.[0] || "";
  const o2 = doc.match(RE_O2)?.[0] || "";
  return { qp, o1, o2, RE_QP, RE_O1, RE_O2 };
}

function hasCompliantOption2(text: string): boolean {
  if (!/Option\s*2/i.test(text || "")) return false;
  const block = (text.match(/Option\s*2[\s\S]{0,800}/i)?.[0] || "").toLowerCase();
  const must = ["direction", "order type", "trigger", "entry", "stop", "tp", "conviction"];
  return must.every((k) => block.includes(k));
}

async function enforceOption2(model: string, instrument: string, text: string) {
  if (hasCompliantOption2(text)) return text;
  const messages = [
    { role: "system", content: "Add a compliant **Option 2 (Alternative)**. Keep everything else unchanged. Include Direction, Order Type, explicit Trigger, Entry (zone or single), SL, TP1/TP2, Conviction %." },
    { role: "user", content: `Instrument: ${instrument}\n\n${text}\n\nAdd Option 2 (Alternative) below Option 1.` },
  ];
  return callOpenAI(model, messages);
}

function hasOption1(text: string): boolean {
  if (!text) return false;
  const re =
    /(^|\n)\s{0,3}#{0,6}\s*[>\s]*[*\-•]?\s*(?:\*\*|__|_)?\s*Option[ \t\u00A0\u202F]*1(?!\d)\s*(?:\(\s*Primary\s*\))?(?:\s*[:\-–—])?(?:\s*(?:\*\*|__|_))?/im;
  return re.test(text);
}

/** Deterministically build & insert "Option 1 (Primary)" if missing.
 * Also avoids duplicate regex const names elsewhere by keeping all regexes local to this function. */
async function enforceOption1(_model: string, instrument: string, text: string) {
  if (!text) return text;

  // Dedupe extra Option 1 blocks if any
  const RE_O1_BLOCK_G = /(Option\s*1(?!\d)[\s\S]*?)(?=\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/gi;
  let o1Count = 0;
  const deduped = text.replace(RE_O1_BLOCK_G, (m) => (++o1Count === 1 ? m : ""));
  if (o1Count > 1) text = deduped;

  if (hasOption1(text)) return text;

  // Local-only regex (do not collide with other helpers)
  const RE_QP_BLOCK_LOCAL = /(Quick\s*Plan\s*\(Actionable\)[\s\S]*?)(?=\n\s*Option\s*1|\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i;
  const RE_O2_BLOCK_LOCAL = /(Option\s*2[\s\S]*?)(?=\n\s*Full\s*Breakdown|$)/i;
  const RE_FULL_LOCAL     = /(\n\s*Full\s*Breakdown)/i;

  const qpBlock = text.match(RE_QP_BLOCK_LOCAL)?.[0] || "";
  const o2Block = text.match(RE_O2_BLOCK_LOCAL)?.[0] || "";

  function detectBulletChar(block: string): string {
    if (/^\s*•\s/m.test(block)) return "• ";
    if (/^\s*-\s/m.test(block)) return "- ";
    return "• ";
  }
  function blockUsesBoldLabels(block: string): boolean {
    return /\*\*\s*(Direction|Order\s*Type|Trigger|Entry|Stop\s*Loss|Take\s*Profit\(s\))\s*:\s*\*\*/i.test(block)
        || /(?:^|\n)\s*(?:[-•]\s*)?\*\*\s*(Direction|Order\s*Type|Trigger|Entry|Stop\s*Loss|Take\s*Profit\(s\))\s*:/i.test(block);
  }
  function pick(re: RegExp, src: string): string | null {
    const m = src.match(re);
    return m ? String(m[1]).trim() : null;
  }
  function parseFields(src: string) {
    return {
      direction: pick(/^\s*(?:[-•]\s*)?(?:\*\*)?\s*Direction\s*:\s*(?:\*\*)?\s*([^\n]+)/mi, src),
      orderType: pick(/^\s*(?:[-•]\s*)?(?:\*\*)?\s*Order\s*Type\s*:\s*(?:\*\*)?\s*([^\n]+)/mi, src),
      trigger:   pick(/^\s*(?:[-•]\s*)?(?:\*\*)?\s*Trigger\s*:\s*(?:\*\*)?\s*([^\n]+)/mi, src),
      entry:     pick(/^\s*(?:[-•]\s*)?(?:\*\*)?\s*Entry\s*\(zone\s*or\s*single\)\s*:\s*(?:\*\*)?\s*([^\n]+)/mi, src)
              || pick(/^\s*(?:[-•]\s*)?(?:\*\*)?\s*Entry\s*:\s*(?:\*\*)?\s*([^\n]+)/mi, src),
      stop:      pick(/^\s*(?:[-•]\s*)?(?:\*\*)?\s*Stop\s*Loss\s*:\s*(?:\*\*)?\s*([^\n]+)/mi, src),
      tps:       pick(/^\s*(?:[-•]\s*)?(?:\*\*)?\s*Take\s*Profit\(s\)\s*:\s*(?:\*\*)?\s*([^\n]+)/mi, src)
              || pick(/^\s*(?:[-•]\s*)?(?:\*\*)?\s*TPs?\s*:\s*(?:\*\*)?\s*([^\n]+)/mi, src),
      conv:      pick(/^\s*(?:[-•]\s*)?(?:\*\*)?\s*Conviction\s*:\s*(?:\*\*)?\s*(\d{1,3})\s*%/mi, src),
      setup:     pick(/^\s*(?:[-•]\s*)?(?:\*\*)?\s*Setup\s*:\s*(?:\*\*)?\s*([^\n]+)/mi, src),
      shortWhy:  pick(/^\s*(?:[-•]\s*)?(?:\*\*)?\s*Short\s*Reasoning\s*:\s*(?:\*\*)?\s*([^\n]+)/mi, src)
    };
  }

  const qp = parseFields(qpBlock);
  const o2 = parseFields(o2Block);
  const choose = (a?: string | null, b?: string | null, ph = "...") =>
    (a && a.trim()) || (b && b.trim()) || ph;

  const bullet = detectBulletChar(qpBlock || o2Block || text);
  const bold = blockUsesBoldLabels(qpBlock || o2Block || "");
  const L = (label: string) => (bold ? `**${label}:**` : `${label}:`);

  const fields = {
    direction: choose(qp.direction, o2.direction, "Long"),
    orderType: choose(qp.orderType, o2.orderType, "Market"),
    trigger:   choose(qp.trigger,   o2.trigger,   "Liquidity sweep on 5m; BOS on 1m (trigger on break/retest)"),
    entry:     choose(qp.entry,     o2.entry,     "zone ..."),
    stop:      choose(qp.stop,      o2.stop,      "behind recent swing"),
    tps:       choose(qp.tps,       o2.tps,       "TP1 1.0R / TP2 2.0R"),
    conv:      choose(qp.conv,      o2.conv,      "60"),
    why:       choose(qp.shortWhy,  qp.setup,     "Primary due to HTF alignment, clean invalidation, and superior R:R.")
  };

  const option1Block =
`Option 1 (Primary)
${bullet}${L("Direction")} ${fields.direction}
${bullet}${L("Order Type")} ${fields.orderType}
${bullet}${L("Trigger")} ${fields.trigger}
${bullet}${L("Entry (zone or single)")} ${fields.entry}
${bullet}${L("Stop Loss")} ${fields.stop}
${bullet}${L("Take Profit(s)")} ${fields.tps}
${bullet}${L("Conviction")} ${fields.conv}%
${bullet}${L("Why this is primary")} ${fields.why}
`;

  let out = text;

  if (RE_O2_BLOCK_LOCAL.test(out)) {
    out = out.replace(RE_O2_BLOCK_LOCAL, `${option1Block}\n$&`);
    return out;
  }
  if (RE_QP_BLOCK_LOCAL.test(out)) {
    out = out.replace(RE_QP_BLOCK_LOCAL, (m) => `${m}\n${option1Block}\n`);
    return out;
  }
  if (RE_FULL_LOCAL.test(out)) {
    out = out.replace(RE_FULL_LOCAL, `\n${option1Block}\n$1`);
  } else {
    out = `${out}\n\n${option1Block}\n`;
  }
  return out;
}


function hasQuickPlan(text: string): boolean { return /Quick\s*Plan\s*\(Actionable\)/i.test(text || ""); }

async function enforceQuickPlan(model: string, instrument: string, text: string) {
  if (hasQuickPlan(text)) return text;
  const messages = [
    { role: "system", content: "Add a 'Quick Plan (Actionable)' section at the very top, copying primary trade details. Keep all other sections unchanged and in order." },
    { role: "user", content: `Instrument: ${instrument}\n\n${text}\n\nAdd the Quick Plan section at the top.` },
  ];
  return callOpenAI(model, messages);
}

/** SCALPING guards (unchanged logic, wording improved where needed) */
function enforceScalpHardStopLossLines(text: string, scalpingHard: boolean) {
  if (!scalpingHard || !text) return text;

  const blocks = [
    { name: "Quick Plan (Actionable)", re: /(Quick\s*Plan\s*\(Actionable\)[\s\S]*?)(?=\n\s*Option\s*1|\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i },
    { name: "Option 1", re: /(Option\s*1[\s\S]*?)(?=\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i },
    { name: "Option 2", re: /(Option\s*2[\s\S]*?)(?=\n\s*Full\s*Breakdown|$)/i },
  ];

  const lineRe = /(^\s*•\s*Stop\s*Loss:\s*)(.*)$/mi;
  const needsRewrite = (s: string) => {
    const l = (s || "").toLowerCase();
    const mentions15m = /\b(15m|15\s*min|15\s*minute)\b/i.test(l);
    const hasMicroTF = /\b(1m|5m)\b/i.test(l);
    const hasSpec = /(swing|choch|bos|atr)/i.test(l);
    return mentions15m || !hasMicroTF || !hasSpec;
  };

  function rewriteBlock(block: string): string {
    const m = block.match(lineRe);
    if (!m) return block;
    const current = m[2] || "";
    if (!needsRewrite(current)) return block;
    const newLine = "• Stop Loss: beyond 1m/5m swing of the entry leg (tight), typical 0.15×–0.40× ATR15; if 1m prints opposite CHOCH/BOS, exit (time-stop 15m).";
    return block.replace(lineRe, (_full, p1) => `${p1}${newLine.replace(/^•\s*Stop\s*Loss:\s*/i, "")}`);
  }

  let out = text;
  for (const b of blocks) {
    const m = out.match(b.re);
    if (!m) continue;
    const patched = rewriteBlock(m[0]);
    out = out.replace(m[0], patched);
  }
  return out;
}

function enforceScalpRiskLines(text: string, scalping: boolean, scalpingHard: boolean) {
  if (!text || (!scalping && !scalpingHard)) return text;
  const timeStop = scalpingHard ? 15 : 20;
  const attempts = scalpingHard ? 2 : 3;

  const blocks = [
    { name: "Quick Plan (Actionable)", re: /(Quick\s*Plan\s*\(Actionable\)[\s\S]*?)(?=\n\s*Option\s*1|\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i },
    { name: "Option 1", re: /(Option\s*1[\s\S]*?)(?=\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i },
    { name: "Option 2", re: /(Option\s*2[\s\S]*?)(?=\n\s*Full\s*Breakdown|$)/i },
  ];

  function injectLines(block: string): string {
    let out = block;
    const anchorRe = /(^\s*•\s*Conviction\s*:\s*.*$)/mi;
    const hasTimeStop = /•\s*Time-?Stop\s*:/i.test(out);
    const hasAttempts = /•\s*Max\s*Attempts\s*:/i.test(out);
    const addTimeStop = `• Time-Stop: ${timeStop} minutes if no follow-through or opposite micro-shift (CHOCH/BOS).`;
    const addAttempts = `• Max Attempts: ${attempts}.`;

    if (!hasTimeStop || !hasAttempts) {
      if (anchorRe.test(out)) {
        out = out.replace(anchorRe, (m) => {
          const insert = `${!hasTimeStop ? addTimeStop + "\n" : ""}${!hasAttempts ? addAttempts + "\n" : ""}`;
          return `${insert}${m}`;
        });
      } else {
        out = out.replace(/$/, `\n${!hasTimeStop ? addTimeStop + "\n" : ""}${!hasAttempts ? addAttempts + "\n" : ""}`);
      }
    }
    return out;
  }

  let out = text;
  for (const b of blocks) {
    const m = out.match(b.re);
    if (!m) continue;
    const patched = injectLines(m[0]);
    out = out.replace(m[0], patched);
  }
  return out;
}

function ensureNewsProximityNote(text: string, warnMins: number | null, instrument: string) {
  if (!text || warnMins == null) return text;
  const qpRe = /(Quick\s*Plan\s*\(Actionable\)[\s\S]*?)(?=\n\s*Option\s*1|\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i;
  const m = text.match(qpRe);
  if (!m) return text;
  let block = m[0];
  if (/News\s*Proximity\s*:/i.test(block)) return text;

  const note = `• News Proximity: High-impact event in ~${warnMins} min — prefer protected limit orders; consider staying flat until after release.`;
  block = block.replace(/(Quick\s*Plan\s*\(Actionable\)[^\n]*\n)/i, `$1${note}\n`);
  return text.replace(m[0], block);
}

function ensureCalendarVisibilityInQuickPlan(text: string, args: { instrument: string; preReleaseOnly: boolean; biasLine: string | null }) {
  if (!text) return text;
  const hasQP = /Quick\s*Plan\s*\(Actionable\)/i.test(text);
  if (!hasQP) return text;

  const qpBlock = text.match(/Quick\s*Plan\s*\(Actionable\)[\s\S]*?(?=\n\s*Option\s*1|\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i)?.[0] || "";
  const hasCalendarMention = /Calendar\s*:/i.test(qpBlock) || /Calendar\s*bias\s*for\s*/i.test(qpBlock);
  if (hasCalendarMention) return text;

  let inject = "";
  if (args.preReleaseOnly) {
    inject = `\n• Note: Pre-release only, no confirmed bias until data is out.`;
   } else if (args.biasLine) {
    if (/unavailable/i.test(args.biasLine)) {
      inject = `\n• Calendar: unavailable.`;
    } else {
      const trimmed = args.biasLine.replace(/^Calendar\s*:\s*/i, "").replace(/\.$/, "");
      const normalized = /^Calendar\s*bias\s*for/i.test(trimmed) ? trimmed : `Calendar bias for ${args.instrument}: ${trimmed}`;
      const finalLine = normalized.replace(new RegExp(`^Calendar\\s*bias\\s*for\\s*${args.instrument}\\s*:\\s*`, "i"), `Calendar bias for ${args.instrument}: `);
      inject = `\n• ${finalLine}`;
    }
  }

  if (!inject) return text;
  return text.replace(/(Quick\s*Plan\s*\(Actionable\)[^\n]*\n)/i, `$1${inject}\n`);
}

function stampM5Used(text: string, used: boolean) {
  if (!used) return text;
  const stamp = "• Used Chart: 5M execution";
  let out = text;
  if (/Quick\s*Plan\s*\(Actionable\)/i.test(out) && !/Used\s*Chart:\s*5M/i.test(out)) {
    out = out.replace(/(Quick\s*Plan\s*\(Actionable\)[\s\S]*?)(\n\s*Option\s*1)/i, (m, a, b) => {
      return /•\s*Used\s*Chart:\s*5M/i.test(a) ? m : `${a}\n${stamp}\n${b}`;
    });
  }
  if (/Option\s*1\s*\(?(Primary)?\)?/i.test(out) && !/Used\s*Chart:\s*5M/i.test(out)) {
    out = out.replace(/(Option\s*1[\s\S]*?)(\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i, (m, a, b) => {
      return /•\s*Used\s*Chart:\s*5M/i.test(a) ? m : `${a}\n${stamp}\n${b}`;
    });
  }
  return out;
}

function stampM1Used(text: string, used: boolean) {
  if (!used) return text;
  const stamp = "• Used Chart: 1M timing";
  let out = text;
  if (/Quick\s*Plan\s*\(Actionable\)/i.test(out) && !/Used\s*Chart:\s*1M/i.test(out)) {
    out = out.replace(/(Quick\s*Plan\s*\(Actionable\)[\s\S]*?)(\n\s*Option\s*1)/i, (m, a, b) => {
      return /•\s*Used\s*Chart:\s*1M/i.test(a) ? m : `${a}\n${stamp}\n${b}`;
    });
  }
  if (/Option\s*1\s*\(?(Primary)?\)?/i.test(out) && !/Used\s*Chart:\s*1M/i.test(out)) {
    out = out.replace(/(Option\s*1[\s\S]*?)(\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i, (m, a, b) => {
      return /•\s*Used\s*Chart:\s*1M/i.test(a) ? m : `${a}\n${stamp}\n${b}`;
    });
  }
  return out;
}

/** Deterministic alignment wording using *final* fundamentals sign + actual plan direction.
 * If fundamentals are neutral, force "Match (Fundamentals neutral — trade managed by technicals)". */
function applyConsistencyGuards(
  text: string,
  args: { fundamentalsSign: -1 | 0 | 1 }
) {
  let out = text || "";
  const { qp, o1 } = _pickBlocks(out);

  // Technical sign preference: Option 1 first, then Quick Plan
  let techSign: -1 | 0 | 1 = _dirSignFromBlock(o1);
  if (techSign === 0) techSign = _dirSignFromBlock(qp);

  const reTF = /(Tech\s*vs\s*Fundy\s*Alignment:\s*)(Match|Mismatch)([^\n]*)/i;
  const isNeutralFinal = args.fundamentalsSign === 0;

  const desired =
    isNeutralFinal
      ? "Match (Fundamentals neutral — trade managed by technicals)"
      : (techSign !== 0 && techSign === args.fundamentalsSign)
        ? "Match"
        : (techSign !== 0 && args.fundamentalsSign !== 0)
          ? "Mismatch"
          : "Match";

  if (reTF.test(out)) {
    out = out.replace(reTF, (_m, p1) => `${p1}${desired}`);
  } else {
    // Inject under Full Breakdown > Fundamental View if missing
    out = out.replace(
      /(Full\s*Breakdown[\s\S]*?Fundamental\s*View:[\s\S]*?)(\n\s*•\s*Tech\s*vs\s*Fundy\s*Alignment:|$)/i,
      (m, a) => `${a}\n• Tech vs Fundy Alignment: ${desired}\n`
    );
  }
  return out;
}


/** Tournament size & non-sweep diversity (unchanged behavior). */
async function enforceTournamentDiversity(model: string, instrument: string, text: string) {
  const sectMatch = text.match(/Candidate\s*Scores\s*\(tournament\):[\s\S]*?(?=\n\s*Final\s*Table\s*Summary:|\n\s*Detected\s*Structures|\n\s*Full\s*Breakdown|$)/i);
  const sect = sectMatch ? sectMatch[0] : "";
  const lines = (sect.match(/^- .+/gmi) || []);

  // Deterministic checks
  const nonSweep = lines.filter(l => !/(sweep|liquidity|stop\s*hunt|bos\b|choch\b)/i.test(l));
  const tfRe = /\b(4H|1H|15m|5m|1m)\b/i;
  const hasTFs = lines.every(l => tfRe.test(l));

  const ok = lines.length >= 5 && nonSweep.length >= 3 && hasTFs;
  if (ok) return text;

  const prompt = [
    "Fix ONLY the 'Candidate Scores (tournament)' section to satisfy ALL of the following:",
    "1) Include at least 5 candidates total.",
    "2) Include at least 3 candidates that are NOT liquidity-sweep/BOS strategies.",
    "3) Each bullet MUST cite explicit timeframe(s) (e.g., 4H/1H/15m/5m/1m) in the reason.",
    "",
    "Keep every other part of the document unchanged. Return only the corrected section content (header + bullet lines).",
    "Each line format: '- name — score — reason' and reasons must reference visible structure/timeframes.",
    `Instrument: ${instrument}`,
    sect || "(section missing)"
  ].join("\n\n");

  const out = await callOpenAI(model, [
    { role: "system", content: "You will output ONLY the corrected 'Candidate Scores (tournament)' section. Do not change anything else." },
    { role: "user", content: prompt }
  ]);

  if (!out || out.trim().length < 10) return text;

  const replacement = `Candidate Scores (tournament):\n${out.trim()}\n`;
  if (sectMatch) {
    return text.replace(sectMatch[0], replacement);
  }
  if (/Final\s*Table\s*Summary:/i.test(text)) {
    return text.replace(/Final\s*Table\s*Summary:/i, `${replacement}\nFinal Table Summary:`);
  }
  return `${text}\n\n${replacement}`;
}


/** Trigger specificity (unchanged behavior). */
async function enforceTriggerSpecificity(model: string, instrument: string, text: string) {
  const blockSpecs = [
    { name: "Quick Plan (Actionable)", re: /(Quick\s*Plan\s*\(Actionable\)[\s\S]*?)(?=\n\s*Option\s*1|\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i },
    { name: "Option 1", re: /(Option\s*1[\s\S]*?)(?=\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i },
    { name: "Option 2", re: /(Option\s*2[\s\S]*?)(?=\n\s*Full\s*Breakdown|$)/i },
  ];

  let out = text;
  for (const spec of blockSpecs) {
    const m = out.match(spec.re);
    if (!m) continue;
    const block = m[0];
    const trigMatch = block.match(/^\s*•\s*Trigger:\s*(.+)$/mi);
    if (!trigMatch) continue;
    const trig = trigMatch[1].trim();

    const hasTF = /(1m|5m|15m|1h|4h)/i.test(trig);
    const hasStrat = /(ob|order\s*block|fvg|fair\s*value|trendline|range|vwap|sweep|bos|choch|divergence|squeeze|pullback|fib|breaker|momentum|breakout)/i.test(trig);
    const isGeneric = !(hasTF && hasStrat) || /\b(price\s+breaks|break\s+(above|below)|crosses)\b/i.test(trig);

    if (!isGeneric) continue;

    const sys = "Rewrite only the Trigger line to be strategy-specific and timeframe-specific using the strategy implied in the block. Keep all other lines unchanged.";
    const usr = `Instrument: ${instrument}\n\nBLOCK:\n${block}\n\nRules:\n- Explicit timeframes (e.g., '5m sweep; 1m BOS').\n- Use a concrete trigger matching the strategy (OB/FVG, TL break+retest, range rotation, momentum breakout, VWAP, etc.).\n- Keep everything else intact. Return ONLY the rewritten Trigger line, starting with '• Trigger:'`;

    const newLine = await callOpenAI(model, [{ role: "system", content: sys }, { role: "user", content: usr }]);
    if (newLine && /^(\s*•\s*Trigger:)/i.test(newLine.trim())) {
      const updatedBlock = block.replace(/^\s*•\s*Trigger:\s*.+$/mi, newLine.trim());
      out = out.replace(block, updatedBlock);
    }
  }
  return out;
}

/** Ensure Full Breakdown skeleton exists. */
async function enforceFullBreakdownSkeleton(model: string, instrument: string, text: string) {
  const hasFB = /Full\s*Breakdown/i.test(text);
  const need = [
    /Technical\s*View/i, /Fundamental\s*View/i, /Tech\s*vs\s*Fundy\s*Alignment/i,
    /Conditional\s*Scenarios/i, /Surprise\s*Risk/i, /Invalidation/i, /One-liner\s*Summary/i
  ];
  const ok = hasFB && need.every(re => re.test(text));
  if (ok) return text;

  if (!hasFB) {
    return `${text}\n\nFull Breakdown\n• Technical View (HTF + Intraday): ...\n• Fundamental View: ...\n• Tech vs Fundy Alignment: ...\n• Conditional Scenarios: ...\n• Surprise Risk: ...\n• Invalidation: ...\n• One-liner Summary: ...\n`;
  }

  const prompt = `Add any missing Full Breakdown subsection labels (exact labels) without altering existing content. Instrument: ${instrument}\n\n${text}`;
  const patched = await callOpenAI(model, [
    { role: "system", content: "Ensure required Full Breakdown subsection labels exist. Do not modify existing content; only insert missing labeled lines under the Full Breakdown section." },
    { role: "user", content: prompt }
  ]);
  return patched && patched.trim().length > 10 ? patched : text;
}

function enforceFinalTableSummary(text: string, instrument: string) {
  if (/Final\s*Table\s*Summary/i.test(text)) return text;
  const stub =
`\nFinal Table Summary:
| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |
| ${instrument} | ... | ... | ... | ... | ... | ... |\n`;
  return `${text}\n${stub}`;
}

/** Conviction calculation & injection (unchanged math, refactored for clarity). */
function computeAndInjectConviction(
  text: string,
  args: { fundamentals: { final: { score: number; sign: number } }, proximityFlag?: boolean }
) {
  if (!text) return text;

  const tSect = text.match(
    /Candidate\s*Scores\s*\(tournament\):[\s\S]*?(?=\n\s*Final\s*Table\s*Summary:|\n\s*Full\s*Breakdown|$)/i
  )?.[0] || "";
  const tMatches = [...tSect.matchAll(/—\s*(\d{1,3})\s*—/g)];
  const uniqSorted = [...new Set(tMatches
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.max(0, Math.min(100, n)))
  )].sort((a, b) => b - a);

  const T1 = uniqSorted[0] ?? 0;
  const T2 = uniqSorted[1] ?? Math.max(0, T1 - 12);

  const F = Math.max(0, Math.min(100, Number(args.fundamentals?.final?.score) || 0));
  const fSign = (Number(args.fundamentals?.final?.sign) || 0) as -1 | 0 | 1;
  const prox = !!args.proximityFlag;

  const RE_QP_BLOCK = /(Quick\s*Plan\s*\(Actionable\)[\s\S]*?)(?=\n\s*Option\s*1|\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i;
  const RE_O1_BLOCK = /(Option\s*1[\s\S]*?)(?=\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i;
  const RE_O2_BLOCK = /(Option\s*2[\s\S]*?)(?=\n\s*Full\s*Breakdown|$)/i;

  function dirSign(block: string): -1 | 0 | 1 { return _dirSignFromBlock(block); }
  function hasText(s: string, re: RegExp) { return re.test((s || "").toLowerCase()); }
  function pickBlock(src: string, re: RegExp): string { const m = src.match(re); return m ? m[0] : ""; }

  const qpBlock = pickBlock(text, RE_QP_BLOCK);
  const o1Block = pickBlock(text, RE_O1_BLOCK);
  const o2Block = pickBlock(text, RE_O2_BLOCK);

  let dQP = dirSign(qpBlock);
  const dO1 = dirSign(o1Block);
  const dO2 = dirSign(o2Block);
  if (dQP === 0) dQP = dO1;

  const alignQP = (fSign !== 0 && dQP !== 0) ? (fSign === dQP ? 8 : -8) : 0;
  const alignO1 = (fSign !== 0 && dO1 !== 0) ? (fSign === dO1 ? 8 : -8) : 0;
  const alignO2 = (fSign !== 0 && dO2 !== 0) ? (fSign === dO2 ? 8 : -8) : 0;

  function qualityFactor(block: string): number {
    let q = 1.0;
    if (hasText(block, /(htf\s+alignment|clean\s+invalidation|confluence|ob\s*\+?\s*fvg|rr\s*[:x]?\s*2(\.?\d+)?|\bR\s*[:x]\s*2)/i)) q += 0.05;
    if (hasText(block, /(clear\s+(bos|choch)|trendline\s+break|range\s+rotation|vwap)/i)) q += 0.05;
    if (hasText(block, /(chop|unclear|messy|low\s+confidence)/i)) q -= 0.1;
    return Math.max(0.8, Math.min(1.1, q));
  }
  function reliabilityFactor(textAll: string): number {
    let r = 1.0;
    if (hasText(textAll, /pre-release\s+only|waiting\s+for\s+results|calendar:\s*unavailable/i)) r -= 0.1;
    if (hasText(textAll, /\bMismatch\b/i)) r -= 0.05;
    return Math.max(0.8, Math.min(1.05, r));
  }
  const Q_qp = qualityFactor(qpBlock || o1Block || "");
  const Q_o1 = qualityFactor(o1Block);
  const Q_o2 = qualityFactor(o2Block);
  const R_f  = reliabilityFactor(text);

  const prox_pen = prox ? 6 : 0;
  const liq_pen  = hasText(text, /\b(asia\s+session|illiquid|thin\s+liquidity)\b/i) ? 2 : 0;

  const Tq_qp = Math.max(0, Math.min(100, Math.round((T1) * Q_qp)));
  const Tq_o1 = Math.max(0, Math.min(100, Math.round((T1) * Q_o1)));
  const Tq_o2 = Math.max(0, Math.min(100, Math.round((T2) * Q_o2)));
  const Fr    = Math.max(0, Math.min(100, Math.round(F * R_f)));

  const convQP = Math.max(0, Math.min(100, Math.round(0.60 * Tq_qp + 0.40 * Fr + alignQP - (prox_pen + liq_pen))));
  const convO1 = Math.max(0, Math.min(100, Math.round(0.60 * Tq_o1 + 0.40 * Fr + alignO1 - (prox_pen + liq_pen))));
  const convO2 = Math.max(0, Math.min(100, Math.round(0.60 * Tq_o2 + 0.40 * Fr + alignO2 - (prox_pen + liq_pen))));

  function detectBullet(block: string): string { if (/^\s*•\s/m.test(block)) return "• "; if (/^\s*-\s/m.test(block)) return "- "; return "• "; }
  function usesBoldLabels(block: string): boolean {
    return /\*\*\s*(Direction|Order\s*Type|Trigger|Entry|Stop\s*Loss|Take\s*Profit\(s\))\s*:\s*\*\*/i.test(block)
        || /(?:^|\n)\s*(?:[-•]\s*)?\*\*\s*(Direction|Order\s*Type|Trigger|Entry|Stop\s*Loss|Take\s*Profit\(s\))\s*:/i.test(block);
  }
  function writeConv(src: string, blockRe: RegExp, pct: number) {
    const m = src.match(blockRe);
    if (!m) return src;
    const block = m[0];

    const bullet = detectBullet(block);
    const bold = usesBoldLabels(block);
    const label = bold ? "**Conviction:**" : "Conviction:";

    const stripped = block.replace(/^\s*(?:[-•]\s*)?(?:\*\*)?\s*Conviction\s*:[^\n]*\n?/gmi, "");
    const reTP = /(^\s*(?:[-•]\s*)?(?:\*\*)?\s*Take\s*Profit\(s\)\s*:[^\n]*\n)/mi;
    const reSL = /(^\s*(?:[-•]\s*)?(?:\*\*)?\s*Stop\s*Loss\s*:[^\n]*\n)/mi;
    const insertion = `${bullet}${label} ${pct}%\n`;

    let updated = stripped;
    if (reTP.test(stripped)) updated = stripped.replace(reTP, (m) => m + insertion);
    else if (reSL.test(stripped)) updated = stripped.replace(reSL, (m) => m + insertion);
    else updated = stripped.replace(/$/, `\n${insertion}`);

    return src.replace(block, updated);
  }

  let out = text;
  out = writeConv(out, RE_QP_BLOCK, convQP);
  out = writeConv(out, RE_O1_BLOCK, convO1);
  out = writeConv(out, RE_O2_BLOCK, convO2);

  return out;
}

/** Final table row filler (unchanged). */
function fillFinalTableSummaryRow(text: string, instrument: string) {
  if (!text) return text;

  const stripMd = (s: string) =>
    String(s || "")
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  function grab(re: RegExp): string | null {
    const m = text.match(re);
    return m ? stripMd(m[1]) : null;
  }

  const bias = grab(/Quick\s*Plan[\s\S]*?Direction\s*:\s*(?:\*\*)?\s*(Long|Short|Stay\s*Flat)/i) || "...";
  const entry = grab(/Quick\s*Plan[\s\S]*?Entry\s*\(zone\s*or\s*single\)\s*:\s*(?:\*\*)?\s*([^\n]+)/i)
             || grab(/Quick\s*Plan[\s\S]*?Entry\s*:\s*(?:\*\*)?\s*([^\n]+)/i)
             || "...";
  const sl    = grab(/Quick\s*Plan[\s\S]*?Stop\s*Loss\s*:\s*(?:\*\*)?\s*([^\n]+)/i) || "...";
  const tps   = grab(/Quick\s*Plan[\s\S]*?Take\s*Profit\(s\)\s*:\s*(?:\*\*)?\s*([^\n]+)/i)
             || grab(/Quick\s*Plan[\s\S]*?TPs?\s*:\s*(?:\*\*)?\s*([^\n]+)/i)
             || "";
  const conv  = grab(/Quick\s*Plan[\s\S]*?Conviction\s*:\s*(?:\*\*)?\s*(\d{1,3})\s*%/i) || "...";

  let tp1 = "...", tp2 = "...";
  if (tps) {
    const mm1 = tps.match(/TP1[:\s]*([0-9.]+)/i);
    const mm2 = tps.match(/TP2[:\s]*([0-9.]+)/i);
    if (mm1) tp1 = stripMd(mm1[1]);
    if (mm2) tp2 = stripMd(mm2[1]);
    if (tp1 === "..." || tp2 === "...") {
      const nums = (tps.match(/[0-9.]+/g) || []).map(stripMd);
      if (tp1 === "..." && nums[0]) tp1 = nums[0];
      if (tp2 === "..." && nums[1]) tp2 = nums[1];
    }
  }

  const headerRe = /Final\s*Table\s*Summary:\s*\n\|\s*Instrument\s*\|\s*Bias\s*\|\s*Entry Zone\s*\|\s*SL\s*\|\s*TP1\s*\|\s*TP2\s*\|\s*Conviction %\s*\|\n/i;
  const rowRe = new RegExp(`^\\|\\s*${instrument.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|[^\\n]*$`, "im");
  const newRow = `| ${instrument} | ${bias} | ${entry} | ${sl} | ${tp1} | ${tp2} | ${conv} |`;

  if (!headerRe.test(text)) {
    const block =
`\nFinal Table Summary:
| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |
${newRow}\n`;
    return `${text}\n${block}`;
  }

  if (rowRe.test(text)) return text.replace(rowRe, newRow);
  return text.replace(headerRe, (m) => m + newRow + "\n");
}

function ensureAiMetaBlock(text: string, patch: Record<string, any>) {
  // Merge existing ai_meta (if any) with the provided patch
  const meta = extractAiMeta(text) || {};
  const merged = { ...meta, ...patch };
  const json = JSON.stringify(merged, null, 2);

  // Always emit a fenced JSON block:
  // ai_meta
  // ```json
  // { ... }
  // ```
  const fenced = `\nai_meta\n\`\`\`json\n${json}\n\`\`\`\n`;

  // Replace existing fenced ai_meta if present
  const reFenced = /\nai_meta\s*```json[\s\S]*?```\s*/i;
  if (reFenced.test(text)) {
    return text.replace(reFenced, fenced);
  }

  // Replace legacy unfenced ai_meta { ... } if present
  const reLegacy = /\nai_meta\s*{[\s\S]*?}\s*/i;
  if (reLegacy.test(text)) {
    return text.replace(reLegacy, fenced);
  }

  // Otherwise, append at the end
  // Ensure there is a trailing newline separation to avoid gluing to previous content
  const needsNL = !/\n$/.test(text);
  return `${needsNL ? text + "\n" : text}${fenced}`;
}


/** Normalize Order Type (existing behavior kept) if ai_meta has price & zone. */
function normalizeOrderTypeLines(text: string, aiMeta: any) {
  const dir = String(aiMeta?.direction || "").toLowerCase();
  const p = Number(aiMeta?.currentPrice);
  const zmin = Number(aiMeta?.zone?.min);
  const zmax = Number(aiMeta?.zone?.max);
  if (!isFinite(p) || !isFinite(zmin) || !isFinite(zmax)) return text;

  function wantOrder(): string | null {
    if (dir === "long") {
      if (Math.max(zmin, zmax) < p) return "Buy Limit";
      if (Math.min(zmin, zmax) > p) return "Buy Stop";
      return "Market";
    } else if (dir === "short") {
      if (Math.min(zmin, zmax) > p) return "Sell Limit";
      if (Math.max(zmin, zmax) < p) return "Sell Stop";
      return "Market";
    }
    return null;
  }

  const desired = wantOrder();
  if (!desired) return text;

  function setOrderInBlock(src: string, blockRe: RegExp) {
    const m = src.match(blockRe);
    if (!m) return src;
    const block = m[0];
    const updated = block.replace(/(^\s*•\s*Order\s*Type:\s*)(.+)$/mi, `$1${desired}`);
    return src.replace(block, updated);
  }

  let out = text;
  out = setOrderInBlock(out, /(Quick\s*Plan\s*\(Actionable\)[\s\S]*?)(?=\n\s*Option\s*1|\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i);
  out = setOrderInBlock(out, /(Option\s*1[\s\S]*?)(?=\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i);
  return out;
}

/** NEW: If trigger says BOS/breakout/close-below, prefer Stop orders; fix Limit/Stop mismatch. */
function _normalizeOrderTypeByTrigger(text: string): string {
  const { qp, o1, o2, RE_QP, RE_O1, RE_O2 } = _pickBlocks(text);

  function desiredOrder(type: "long" | "short", triggerLine: string): "Market" | "Buy Stop" | "Sell Stop" | "Buy Limit" | "Sell Limit" {
    const trig = triggerLine.toLowerCase();
    const isBreak = /(bos|break\s+of\s+structure|close\s+(above|below)|break(out)?|breach)/i.test(trig);
    if (isBreak) {
      return type === "long" ? "Buy Stop" : "Sell Stop";
    }
    // pullback/tap style
    const isTap = /(tap|retest|pullback|mitigation|fvg|order\s*block|ob|supply|demand)/i.test(trig);
    if (isTap) {
      return type === "long" ? "Buy Limit" : "Sell Limit";
    }
    return type === "long" ? "Market" : "Market";
  }

  function fixInBlock(src: string, block: string) {
    const dirM = block.match(/^\s*•\s*Direction:\s*(Long|Short)/mi);
    const trigM = block.match(/^\s*•\s*Trigger:\s*([^\n]+)/mi);
    const ordM  = block.match(/^\s*•\s*Order\s*Type:\s*([^\n]+)/mi);
    if (!dirM || !trigM || !ordM) return src;

    const want = desiredOrder(dirM[1].toLowerCase() === "long" ? "long" : "short", trigM[1]);
    const cur  = ordM[1].trim();

    if (cur.toLowerCase() !== want.toLowerCase()) {
      const patched = block.replace(/(^\s*•\s*Order\s*Type:\s*)([^\n]+)/mi, `$1${want}`);
      src = src.replace(block, patched);
    }
    return src;
  }

  let out = text;
  if (qp) out = fixInBlock(out, qp);
  if (o1) out = fixInBlock(out, o1);
  if (o2) out = fixInBlock(out, o2);
  return out;
}

/** NEW: Clarify BOS wording (no numbers needed). */
function _clarifyBOSWording(text: string): string {
  return text
    .replace(/5m:\s*Awaiting\s*BOS\s*for\s*confirmation/gi, "5m: Awaiting 5m BOS (decisive break/close below latest 5m swing low) for confirmation")
    .replace(/BOS\s*needed\s*for\s*confirmation/gi, "BOS needed for confirmation (break/close of recent swing)");
}

/** NEW: Reconcile 4H trend in X-ray with swing cues read from your uploaded charts (Technical View text). */
function _reconcileHTFTrendFromText(text: string): string {
  if (!text) return text;

  // ---- Parse Technical View snippets for 4H and 1H cues (image-first wording) ----
  const techWin = /Technical\s*View[\s\S]{0,1000}?(\n\s*•|\n\s*-\s*|$)/i; // limit scope
  const techBlockMatch = text.match(techWin);
  const techBlock = techBlockMatch ? techBlockMatch[0] : "";

  const tech4hMatch = techBlock.match(/4H\s*:\s*([^\n]+)/i);
  const tech1hMatch = techBlock.match(/1H\s*:\s*([^\n]+)/i);
  const t4 = (tech4hMatch ? String(tech4hMatch[1]) : "").toLowerCase();
  const t1 = (tech1hMatch ? String(tech1hMatch[1]) : "").toLowerCase();

  // 4H desired state
  let d4: "up" | "down" | "range" | null = null;
  if (/(uptrend|higher\s+high|higher\s+low|hh\s*\/?\s*hl|bullish\s+structure)/i.test(t4)) d4 = "up";
  else if (/(downtrend|lower\s+high|lower\s+low|lh\s*\/?\s*ll|bearish\s+structure)/i.test(t4)) d4 = "down";
  else if (/(range|ranging|consolidation|sideways)/i.test(t4)) d4 = "range";

  // 1H desired trend & phase
  let d1: "up" | "down" | "range" | null = null;
  if (/(trend\s*up|uptrend|hh\s*\/?\s*hl|bullish)/i.test(t1)) d1 = "up";
  else if (/(trend\s*down|downtrend|lh\s*\/?\s*ll|bearish)/i.test(t1)) d1 = "down";
  else if (/(range|ranging|consolidation|sideways|equal\s*(highs|lows))/i.test(t1)) d1 = "range";

  // Phase detection (pullback/impulse) from 1H wording; if unclear, infer vs 4H
  let phase: "pullback" | "impulse" | "range-phase" | null = null;
  if (/(pullback|retracement|counter|mean\s*revert)/i.test(t1)) phase = "pullback";
  else if (/(impulse|expansion|continuation|momentum)/i.test(t1)) phase = "impulse";
  else if (d1 === "range") phase = "range-phase";

  if (!phase && d4 && d1 && d1 !== "range") {
    // If 4H up & 1H down ⇒ 1H pullback; if same sign ⇒ impulse
    if ((d4 === "up" && d1 === "down") || (d4 === "down" && d1 === "up")) phase = "pullback";
    else phase = "impulse";
  }

  // ---- Determine 15m structure bucket from document cues ----
  const doc = text.toLowerCase();
  const hasOB   = /(order\s*block|\bob\b|breaker)/i.test(doc);
  const hasFVG  = /(fair\s*value\s*gap|\bfvg\b|imbalance)/i.test(doc);
  const hasTL   = /(trendline|channel|wedge|triangle)/i.test(doc);
  const hasRng  = /\brange\b|rotation|eq\s*of\s*range/i.test(doc);

  let m15Desc = "";
  if (hasOB && hasFVG) m15Desc = "OB+FVG confluence";
  else if (hasOB) m15Desc = "Order Block (OB) anchor";
  else if (hasFVG) m15Desc = "FVG/imbalance anchor";
  else if (hasTL) m15Desc = "Trendline/channel structure";
  else if (hasRng) m15Desc = "Range bounds & EQ rotation";
  else m15Desc = "Execution anchors from 1H (refined on 15m)";

  // ---- Patch X-ray section lines (4H / 1H / 15m / 5m / 1m) ----
  const xraySectRe = /(Detected\s*Structures\s*\(X-ray\):[\s\S]*?)(?=\n\s*Candidate\s*Scores|\n\s*Final\s*Table\s*Summary:|\n\s*Full\s*Breakdown|$)/i;
  const xrayMatch = text.match(xraySectRe);
  if (!xrayMatch) return text;
  let xray = xrayMatch[0];

  const line4hRe = /(^\s*[-•]\s*4H:\s*)([^\n]*)/mi;
  const line1hRe = /(^\s*[-•]\s*1H:\s*)([^\n]*)/mi;
  const line15Re = /(^\s*[-•]\s*15m:\s*)([^\n]*)/mi;
  const line5mRe = /(^\s*[-•]\s*5m\s*\(if\s*used\)\s*:\s*|^\s*[-•]\s*5m:\s*)([^\n]*)/mi;
  const line1mRe = /(^\s*[-•]\s*1m\s*\(if\s*used\)\s*:\s*|^\s*[-•]\s*1m:\s*)([^\n]*)/mi;

  // 4H normalization
  if (d4) {
    const desc4 =
      d4 === "up"   ? "Uptrend (HH/HL), bullish structure"
    : d4 === "down" ? "Downtrend (LH/LL), bearish structure"
    :                 "Larger range / consolidation";
    if (line4hRe.test(xray)) xray = xray.replace(line4hRe, (_m, p1) => `${p1}${desc4}`);
  }

  // 1H normalization w/ phase
  if (d1) {
    const ph = phase || (d1 === "range" ? "range-phase" : "impulse");
    const desc1 =
      d1 === "up"   ? `Trend Up (${ph})`
    : d1 === "down" ? `Trend Down (${ph})`
    :                 "Range (mark RH/RL & EQ)";
    if (line1hRe.test(xray)) {
      xray = xray.replace(line1hRe, (_m, p1) => `${p1}${desc1}`);
    } else {
      // If missing, insert a normalized 1H line after 4H
      xray = xray.replace(/(^\s*[-•]\s*4H:[^\n]*\n)/mi, ($0) => $0 + `• 1H: ${desc1}\n`);
    }
  }

  // 15m structure description
  if (line15Re.test(xray)) {
    xray = xray.replace(line15Re, (_m, p1) => `${p1}${m15Desc}`);
  } else {
    // Insert a 15m line after 1H if absent
    if (line1hRe.test(xray)) {
      xray = xray.replace(line1hRe, (m) => m + `\n• 15m: ${m15Desc}`);
    }
  }

  // 5m/1m confirmation wording (timing only; explicit BOS/CHOCH)
  const fiveDesc = "awaiting BOS (decisive break/close of latest 5m swing) for timing";
  const oneDesc  = "awaiting CHOCH/BOS micro-shift for entry timing";
  if (line5mRe.test(xray)) xray = xray.replace(line5mRe, (_m, p1) => `${p1}${fiveDesc}`);
  if (line1mRe.test(xray)) xray = xray.replace(line1mRe, (_m, p1) => `${p1}${oneDesc}`);

  // Apply patched X-ray back into text
  return text.replace(xrayMatch[0], xray);
}

/** Ensure Option 1 aligns with fundamentals when possible; also prefers confirmation-based option when Option 1 uses Limit but trigger says BOS. */
function enforceOptionOrderByBias(text: string, fundamentalsSign: number): string {
  if (!text) return text;

  const { qp, o1, o2, RE_O1, RE_O2 } = _pickBlocks(text);
  if (!o1 || !o2) return _normalizeOrderTypeByTrigger(text); // still fix order types

  const d1 = _dirSignFromBlock(o1);
  const d2 = _dirSignFromBlock(o2);

  const o1Trig = (o1.match(/^\s*•\s*Trigger:\s*([^\n]+)/mi)?.[1] || "").toLowerCase();
  const o2Trig = (o2.match(/^\s*•\s*Trigger:\s*([^\n]+)/mi)?.[1] || "").toLowerCase();
  const o1Ord  = (o1.match(/^\s*•\s*Order\s*Type:\s*([^\n]+)/mi)?.[1] || "").toLowerCase();
  const o2Ord  = (o2.match(/^\s*•\s*Order\s*Type:\s*([^\n]+)/mi)?.[1] || "").toLowerCase();

  const trigImpliesBOS = (s: string) => /(bos|break\s+of\s+structure|close\s+(below|above)|breakout|breach)/i.test(s);

  // Fix Order Type mismatches to match triggers first
  let out = _normalizeOrderTypeByTrigger(text);

  // Re-pick post-normalization blocks for swap logic
  const b = _pickBlocks(out);
  const O1 = b.o1, O2 = b.o2;
  if (!O1 || !O2) return out;

  const O1_trig = (O1.match(/^\s*•\s*Trigger:\s*([^\n]+)/mi)?.[1] || "").toLowerCase();
  const O2_trig = (O2.match(/^\s*•\s*Trigger:\s*([^\n]+)/mi)?.[1] || "").toLowerCase();
  const O1_dir  = _dirSignFromBlock(O1);
  const O2_dir  = _dirSignFromBlock(O2);

  const o1Aligned = fundamentalsSign !== 0 && O1_dir !== 0 && Math.sign(fundamentalsSign) === Math.sign(O1_dir);
  const o2Aligned = fundamentalsSign !== 0 && O2_dir !== 0 && Math.sign(fundamentalsSign) === Math.sign(O2_dir);

  // If Option 1 requires BOS but is a pullback/limit-style (or simply less robust than O2 breakout), prefer O2
  const o1NeedsBOS = trigImpliesBOS(O1_trig);
  const o2NeedsBOS = trigImpliesBOS(O2_trig);

  const preferO2BecauseConfirmation = (o1NeedsBOS && /limit/i.test(O1)) || (o2NeedsBOS && !o1NeedsBOS);

  if ((!o1Aligned && o2Aligned) || preferO2BecauseConfirmation) {
    // swap blocks
    let swapped = out.replace(RE_O2, "__O2_SWAP_MARKER__");
    swapped = swapped.replace(RE_O1, O2);
    swapped = swapped.replace("__O2_SWAP_MARKER__", O1);
    return swapped;
  }

  return out;
}

/** Ensure Option 2 is a distinct strategy. */
async function enforceDistinctAlternative(model: string, instrument: string, text: string) {
  const m1 = text.match(/(Option\s*1[\s\S]*?)(?=\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i);
  const m2 = text.match(/(Option\s*2[\s\S]*?)(?=\n\s*Full\s*Breakdown|$)/i);
  if (!m1 || !m2) return text;

  const o1 = m1[0], o2 = m2[0];
  const t1 = (o1.match(/^\s*•\s*Trigger:\s*(.+)$/mi)?.[1] || "").toLowerCase();
  const t2 = (o2.match(/^\s*•\s*Trigger:\s*(.+)$/mi)?.[1] || "").toLowerCase();
  if (!t1 || !t2) return text;

  const buckets: Record<string, RegExp> = {
    sweep: /(sweep|liquidity|raid|stop\s*hunt|bos|choch)/i,
    ob_fvg: /(order\s*block|\bob\b|fvg|fair\s*value|breaker)/i,
    tl_break: /(trendline|channel|wedge|triangle)/i,
    range: /(range|rotation|mean\s*reversion|eq\s*of\s*range)/i,
    vwap: /\bvwap\b/i,
    momentum: /(ignition|breakout|squeeze|bollinger|macd|divergence)/i,
  };
  function bucketOf(s: string): string | null { for (const [k, re] of Object.entries(buckets)) if (re.test(s)) return k; return null; }
  const b1 = bucketOf(t1);
  const b2 = bucketOf(t2);

  const tooSimilar = (b1 && b2 && b1 === b2) || t1.replace(/\s+/g,"") === t2.replace(/\s+/g,"");
  if (!tooSimilar) return text;

  const sys = "Rewrite ONLY the 'Option 2 (Alternative)' block so it is a DISTINCT strategy from Option 1, with a different trigger type and explicit timeframes.";
  const rules = [
    "Choose a different play from the library (e.g., if Option 1 is sweep/BOS, make Option 2 a TL break+retest, range rotation, OB/FVG pullback, VWAP, or momentum breakout).",
    "Keep direction if justified by HTF, but change the strategy & Trigger wording.",
    "Include Direction, Order Type, Trigger (with timeframes), Entry (zone/single), Stop Loss, TP1/TP2, Conviction, Why this alternative."
  ].join("\n- ");
  const out = await callOpenAI(model, [
    { role: "system", content: "Return ONLY a full, corrected 'Option 2 (Alternative)' block. Do not alter other sections." },
    { role: "user", content: `Instrument: ${instrument}\n\nOPTION 1:\n${o1}\n\nOPTION 2 (to be rewritten):\n${o2}\n\nRules:\n- ${rules}` }
  ]);

  if (!out || out.length < 30) return text;
  return text.replace(m2[0], out.trim());
}

// ---------- Live price ----------

async function fetchLivePrice(pair: string): Promise<number | null> {
  if (TD_KEY) {
    try {
      const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
      const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&dp=5`;
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1800) });
      const j: any = await r.json().catch(() => ({}));
      const p = Number(j?.price);
      if (isFinite(p) && p > 0) return p;
    } catch {}
  }
  if (FH_KEY) {
    try {
      const sym = `OANDA:${pair.slice(0, 3)}_${pair.slice(3)}`;
      const to = Math.floor(Date.now() / 1000);
      const from = to - 60 * 60 * 3;
      const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(sym)}&resolution=15&from=${from}&to=${to}&token=${FH_KEY}`;
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1800) });
      const j: any = await r.json().catch(() => ({}));
      const c = Array.isArray(j?.c) ? j.c : [];
      const last = Number(c[c.length - 1]);
      if (isFinite(last) && last > 0) return last;
    } catch {}
  }
  if (POLY_KEY) {
    try {
      const ticker = `C:${pair}`;
      const to = new Date();
      const from = new Date(to.getTime() - 60 * 60 * 1000);
      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=desc&limit=1&apiKey=${POLY_KEY}`;
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1500) });
      const j: any = await r.json().catch(() => ({}));
      const res = Array.isArray(j?.results) ? j.results[0] : null;
      const last = Number(res?.c);
      if (isFinite(last) && last > 0) return last;
    } catch {}
  }
  try {
    const S = await fetchSeries15(pair);
    const last = S?.c?.[S.c.length - 1];
    if (isFinite(Number(last)) && Number(last) > 0) return Number(last);
  } catch {}
  return null;
}

// ---------- Provenance footer ----------
function buildServerProvenanceFooter(args: {
  headlines_provider: string | null;
  calendar_status: "api" | "image-ocr" | "unavailable";
  calendar_provider: string | null;
  csm_time: string | null;
  extras?: Record<string, any>;
}) {
  const lines = [
    "\n---",
    "Data Provenance (server — authoritative):",
    `• Headlines: ${args.headlines_provider || "unknown"}`,
    `• Calendar: ${args.calendar_status}${args.calendar_provider ? ` (${args.calendar_provider})` : ""}`,
    `• Sentiment CSM timestamp: ${args.csm_time || "n/a"}`,
    args.extras ? `• Meta: ${JSON.stringify(args.extras)}` : undefined,
    "---\n",
  ].filter(Boolean);
  return lines.join("\n");
}

// ---------- Handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    const urlMode = String((req.query.mode as string) || "").toLowerCase();
    let mode: "full" | "fast" | "expand" = urlMode === "fast" ? "fast" : urlMode === "expand" ? "expand" : "full";
    const debugQuery = String(req.query.debug || "").trim() === "1";

    // ---------- expand ----------
    if (mode === "expand") {
      const modelExpand = pickModelFromFields(req);
      const cacheKey = String(req.query.cache || "").trim();
      const c = getCache(cacheKey);
      if (!c) return res.status(400).json({ ok: false, reason: "Expand failed: cache expired or not found." });

      const dateStr = new Date().toISOString().slice(0, 10);
      const calAdv = await fetchCalendarForAdvisory(req, c.instrument);
      const provHint = { headlines_present: !!c.headlinesText, calendar_status: c.calendar ? "image-ocr" : (calAdv.status || "unavailable") };

      const messages = messagesFull({
  instrument: c.instrument, dateStr,
  m15: c.m15, h1: c.h1, h4: c.h4, m5: c.m5 || null, m1: null,
  calendarDataUrl: c.calendar || undefined,
  headlinesText: c.headlinesText || undefined,
  sentimentText: c.sentimentText || undefined,
  calendarAdvisory: { warningMinutes: calAdv.warningMinutes, biasNote: calAdv.biasNote, advisoryText: calAdv.advisoryText, evidence: calAdv.evidence || [] },
  provenance: provHint,
  scalping: false,
  scalpingHard: false
});


      let text = await callOpenAI(modelExpand, messages);
      text = await enforceQuickPlan(modelExpand, c.instrument, text);
      text = await enforceOption1(modelExpand, c.instrument, text);
      text = await enforceOption2(modelExpand, c.instrument, text);

      // Visibility and stamping
      text = ensureCalendarVisibilityInQuickPlan(text, { instrument: c.instrument, preReleaseOnly: false, biasLine: calAdv.text || null });
      const usedM5 = !!c.m5 && /(\b5m\b|\b5\-?min|\b5\s*minute)/i.test(text);
      text = stampM5Used(text, usedM5);

      const footer = buildServerProvenanceFooter({
        headlines_provider: "expand-uses-stage1",
        calendar_status: c.calendar ? "image-ocr" : (calAdv?.status || "unavailable"),
        calendar_provider: c.calendar ? "image-ocr" : calAdv?.provider || null,
        csm_time: null,
        extras: { vp_version: VP_VERSION, model: modelExpand, mode: "expand" },
      });
      text = `${text}\n${footer}`;

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ok: true, text, meta: { instrument: c.instrument, cacheKey, model: modelExpand, vp_version: VP_VERSION } });
    }

    // ---------- multipart ----------
    if (!isMultipart(req)) {
      return res.status(400).json({ ok: false, reason: "Use multipart/form-data with files: m15, h1, h4 and optional 'calendar'/'m5'/'m1'. Or pass m15Url/h1Url/h4Url and optional 'calendarUrl'/'m5Url'/'m1Url'. Include 'instrument'." });
    }

    const { fields, files } = await parseMultipart(req);

    const MODEL = pickModelFromFields(req, fields);
    const instrument = String(fields.instrument || fields.code || "EURUSD").toUpperCase().replace(/\s+/g, "");
    const requestedMode = String(fields.mode || "").toLowerCase();
    if (requestedMode === "fast") mode = "fast";

    // NEW: scalping toggles (default off). Safe: when off, behavior is unchanged.
const scalpingRaw = String(pickFirst(fields.scalping) || "").trim().toLowerCase();
const scalping =
  scalpingRaw === "1" || scalpingRaw === "true" || scalpingRaw === "on" || scalpingRaw === "yes";

const scalpingHardRaw = String(pickFirst(fields.scalping_hard) || "").trim().toLowerCase();
const scalpingHard =
  scalpingHardRaw === "1" || scalpingHardRaw === "true" || scalpingHardRaw === "on" || scalpingHardRaw === "yes";


    // debug toggle
    const debugField = String(pickFirst(fields.debug) || "").trim() === "1";
    const debugOCR = debugQuery || debugField;

    // files + urls
    const m1f = pickFirst(files.m1);
    const m5f = pickFirst(files.m5);
    const m15f = pickFirst(files.m15);
    const h1f = pickFirst(files.h1);
    const h4f = pickFirst(files.h4);
    const calF = pickFirst(files.calendar);

    const m1Url = String(pickFirst(fields.m1Url) || "").trim();
    const m5Url = String(pickFirst(fields.m5Url) || "").trim();
    const m15Url = String(pickFirst(fields.m15Url) || "").trim();
    const h1Url = String(pickFirst(fields.h1Url) || "").trim();
    const h4Url = String(pickFirst(fields.h4Url) || "").trim();
    const calendarUrlField = String(pickFirst(fields.calendarUrl) || "").trim();

    const [m1FromFile, m5FromFile, m15FromFile, h1FromFile, h4FromFile, calFromFile] = await Promise.all([
      m1f ? fileToDataUrl(m1f) : Promise.resolve(null),
      m5f ? fileToDataUrl(m5f) : Promise.resolve(null),
      fileToDataUrl(m15f), fileToDataUrl(h1f), fileToDataUrl(h4f),
      calF ? fileToDataUrl(calF) : Promise.resolve(null),
    ]);
    const [m1FromUrl, m5FromUrl, m15FromUrl, h1FromUrl, h4FromUrl, calFromUrl] = await Promise.all([
      m1FromFile ? Promise.resolve(null) : linkToDataUrl(m1Url),
      m5FromFile ? Promise.resolve(null) : linkToDataUrl(m5Url),
      m15FromFile ? Promise.resolve(null) : linkToDataUrl(m15Url),
      h1FromFile ? Promise.resolve(null) : linkToDataUrl(h1Url),
      h4FromFile ? Promise.resolve(null) : linkToDataUrl(h4Url),
      calFromFile ? Promise.resolve(null) : linkToDataUrl(calendarUrlField),
    ]);

    const m1 = m1FromFile || m1FromUrl || null;
    const m5 = m5FromFile || m5FromUrl || null;
    const m15 = m15FromFile || m15FromUrl;
    const h1 = h1FromFile || h1FromUrl;
    const h4 = h4FromFile || h4FromUrl;
    const calUrlOrig = calFromFile || calFromUrl || null;

    if (!m15 || !h1 || !h4) {
      return res.status(400).json({ ok: false, reason: "Provide all three charts: m15, h1, h4 — either files or TV/Gyazo image links. (5m/1m optional)" });
    }

    // Hard scalping requires both 5m and 1m charts.
if (scalpingHard && (!m5 || !m1)) {
  return res.status(400).json({ ok: false, reason: "Hard scalping requires BOTH 5m and 1m charts. Please upload 5m + 1m along with 15m/1H/4H." });
}

    // Headlines
    let headlineItems: AnyHeadline[] = [];
    let headlinesText: string | null = null;
    let headlinesProvider: string = "unknown";
    const rawHeadlines = pickFirst(fields.headlinesJson) as string | null;
    if (rawHeadlines) {
      try {
        const parsed = JSON.parse(String(rawHeadlines));
        if (Array.isArray(parsed)) {
          headlineItems = parsed.slice(0, 12);
          headlinesText = headlinesToPromptLines(headlineItems, 6);
          headlinesProvider = "client";
        }
      } catch {}
    }
    if (!headlinesText) {
      const viaServer = await fetchedHeadlinesViaServer(req, instrument);
      headlineItems = viaServer.items;
      headlinesText = viaServer.promptText;
      headlinesProvider = viaServer.provider || "unknown";
    }
    const hBias = computeHeadlinesBias(headlineItems);

    // Calendar (OCR-first STRICT pre-release handling, fallback to API)
    let calendarStatus: "image-ocr" | "api" | "unavailable" = "unavailable";
    let calendarProvider: string | null = null;
    let calendarText: string | null = null;
    let calendarEvidence: string[] = [];
    let warningMinutes: number | null = null;
    let biasNote: string | null = null;
    let advisoryText: string | null = null;
    let debugRows: any[] | null = null;
    let preReleaseOnly = false;

    let calDataUrlForPrompt: string | null = calUrlOrig;

    if (calUrlOrig) {
      const ocr = await ocrCalendarFromImage(MODEL, calUrlOrig).catch(() => null);
      if (ocr && Array.isArray(ocr.items)) {
        const relCurs = new Set(relevantCurrenciesFromInstrument(instrument));
        const usableForInstr = (ocr.items || []).some((r) => relCurs.has(String(r?.currency || "")) && hasUsableFields(r));
        calendarStatus = "image-ocr";
        calendarProvider = "image-ocr";
        if (usableForInstr) {
          const analyzed = analyzeCalendarOCR(ocr, instrument);
          calendarText = analyzed.biasLine;                    // pre-release line or bias line
          calendarEvidence = analyzed.evidenceLines;           // only post-result rows (≤72h)
          warningMinutes = analyzed.warningMinutes;
          biasNote = analyzed.preReleaseOnly ? null : analyzed.biasNote; // no biasNote if pre-release
          preReleaseOnly = analyzed.preReleaseOnly;
          debugRows = analyzed.rowsForDebug || null;
          calDataUrlForPrompt = calUrlOrig; // keep image in prompt
          if (preReleaseOnly) {
            advisoryText = calendarText; // surface pre-release line in prompt too
          }
        } else {
          calendarText = `Calendar provided, but no relevant info for ${instrument}.`;
          calDataUrlForPrompt = null;
        }
      } else {
        const calAdv = await fetchCalendarForAdvisory(req, instrument);
        calendarStatus = calAdv.status;
        calendarProvider = calAdv.provider;
        calendarText = calAdv.text;
        advisoryText = calAdv.advisoryText || null;
        calendarEvidence = calAdv.evidence || [];
        warningMinutes = calAdv.warningMinutes;
        biasNote = calAdv.biasNote;
        calDataUrlForPrompt = null;
      }
    } else {
      const calAdv = await fetchCalendarForAdvisory(req, instrument);
      calendarStatus = calAdv.status;
      calendarProvider = calAdv.provider;
      calendarText = calAdv.text;
      calendarEvidence = calAdv.evidence || [];
      warningMinutes = calAdv.warningMinutes;
      biasNote = calAdv.biasNote;
      calDataUrlForPrompt = null;
    }

    // Sentiment + price
    let csm: CsmSnapshot;
    try { csm = await getCSM(); }
    catch (e: any) { return res.status(503).json({ ok: false, reason: `CSM unavailable: ${e?.message || "fetch failed"}.` }); }
    const cotCue = detectCotCueFromHeadlines(headlineItems);
    const { text: sentimentText } = sentimentSummary(csm, cotCue, hBias);
    const livePrice = await fetchLivePrice(instrument);
    const dateStr = new Date().toISOString().slice(0, 10);

    // Composite bias (provenance only)
    const composite = computeCompositeBias({
      instrument,
      calendarBiasNote: biasNote,
      headlinesBias: hBias,
      csm,
      warningMinutes
    });

   const provForModel = {
  headlines_present: !!headlinesText,
  calendar_status: calendarStatus,
  composite,
  fundamentals_hint: {
    calendar_sign: parseInstrumentBiasFromNote(biasNote),
    headlines_label: hBias.label,
    csm_diff: computeCSMInstrumentSign(csm, instrument).zdiff,
    cot_cue_present: !!cotCue
  },
  proximity_flag: warningMinutes != null ? 1 : 0,
  scalping_mode: !!scalping,
  scalping_hard_mode: !!scalpingHard
};

   // ---------- Stage-1 (fast) ----------
if (mode === "fast") {
  const messages = messagesFastStage1({
    instrument, dateStr, m15, h1, h4, m5, m1,
    calendarDataUrl: calDataUrlForPrompt || undefined,
    calendarText: (!calDataUrlForPrompt && calendarText) ? calendarText : undefined,
    headlinesText: headlinesText || undefined,
    sentimentText: sentimentText,
    calendarAdvisory: { warningMinutes, biasNote, advisoryText, evidence: calendarEvidence || [], debugRows: debugOCR ? debugRows || [] : [], preReleaseOnly },
    provenance: provForModel,
    scalping,
    scalpingHard
  });
  if (livePrice) { (messages[0] as any).content = (messages[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice};`; }

  let text = await callOpenAI(MODEL, messages);
  let aiMeta = extractAiMeta(text) || {};
  if (livePrice && (aiMeta.currentPrice == null || !isFinite(Number(aiMeta.currentPrice)))) aiMeta.currentPrice = livePrice;

  const bad = invalidOrderRelativeToPrice(aiMeta);
  if (bad) {
    text = await enforceOption1(MODEL, instrument, text);
    text = await enforceOption2(MODEL, instrument, text);
    aiMeta = extractAiMeta(text) || aiMeta;
  }

  text = await enforceQuickPlan(MODEL, instrument, text);
  text = await enforceOption1(MODEL, instrument, text);
  text = await enforceOption2(MODEL, instrument, text);

  text = ensureCalendarVisibilityInQuickPlan(text, { instrument, preReleaseOnly, biasLine: calendarText });

  const usedM5 = !!m5 && /(\b5m\b|\b5\-?min|\b5\s*minute)/i.test(text);
  text = stampM5Used(text, usedM5);
  const usedM1 = !!m1 && /(\b1m\b|\b1\-?min|\b1\s*minute)/i.test(text);
  text = stampM1Used(text, usedM1);

  // === Independent Fundamentals Snapshot (Calendar, Headlines, CSM, COT) ===
  const calendarSignFast = parseInstrumentBiasFromNote(biasNote);
  const fundamentalsSnapshot = computeIndependentFundamentals({
    instrument,
    calendarSign: calendarSignFast,
    headlinesBias: hBias,
    csm,
    cotCue,
    warningMinutes
  });

  // Inject standardized Fundamentals block under Full Breakdown (fast mode too)
  text = ensureFundamentalsSnapshot(text, {
    instrument,
    snapshot: fundamentalsSnapshot,
    preReleaseOnly,
    calendarLine: calendarText || null
  });

  // Consistency pass on alignment wording (neutral ⇒ "Match (Fundamentals neutral — trade managed by technicals)")
  text = applyConsistencyGuards(text, {
    fundamentalsSign: fundamentalsSnapshot.final.sign as -1 | 0 | 1
  });

  // === Order Option 1/2 to align with Final Fundamental Bias ===
  text = enforceOptionOrderByBias(text, fundamentalsSnapshot.final.sign);


// === HTF swing reconciliation + Tournament & Trigger Enforcement ===
// 1) Clarify BOS wording and reconcile 4H X-ray with swing cues from your uploaded charts
text = _clarifyBOSWording(text);
text = _reconcileHTFTrendFromText(text);

// 2) Ensure ≥5 candidates with ≥3 non-sweep/BOS; fix generic triggers with timeframe-specific wording
text = await enforceTournamentDiversity(MODEL, instrument, text);
text = await enforceTriggerSpecificity(MODEL, instrument, text);

// 3) Scalp guardrails + news proximity note
text = enforceScalpHardStopLossLines(text, scalpingHard);
text = enforceScalpRiskLines(text, scalping, scalpingHard);
text = ensureNewsProximityNote(text, warningMinutes, instrument);


  // Ensure Full Breakdown has all required subsections and Final Table Summary exists
  text = await enforceFullBreakdownSkeleton(MODEL, instrument, text);
  text = enforceFinalTableSummary(text, instrument);

  // === Conviction (0–100) based on T & F, then fill table row ===
  text = computeAndInjectConviction(text, {
    fundamentals: fundamentalsSnapshot,
    proximityFlag: warningMinutes != null
  });
  text = fillFinalTableSummaryRow(text, instrument);

  // Ensure Full Breakdown has all required subsections and Final Table Summary exists
  text = await enforceFullBreakdownSkeleton(MODEL, instrument, text);
  text = enforceFinalTableSummary(text, instrument);

  // Ensure ai_meta exists and is enriched with runtime fields
  const lowFundReliability =
    preReleaseOnly ||
    parseInstrumentBiasFromNote(biasNote) === 0 ||
    (warningMinutes != null);

   const aiPatchFast = {
    version: "vp-AtoL-1",
    mode,
    vwap_used: /vwap/i.test(text),
    time_stop_minutes: scalpingHard ? 15 : (scalping ? 20 : undefined),
    max_attempts: scalpingHard ? 2 : (scalping ? 3 : undefined),
    currentPrice: livePrice ?? undefined,
    fundamentals: {
      calendar: { sign: fundamentalsSnapshot.components.calendar.sign, line: calendarText || null },
      headlines: { label: fundamentalsSnapshot.components.headlines.label, avg: hBias.avg ?? null },
      csm: { diff: fundamentalsSnapshot.components.csm.diff },
      cot: { sign: fundamentalsSnapshot.components.cot.sign, detail: fundamentalsSnapshot.components.cot.detail },
      final: {
        score: Math.round(fundamentalsSnapshot.final.score),
        label: fundamentalsSnapshot.final.label,
        sign: fundamentalsSnapshot.final.sign
      },
      reliability: lowFundReliability ? "low" : "normal"
    },
    proximity: { highImpactMins: warningMinutes ?? null },
    compliance: {
      option2Distinct: (() => {
        try {
          const { o1, o2 } = _pickBlocks(text);
          const t1 = (o1.match(/^\s*•\s*Trigger:\s*(.+)$/mi)?.[1] || "").toLowerCase();
          const t2 = (o2.match(/^\s*•\s*Trigger:\s*(.+)$/mi)?.[1] || "").toLowerCase();
          if (!t1 || !t2) return false;
          const buckets: Record<string, RegExp> = {
            sweep: /(sweep|liquidity|raid|stop\s*hunt|bos\b|choch\b)/i,
            ob_fvg: /(order\s*block|\bob\b|fvg|fair\s*value|breaker)/i,
            tl_break: /(trendline|channel|wedge|triangle)/i,
            range: /(range\s*rotation|range\b|mean\s*reversion|eq\s*of\s*range)/i,
            vwap: /\bvwap\b/i,
            momentum: /(ignition|breakout|squeeze|bollinger|macd|divergence)/i,
          };
          const bucketOf = (s: string) => {
            for (const [k, re] of Object.entries(buckets)) if (re.test(s)) return k;
            return "other";
          };
          return bucketOf(t1) !== bucketOf(t2) || t1.replace(/\s+/g,"") !== t2.replace(/\s+/g,"");
        } catch { return false; }
      })(),
      tournamentMin: 5,
      nonSweepMin: 3
    },
    vp_version: VP_VERSION
  };

  text = ensureAiMetaBlock(text, Object.fromEntries(Object.entries(aiPatchFast).filter(([,v]) => v !== undefined)));

  aiMeta = extractAiMeta(text) || aiMeta;

  // Normalize conflicting Order Type for primary plan if needed
  if (aiMeta && invalidOrderRelativeToPrice(aiMeta)) {
    text = normalizeOrderTypeLines(text, aiMeta);
  }

  // Ensure Option 2 is a truly distinct strategy
  text = await enforceDistinctAlternative(MODEL, instrument, text);

  // Cache & provenance footer
  const cacheKey = setCache({ instrument, m5: m5 || null, m15, h1, h4, calendar: calDataUrlForPrompt || null, headlinesText: headlinesText || null, sentimentText });

  const footer = buildServerProvenanceFooter({
    headlines_provider: headlinesProvider || "unknown",
    calendar_status: calendarStatus,
    calendar_provider: calendarProvider,
    csm_time: csm.tsISO,
    extras: { vp_version: VP_VERSION, model: MODEL, mode, composite_cap: composite.cap, composite_align: composite.align, composite_conflict: composite.conflict, pre_release: preReleaseOnly, debug_ocr: !!debugOCR, scalping_mode: scalping, scalping_hard_mode: scalpingHard },
  });
  text = `${text}\n${footer}`;


  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    text,
    meta: {
      instrument, mode, cacheKey, vp_version: VP_VERSION, model: MODEL,
      sources: {
        headlines_used: Math.min(6, Array.isArray(headlineItems) ? headlineItems.length : 0),
        headlines_instrument: instrument,
        headlines_provider: headlinesProvider || "unknown",
        calendar_used: calendarStatus !== "unavailable",
        calendar_status: calendarStatus,
        calendar_provider: calendarProvider,
        csm_used: true,
        csm_time: csm.tsISO,
      },
      aiMeta,
    },
  });
}


    // ---------- FULL ----------
    const messages = messagesFull({
  instrument, dateStr, m15, h1, h4, m5, m1,
  calendarDataUrl: calDataUrlForPrompt || undefined,
  calendarText: (!calDataUrlForPrompt && calendarText) ? calendarText : undefined,
  headlinesText: headlinesText || undefined,
  sentimentText,
  calendarAdvisory: { warningMinutes, biasNote, advisoryText, evidence: calendarEvidence || [], debugRows: debugOCR ? debugRows || [] : [], preReleaseOnly },
  provenance: provForModel,
  scalping,
  scalpingHard
});

    if (livePrice) { (messages[0] as any).content = (messages[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice};`; }

    let textFull = await callOpenAI(MODEL, messages);
    let aiMetaFull = extractAiMeta(textFull) || {};

    if (livePrice && (aiMetaFull.currentPrice == null || !isFinite(Number(aiMetaFull.currentPrice)))) aiMetaFull.currentPrice = livePrice;

    textFull = await enforceQuickPlan(MODEL, instrument, textFull);
    textFull = await enforceOption1(MODEL, instrument, textFull);
    textFull = await enforceOption2(MODEL, instrument, textFull);

    // Ensure calendar visibility in Quick Plan
    textFull = ensureCalendarVisibilityInQuickPlan(textFull, { instrument, preReleaseOnly, biasLine: calendarText });

    // Stamp 5M/1M execution if used
    const usedM5Full = !!m5 && /(\b5m\b|\b5\-?min|\b5\s*minute)/i.test(textFull);
    textFull = stampM5Used(textFull, usedM5Full);
    const usedM1Full = !!m1 && /(\b1m\b|\b1\-?min|\b1\s*minute)/i.test(textFull);
    textFull = stampM1Used(textFull, usedM1Full);

        // === Independent Fundamentals Snapshot (Calendar, Headlines, CSM, COT) ===
  const calendarSignFull = parseInstrumentBiasFromNote(biasNote);
   const fundamentalsSnapshotFull = computeIndependentFundamentals({
    instrument,
    calendarSign: calendarSignFull,
    headlinesBias: hBias,
    csm,
    cotCue,
    warningMinutes
  });

  // Inject standardized Fundamentals block under Full Breakdown
  textFull = ensureFundamentalsSnapshot(textFull, {
    instrument,
    snapshot: fundamentalsSnapshotFull,
    preReleaseOnly,
    calendarLine: calendarText || null
  });

  // Consistency pass on alignment wording (run AFTER fundamentals snapshot so neutral forces Match)
  textFull = applyConsistencyGuards(textFull, {
    fundamentalsSign: fundamentalsSnapshotFull.final.sign as -1 | 0 | 1
  });


  // === Order Option 1/2 to align with Final Fundamental Bias ===
  textFull = enforceOptionOrderByBias(textFull, fundamentalsSnapshotFull.final.sign);

  // === HTF swing reconciliation + Tournament & Trigger Enforcement ===
// 1) Clarify BOS wording and reconcile 4H X-ray with swing cues from your uploaded charts
textFull = _clarifyBOSWording(textFull);
textFull = _reconcileHTFTrendFromText(textFull);

// 2) Tournament diversity + trigger specificity
textFull = await enforceTournamentDiversity(MODEL, instrument, textFull);
textFull = await enforceTriggerSpecificity(MODEL, instrument, textFull);

// 3) Scalp guardrails + news proximity
textFull = enforceScalpHardStopLossLines(textFull, scalpingHard);
textFull = enforceScalpRiskLines(textFull, scalping, scalpingHard);
textFull = ensureNewsProximityNote(textFull, warningMinutes, instrument);


  // Ensure Full Breakdown skeleton + Final Table Summary
  textFull = await enforceFullBreakdownSkeleton(MODEL, instrument, textFull);
  textFull = enforceFinalTableSummary(textFull, instrument);

  // === Conviction (0–100) based on T & F, then fill table row ===
  textFull = computeAndInjectConviction(textFull, {
    fundamentals: fundamentalsSnapshotFull,
    proximityFlag: warningMinutes != null
  });
  textFull = fillFinalTableSummaryRow(textFull, instrument);

  // Ensure Full Breakdown skeleton + Final Table Summary
  textFull = await enforceFullBreakdownSkeleton(MODEL, instrument, textFull);
  textFull = enforceFinalTableSummary(textFull, instrument);

  // Ensure ai_meta exists and is enriched with runtime fields
  const lowFundReliabilityFull =
    preReleaseOnly ||
    parseInstrumentBiasFromNote(biasNote) === 0 ||
    (warningMinutes != null);

    const aiPatchFull = {
    version: "vp-AtoL-1",
    mode,
    vwap_used: /vwap/i.test(textFull),
    time_stop_minutes: scalpingHard ? 15 : (scalping ? 20 : undefined),
    max_attempts: scalpingHard ? 2 : (scalping ? 3 : undefined),
    currentPrice: livePrice ?? undefined,
    fundamentals: {
      calendar: { sign: fundamentalsSnapshotFull.components.calendar.sign, line: calendarText || null },
      headlines: { label: fundamentalsSnapshotFull.components.headlines.label, avg: hBias.avg ?? null },
      csm: { diff: fundamentalsSnapshotFull.components.csm.diff },
      cot: { sign: fundamentalsSnapshotFull.components.cot.sign, detail: fundamentalsSnapshotFull.components.cot.detail },
      final: {
        score: Math.round(fundamentalsSnapshotFull.final.score),
        label: fundamentalsSnapshotFull.final.label,
        sign: fundamentalsSnapshotFull.final.sign
      },
      reliability: lowFundReliabilityFull ? "low" : "normal"
    },
    proximity: { highImpactMins: warningMinutes ?? null },
    vp_version: VP_VERSION
  };

  textFull = ensureAiMetaBlock(textFull, Object.fromEntries(Object.entries(aiPatchFull).filter(([,v]) => v !== undefined)));

    aiMetaFull = extractAiMeta(textFull) || aiMetaFull;

    // Normalize conflicting Order Type for primary plan if needed
    if (aiMetaFull && invalidOrderRelativeToPrice(aiMetaFull)) {
      textFull = normalizeOrderTypeLines(textFull, aiMetaFull);
    }

    // Ensure Option 2 is a truly distinct strategy
    textFull = await enforceDistinctAlternative(MODEL, instrument, textFull);


    // Provenance footer
    const footer = buildServerProvenanceFooter({
      headlines_provider: headlinesProvider || "unknown",
      calendar_status: calendarStatus,
      calendar_provider: calendarProvider,
      csm_time: csm.tsISO,
      extras: { vp_version: VP_VERSION, model: MODEL, mode, composite_cap: composite.cap, composite_align: composite.align, composite_conflict: composite.conflict, pre_release: preReleaseOnly, debug_ocr: !!debugOCR, scalping_mode: scalping, scalping_hard_mode: scalpingHard },
    });
    textFull = `${textFull}\n${footer}`;

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text: textFull,
      meta: {
        instrument, mode, vp_version: VP_VERSION, model: MODEL,
        sources: {
          headlines_used: Math.min(6, Array.isArray(headlineItems) ? headlineItems.length : 0),
          headlines_instrument: instrument,
          headlines_provider: headlinesProvider || "unknown",
          calendar_used: calendarStatus !== "unavailable",
          calendar_status: calendarStatus,
          calendar_provider: calendarProvider,
          csm_used: true,
          csm_time: csm.tsISO,
        },
        aiMeta: aiMetaFull,
      },
    });

  } catch (err: any) {
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}
