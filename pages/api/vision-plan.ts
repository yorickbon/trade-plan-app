// /pages/api/vision-plan.ts
/**
 * Professional FX Trading Analysis API
 * - Multi-timeframe institutional analysis (4H/1H/15M + optional 5M/1M)
 * - Strategy tournament with 5 institutional approaches
 * - OCR-based economic calendar analysis
 * - Real-time price validation and R:R enforcement
 * - Professional structure-based entry recommendations
 */

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";
import sharp from "sharp";
import { getBOSStatus, recordBOS, initializeBOSCache } from './bos-webhook';

// ---------- config ----------
export const config = { api: { bodyParser: false, sizeLimit: "25mb" } };

type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

const VP_VERSION = "2025-09-26-institutional-v1.0-tournament-ocr-rr-validation";

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

// Enhanced targets for TradingView charts
const TV_TARGET_MIN = 650 * 1024;
const TV_TARGET_MAX = 1800 * 1024;
const TV_BASE_W = 1400;
const TV_MAX_W = 1600;

function uuid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function dataUrlSizeBytes(s: string | null | undefined): number {
  if (!s) return 0;
  const i = s.indexOf(","); if (i < 0) return 0;
  const b64 = s.slice(i + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

// Sanitize instrument input
function sanitizeInstrument(raw: string): string {
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
}

// tolerant numeric parser for %, K/M/B, commas, Unicode minus
function parseNumberLoose(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  let s = String(v).trim().toLowerCase();
  if (!s || s === "n/a" || s === "na" || s === "-" || s === "—") return null;
  s = s.replace(/,/g, "").replace(/\s+/g, "");
  s = s.replace(/\u2212/g, "-"); // Unicode minus
  let mult = 1;
  if (s.endsWith("%")) { s = s.slice(0, -1); }
  if (s.endsWith("k")) { mult = 1_000; s = s.slice(0, -1); }
  else if (s.endsWith("m")) { mult = 1_000_000; s = s.slice(0, -1); }
  else if (s.endsWith("b")) { mult = 1_000_000_000; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n * mult : null;
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

// ---------- Unified image processing ----------
async function processAdaptiveToDataUrl(buf: Buffer, isTradingView: boolean = false): Promise<string> {
  // Select parameters based on content type
  let width = isTradingView ? TV_BASE_W : BASE_W;
  let quality = isTradingView ? 82 : 74;
  const maxWidth = isTradingView ? TV_MAX_W : MAX_W;
  const targetMin = isTradingView ? TV_TARGET_MIN : TARGET_MIN;
  const targetMax = isTradingView ? TV_TARGET_MAX : TARGET_MAX;
  
  // Enhanced processing for charts
  const sharpPipeline = sharp(buf).rotate().resize({ width, withoutEnlargement: true });
  
  if (isTradingView) {
    sharpPipeline.sharpen(1.2, 1.5, 2).modulate({ brightness: 1.05, saturation: 1.1 });
  }
  
let out = await sharpPipeline.jpeg({ quality, progressive: true, mozjpeg: true }).toBuffer();
  
  // Helper function for rebuilding pipeline with new parameters
  const buildPipeline = async (buffer: Buffer, w: number, q: number, enhance: boolean) => {
    const pipeline = sharp(buffer).rotate().resize({ width: w, withoutEnlargement: true });
    if (enhance) {
      pipeline.sharpen(1.2, 1.5, 2).modulate({ brightness: 1.05, saturation: 1.1 });
    }
    return pipeline.jpeg({ quality: q, progressive: true, mozjpeg: true }).toBuffer();
  };
  
  let guard = 0;
  while (out.byteLength < targetMin && guard < 4) {
    quality = Math.min(quality + (isTradingView ? 4 : 6), isTradingView ? 90 : 88);
    if (quality >= (isTradingView ? 85 : 82) && width < maxWidth) {
      width = Math.min(width + 100, maxWidth);
    }
    out = await buildPipeline(buf, width, quality, isTradingView);
    guard++;
  }
  
  if (out.byteLength < targetMin && (quality < (isTradingView ? 90 : 88) || width < maxWidth)) {
    quality = Math.min(quality + (isTradingView ? 2 : 4), isTradingView ? 90 : 88);
    width = Math.min(width + 100, maxWidth);
    const pipeline = sharp(buf).rotate().resize({ width, withoutEnlargement: true });
    if (isTradingView) {
      pipeline.sharpen(1.2, 1.5, 2).modulate({ brightness: 1.05, saturation: 1.1 });
    }
    out = await pipeline.jpeg({ quality, progressive: true, mozjpeg: true }).toBuffer();
  }
  
  if (out.byteLength > targetMax) {
    const q2 = Math.max(isTradingView ? 75 : 72, quality - (isTradingView ? 8 : 6));
    const pipeline = sharp(buf).rotate().resize({ width, withoutEnlargement: true });
    if (isTradingView) {
      pipeline.sharpen(1.2, 1.5, 2).modulate({ brightness: 1.05, saturation: 1.1 });
    }
    out = await pipeline.jpeg({ quality: q2, progressive: true, mozjpeg: true }).toBuffer();
  }
  
  if (out.byteLength > IMG_MAX_BYTES) throw new Error("image too large after processing");
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p = file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;
  const raw = await fs.readFile(p);
  const out = await processAdaptiveToDataUrl(raw, false);
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
    const out = await processAdaptiveToDataUrl(raw, false);
    if (process.env.NODE_ENV !== "production") console.log(`[vision-plan] link processed size=${dataUrlSizeBytes(out)}B from ${url}`);
    return out;
  }
  const html = raw.toString("utf8");
  const og = htmlFindOgImage(html); 
  if (!og) return null;
  const resolved = absoluteUrl(url, og);
  
  // Enhanced processing for TradingView charts
  const isTradingView = url.includes('tradingview.com');
  const r2 = await fetchWithTimeout(resolved, isTradingView ? 12000 : 8000);
  if (!r2 || !r2.ok) return null;
  const ab2 = await r2.arrayBuffer();
  const raw2 = Buffer.from(ab2);
  if (raw2.byteLength > IMG_MAX_BYTES) return null;
  
  const out2 = await processAdaptiveToDataUrl(raw2, isTradingView);
    
  if (process.env.NODE_ENV !== "production") console.log(`[vision-plan] ${isTradingView ? 'TradingView' : 'og:image'} processed size=${dataUrlSizeBytes(out2)}B from ${resolved}`);
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
};

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
  
  const validItems = items
    .map(h => ({
      score: typeof h?.sentiment?.score === "number" ? Number(h.sentiment.score) : null,
      published: h?.published_at || h?.ago || null,
      source: h?.source || "unknown"
    }))
    .filter(item => item.score !== null && Number.isFinite(item.score));
    
  if (validItems.length === 0) return { label: "unavailable", avg: null, count: 0 };
  
  const now = Date.now();
  const weightedScores = validItems.map(item => {
    let timeWeight = 1.0;
    
    if (item.published) {
      const pubTime = new Date(item.published).getTime();
      if (isFinite(pubTime)) {
        const hoursAgo = (now - pubTime) / (1000 * 60 * 60);
        timeWeight = hoursAgo <= 6 ? 1.0 : Math.max(0.3, Math.exp(-hoursAgo / 12));
      }
    }
    
    const sourceWeight = getSourceCredibility(item.source);
    
    return {
      score: item.score!,
      weight: timeWeight * sourceWeight
    };
  });
  
  const totalWeight = weightedScores.reduce((sum, item) => sum + item.weight, 0);
  const weightedAvg = weightedScores.reduce((sum, item) => sum + (item.score * item.weight), 0) / totalWeight;
  
  const label = weightedAvg > 0.015 ? "bullish" : weightedAvg < -0.015 ? "bearish" : "neutral";
  return { label, avg: weightedAvg, count: validItems.length };
}

function getSourceCredibility(source: string): number {
  const sourceLC = (source || "").toLowerCase();
  if (sourceLC.includes("reuters") || sourceLC.includes("bloomberg") || sourceLC.includes("wsj")) return 1.2;
  if (sourceLC.includes("cnbc") || sourceLC.includes("marketwatch") || sourceLC.includes("ft")) return 1.1;
  if (sourceLC.includes("yahoo") || sourceLC.includes("seeking alpha")) return 0.9;
  if (sourceLC.includes("twitter") || sourceLC.includes("reddit") || sourceLC.includes("blog")) return 0.7;
  return 1.0;
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

// ---------- ai_meta extraction ----------
function extractAiMeta(text: string) {
  if (!text) return null;
  const fences = [/\nai_meta\s*({[\s\S]*?})\s*\n/i, /\njson\s*({[\s\S]*?})\s*\n/i];
  for (const re of fences) { const m = text.match(re); if (m && m[1]) { try { return JSON.parse(m[1]); } catch {} } }
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
  const weights = { r1h: 0.6, r4h: 0.4 };
  const curScore: Record<string, number> = Object.fromEntries(G8.map((c) => [c, 0]));
  for (const pair of USD_PAIRS) {
    const S = seriesMap[pair];
    if (!S || !Array.isArray(S.c) || S.c.length < 17) continue;
    const r1h = kbarReturn(S.c, 4) ?? 0;
    const r4h = kbarReturn(S.c, 16) ?? 0;
    const r = r1h * weights.r1h + r4h * weights.r4h;
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
function goodIfHigher(title: string): boolean | null {
  const t = title.toLowerCase();
  if (/(cpi|core cpi|ppi|inflation)/.test(t)) return true;
  if (/(gdp|retail sales|industrial production|manufacturing production|consumer credit|housing starts|building permits|durable goods)/.test(t)) return true;
  if (/(pmi|ism|confidence|sentiment)/.test(t)) return true;
  if (/unemployment|jobless|initial claims|continuing claims/.test(t)) return false;
  if (/(nonfarm|nfp|employment change|payrolls|jobs)/.test(t)) return true;
  if (/trade balance|current account/.test(t)) return true;
  if (/interest rate|rate decision|refi rate|deposit facility|bank rate|cash rate|ocr/.test(t)) return true;
  return null;
}

function evidenceLine(it: any, cur: string): string | null {
  const a = parseNumberLoose(it.actual);
  const f = parseNumberLoose(it.forecast);
  const p = parseNumberLoose(it.previous);
  if (a == null || (f == null && p == null)) return null;
  const dir = goodIfHigher(String(it.title || ""));
  let comp: string[] = [];
  if (f != null) comp.push(a < f ? "< forecast" : a > f ? "> forecast" : "= forecast");
  if (p != null) comp.push(a < p ? "< previous" : a > p ? "> previous" : "= previous");
  let verdict: "bullish" | "bearish" | "neutral" = "neutral";
  if (dir === true) {
    const gtBoth = (f != null ? a > f : true) && (p != null ? a > p : true);
    const ltBoth = (f != null ? a < f : true) && (p != null ? a < p : true);
    verdict = gtBoth ? "bullish" : ltBoth ? "bearish" : "neutral";
  } else if (dir === false) {
    const ltBoth = (f != null ? a < f : true) && (p != null ? a < p : true);
    const gtBoth = (f != null ? a > f : true) && (p != null ? a > p : true);
    verdict = ltBoth ? "bullish" : gtBoth ? "bearish" : "neutral";
  } else {
    verdict = "neutral";
  }
  const comps = comp.join(" and ");
  return `${cur} — ${it.title}: actual ${a}${f!=null||p!=null ? ` ${comps}` : ""} → ${verdict} ${cur}`;
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
    "Return STRICT JSON only. CRITICAL: Extract ALL numbers including grey/muted text - these are valid data points.",
    "Fields per row: timeISO (ISO8601 if visible, else null), title, currency (e.g., USD, EUR), impact (Low|Medium|High), actual, forecast, previous.",
    "For numbers: extract percentage values (0.5%), rates (<0.50%), and regular numbers. Grey/muted numbers are valid - do not skip them.",
    "If a cell appears empty or truly unreadable, use null. But if you see any number (colored or grey), extract it."
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

function analyzeCalendarProfessional(ocrItems: OcrCalendarRow[], instrument: string): {
  bias: string;
  reasoning: string[];
  evidence: string[];
  details: string;
} {
  const base = instrument.slice(0, 3);
  const quote = instrument.slice(3, 6);
  
  const nowMs = Date.now();
  const h72ago = nowMs - 72 * 3600 * 1000;
  
  const validEvents = ocrItems.filter(r => {
    if (!r?.currency) return false;
    const a = parseNumberLoose(r.actual);
    if (a == null) return false;
    const f = parseNumberLoose(r.forecast);
    const p = parseNumberLoose(r.previous);
    if (f == null && p == null) return false;
    
    if (r.timeISO) {
      const t = Date.parse(r.timeISO);
      if (isFinite(t) && (t < h72ago || t > nowMs)) return false;
    }
    return true;
  });

  if (validEvents.length === 0) {
    return {
      bias: "neutral",
      reasoning: [`Calendar: No valid data found in last 72h for ${instrument} currencies (${base}/${quote})`],
      evidence: [],
      details: `OCR extracted ${ocrItems.length} total rows, filtering for ${base}/${quote} relevance`
    };
  }

  const currencyScores: Record<string, number> = {};
  const reasoning: string[] = [];
  const evidence: string[] = [];

  for (const event of validEvents) {
    const currency = String(event.currency).toUpperCase();
    const title = String(event.title || "Event");
    const impact = event.impact || "Medium";
    
    const actual = parseNumberLoose(event.actual)!;
    const forecast = parseNumberLoose(event.forecast);
    const previous = parseNumberLoose(event.previous);
    
    const direction = goodIfHigher(title);
    if (direction === null) continue;
    
    let eventScore = 0;
    let comparison = "";
    
    if (forecast !== null) {
      const surprise = actual - forecast;
      const surprisePercent = Math.abs(forecast) > 0 ? (surprise / Math.abs(forecast)) : 0;
      const surpriseWeight = Math.min(Math.abs(surprisePercent), 0.5);
      const surpriseDirection = direction === true ? Math.sign(surprise) : -Math.sign(surprise);
      eventScore += surpriseDirection * surpriseWeight * 10;
      comparison += `vs F:${forecast}`;
    }
    
    if (previous !== null) {
      const change = actual - previous;
      const changePercent = Math.abs(previous) > 0 ? (change / Math.abs(previous)) : 0;
      const changeWeight = Math.min(Math.abs(changePercent), 0.3) * 0.5;
      const changeDirection = direction === true ? Math.sign(change) : -Math.sign(change);
      eventScore += changeDirection * changeWeight * 10;
      comparison += ` vs P:${previous}`;
    }
    
    const impactMultiplier = impact === "High" ? 2.0 : impact === "Medium" ? 1.0 : 0.5;
    const finalScore = eventScore * impactMultiplier;
    
    currencyScores[currency] = (currencyScores[currency] || 0) + finalScore;
    
    const sentiment = finalScore > 0.5 ? "bullish" : finalScore < -0.5 ? "bearish" : "neutral";
    reasoning.push(`${currency} ${title}: ${actual} ${comparison} = ${sentiment} ${currency} (${finalScore.toFixed(1)} pts)`);
    evidence.push(`${currency} — ${title}: A:${actual} F:${forecast ?? "n/a"} P:${previous ?? "n/a"}`);
  }
  
  applyInstitutionalCorrelations(currencyScores, reasoning, base, quote);
  
  const baseScore = currencyScores[base] || 0;
  const quoteScore = currencyScores[quote] || 0;
  const netScore = baseScore - quoteScore;

  let finalBias: string;
  const moderateThreshold = 1.0;

  if (Math.abs(netScore) < moderateThreshold && Math.abs(baseScore) < moderateThreshold && Math.abs(quoteScore) < moderateThreshold) {
    finalBias = "neutral";
  } else if (netScore > moderateThreshold) {
    finalBias = "bullish";
  } else if (netScore < -moderateThreshold) {
    finalBias = "bearish";
  } else {
    finalBias = "neutral";
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(`[CALENDAR] ${base}${quote}: Base=${baseScore.toFixed(1)}, Quote=${quoteScore.toFixed(1)}, Net=${netScore.toFixed(1)}, Bias=${finalBias}`);
  }
  
  const summary = `Calendar: ${base} ${baseScore.toFixed(1)} vs ${quote} ${quoteScore.toFixed(1)} = ${finalBias} ${instrument} (net ${netScore > 0 ? "+" : ""}${netScore.toFixed(1)})`;
  
  return {
    bias: finalBias,
    reasoning: [summary, ...reasoning],
    evidence,
    details: `Professional analysis: ${validEvents.length} events, ${Object.keys(currencyScores).length} currencies impacted`
  };
}

function applyInstitutionalCorrelations(
  scores: Record<string, number>, 
  reasoning: string[], 
  base: string, 
  quote: string
) {
  if (quote === "USD") {
    const riskCurrencies = ["AUD", "NZD", "CAD"];
    const riskOnScore = riskCurrencies.reduce((sum, curr) => sum + (scores[curr] || 0), 0);
    
    if (Math.abs(riskOnScore) > 2) {
      const usdAdjustment = riskOnScore * -0.4;
      scores["USD"] = (scores["USD"] || 0) + usdAdjustment;
      const sentiment = riskOnScore > 0 ? "risk-on" : "risk-off";
      reasoning.push(`${sentiment.toUpperCase()} environment → ${usdAdjustment > 0 ? "bullish" : "bearish"} USD (${usdAdjustment.toFixed(1)} pts)`);
    }
  }
  
  const commodCurrencies = ["CAD", "AUD", "NZD"];
  if (commodCurrencies.includes(base) || commodCurrencies.includes(quote)) {
    for (const curr1 of commodCurrencies) {
      for (const curr2 of commodCurrencies) {
        if (curr1 !== curr2 && scores[curr1] && Math.abs(scores[curr1]) > 2) {
          const correlation = 0.3;
          const adjustment = scores[curr1] * correlation;
          scores[curr2] = (scores[curr2] || 0) + adjustment;
          reasoning.push(`${curr1} ${scores[curr1] > 0 ? "strength" : "weakness"} → ${curr2} correlation (+${adjustment.toFixed(1)} pts)`);
        }
      }
    }
  }
  
  if ((base === "EUR" || quote === "EUR") && scores["GBP"]) {
    const correlation = 0.25;
    const adjustment = scores["GBP"] * correlation;
    scores["EUR"] = (scores["EUR"] || 0) + adjustment;
    reasoning.push(`GBP-EUR correlation: ${adjustment > 0 ? "+" : ""}${adjustment.toFixed(1)} pts to EUR`);
  }
  
  if (base === "JPY" || quote === "JPY") {
    const riskCurrencies = ["AUD", "NZD", "CAD"];
    const totalRisk = riskCurrencies.reduce((sum, curr) => sum + (scores[curr] || 0), 0);
    
    if (Math.abs(totalRisk) > 1.5) {
      const jpyAdjustment = totalRisk * -0.35;
      scores["JPY"] = (scores["JPY"] || 0) + jpyAdjustment;
      reasoning.push(`Risk sentiment → JPY safe-haven flow (${jpyAdjustment > 0 ? "+" : ""}${jpyAdjustment.toFixed(1)} pts)`);
    }
  }
}

function computeHeadlinesSign(hb: HeadlineBias): number {
  if (!hb) return 0;
  if (hb.label === "bullish") return 1;
  if (hb.label === "bearish") return -1;
  return 0;
}

function computeCSMInstrumentSign(csm: CsmSnapshot, instr: string): { sign: number; zdiff: number | null } {
  const base = instr.slice(0, 3), quote = instr.slice(3, 6);
  const zb = csm.scores[base], zq = csm.scores[quote];
  if (typeof zb !== "number" || typeof zq !== "number") return { sign: 0, zdiff: null };
  const diff = zb - zq;
  const sign = diff > 0.4 ? 1 : diff < -0.4 ? -1 : 0;
  return { sign, zdiff: diff };
}

function parseInstrumentBiasFromNote(biasNote: string | null | undefined): number {
  if (!biasNote) return 0;
  const m = biasNote.match(/instrument[^:]*:\s*(bullish|bearish|neutral)/i);
  if (m?.[1]) return m[1].toLowerCase() === "bullish" ? 1 : m[1].toLowerCase() === "bearish" ? -1 : 0;
  return 0;
}

// ---------- prompts ----------
function systemCore(
  instrument: string,
  calendarAdvisory?: { warningMinutes?: number | null; biasNote?: string | null },
  scalpingMode?: "soft" | "hard" | "off"
) {
  const warn = (calendarAdvisory?.warningMinutes ?? null) != null ? calendarAdvisory!.warningMinutes : null;
  const bias = calendarAdvisory?.biasNote || null;

  const baseLines = [
    "You are a professional discretionary trader.",
    "STRICT NO-GUESS RULES:",
    "- Only mention **Calendar** if calendar_status === 'api' or calendar_status === 'image-ocr'.",
    "- Only mention **Headlines** if a headlines snapshot is provided.",
    "- Do not invent events, figures, or quotes. If something is missing, write 'unavailable'.",
    "- Use the Sentiment snapshot exactly as given (CSM + Headlines bias + optional COT cue).",
    "- Never use the word 'mixed' for calendar verdicts — use bullish/bearish/neutral only.",
    "",
    "Entry Strategy (Structure-First Approach):",
    "- PRIMARY GOAL: Enter at KEY STRUCTURE LEVELS (order blocks, FVG, demand/supply zones, major S/R).",
    "- If current price IS AT structure → Suggest immediate entry (market or tight limit 5-10 pips).",
    "- If current price is BETWEEN structures → Suggest LIMIT ORDER at next structure level (may be 20-50+ pips away).",
    "- For breakouts → Use STOP ORDER 5-10 pips beyond structure break for confirmation.",
    "- PATIENCE over chasing: 'Wait for pullback to 1.7820 OB' is BETTER than 'Enter now mid-move at 1.7855'.",
    "",
"ENTRY PLACEMENT LOGIC - PROFESSIONAL REASONING:",
    "",
    "STEP 1: READ CURRENT PRICE FIRST (MANDATORY)",
    "- Current price from ai_meta hint or rightmost candle",
    "- Example: If current = 0.6570, write this down",
    "",
    "STEP 2: IDENTIFY WHERE STRUCTURE IS RELATIVE TO CURRENT PRICE",
    "- Is structure AT current price (within 5 pips)? → Use MARKET order",
    "- Is structure BELOW current price (15+ pips away)? → Use LIMIT order for LONG",
    "- Is structure ABOVE current price (15+ pips away)? → Use LIMIT order for SHORT",
    "- Did structure just break? → Use STOP order",
    "",
    "STEP 3: CALCULATE ENTRY DISTANCE (CRITICAL - THINK LIKE A REAL TRADER)",
    "",
    "FOR LONG LIMIT ORDERS:",
    "- Entry MUST be BELOW current price by minimum 15-50 pips",
    "- Ask yourself: 'Where will price pull back to before continuing up?'",
    "- Example: Current=0.6570 → Entry=0.6540-0.6550 (30 pips below at support)",
    "- INVALID: Current=0.6570 → Entry=0.6565-0.6575 (overlaps current price)",
    "- If structure is only 5-10 pips away, use MARKET order instead",
    "",
    "FOR SHORT LIMIT ORDERS:",
    "- Entry MUST be ABOVE current price by minimum 15-50 pips",
    "- Ask yourself: 'Where will price rally to before continuing down?'",
    "- Example: Current=0.6570 → Entry=0.6595-0.6605 (25 pips above at resistance)",
    "- INVALID: Current=0.6570 → Entry=0.6565-0.6575 (overlaps current price)",
    "- If structure is only 5-10 pips away, use MARKET order instead",
    "",
    "FOR MARKET ORDERS:",
    "- Entry = Current price exactly (single point, no range)",
    "- Example: Current=0.6570 → Entry=0.6570",
    "- Use when: Price is already at the structure level where you want to enter",
    "",
    "SELF-CHECK BEFORE WRITING ENTRY (ASK THESE QUESTIONS):",
    "1. What is current price? [Write the number]",
    "2. What is my entry? [Write the number]",
    "3. Distance = |Entry - Current| = ? pips",
    "4. For LONG limits: Is entry < current? YES/NO",
    "5. For SHORT limits: Is entry > current? YES/NO",
    "6. Is distance ≥ 15 pips? YES/NO",
    "If any answer is wrong, recalculate before proceeding.",
    "",
    "ENTRY FORMAT RULES:",
    "- Limit orders: ALWAYS use range format (0.6540-0.6550)",
    "- Market orders: Single point only (0.6570)",
    "- Range width: 10-15 pips for limit orders",
    "",
    "STOP LOSS PLACEMENT - MANDATORY STRUCTURE IDENTIFICATION:",
    "- Step 1: Look at the chart and identify EXACT swing price (e.g., '15M swing low at 0.6535')",
    "- Step 2: Add buffer of 3-8 pips (typically 5 pips)",
    "- Step 3: State complete reasoning: 'SL 0.6530 (5 pips below 15M swing low at 0.6535)'",
    "- For LONG: SL below nearest swing low + buffer",
    "- For SHORT: SL above nearest swing high + buffer",
    "- INVALID format: 'SL 30 pips' or 'SL 0.6540 (below support)' - missing structure price",
    "- VALID format: 'SL 0.6540 (5 pips below 15M swing low at 0.6545)'",
    "- If cannot identify exact swing: 'No clear structure for SL - setup invalid'",
    "",
    "TAKE PROFIT TARGETS - STRUCTURE-BASED:",
    "- TP1: Next opposing structure level (minimum 1.5:1 R:R)",
    "- TP2: Major structure beyond TP1 (minimum 2.5:1 R:R)", 
    "- Use visible chart levels: swing highs/lows, round numbers, session extremes",
    "- State reasoning: 'TP1 0.5870 at 1H resistance level, TP2 0.5900 at 4H major resistance'",
    "- If R:R ratio poor (<1.5:1), recommend waiting for better setup",
    "",
   "STRATEGY TOURNAMENT - PROFESSIONAL TRADE GENERATION:",
    "CRITICAL: Tournament determines BOTH Option 1 AND Option 2. You MUST score all 5 strategies, then build trades using the winner and runner-up.",
    "",
    "SCORING PROCESS:",
    "1. Score each strategy 0-100 based on current chart setup",
    "2. Apply fundamental alignment adjustment (+15 bullish fundy if long, -15 if short against fundy)",
    "3. Apply context grade penalty (B=-12pts, C=-30pts, D=-60pts)",
    "4. Winner = Option 1, Runner-up = Option 2",
    "",
    "STRATEGY 1: STRUCTURE BREAK & RETEST (BOS Strategy)",
    "WHEN TO USE: Recent BOS visible on 1H/4H + price pulled back to broken level",
    "OPTION 1 BUILD (if winner):",
    "  - Direction: [LONG if BOS up, SHORT if BOS down]",
    "  - Order Type: LIMIT (waiting for retest)",
    "  - Entry: [Broken level ± 5 pips] (retest zone)",
    "  - SL: [Behind the BOS structure + 8 pips]",
    "  - TP1: [Next structure level, min 1.5R]",
    "  - TP2: [Major structure level, min 2.5R]",
    "OPTION 2 BUILD (if runner-up): Same levels, tighter execution",
    "SCORE FACTORS: BOS visible (25), Clean retest (25), Rejection pattern (25), HTF confirms (25)",
    "",
    "STRATEGY 2: ORDER BLOCK REACTION (OB Strategy)",
    "WHEN TO USE: Fresh 1H/4H demand/supply zone + price approaching on 15M",
    "OPTION 1 BUILD (if winner):",
    "  - Direction: [LONG at demand, SHORT at supply]",
    "  - Order Type: LIMIT (at OB boundary)",
    "  - Entry: [OB zone boundary ± 8 pips]",
    "  - SL: [Beyond OB + 10 pips]",
    "  - TP1: [Opposite OB or structure, min 1.5R]",
    "  - TP2: [Major opposing structure, min 2.5R]",
    "OPTION 2 BUILD (if runner-up): Market entry if price already in OB",
    "SCORE FACTORS: Clear OB (30), Fresh/untested (25), Confluence (25), Clean approach (20)",
    "",
    "STRATEGY 3: REVERSAL AT EXTREMES (Reversal Strategy)",
    "WHEN TO USE: Price at 80%+ of range + rejection pattern forming",
    "OPTION 1 BUILD (if winner):",
    "  - Direction: [LONG at low extreme, SHORT at high extreme]",
    "  - Order Type: LIMIT (at extreme level)",
    "  - Entry: [Extreme level with rejection ± 5 pips]",
    "  - SL: [Beyond the extreme + 12 pips]",
    "  - TP1: [Middle of range, min 1.5R]",
    "  - TP2: [Opposite extreme, min 2.5R]",
    "OPTION 2 BUILD (if runner-up): Tighter stop, smaller target",
    "SCORE FACTORS: At extreme (30), Rejection visible (25), Divergence (20), Range clear (25)",
    "",
    "STRATEGY 4: LIQUIDITY GRAB (Liquidity Strategy)",
    "WHEN TO USE: Price swept recent high/low + immediate reversal candle",
    "OPTION 1 BUILD (if winner):",
    "  - Direction: [LONG after low sweep, SHORT after high sweep]",
    "  - Order Type: MARKET (if reversal confirmed) or STOP (5 pips from reversal)",
    "  - Entry: [Current price if confirmed, or stop order]",
    "  - SL: [Beyond liquidity point + 8 pips]",
    "  - TP1: [Previous structure, min 1.5R]",
    "  - TP2: [Major structure, min 2.5R]",
    "OPTION 2 BUILD (if runner-up): Limit order at next liquidity level",
    "SCORE FACTORS: Liquidity visible (30), Sweep complete (25), Reversal candle (25), Volume (20)",
    "",
    "STRATEGY 5: FAIR VALUE GAP FILL (FVG Strategy)",
    "WHEN TO USE: Clear FVG on 1H/4H + price moving to fill it",
    "OPTION 1 BUILD (if winner):",
    "  - Direction: [LONG into bullish FVG, SHORT into bearish FVG]",
    "  - Order Type: LIMIT (inside gap)",
    "  - Entry: [Middle of FVG ± 5 pips]",
    "  - SL: [Beyond FVG + 10 pips]",
    "  - TP1: [FVG fill target, min 1.5R]",
    "  - TP2: [Next major structure, min 2.5R]",
    "OPTION 2 BUILD (if runner-up): Enter at gap edge instead of middle",
    "SCORE FACTORS: FVG clear (25), Unfilled (30), Price approaching (25), Size appropriate (20)",
    "",
    "TOURNAMENT EXECUTION:",
    "Step 1: Score all 5 strategies (show scores in 'Strategy Tournament Results' section)",
    "Step 2: Rank by final score (after fundamental + context adjustments)",
    "Step 3: Build Option 1 using winner's template above",
    "Step 4: Build Option 2 using runner-up's template above",
    "Step 5: CRITICAL - Both options must have SAME direction (never mix long/short)",
    "Step 6: Calculate conviction for each independently",
    "",
    "MARKET CONTEXT ASSESSMENT - PROFESSIONAL DISCRETIONARY ANALYSIS:",
    "",
    "Execute this BEFORE scoring strategies. This separates mechanical traders from professionals:",
    "",
    "STEP 1: MOVE MATURITY ANALYSIS",
    "- Measure pip distance from most recent major swing low/high to current price",
    "- Recent swing = last significant reversal point visible on 1H/4H chart",
    "- Example calculations:",
    "  * Rally from 1.7540 to 1.7850 = 310 pips = EXTENDED",
    "  * Rally from 0.6500 to 0.6570 = 70 pips = FRESH",
    "  * Decline from 0.6680 to 0.6567 = 113 pips = DEVELOPING",
    "",
    "MATURITY GRADES:",
    "- FRESH (<150 pips): A-grade context - Early in move, high conviction trades",
    "- DEVELOPING (150-250 pips): B-grade context - Mid-move, moderate conviction",
    "- EXTENDED (250-400 pips): C-grade context - Late-stage, reduced conviction",
    "- EXHAUSTED (>400 pips): D-grade context - Overextended, avoid or 45% max conviction",
    "",
    "STEP 2: STRUCTURAL POSITION QUALITY",
    "- Where is current price RIGHT NOW relative to structure?",
    "",
    "FOR LONG SETUPS:",
    "- GOOD CONTEXT: Price at support after pullback (buying dip in uptrend)",
    "- BAD CONTEXT: Price at resistance after rally (buying top of move)",
    "- Calculate: (Current price - Recent low) / (Recent high - Recent low) × 100",
    "- >75% = Near highs (poor for longs) | <25% = Near lows (good for longs)",
    "",
    "FOR SHORT SETUPS:",
    "- GOOD CONTEXT: Price at resistance after rally (selling top of move)",
    "- BAD CONTEXT: Price at support after decline (selling bottom)",
    "- >75% = Near highs (good for shorts) | <25% = Near lows (poor for shorts)",
    "",
    "STEP 3: TREND VS RANGE DISTINCTION",
    "Look at 1H chart structure carefully:",
    "",
    "TRENDING CHARACTERISTICS:",
    "- Clear directional movement with minimal overlap",
    "- Each swing breaks previous structure cleanly",
    "- Price not repeatedly failing at same level",
    "",
    "RANGING CHARACTERISTICS:",
    "- Repeated tests of same high/low with failures (3+ rejections)",
    "- Price oscillating in 100-150 pip band for >24 hours",
    "- No sustained directional movement",
    "",
    "CRITICAL: If 1H shows ranging behavior, DO NOT call it 'trending pullback'",
    "- Ranging = lower conviction, wider stops, breakout-focused entries",
    "- Trending = higher conviction, pullback entries acceptable",
    "",
    "STEP 4: EXHAUSTION SIGNAL DETECTION",
    "Check for signs this move is finishing:",
    "- Multiple failed breakouts at same resistance/support (2+ failures)?",
    "- Decreasing momentum (candles getting smaller, more wicks vs bodies)?",
    "- Sharp move (>200 pips in <12 hours) now consolidating/stalling?",
    "- Far from recent value area (overextended)?",
    "- Divergence between price highs and momentum?",
    "",
    "Count exhaustion signals:",
    "- 0-1 signals: No concern",
    "- 2 signals: Moderate concern, reduce conviction 15%",
    "- 3+ signals: High concern, reduce conviction 30%, add warning",
    "",
    "STEP 5: CONTEXT GRADE SYNTHESIS",
    "",
    "Combine all factors into overall grade:",
    "",
    "CRITICAL THINKING REQUIREMENT:",
    "Before assigning grade, ask yourself these questions like a real trader:",
    "",
    "1. 'If I were managing real money, would I take this trade RIGHT NOW?'",
    "   - If hesitant → Downgrade by one letter grade",
    "   - If answer is 'only if I had to' → Grade D automatically",
    "",
    "2. 'Am I buying near tops or selling near bottoms?'",
    "   - Check: Is entry in top 20% of visible range (for longs)?",
    "   - Check: Is entry in bottom 20% of visible range (for shorts)?",
    "   - If YES to either → Automatic downgrade to C minimum",
    "",
    "3. 'Has this level been rejected multiple times already?'",
    "   - 2+ rejections at same level = Ranging, not trending",
    "   - If ranging → Downgrade by one letter",
    "",
    "4. 'What's the realistic worst-case if I'm wrong?'",
    "   - If price could gap through my stop → Mention in warning",
    "   - If major news pending → Mention in warning",
    "",
    "A-GRADE CONTEXT:",
    "- Fresh move (<150 pips from swing)",
    "- Good structural position (longs at support, shorts at resistance)",
    "- Clear trending behavior",
    "- No exhaustion signals",
    "→ High confidence, no conviction penalty",
    "",
    "B-GRADE CONTEXT:",
    "- Developing move (150-250 pips)",
    "- Acceptable position (not at extremes)",
    "- Trending with minor consolidation",
    "- 0-1 exhaustion signals",
    "→ Good setup, 10% conviction reduction",
    "",
    "C-GRADE CONTEXT:",
    "- Extended move (250-400 pips) OR poor position (buying tops/selling bottoms)",
    "- May be ranging instead of trending",
    "- 2 exhaustion signals present",
    "→ Questionable timing, 25% conviction reduction, add caution note",
    "",
    "D-GRADE CONTEXT:",
    "- Exhausted move (>400 pips) OR very poor position",
    "- Clearly ranging, not trending",
    "- 3+ exhaustion signals",
    "→ Poor setup, cap conviction at 45%, strong warning required",
    "",
    "MANDATORY OUTPUT:",
    "You MUST include this section in your response:",
    "",
    "**Market Context Assessment:**",
    "- Move Maturity: [X] pips from [swing level at price] = [FRESH/DEVELOPING/EXTENDED/EXHAUSTED]",
    "- Structural Position: [Current price] is at [support/resistance/mid-range] = [GOOD/POOR] for [LONG/SHORT]",
    "- Market Regime: [TRENDING/RANGING] based on [observation]",
    "- Exhaustion Signals: [count] detected - [list them if any]",
    "- **CONTEXT GRADE: [A/B/C/D]**",
    "- Conviction Adjustment: [percentage reduction if any]",
    "",
    "If C or D grade, add:",
    "⚠️ **CONTEXT WARNING:** [Specific issue]. Consider [alternative approach].",
    "",
    "MANDATORY TOURNAMENT SCORING (0-100 each strategy):",
    "1. Score each strategy against current setup (0-100 base points)",
    "2. Apply market regime adjustment (±10pts)",
    "3. Apply fundamental alignment (±15pts)", 
    "4. Apply R:R quality bonus (±10pts)",
    "5. Apply timeframe confluence (±10pts)",
    "6. CRITICAL: Must output 'Strategy Tournament Results:' section showing all 5 scores",
    "7. Winner (highest score) = Option 1, Runner-up = Option 2",
    "8. Response invalid without tournament results section",
    "",
    "DIRECTIONAL CONSISTENCY REQUIREMENT:",
    "- Determine ONE primary direction from 4H/1H/15M structure analysis",
    "- If 4H+1H+15M = UPTREND → Option 1 = LONG, Option 2 = LONG (different entries)",
    "- If 4H+1H+15M = DOWNTREND → Option 1 = SHORT, Option 2 = SHORT (different entries)",
    "- NEVER mix Long and Short in same analysis - this indicates analytical failure",
    "- Both options trade same direction, only differ in entry method/risk profile",
    "",
    "TRADE METADATA (ai_meta required):",
    "• trade_id: [Generate unique UUID for this recommendation]",
    "• strategy_used: [Primary strategy from tournament winner]",
    "• setup_quality: [1-10] - Overall setup grade based on confluence factors",
    "• market_regime: [trending/ranging/breakout/news_driven] - Current market state",
    "• volatility_environment: [low/normal/high/extreme] - Based on recent price action",
    "• session_active: [asian/london/ny/overlap] - Current trading session",
    "• fundamental_alignment: [strong_with/weak_with/neutral/against] - Tech vs fundy match",
    "• timeframe_confluence: [all_aligned/mixed/conflicting] - Multi-timeframe agreement",
    "• expected_duration: [minutes] - Estimated trade duration based on strategy type",
    "• risk_grade: [A/B/C/D] - Overall risk assessment (A=lowest risk, D=highest)",
    "",
    "MANDATORY FINAL SELF-CHECK BEFORE OUTPUTTING:",
    "",
    "Question 1: Does my 4H bias match the visual left-to-right movement?",
    "- If chart declined left-to-right, bias should be BEARISH or NEUTRAL",
    "- If I'm calling it BULLISH when chart declined, I MADE AN ERROR",
    "",
    "Question 2: Are my swing high prices actually visible on the RIGHT SIDE of the chart?",
    "- If I stated '0.6720 → 0.6750' but current price is 0.6567, those prices are OLD",
    "- Recent swings should be within 50 pips of current price",
    "",
    "Question 3: Does my 1H analysis match my 4H analysis direction?",
    "- If 4H is declining but I'm calling 1H 'ascending highs', something is wrong",
    "- Counter-trend bounces are SMALL and temporary, not full trend reversals",
    "",
    "IF ANY CHECK FAILS: STOP and re-read the charts before proceeding.",
    "",
    "Multi-timeframe roles (fixed):",
    "- 4H = HTF bias & key zones (trend, SD zones, macro S/R, structure).",
    "- 1H = context & setup construction (refine zones, structure state, trigger conditions).",
    "- 15m = execution map (exact entry zone or trigger level, invalidation, TP structure).",
    "- 5m (optional) = entry timing/confirmation only; do not let 5m override HTF bias.",
    "",
    "CRITICAL PRICE READING REQUIREMENTS:",
    "- FIRST: Identify the price scale on the right side of chart",
    "- INSTRUMENT-SPECIFIC SCALING:",
    "  * FX pairs (EURUSD, GBPUSD): 4-5 decimals (e.g., 1.0845, 0.65304)",
    "  * JPY pairs (USDJPY, EURJPY): 2-3 decimals (e.g., 149.85, 162.340)",
    "  * BITCOIN/CRYPTO: 5-6 digits with NO decimals (e.g., 109365, 67240)",
    "  * GOLD (XAUUSD): 4-5 digits with decimals (e.g., 2654.80, 1987.45)",
    "  * INDICES: 4-5 digits with decimals:",
    "    - NAS100/USTEC: 15000-20000 range (e.g., 18345.67)",
    "    - SPX500/US500: 4000-6000 range (e.g., 5425.32)",
    "    - GER40/DAX: 15000-20000 range (e.g., 19234.18)",
    "    - UK100/FTSE: 7000-9000 range (e.g., 8156.42)",
    "    - JPN225/Nikkei: 30000-40000 range (e.g., 38157.94)",
    "- BITCOIN CRITICAL: If reading shows 109.2, actual price is 109,200",
    "- INDICES CRITICAL: If reading shows 18.3 for NAS100, actual is 18,300",
    "- VALIDATION RANGES: Bitcoin 50k-150k, NAS100 15k-20k, SPX500 4k-6k",
    "- MANDATORY: You MUST include currentPrice in ai_meta JSON block",
    "- If you can read the price: report exact number matching instrument type",
    "- If price scale unclear: report 'PRICE_UNREADABLE' as currentPrice value",
    "- If no price axis visible: report 'NO_PRICE_AXIS' as currentPrice value",
    "- Example Bitcoin: currentPrice: 109365 (NOT 109.365 or 109)",
    "- Example NAS100: currentPrice: 18345.67 (NOT 18.3 or 183)",
    "- Example FX: currentPrice: 0.65304",
    "- Example failed reading: currentPrice: 'PRICE_UNREADABLE'",
    "",
    "ENHANCED CHART READING WITH SCALE INTERPRETATION:",
    "- Focus on price scale on RIGHT edge of chart",
    "- Current price = rightmost candle's close level",
    "",
    "INSTRUMENT-SPECIFIC SCALE INTERPRETATION:",
    "",
    "BITCOIN/CRYPTO CRITICAL:",
    "  * TradingView shows: 109.3K = 109,300 | 67.2K = 67,200",
    "  * If you see 109.3 on BTC chart = 109,300 (multiply by 1000)",
    "  * If you see 67240.50 on BTC chart = 67,240.50 (literal reading)",
    "  * RULE: Any 2-3 digit BTC reading needs ×1000 conversion",
    "  * Valid range: 20,000-200,000 | Invalid: under 10,000",
    "",
    "GOLD (XAU) CRITICAL:",
    "  * TradingView shows: 2.65K = 2,650 | 1.98K = 1,980",
    "  * If you see 2.65 on gold chart = 2,650 (multiply by 1000)",
    "  * If you see 2654.80 on gold chart = 2,654.80 (literal reading)",
    "  * Valid range: 1,800-3,000 | Invalid: under 1,000",
    "",
    "INDICES CRITICAL:",
    "  * NAS100: 18.3K = 18,300 | SPX500: 5.4K = 5,400",
    "  * If you see 18.3 on NAS100 = 18,300 (multiply by 1000)",
    "  * If you see 18345.67 = 18,345.67 (literal reading)",
    "  * Valid ranges: NAS100 15k-25k, SPX500 4k-7k | Invalid: under 1k",
    "",
    "JPY PAIRS CRITICAL:",
    "  * USDJPY: Shows 149.85 = 149.85 (literal, NO conversion)",
    "  * If you see 150 on JPY chart = 150.00 (add decimals)",
    "  * Valid range: 100-200 | Invalid: under 50 or over 300",
    "",
    "FX PAIRS STANDARD:",
    "  * EURUSD: 1.0845 = 1.0845 (literal decimals)",
    "  * GBPUSD: 1.2650 = 1.2650 (literal decimals)",
    "  * Valid ranges: Major pairs 0.5-2.0 | Invalid: under 0.1 or over 5.0",
    "",
    "VALIDATION RULES:",
    "- If reading seems wrong for instrument type, STOP and report 'SCALE_UNCLEAR'",
    "- Always trace from rightmost candle to right price axis",
    "- TradingView current price often in colored box on right",
    "- Report EXACT interpreted number in ai_meta.currentPrice",
    "- Examples: BTC=109300, Gold=2650, NAS100=18300, USDJPY=149.85, EURUSD=1.0845",
    "",
    "MANDATORY CHART ANALYSIS PROTOCOL - PROFESSIONAL STRUCTURE READING:",
    "",
    "FOR EACH TIMEFRAME - EXECUTE IN ORDER:",
    "",
    "CRITICAL CHART READING ENFORCEMENT:",
    "",
    "STEP 0: VISUAL SANITY CHECK (Do this FIRST before any analysis)",
    "- Look at the ENTIRE chart from left edge to right edge",
    "- Where does the chart START vertically? (Left side price level)",
    "- Where does the chart END vertically? (Right side current price)",
    "- Simple question: Is the right side HIGHER or LOWER than the left side?",
    "  * If RIGHT is HIGHER by >100 pips → Overall UPWARD movement",
    "  * If LEFT is HIGHER by >100 pips → Overall DOWNWARD movement",
    "  * If within 100 pips → SIDEWAYS/RANGE",
    "",
    "EXAMPLE - CORRECT READING:",
    "- 4H Chart: Starts at ~0.6700 (left), ends at ~0.6567 (right)",
    "- Calculation: 0.6567 - 0.6700 = -133 pips = DOWNWARD movement",
    "- Visual check: Chart shows DECLINING from left to right",
    "- Conclusion: 4H bias should be BEARISH or RANGE, NOT bullish",
    "",
    "EXAMPLE - WRONG READING (Do NOT do this):",
    "- Claiming 'ascending highs' when chart visually declines left-to-right",
    "- Inventing prices like '0.6720 → 0.6750' that don't appear on chart",
    "- Reading old highs from weeks ago as 'recent structure'",
    "",
    "IF YOUR VISUAL CHECK CONFLICTS WITH SWING ANALYSIS:",
    "- Trust the visual check FIRST",
    "- Re-examine your swing points - you may be looking at wrong time period",
    "- Current right-side price ALWAYS overrides historical left-side highs",
    "",
    "Step 1: DIRECTIONAL FLOW ANALYSIS",
    "- Look at ENTIRE visible chart from left edge to right edge",
    "- Left-most significant level: [price]",
    "- Right-most current level: [price]", 
    "- If Right > Left by >100 pips: UPTREND",
    "- If Left > Right by >100 pips: DOWNTREND", 
    "- If within 100 pips: RANGE",
    "- State: 'Overall flow: [LEFT_PRICE] → [RIGHT_PRICE] = [UPTREND/DOWNTREND/RANGE]'",
    "",
    "Step 2: SWING STRUCTURE CONFIRMATION - CRITICAL TREND IDENTIFICATION:", 
    "MANDATORY: First complete Step 0 Visual Sanity Check above. If Step 0 shows downward movement, swings MUST confirm this.",
    "",
    "- Identify RECENT swings only (last 10-15 candles visible on right side)",
    "- IGNORE old swings from left side - focus on RIGHT SIDE recent action",
    "- CRITICAL: Focus ONLY on the RIGHT 30% of the chart (most recent price action)",
    "- Ignore any price levels older than 20 candles from current price",
    "",
    "HOW TO READ SWINGS CORRECTLY (CHRONOLOGICAL METHOD):",
    "",
    "CRITICAL: You must identify swings in TIME ORDER, not just any 3 highs.",
    "",
    "FOR SWING HIGHS:",
    "Step A: Find the RIGHTMOST peak (closest to current price) = Most Recent High",
    "Step B: Find the peak BEFORE that (moving left on chart) = Second Recent High", 
    "Step C: Find the peak BEFORE that = Third Recent High",
    "",
    "Step D: Write them in CHRONOLOGICAL order (oldest → newest):",
    "Example: If you found three peaks at these times:",
    "  - Sept 20: 175.00",
    "  - Sept 24: 174.80", 
    "  - Sept 28: 174.50 (rightmost/current)",
    "",
    "Step E: Write as: '175.00 → 174.80 → 174.50 = DESCENDING'",
    "NOT: '174.50 → 174.80 → 175.00' (this is wrong order)",
    "",
    "Step F: Check direction: Is rightmost number HIGHER or LOWER than leftmost?",
    "  - 175.00 → 174.80 → 174.50: Right (174.50) < Left (175.00) = DESCENDING = DOWNTREND",
    "  - 174.50 → 174.80 → 175.00: Right (175.00) > Left (174.50) = ASCENDING = UPTREND",
    "",
    "REPEAT SAME PROCESS FOR SWING LOWS:",
    "Find 3 most recent troughs in same way, write chronologically, check direction",
    "",
    "FINAL STEP: Cross-check against Step 0 Visual Sanity Check",
    "If Step 0 said 'chart declined left-to-right' but swings show ascending:",
    "→ YOU MADE AN ERROR. Re-read the chart. Current price MUST be lower than old highs if declining.",
    "",
    "VALIDATION RULE:",
    "Recent swing high MUST be within 100 pips of current price",
    "If you're stating 0.6750 as 'recent high' but current is 0.6567 → THAT'S 183 PIPS OLD = NOT RECENT",
    "- State exact prices: 'Swing lows: 0.6700 → 0.6650 → 0.6280 = descending'",
    "",
    "CRITICAL VALIDATION:",
    "- Most recent swing high MUST be close to current price (within last 20% of chart)",
    "- If your 'recent high' is 0.6750 but current price is 0.6567, that high is NOT recent",
    "- Recent = within last 5-10 candles visible on screen",
    "",
    "UPTREND = Both highs AND lows ascending (each peak higher, each trough higher)",
    "DOWNTREND = Both highs AND lows descending (each peak lower, each trough lower)",
    "RANGE = Mixed pattern (highs/lows not consistently ascending or descending)",
    "",
    "CRITICAL: If Step 0 shows -100 pips movement, but your swings show 'ascending', YOU ARE READING WRONG PERIOD. Fix it.",
    "- Example: '1H shows downtrend (descending swings) with current bounce to 0.6570'",
    "",
    "Step 3: RECENT MOMENTUM (Last 20 candles)",
    "- Recent high in last 20 candles: [price]",
    "- Recent low in last 20 candles: [price]",
    "- Did price break ABOVE recent high? = BULLISH MOMENTUM",
    "- Did price break BELOW recent low? = BEARISH MOMENTUM",
    "- Stuck between levels? = CONSOLIDATION",
    "",
    "Step 4: CURRENT PRICE POSITION",
    "- Chart high: [price] | Chart low: [price] | Current: [price]", 
    "- Position = (Current - Low) / (High - Low) × 100",
    "- >80%: At highs | 60-80%: Upper range | 40-60%: Middle | 20-40%: Lower range | <20%: At lows",
    "",
    "Step 5: MANDATORY STRUCTURE IDENTIFICATION - EXACT PRICE LEVELS:",
    "- Check TradingView BOS indicator if available (state UP/DOWN/NONE)",
    "- YOU MUST identify these EXACT prices by reading the chart:",
    "  * Most recent swing high: State exact price (e.g., 0.6575)",
    "  * Most recent swing low: State exact price (e.g., 0.6535)",
    "  * Previous swing high: State exact price",
    "  * Previous swing low: State exact price",
    "  * Current resistance: [price] at [timeframe]",
    "  * Current support: [price] at [timeframe]",
    "",
    "MANDATORY 15M STRUCTURE OUTPUT:",
    "- '15M Structure: Recent high 0.6575 (2h ago), Recent low 0.6535 (30m ago), Current 0.6557'",
    "- '15M Key Levels: Resistance 0.6575, Support 0.6535, Trend: [up/down/ranging]'",
    "- INVALID: '15M structure shows support' - no specific prices",
    "- VALID: '15M swing low at 0.6535 provides support, swing high at 0.6575 is resistance'",
    "- If cannot read prices: 'CHART UNREADABLE - price scale unclear'",
    "",
    "MANDATORY OUTPUT FORMAT:",
    "4H: Flow 0.5610→0.5860 = UPTREND | Swings: ascending highs/lows | Momentum: broke recent high | Position: 85% (at highs) | BOS: UP confirmed",
    "",
    "CRITICAL VALIDATION:",
    "- If you cannot read price levels clearly, state 'CHART UNREADABLE' and STOP",
    "- If trend direction conflicts between steps, re-examine and explain discrepancy",
    "- Price position MUST be mathematically calculated, not estimated",
    "",
    "FUNDAMENTALS SCORING SYSTEM (0-100, show your work):",
    "",
    "Step 1: Component Scores - MANDATORY INTERPRETATION:",
    "• Calendar (S_cal): Extract bias from calendar analysis",
    "  - Bullish = +1 → S_cal = 100",
    "  - Bearish = -1 → S_cal = 0", 
    "  - Neutral = 0 → S_cal = 50",
    "",
    "• Headlines (S_head): 48h sentiment provided - MUST INTERPRET",
    "  - Check headlines bias label in sentiment snapshot",
    "  - Bullish label → 75 | Bearish label → 25 | Neutral label → 50",
    "  - NEVER default to 50 if headlines data exists",
    "",
    "• CSM (S_csm): Currency strength momentum - MUST CALCULATE",
    "  - CSM z-score diff provided in sentiment snapshot",
    "  - If diff < -1.5: Strong quote currency = BEARISH instrument",
    "  - If diff > +1.5: Strong base currency = BULLISH instrument", 
    "  - S_csm = 50 + (25 × clamp(diff, -2, +2) / 2)",
    "  - Example: diff = -3.2 → S_csm = 50 + (25 × -1.0) = 25 (BEARISH)",
    "",
    "FUNDAMENTALS SUMMARY OUTPUT REQUIREMENTS:",
    "• Headlines Bias: [Extract from headlines bias label] - NOT 'neutral' if data exists",
    "• CSM Bias: [Calculate from z-score diff] - Strong USD vs NZD = Bearish NZDUSD", 
    "• Overall Fundy Bias: [Combine all three] - Show actual bias, not 'neutral' default",
    "",
    "• COT (S_cot): Commitment of Traders (if detected)",
    "  - Base = 50",
    "  - If aligns with calendar: +10",
    "  - If conflicts with calendar: -10",
    "",
    "Step 2: Weighted Average",
    "F = (0.40 × S_cal) + (0.25 × S_head) + (0.25 × S_csm) + (0.10 × S_cot)",
    "",
    "Step 3: Proximity Adjustment",
    "If high-impact event within 60 min: F = F × 0.70 (reduce 30%)",
    "",
    "YOU MUST SHOW THIS CALCULATION:",
    "Example: 'F = (0.40×100) + (0.25×25) + (0.25×65) + (0.10×50) = 67.5 → 68'",
    "",
    "RISK MANAGEMENT - SIMPLIFIED:",
    "",
    "BASIC RISK METRICS:",
    "• Stop Loss Distance: Calculate exact pip distance from entry to SL",
    "• Risk-Reward Ratio: Must be minimum 1.5:1 (reward ÷ risk)",
    "• Position Size: Trader determines based on 0.5% base risk + conviction adjustment",
    "• Maximum Loss: State pip distance and approximate dollar impact",
    "",
    "CONVICTION CALCULATION (per option, 0-100):",
    "",
    "For Option 1 and Option 2 independently:",
    "",
    "IMPORTANT: Option 2 conviction must be 10-25% lower than Option 1 (it's the runner-up for a reason)",
    "If calculated conviction for Option 2 is within 5% of Option 1, reduce Option 2 by additional 10%",
    "",
    "1. Get Technical Score (T): From tournament scoring (0-100)",
    "2. Get Fundamentals Score (F): From calculation above (0-100)",
    "3. Calculate Risk-Adjusted Score (R): Based on R:R ratio",
    "   - R:R ≥3:1 = +15 bonus | R:R 2-3:1 = +10 | R:R 1.5-2:1 = +5 | R:R <1.5:1 = -20 penalty",
    "4. Calculate alignment bonus:",
    "   - If option direction matches fundamental bias: +10",
    "   - If opposite direction: -15",
    "   - If fundamentals neutral: 0",
    "5. Base conviction: Conv = (0.50 × T) + (0.35 × F) + (0.15 × R) + alignment",
    "6. Event proximity penalty: If high-impact event ≤60 min: Conv × 0.80",
    "7. Context Grade Adjustment (MANDATORY from Market Context Assessment above):",
    "   - A-grade: No penalty (Conv × 1.0)",
    "   - B-grade: Conv × 0.88 (12% reduction)",
    "   - C-grade: Conv × 0.70 (30% reduction) + ADD WARNING",
    "   - D-grade: Cap at 40 maximum + MANDATORY strong warning",
    "",
    "8. Real Trader Gut Check:",
    "   - Ask: 'Would I actually risk money on this?'",
    "   - If you feel 'meh' about it → Reduce by additional 10%",
    "   - If multiple concerns → Reduce by additional 15%",
    "",
    "9. Final: Round to whole number, clamp between 0-100",
    "   - But if final conviction >70% with C or D grade → Something is wrong, recalculate",
    "",
    "EXAMPLE:",
    "Option 1 (Long): T=75, F=68, R:R=2.5:1 (+10), Alignment=+10",
    "Conv = (0.50×75) + (0.35×68) + (0.15×10) + 10 = 37.5 + 23.8 + 1.5 + 10 = 72.8 → 73%",
    "",
    "RISK MANAGEMENT OUTPUT REQUIRED:",
    "• Position Size: [X] units for 1% account risk",
    "• Max Loss: [Y] pips = $[Z] at calculated position size", 
    "• Risk-Reward Ratio: [A:B] (TP1 vs SL distance)",
    "• Correlation Warning: [None/USD exposure/Commodity overlap/etc]",
    "",
    "Essential Trade Quality Checks:",
    "- Minimum 1.5:1 R:R ratio (enforced by system validation)",
    "- Entry must reference specific chart structure (swing high/low, order block, S/R)",
    "- Clear stop loss placement behind structure level",
    "- Take profits at opposing structure levels",
    "",
    "Structure-Based Entry Requirements:",
    "- Entry must be at identified chart structure (swing high/low, order block, S/R level)",
    "- Stop loss placed beyond the structure level with appropriate buffer",  
    "- Take profits target opposing structure levels on the charts",
    "- All levels must reference specific timeframe source (15M/1H/4H structure)",
    "",
    "Consistency rule:",
    "- If Calendar/Headlines/CSM align, do not say 'contradicting'; say 'aligning'.",
    "- 'Tech vs Fundy Alignment' must be Match when aligned, Mismatch when conflicted.",
    "",
    `Keep instrument alignment with ${instrument}.`,
    warn !== null ? `\nCALENDAR WARNING: High-impact event within ~${warn} min. Avoid impulsive market entries right before release.` : "",
    bias ? `\nPOST-RESULT ALIGNMENT: ${bias}.` : "",
    "",
    "MARKET STRUCTURE FOCUS:",
    "- Identify key support/resistance levels on all timeframes",
    "- Look for institutional order blocks and fair value gaps",
    "- Note any recent liquidity grabs or stop hunts",
    "- Assess current price position relative to major structure",
    "",
    "Under **Fundamental View**, you MUST include the complete calendar analysis provided.",
    "If calendar_status === 'image-ocr', use the calendar reasoning lines provided in the calendar evidence.",
    "Format: 'Calendar: [exact text from calendar analysis]' then list each event on new lines.",
    "NEVER write just 'Calendar: neutral' or 'Calendar: unavailable' without the supporting evidence lines.",
    "If truly no data exists, write: 'Calendar: [exact reason from analysis]'.",
  ];

  const scalpingLines = scalpingMode === "off" ? [] : scalpingMode === "soft" ? [
    "",
    "SCALPING MODE - SOFT (Conservative Intraday):",
    "- Respect 4H/1H trend fully. Build setups on 15M (primary). Use 5M for confirmation only.",
    "- Target: 15-30 pip moves with tighter stops than swing (12-20 pips vs 30-50 pips).",
    "- Entry: 15M order blocks, FVG, minor S/R within HTF structure.",
    "- Management: Partial at 1R, BE after 10-15 pips, time-stop after 2-4 hours.",
    "",
    "ai_meta: include {'mode':'scalping_soft', 'time_stop_minutes': 180, 'currentPrice': EXACT_PRICE_FROM_HINT}",
  ] : [
    "",
    "SCALPING MODE - HARD (Micro Execution):",
    "- If 4H/1H provided: quick bias check only (30 seconds). If not provided: assume 15M trend = bias.",
    "- PRIMARY: 15M structure → 5M confirmation (MANDATORY) → 1M precision entry (if provided).",
    "- Ignore macro levels. Focus: micro order blocks, 5M/1M FVG, session opens, round numbers.",
    "- CRITICAL: For market orders, entry MUST be current price (from hint). For limit orders, max 3-5 pips away from current.",
    "- 1M usage: Pin bar wicks, engulfing close, BOS candle. Entry at EXACT 1M wick level (e.g., 1.78536, not 1.7850).",
    "- Stop loss: 12-20 pips minimum (accounts for 2-3 pip spread + 2 pip slippage + 8-15 pip structure buffer).",
    "- SL Placement: Behind 5M structure preferred, 1M only for ultra-tight setups with high conviction.",
    "- Take profits: TP1 at 18-30 pips (1.5R min), TP2 at 30-40 pips (2R). Target actual resistance levels.",
    "- Spread considerations: Add 3 pips to all calculations (entry slippage + exit spread costs).",
    "- If 1M shows conflicting momentum vs 15M setup, note this as execution risk but proceed with 15M plan.",
    "- Session-specific: London open (8-10am GMT), NY open (1:30-3:30pm GMT), Asia range breakout.",
    "- Management: partial at 1R, BE after 1.2R (account for spread), time-stop within 30-45 min.",
    "",
    "SCALPING VALIDATION OVERRIDES:",
    "- Minimum SL distance for hard scalping: 12 pips (overrides normal 15 pip minimum)",
    "- Maximum SL distance for hard scalping: 25 pips (tighter than normal 80 pip maximum)",
    "- R:R requirement reduced to 1.2:1 minimum for scalping (vs 1.5:1 normal)",
    "",
    "ai_meta: include {'mode':'scalping_hard', 'vwap_used': boolean if VWAP referenced, 'time_stop_minutes': 20, 'currentPrice': EXACT_PRICE_FROM_HINT}",
    "",
    "CRITICAL: ai_meta MUST include 'currentPrice' field with the exact current market price from the hint provided. This is used for validation."
  ];
  
  return [...baseLines, ...scalpingLines].join("\n");
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
  const bos4H = getBOSStatus(args.instrument, "240");
  const bos1H = getBOSStatus(args.instrument, "60");
  const bos15M = getBOSStatus(args.instrument, "15");
  const bos5M = getBOSStatus(args.instrument, "5");
  
  const bosContext = (bos4H !== "NONE" || bos1H !== "NONE" || bos15M !== "NONE" || bos5M !== "NONE")
    ? `\n\nRECENT STRUCTURE BREAKS (from TradingView indicator):\n- 4H: ${bos4H === "NONE" ? "No recent BOS" : "BOS " + bos4H}\n- 1H: ${bos1H === "NONE" ? "No recent BOS" : "BOS " + bos1H}\n- 15M: ${bos15M === "NONE" ? "No recent BOS" : "BOS " + bos15M}\n- 5M: ${bos5M === "NONE" ? "No recent BOS" : "BOS " + bos5M}\n`
    : "\n\nRECENT STRUCTURE BREAKS: No BOS data from TradingView (check if alerts are active)\n";

  const parts: any[] = [
    { type: "text", text: `Instrument: ${args.instrument}\nDate: ${args.dateStr}${bosContext}

MULTI-TIMEFRAME ANALYSIS PROTOCOL - INSTITUTIONAL HIERARCHY:

STEP 1: 4H BIAS DETERMINATION (Market Direction)
- Identify overall trend: UPTREND/DOWNTREND/RANGE
- Key structure levels: Major S/R, round numbers, session extremes
- Current price position: At highs/middle/lows
- BOS status and market structure state
- BIAS OUTPUT: "4H BIAS: [BULLISH/BEARISH/NEUTRAL] - Price [location] in [trend] structure"

STEP 2: 1H INDEPENDENT ANALYSIS (Setup Construction)
CRITICAL: Analyze 1H chart INDEPENDENTLY first, then compare to 4H

2A: INDEPENDENT 1H STRUCTURE READING:
- Look at 1H swing highs from left to right: State 3-5 exact prices
- Look at 1H swing lows from left to right: State 3-5 exact prices
- DETERMINE 1H TREND INDEPENDENTLY:
  * If both highs AND lows ascending → 1H UPTREND
  * If both highs AND lows descending → 1H DOWNTREND
  * If mixed pattern → 1H RANGE
- Example: "1H highs: 0.6680 → 0.6720 → 0.6750 = ascending"
- Example: "1H lows: 0.6550 → 0.6580 → 0.6600 = ascending"
- Independent 1H verdict: UPTREND (both ascending)

2B: COMPARE 1H TO 4H BIAS:
- 4H bias from Step 1: [state it]
- 1H independent bias: [state it]
- Relationship:
  * If same direction → "CONFIRMS 4H bias"
  * If opposite direction → "CONFLICTS with 4H - counter-trend move"
  * If 1H range but 4H trending → "CONSOLIDATION within 4H trend"

2C: PATTERN & SETUP IDENTIFICATION:
- Current 1H pattern: Continuation / Reversal / Range breakout
- Key 1H support: [price] | Key 1H resistance: [price]
- Setup type: [Pullback entry / Breakout confirmation / Reversal at extreme]

1H CONTEXT OUTPUT: "1H BIAS: [INDEPENDENT DIRECTION] - [CONFIRMS/CONFLICTS/CONSOLIDATES] 4H [direction]. Setup type: [pattern]"
Example: "1H BIAS: UPTREND (ascending structure) - CONFLICTS with 4H downtrend. Counter-trend bounce in progress."

STEP 3: 15M CHART CONTEXT ANALYSIS (Structure & Momentum Reading)
- DO NOT suggest entries yet - this is chart reading only
- Identify current 15M trend: UPTREND (higher highs + higher lows) / DOWNTREND (lower highs + lower lows) / RANGING
- Recent 15M swing high price: [state exact price from chart]
- Recent 15M swing low price: [state exact price from chart]
- Current 15M momentum: Bullish/Bearish/Consolidating
- Key 15M structure levels: Support at [price], Resistance at [price]
- 15M position relative to 1H setup: [approaching resistance / at support / mid-range / etc]
- CONTEXT OUTPUT: "15M CONTEXT: [Current trend] with price at [location], approaching [next structure level]"

STEP 4: STRATEGY TOURNAMENT & TRADE EXECUTION PLAN (After analyzing all charts)
- NOW you can suggest entries based on multi-timeframe analysis
- Run 5-strategy tournament as specified earlier
- Build Option 1 (Primary) and Option 2 (Alternative)
- EXECUTION OUTPUT: Comes in 'Option 1' and 'Option 2' sections below

MANDATORY TIMEFRAME LABELS:
- Entry: Always specify source (e.g., "0.6545 (15M order block)", "1.2850-1.2860 (1H support zone)")
- Stop Loss: State exact structure used (e.g., "0.6575 (above 1H swing high)", "1.2820 (below 15M support)")  
- Take Profits: Label target timeframe (e.g., "TP1 0.6500 (15M resistance)", "TP2 0.6450 (1H major support)")

CRITICAL HIERARCHY RULES:
- 4H bias OVERRIDES lower timeframes (don't fade strong 4H trends)
- 1H provides setup context within 4H bias
- 15M provides execution timing ONLY (never changes the setup thesis)
- If timeframes conflict, explain which takes priority and why` },
    { type: "text", text: "4H BIAS CHART - Determine overall market direction and key levels:" },
    { type: "image_url", image_url: { url: args.h4 } },
    { type: "text", text: "1H CONTEXT CHART - Setup construction within 4H bias:" },
    { type: "image_url", image_url: { url: args.h1 } },
    { type: "text", text: "15M CHART - Structure and momentum context (do NOT suggest trades yet):" },
    { type: "image_url", image_url: { url: args.m15 } },
  ];
  
  if (args.m5) { parts.push({ type: "text", text: "Scalp 5M Chart" }); parts.push({ type: "image_url", image_url: { url: args.m5 } }); }
  if (args.m1) { parts.push({ type: "text", text: "Timing 1M Chart" }); parts.push({ type: "image_url", image_url: { url: args.m1 } }); }
  if (args.calendarDataUrl) { parts.push({ type: "text", text: "Economic Calendar Image:" }); parts.push({ type: "image_url", image_url: { url: args.calendarDataUrl } }); }
  if (!args.calendarDataUrl && args.calendarText) { 
    const calBlock = args.calendarEvidence && args.calendarEvidence.length > 0
      ? `Calendar Analysis:\n${args.calendarText}\n\nEvents:\n${args.calendarEvidence.join("\n")}`
      : `Calendar Analysis:\n${args.calendarText}`;
    parts.push({ type: "text", text: calBlock }); 
  }
  if (args.calendarAdvisoryText) { parts.push({ type: "text", text: `Calendar advisory:\n${args.calendarAdvisoryText}` }); }
  if (args.calendarEvidence && args.calendarEvidence.length && args.calendarDataUrl) { 
    parts.push({ type: "text", text: `MANDATORY: Use this calendar analysis in your Fundamental View:\n${args.calendarEvidence.join("\n")}` }); 
  }
  if (args.headlinesText) { parts.push({ type: "text", text: `Headlines snapshot:\n${args.headlinesText}` }); }
  if (args.sentimentText) { parts.push({ type: "text", text: `Sentiment snapshot (server):\n${args.sentimentText}` }); }
  if (args.debugOCRRows && args.debugOCRRows.length) {
    const rows = args.debugOCRRows.map(r => `${r.timeISO ?? "n/a"} | ${r.currency ?? "??"} | ${r.title ?? "??"} | A:${r.actual ?? "?"} F:${r.forecast ?? "?"} P:${r.previous ?? "?"}`).join("\n");
    parts.push({ type: "text", text: `DEBUG OCR ROWS (first 3):\n${rows}` });
  }
  return parts;
}

function messagesFull(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string; m5?: string | null; m1?: string | null;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  calendarAdvisory?: { warningMinutes?: number | null; biasNote?: string | null; advisoryText?: string | null; evidence?: string[] | null; debugRows?: any[] | null; preReleaseOnly?: boolean | null };
  provenance?: any;
  scalpingMode?: "soft" | "hard" | "off";
}) {
  const system = [
    systemCore(args.instrument, args.calendarAdvisory, args.scalpingMode), "",
    "EXECUTION REALISM - REAL WORLD CONSIDERATIONS:",
    "",
    "SPREAD AND SLIPPAGE ADJUSTMENTS:",
    "- Major pairs (EUR/USD, GBP/USD): 2-3 pip spread typical",
    "- Minor pairs (EUR/GBP, AUD/CAD): 3-5 pip spread typical", 
    "- Exotic pairs: 5-15 pip spread typical",
    "- Market orders: Add 1-2 pips slippage in normal conditions",
    "- News events: Spreads can widen to 10-20 pips temporarily",
    "",
    "ORDER EXECUTION MODELING:",
    "- Limit orders: May not fill if market gaps through level",
    "- Stop orders: May fill with slippage during fast moves",
    "- Market orders: Immediate fill but at current bid/ask",
    "- Partial fills: Large positions may require scaling in/out",
    "",
    "BROKER LIMITATIONS:",
    "- Weekend gaps: Price may open away from Friday close",
    "- Margin requirements: Typically 2-5% for major pairs",
    "- Position size limits: Based on account equity and leverage",
    "- Trading hours: Some brokers close briefly during rollover",
    "",
    "REAL-WORLD ADJUSTMENTS:",
    "- Add spread to entry calculations: Buy at ask, sell at bid",
    "- Widen stops by 2-3 pips to account for spread/slippage",
    "- Reduce targets by 1-2 pips for realistic profit taking",
    "- Consider order queue depth for large positions",
    "",
"MANDATORY OUTPUT STRUCTURE - ALL SECTIONS REQUIRED:",
"",
"Your response MUST contain ALL these sections in this EXACT order:",
"",
"**4H BIAS DETERMINATION:**",
"• Trend: [UPTREND/DOWNTREND/RANGE]",
"• Swing Structure: [ascending/descending highs and lows with exact prices]",
"• Key Levels: [Major S/R levels with prices]",
"• Position: [At highs/middle/lows]",
"• BOS Status: [UP/DOWN/NONE]",
"• 4H BIAS: [BULLISH/BEARISH/NEUTRAL] - [Reasoning]",
"",
"**1H CONTEXT ANALYSIS:**",
"• Independent Trend: [UPTREND/DOWNTREND/RANGE]",
"• Swing Highs: [List 3-5 exact prices chronologically]",
"• Swing Lows: [List 3-5 exact prices chronologically]",
"• Relationship to 4H: [CONFIRMS/CONFLICTS/CONSOLIDATES]",
"• Pattern: [Continuation/Reversal/Range breakout]",
"• 1H BIAS: [Direction] - [Setup type]",
"",
"**15M EXECUTION CONTEXT:**",
"• Current Trend: [UPTREND/DOWNTREND/RANGING]",
"• Recent High: [Exact price] | Recent Low: [Exact price]",
"• Current Price: [Exact price from rightmost candle]",
"• Momentum: [Bullish/Bearish/Consolidating]",
"• Key Structure: Support at [price], Resistance at [price]",
"• 15M Position: [At support/resistance/mid-range]",
"",
"**Market Context Assessment:**",
"• Move Maturity: [X] pips from [swing level at price] = [FRESH/DEVELOPING/EXTENDED/EXHAUSTED]",
"• Structural Position: [Current price] is at [support/resistance/mid-range] = [GOOD/POOR] for [LONG/SHORT]",
"• Market Regime: [TRENDING/RANGING] based on [observation]",
"• Exhaustion Signals: [count] detected - [list them if any]",
"• **CONTEXT GRADE: [A/B/C/D]**",
"• Conviction Adjustment: [percentage reduction if any]",
"",
"**Strategy Tournament Results:**",
"[Show all 5 strategies scored 0-100 with reasoning]",
"",
"**Option 1 (Primary)**",
"• Strategy: [Name of winner strategy from tournament]",
"• Direction: ...",
"• Order Type: ...",
"• Trigger:", 
"• Entry (zone or single):", 
"• Stop Loss:", 
"• Take Profit(s): TP1 / TP2",
"• Spread Adjustment: Entry ±[X] pips, SL +[Y] pips buffer",
"• Conviction: <0–100>% (independent calculation for this option)",
"• Why this is primary:",
"",
"**Option 2 (Alternative)**",
"• Strategy: [Name of runner-up strategy from tournament]",
"• Direction: ...",
"• Order Type: ...",
"• Trigger:", 
"• Entry (zone or single):", 
"• Stop Loss:", 
"• Take Profit(s): TP1 / TP2",
"• Spread Adjustment: Entry ±[X] pips, SL +[Y] pips buffer",
"• Conviction: <0–100>% (must be 10-20% lower than Option 1)",
"• Why this alternative:",
"",
"**Performance Tracking**",
"• Expected R:R Ratio: [Calculated from entry/SL/TP levels]",
"• Strategy Attribution: [Primary strategy from tournament]",
"• Setup Quality: [High/Medium/Low] based on confluence factors",
"",
"**Trade Management - Essential Metrics**",
"• Stop Loss Distance: [X] pips from entry to SL",
"• Risk-Reward Ratio: [X:1] (minimum 1.5:1 required)",
"• Entry Logic: Structure-based with clear invalidation level",
"",
"**Full Breakdown**",
"• Technical View (HTF + Intraday): 4H/1H/15m structure (include 5m/1m if used)",
"• Market Context Grade: [A/B/C/D] - [Brief explanation]",
"• Move Maturity: [X] pips from [swing at price level]",
"• Position Quality: [At support/resistance/mid-range] = [Good/Poor for trade direction]",
"• Fundamental View (Calendar + Sentiment + Headlines) — include explicit Calendar bias",
"• Tech vs Fundy Alignment: Match | Mismatch (+why)",
"• Validation Results: [All checks passed/Failed validations listed]",
"• Market Regime: [Trending/Ranging/Breakout/News-driven] with implications",
"• Conditional Scenarios: [If price does X, then Y]",
"• Surprise Risk: [What could unexpectedly go wrong]",
"• Invalidation: [Specific price level where setup fails]",
"• One-liner Summary: [Single sentence trade thesis]",
"",
"**Trade Summary**",
"• Instrument: [PAIR]",
"• Primary Strategy: [Strategy from tournament winner]", 
"• Setup Quality: [High/Medium/Low] based on confluence",
"• Key Invalidation: [Price level where setup becomes wrong]",
"",
"**Trade Validation**",
"• Logic Check: Trade direction aligns with analysis reasoning",
"• Price Validation: Entry/SL/TP levels are structure-based and realistic",
"• R:R Confirmation: Minimum 1.5:1 ratio achieved",
"",
"**Trader's Honest Assessment**",
"",
"Answer these like you're explaining to a fellow trader:",
"",
"• What's the best case? [Describe if everything goes right]",
"• What's the realistic case? [Most likely outcome]",
"• What's the risk case? [What could go wrong]",
"• Would I take this? [Yes/No/Maybe with clear reasoning]",
"• Key concern: [Main risk or uncertainty about this setup]",
"",
"If this is a C or D grade setup, you MUST state:",
"'⚠️ This is a lower-probability setup. Consider waiting for [specific better condition].'",

    "",
    "OUTPUT format (in this exact order):",
    "Option 1 (Primary)",
    "• Strategy: [Name of winner strategy from tournament]",
    "• Direction: ...",
    "• Order Type: ...",
    "• Trigger:", 
    "• Entry (zone or single):", 
    "• Stop Loss:", 
    "• Take Profit(s): TP1 / TP2",
    "• Spread Adjustment: Entry ±[X] pips, SL +[Y] pips buffer",
    "• Conviction: <0–100>% (independent calculation for this option)",
    "• Why this is primary:",
    "",
    "Option 2 (Alternative)",
    "• Strategy: [Name of runner-up strategy from tournament]",
    "• Direction: ...",
    "• Order Type: ...",
    "• Trigger:", 
    "• Entry (zone or single):", 
    "• Stop Loss:", 
    "• Take Profit(s): TP1 / TP2",
    "• Spread Adjustment: Entry ±[X] pips, SL +[Y] pips buffer",
    "• Conviction: <0–100>% (independent calculation - typically 10-20% lower than Option 1)",
    "• Why this alternative: [Explain why runner-up strategy also has merit here]",
    "",
    "Performance Tracking",
    "• Expected R:R Ratio: [Calculated from entry/SL/TP levels]",
    "• Strategy Attribution: [Primary strategy from tournament]",
    "• Setup Quality: [High/Medium/Low] based on confluence factors",
    "",
    "Trade Management - Essential Metrics",
    "• Stop Loss Distance: [X] pips from entry to SL",
    "• Risk-Reward Ratio: [X:1] (minimum 1.5:1 required)",
    "• Entry Logic: Structure-based with clear invalidation level",
    "",
    "Full Breakdown",
    "• Technical View (HTF + Intraday): 4H/1H/15m structure (include 5m/1m if used)",
    "• Market Context Grade: [A/B/C/D] - [Brief explanation]",
    "• Move Maturity: [X] pips from [swing at price level]",
    "• Position Quality: [At support/resistance/mid-range] = [Good/Poor for trade direction]",
    "• Fundamental View (Calendar + Sentiment + Headlines) — include explicit Calendar bias for <PAIR> when available; if pre-release, say: 'Pre-release only, no confirmed bias until data is out.'",
    "• Tech vs Fundy Alignment: Match | Mismatch (+why)",
    "• Validation Results: [All checks passed/Failed validations listed]",
    "• Market Regime: [Trending/Ranging/Breakout/News-driven] with implications",
    "• Conditional Scenarios:",
    "• Surprise Risk:",
    "• Invalidation:",
    "• One-liner Summary:",
    "",
    "Trade Summary",
    "• Instrument: [PAIR]",
    "• Primary Strategy: [Strategy from tournament winner]", 
    "• Setup Quality: [High/Medium/Low] based on confluence",
    "• Key Invalidation: [Price level where setup becomes wrong]",
    "",
    "Trade Validation",
    "• Logic Check: Trade direction aligns with analysis reasoning",
    "• Price Validation: Entry/SL/TP levels are structure-based and realistic",
    "• R:R Confirmation: Minimum 1.5:1 ratio achieved",
    "",
    "Trader's Honest Assessment",
    "",
    "Answer these like you're explaining to a fellow trader:",
    "",
    "• What's the best case? [Describe if everything goes right]",
    "• What's the realistic case? [Most likely outcome]",
    "• What's the risk case? [What could go wrong]",
    "• Would I take this? [Yes/No/Maybe with clear reasoning]",
    "• Key concern: [Main risk or uncertainty about this setup]",
    "",
    "If this is a C or D grade setup, you MUST state:",
    "'⚠️ This is a lower-probability setup. Consider waiting for [specific better condition].'",
    "",
    "CRITICAL: End your response with this EXACT format:",
    "```json",
    "ai_meta",
    "{",
    "  \"currentPrice\": [PUT_CURRENT_PRICE_HERE_OR_UNREADABLE]",
    "}",
    "```",
    "Replace [PUT_CURRENT_PRICE_HERE_OR_UNREADABLE] with either:",
    "- The exact price number: 0.65318",
    "- Or the text: \"UNREADABLE\" if you cannot read it",
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

async function enforceAllSections(model: string, instrument: string, text: string): Promise<string> {
  const requiredSections = [
    { name: "4H BIAS", pattern: /4H\s+BIAS\s*(?:DETERMINATION)?:/i },
    { name: "1H CONTEXT", pattern: /1H\s+CONTEXT\s*(?:ANALYSIS)?:/i },
    { name: "15M EXECUTION", pattern: /15M\s+(?:EXECUTION\s+)?CONTEXT:/i },
    { name: "Market Context Assessment", pattern: /Market\s+Context\s+Assessment:/i },
    { name: "Strategy Tournament Results", pattern: /Strategy\s+Tournament\s+Results:/i },
    { name: "Option 1 (Primary)", pattern: /Option\s+1\s*\(?(Primary)?\)?/i },
    { name: "Option 2 (Alternative)", pattern: /Option\s+2\s*\(?(Alternative)?\)?/i },
    { name: "Performance Tracking", pattern: /Performance\s+Tracking/i },
    { name: "Trade Management", pattern: /Trade\s+Management/i },
    { name: "Full Breakdown", pattern: /Full\s+Breakdown/i },
    { name: "Trade Summary", pattern: /Trade\s+Summary/i },
    { name: "Trade Validation", pattern: /Trade\s+Validation/i },
    { name: "Trader's Honest Assessment", pattern: /Trader'?s\s+Honest\s+Assessment/i }
  ];
  
  const missing = requiredSections.filter(section => !section.pattern.test(text));
  
  if (missing.length === 0) return text;
  
  const missingNames = missing.map(s => s.name).join(", ");
  console.warn(`[VISION-PLAN] Missing sections: ${missingNames}`);
  
  const messages = [
    {
      role: "system",
      content: `Add these missing MANDATORY sections: ${missingNames}. 
      
      CRITICAL for chart sections:
      - 4H BIAS: Must include trend, swings with exact prices, key levels, BOS status
      - 1H CONTEXT: Must show independent analysis with exact swing prices
      - 15M EXECUTION: Must show current price, recent highs/lows, momentum
      - Market Context Assessment: Must include move maturity calculation and context grade
      
      Each section is MANDATORY. Follow the exact format specified in the OUTPUT structure.`
    },
    {
      role: "user",
      content: `Instrument: ${instrument}\n\n${text}\n\nAdd missing sections: ${missingNames}`
    }
  ];
  
  return callOpenAI(model, messages);
}

// ---------- Enforcement helpers ----------
function hasCompliantOption2(text: string): boolean {
  if (!/Option\s*2/i.test(text || "")) return false;
  const block = (text.match(/Option\s*2[\s\S]{0,800}/i)?.[0] || "").toLowerCase();
  const must = ["direction", "order type", "trigger", "entry", "stop", "tp", "conviction"];
  return must.every((k) => block.includes(k));
}

async function enforceOption2(model: string, instrument: string, text: string) {
  if (hasCompliantOption2(text)) return text;
  
  // Extract tournament results to guide Option 2
  const tournamentBlock = text.match(/Strategy Tournament Results:[\s\S]{200,2000}/i)?.[0] || "";
  const scores: Array<{name: string, score: number}> = [];
  const scoreMatches = tournamentBlock.matchAll(/(\w+[\s\w]*?):\s*(\d+)/g);
 for (const match of scoreMatches) {
    const score = parseInt(match[2]);
    if (isFinite(score)) {
      scores.push({name: match[1], score});
    }
}
  scores.sort((a, b) => b.score - a.score);
  
  const runnerUp = scores.length > 1 ? scores[1].name : "alternative approach";
  
  const messages = [
    { role: "system", content: `Add **Option 2 (Alternative)** using the RUNNER-UP strategy from tournament: "${runnerUp}". Must have SAME direction as Option 1 (never mix long/short). Build complete trade with: Direction, Order Type, Trigger, Entry (zone or single), SL, TP1/TP2, Conviction %. Use the strategy template for ${runnerUp}.` },
    { role: "user", content: `Instrument: ${instrument}\n\n${text}\n\nAdd Option 2 using runner-up strategy: ${runnerUp}` },
  ];
  return callOpenAI(model, messages);
}

function hasOption1(text: string): boolean { return /Option\s*1\s*\(?(Primary)?\)?/i.test(text || ""); }

async function enforceOption1(model: string, instrument: string, text: string) {
  if (hasOption1(text)) return text;
  const messages = [
    { role: "system", content: "Insert a labeled 'Option 1 (Primary)' block BEFORE 'Option 2'. Use the primary trade details already present. Include Direction, Order Type, Trigger, Entry (zone or single), SL, TP1/TP2, Conviction %. Keep other content unchanged." },
    { role: "user", content: `Instrument: ${instrument}\n\n${text}\n\nAdd/normalize 'Option 1 (Primary)' as specified.` },
  ];
  return callOpenAI(model, messages);
}

async function enforceStrategyTournament(model: string, instrument: string, text: string) {
  if (/Strategy\s+Tournament\s+Results/i.test(text)) return text;
  const messages = [
    { role: "system", content: "Add a 'Strategy Tournament Results' section before the trade options. Score each of the 5 strategies (Structure Break & Retest, Order Block Reaction, Reversal at Extremes, Liquidity Grab, Fair Value Gap Fill) from 0-100 with reasoning. Winner becomes Option 1, runner-up becomes Option 2." },
    { role: "user", content: `Instrument: ${instrument}\n\n${text}\n\nAdd Strategy Tournament Results section as specified.` },
  ];
  return callOpenAI(model, messages);
}

async function validateOrderTypeLogic(model: string, instrument: string, text: string, currentPrice: number): Promise<string> {
  const dirMatch = text.match(/Direction:\s*(Long|Short)/i);
  const orderMatch = text.match(/Order Type:\s*(Limit|Stop|Market)/i);
  const entryMatch = text.match(/Entry[^:]*:\s*([\d.]+(?:-[\d.]+)?)/i);
  // Check for trigger/order type conflicts
  const triggerMatch = text.match(/Trigger:\s*([^\n]+)/i);
  if (triggerMatch && orderMatch) {
    const trigger = triggerMatch[1].toLowerCase();
    const orderType = orderMatch[1].toLowerCase();
    
    // Market orders can't have future triggers
    if (orderType === "market" && (trigger.includes("break") || trigger.includes("wait") || trigger.includes("reach"))) {
      const messages = [
        { role: "system", content: "FIX CONFLICT: Market orders execute immediately and cannot have future triggers like 'break below' or 'wait for'. Either change to LIMIT/STOP order, or change trigger to 'immediate execution'. Keep all other analysis unchanged." },
        { role: "user", content: `${instrument}\n\n${text}\n\nFIX: Market order cannot wait for "${trigger}".` }
      ];
      return callOpenAI(model, messages);
    }
  }
  if (!dirMatch || !orderMatch || !entryMatch) return text;
  
  const direction = dirMatch[1].toLowerCase();
  const orderType = orderMatch[1].toLowerCase();
  const entryStr = entryMatch[1];
  
  const entryNums = entryStr.split('-').map(Number);
  const minEntry = Math.min(...entryNums);
  const maxEntry = Math.max(...entryNums);
  
if (orderType === "limit") {
    const minDistancePips = 15;
    const pipValue = instrument.includes("JPY") ? 0.01 : 0.0001;
    
    if (direction === "long") {
      if (minEntry >= currentPrice) {
        const messages = [
          { role: "system", content: `FIX CRITICAL ERROR: Long Limit MUST be BELOW current price by at least ${minDistancePips} pips. Current: ${currentPrice}, Your entry: ${entryStr} is AT/ABOVE current. This is impossible - limit orders execute when price REACHES the level. For long, price must FALL to your entry. Find support structure BELOW ${currentPrice} or use market order. Keep other analysis unchanged.` },
          { role: "user", content: `Current ${instrument}: ${currentPrice}\n\n${text}\n\nFIX: Long Limit at ${entryStr} impossible. Need entry BELOW current price.` }
        ];
        return callOpenAI(model, messages);
      }
      
      const distancePips = (currentPrice - maxEntry) / pipValue;
      if (distancePips < minDistancePips) {
        const messages = [
          { role: "system", content: `FIX: Long Limit too close. Current: ${currentPrice}, Entry: ${entryStr}, Distance: ${distancePips.toFixed(1)} pips. Need minimum ${minDistancePips} pips. Current price might already hit your entry on next tick. Find structure at least ${minDistancePips} pips BELOW current, or use market order. Keep other analysis unchanged.` },
          { role: "user", content: `${instrument}\n\n${text}\n\nFIX: Entry only ${distancePips.toFixed(1)} pips away. Need ${minDistancePips}+ pips distance.` }
        ];
        return callOpenAI(model, messages);
      }
    }
    
    if (direction === "short") {
      if (maxEntry <= currentPrice) {
        const messages = [
          { role: "system", content: `FIX CRITICAL ERROR: Short Limit MUST be ABOVE current price by at least ${minDistancePips} pips. Current: ${currentPrice}, Your entry: ${entryStr} is AT/BELOW current. This is impossible - limit orders execute when price REACHES the level. For short, price must RISE to your entry. Find resistance structure ABOVE ${currentPrice} or use market order. Keep other analysis unchanged.` },
          { role: "user", content: `Current ${instrument}: ${currentPrice}\n\n${text}\n\nFIX: Short Limit at ${entryStr} impossible. Need entry ABOVE current price.` }
        ];
        return callOpenAI(model, messages);
      }
      
      const distancePips = (minEntry - currentPrice) / pipValue;
      if (distancePips < minDistancePips) {
        const messages = [
          { role: "system", content: `FIX: Short Limit too close. Current: ${currentPrice}, Entry: ${entryStr}, Distance: ${distancePips.toFixed(1)} pips. Need minimum ${minDistancePips} pips. Current price might already hit your entry on next tick. Find structure at least ${minDistancePips} pips ABOVE current, or use market order. Keep other analysis unchanged.` },
          { role: "user", content: `${instrument}\n\n${text}\n\nFIX: Entry only ${distancePips.toFixed(1)} pips away. Need ${minDistancePips}+ pips distance.` }
        ];
        return callOpenAI(model, messages);
      }
    }
  }
  
  return text;
}

async function enforceEntryFormat(model: string, instrument: string, text: string): Promise<string> {
  const limitSingleMatch = text.match(/Order Type:\s*Limit[\s\S]{0,300}Entry[^:]*:\s*(\d+\.\d+)\s*\([^)]*\)/i);
  if (limitSingleMatch && !/-/.test(limitSingleMatch[1])) {
    const messages = [
      { role: "system", content: "FIX: Limit orders MUST use range format (e.g., '0.6555-0.6565'), not single point. Convert single-point limit entries to proper ranges. Width: 10-15 pips for structure zones." },
      { role: "user", content: `${instrument}\n\n${text}\n\nFIX: Convert limit entry "${limitSingleMatch[1]}" to range format.` }
    ];
    return callOpenAI(model, messages);
  }
  return text;
}

function stampM5Used(text: string, used: boolean) {
  if (!used) return text;
  const stamp = "• Used Chart: 5M execution";
  let out = text;
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
  if (/Option\s*1\s*\(?(Primary)?\)?/i.test(out) && !/Used\s*Chart:\s*1M/i.test(out)) {
    out = out.replace(/(Option\s*1[\s\S]*?)(\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i, (m, a, b) => {
      return /•\s*Used\s*Chart:\s*1M/i.test(a) ? m : `${a}\n${stamp}\n${b}`;
    });
  }
  return out;
}

function applyConsistencyGuards(text: string, args: { instrument: string; headlinesSign: number; csmSign: number; calendarSign: number; }) {
  let out = text || "";
  const signs = [args.headlinesSign, args.csmSign, args.calendarSign].filter((s) => s !== 0);
  const hasPos = signs.some((s) => s > 0);
  const hasNeg = signs.some((s) => s < 0);
  
  const strongConflict = hasPos && hasNeg && signs.length >= 2;
  const aligned = signs.length > 0 && ((hasPos && !hasNeg) || (hasNeg && !hasPos));
  
  const techBullish = /Direction:\s*Long/i.test(out);
  const techBearish = /Direction:\s*Short/i.test(out);
  const fundyBullish = hasPos && !hasNeg;
  const fundyBearish = hasNeg && !hasPos;
  
  const fundamentalTechnicalConflict = 
    (techBullish && fundyBearish) || 
    (techBearish && fundyBullish);

  if (aligned) out = out.replace(/contradict(?:ion|ing|s)?/gi, "aligning");
  
  const reTF = /(Tech\s*vs\s*Fundy\s*Alignment:\s*)(Match|Mismatch)/i;
  if (reTF.test(out)) {
    let alignment;
    if (fundamentalTechnicalConflict) {
      alignment = "Mismatch";
      out = out.replace(/Conviction:\s*(\d+)%/gi, (match, conv) => {
        const reducedConv = Math.min(Math.floor(Number(conv) * 0.6), 45);
        return `Conviction: ${reducedConv}%`;
      });
    } else if (strongConflict) {
      alignment = "Mismatch";
    } else if (aligned) {
      alignment = "Match";
    } else {
      alignment = "Neutral";
    }
    out = out.replace(reTF, (_, p1) => `${p1}${alignment}`);
  }
  return out;
}

// ---------- Live price ----------
interface PriceSource {
  provider: string;
  price: number;
  latency: number;
  confidence: number;
}

async function fetchLivePriceConsensus(pair: string): Promise<{ consensus: number; sources: PriceSource[]; confidence: number } | null> {
  const sources: Promise<PriceSource | null>[] = [];
  
  if (TD_KEY) sources.push(fetchTwelveDataPrice(pair));
  if (FH_KEY) sources.push(fetchFinnhubPrice(pair));
  if (POLY_KEY) sources.push(fetchPolygonPrice(pair));
  
  const timeoutPromise = new Promise<never>((_, reject) => 
    setTimeout(() => reject(new Error('Price consensus timeout')), 5000)
  );
  
  const results = await Promise.race([
    Promise.allSettled(sources),
    timeoutPromise
  ]).catch(() => []);
  
  if (!Array.isArray(results)) return null;
  
  const validSources: PriceSource[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value !== null) {
      validSources.push(result.value);
    }
  }
    
  if (validSources.length === 0) return null;
  
  const totalWeight = validSources.reduce((sum, s) => sum + s.confidence, 0);
  const consensus = validSources.reduce((sum, s) => sum + (s.price * s.confidence), 0) / totalWeight;
  
  const maxDiff = Math.max(...validSources.map(s => Math.abs(s.price - consensus) / consensus));
  const confidence = maxDiff < 0.001 ? 95 : maxDiff < 0.005 ? 85 : maxDiff < 0.01 ? 70 : 50;
  
  return { consensus, sources: validSources, confidence };
}

async function fetchTwelveDataPrice(pair: string): Promise<PriceSource | null> {
  const start = Date.now();
  try {
    const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
    const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&dp=5`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    const j: any = await r.json().catch(() => ({}));
    const p = Number(j?.price);
    if (isFinite(p) && p > 0) {
      return { provider: "TwelveData", price: p, latency: Date.now() - start, confidence: 0.4 };
    }
  } catch {}
  return null;
}

async function fetchFinnhubPrice(pair: string): Promise<PriceSource | null> {
  const start = Date.now();
  try {
    const sym = `OANDA:${pair.slice(0, 3)}_${pair.slice(3)}`;
    const to = Math.floor(Date.now() / 1000);
    const from = to - 60 * 60 * 3;
    const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(sym)}&resolution=15&from=${from}&to=${to}&token=${FH_KEY}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    const j: any = await r.json().catch(() => ({}));
    const c = Array.isArray(j?.c) ? j.c : [];
    const last = Number(c[c.length - 1]);
    if (isFinite(last) && last > 0) {
      return { provider: "Finnhub", price: last, latency: Date.now() - start, confidence: 0.3 };
    }
  } catch {}
  return null;
}

async function fetchPolygonPrice(pair: string): Promise<PriceSource | null> {
  const start = Date.now();
  try {
    const ticker = `C:${pair}`;
    const to = new Date();
    const from = new Date(to.getTime() - 60 * 60 * 1000);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=desc&limit=1&apiKey=${POLY_KEY}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    const j: any = await r.json().catch(() => ({}));
    const res = Array.isArray(j?.results) ? j.results[0] : null;
    const last = Number(res?.c);
    if (isFinite(last) && last > 0) {
      return { provider: "Polygon", price: last, latency: Date.now() - start, confidence: 0.3 };
    }
  } catch {}
  return null;
}

async function fetchLivePrice(pair: string): Promise<number | null> {
  const result = await fetchLivePriceConsensus(pair);
  return result?.consensus || null;
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

// Initialize BOS cache on module load
initializeBOSCache();

// ---------- Handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    const urlMode = String((req.query.mode as string) || "").toLowerCase();
    const debugQuery = String(req.query.debug || "").trim() === "1";

    // ---------- expand ----------
    if (urlMode === "expand") {
      const modelExpand = pickModelFromFields(req);
      const cacheKey = String(req.query.cache || "").trim();
      const c = getCache(cacheKey);
      if (!c) return res.status(400).json({ ok: false, reason: "Expand failed: cache expired or not found." });

      const dateStr = new Date().toISOString().slice(0, 10);
      const provHint = { headlines_present: !!c.headlinesText, calendar_status: c.calendar ? "image-ocr" : "unavailable" };

      const messages = messagesFull({
        instrument: c.instrument, dateStr,
        m15: c.m15, h1: c.h1, h4: c.h4, m5: c.m5 || null, m1: null,
        calendarDataUrl: c.calendar || undefined,
        headlinesText: c.headlinesText || undefined,
        sentimentText: c.sentimentText || undefined,
        calendarAdvisory: { warningMinutes: null, biasNote: null, advisoryText: null, evidence: [] },
        provenance: provHint,
        scalpingMode: "off",
      });

      let text = await callOpenAI(modelExpand, messages);
      text = await enforceOption1(modelExpand, c.instrument, text);
      text = await enforceOption2(modelExpand, c.instrument, text);

      const usedM5 = !!c.m5 && /(\b5m\b|\b5\-?min|\b5\s*minute)/i.test(text);
      text = stampM5Used(text, usedM5);

      const footer = buildServerProvenanceFooter({
        headlines_provider: "expand-uses-stage1",
        calendar_status: c.calendar ? "image-ocr" : "unavailable",
        calendar_provider: c.calendar ? "image-ocr" : null,
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
    const rawInstr = String(fields.instrument || fields.code || "").trim();
    if (!rawInstr) {
      return res.status(400).json({ ok: false, reason: "Missing 'instrument'. Provide instrument code (e.g., EURUSD)." });
    }
    const instrument = sanitizeInstrument(rawInstr);

    // Scalping mode detection
    const scalpingRaw = String(pickFirst(fields.scalping) || "").trim().toLowerCase();
    const scalpingHardRaw = String(pickFirst(fields.scalping_hard) || "").trim().toLowerCase();
    
    const scalpingMode = 
      (scalpingHardRaw === "1" || scalpingHardRaw === "true" || scalpingHardRaw === "on") ? "hard" :
      (scalpingRaw === "1" || scalpingRaw === "true" || scalpingRaw === "on") ? "soft" :
      "off";

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

    if (scalpingMode === "hard") {
      if (!m15 || !m5) {
        return res.status(400).json({ ok: false, reason: "Hard scalping requires: 15M + 5M minimum. 1M highly recommended. 1H/4H optional for bias." });
      }
    } else {
      if (!m15 || !h1 || !h4) {
        return res.status(400).json({ ok: false, reason: "Provide all three charts: m15, h1, h4 — either files or TV/Gyazo image links. (5m/1m optional)" });
      }
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

    // ---------- Calendar Handling ----------
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
      if (process.env.NODE_ENV !== "production") {
        console.log("[CALENDAR] Processing image via OCR");
      }
      const ocr = await ocrCalendarFromImage(MODEL, calUrlOrig).catch((err) => {
        console.error("[vision-plan] Calendar OCR error:", err?.message || err);
        return null;
      });
      
      if (ocr && Array.isArray(ocr.items) && ocr.items.length > 0) {
        if (process.env.NODE_ENV !== "production") {
          console.log(`[vision-plan] OCR extracted ${ocr.items.length} calendar rows`);
        }
        const analysis = analyzeCalendarProfessional(ocr.items, instrument);
        calendarProvider = "image-ocr";
        calendarStatus = "image-ocr";
        calendarText = analysis.reasoning[0];
        calendarEvidence = analysis.evidence;
        biasNote = analysis.reasoning.join("; ");
        advisoryText = analysis.details;
        calDataUrlForPrompt = calUrlOrig;
        
        const nowMs = Date.now();
        for (const it of ocr.items) {
          if (it?.impact === "High" && it?.timeISO) {
            const t = Date.parse(it.timeISO);
            if (isFinite(t) && t >= nowMs) {
              const mins = Math.floor((t - nowMs) / 60000);
              if (mins <= 60) warningMinutes = warningMinutes == null ? mins : Math.min(warningMinutes, mins);
            }
          }
        }
        
        if (debugOCR || debugQuery || debugField) {
          debugRows = ocr.items.slice(0, 5).map(r => ({
            timeISO: r.timeISO || null, title: r.title || null, currency: r.currency || null,
            impact: r.impact || null, actual: r.actual ?? null, forecast: r.forecast ?? null, previous: r.previous ?? null,
          }));
        }
      } else {
        console.warn("[vision-plan] Calendar OCR failed or returned no data");
        calendarProvider = "image-ocr-failed";
        calendarStatus = "unavailable";
        calendarText = "Calendar: Unable to extract data from image. Please ensure calendar image is clear and contains economic events.";
        calendarEvidence = [`Calendar image processing failed for ${instrument}`];
        biasNote = null;
        advisoryText = "📊 Technical Analysis Focus: Calendar data unavailable. Analysis based on price action and sentiment only.";
        warningMinutes = null;
        calDataUrlForPrompt = calUrlOrig;
      }
    } else {
      if (process.env.NODE_ENV !== "production") {
        console.log("[vision-plan] No calendar image provided");
      }
      calendarProvider = null;
      calendarStatus = "unavailable";
      calendarText = "Calendar: No calendar image provided";
      calendarEvidence = [`No calendar data for ${instrument} analysis`];
      biasNote = null;
      advisoryText = "📊 Upload calendar image for fundamental analysis enhancement";
      warningMinutes = null;
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

    const calendarSign = parseInstrumentBiasFromNote(biasNote);
    const headlinesSign = computeHeadlinesSign(hBias);
    const csmData = computeCSMInstrumentSign(csm, instrument);

    const provForModel = {
      headlines_present: !!headlinesText,
      calendar_status: calendarStatus,
      fundamentals_hint: {
        calendar_sign: calendarSign,
        headlines_label: hBias.label,
        csm_diff: csmData.zdiff,
        cot_cue_present: !!cotCue
      },
      proximity_flag: warningMinutes != null ? 1 : 0,
      scalping_mode: scalpingMode !== "off"
    };

    // ---------- FULL ANALYSIS ----------
    const messages = messagesFull({
      instrument, dateStr, 
      m15: m15!, 
      h1: h1 || "", 
      h4: h4 || "", 
      m5, m1,
      calendarDataUrl: calDataUrlForPrompt || undefined,
      calendarText: (!calDataUrlForPrompt && calendarText) ? calendarText : undefined,
      headlinesText: headlinesText || undefined,
      sentimentText,
      calendarAdvisory: { warningMinutes, biasNote, advisoryText, evidence: calendarEvidence || [], debugRows: debugOCR ? debugRows || [] : [], preReleaseOnly },
      provenance: provForModel,
      scalpingMode,
    });
    
    if (livePrice && scalpingMode === "hard") {
      (messages[0] as any).content = (messages[0] as any).content + `\n\n**HARD SCALPING PRICE LOCK**: ${instrument} is EXACTLY at ${livePrice} RIGHT NOW. For market orders, entry = ${livePrice} (no rounding). For limit orders, max 5 pips away. SL must be 5-8 pips. TP1 = 8-12 pips, TP2 = 12-18 pips. DO NOT round to .7850 or .50 levels.`;
    } else if (livePrice) {
      (messages[0] as any).content = (messages[0] as any).content + `\n\n**CRITICAL PRICE CHECK**: Current ${instrument} price is EXACTLY ${livePrice}. You MUST report this exact price in ai_meta.currentPrice. All entry suggestions must be within 15 points (0.4%) of this level for immediate execution.`;
    }

    let textFull = await callOpenAI(MODEL, messages);
    let aiMetaFull = extractAiMeta(textFull) || {};

    // Enhanced price validation
    if (livePrice) {
      const modelPrice = Number(aiMetaFull?.currentPrice);
      
      if (!isFinite(modelPrice) || modelPrice <= 0) {
        console.warn(`[VISION-PLAN] Model failed to report currentPrice, injecting live price ${livePrice}`);
        aiMetaFull.currentPrice = livePrice;
      } else {
        if (instrument.includes("BTC") || instrument.includes("ETH") || instrument.startsWith("CRYPTO")) {
          const percentDiff = Math.abs((modelPrice - livePrice) / livePrice);
          if (percentDiff > 0.05) {
            console.error(`[VISION-PLAN] Crypto price mismatch: Reported=${modelPrice}, Actual=${livePrice}, Diff=${(percentDiff*100).toFixed(1)}%`);
            return res.status(400).json({ 
              ok: false, 
              reason: `Price reading error: Model read ${modelPrice} but actual is ${livePrice} (${(percentDiff*100).toFixed(1)}% difference).` 
            });
          }
        } else if (instrument.includes("XAU") || instrument.includes("GOLD")) {
          const dollarDiff = Math.abs(modelPrice - livePrice);
          if (dollarDiff > 10) {
            console.error(`[VISION-PLAN] Gold price mismatch: Reported=${modelPrice}, Actual=${livePrice}, Diff=$${dollarDiff.toFixed(2)}`);
            return res.status(400).json({ 
              ok: false, 
              reason: `Price reading error: Model read ${modelPrice} but actual is ${livePrice} ($${dollarDiff.toFixed(2)} difference).` 
            });
          }
        } else if (instrument.includes("NAS") || instrument.includes("SPX") || instrument.includes("GER") || instrument.includes("UK100") || instrument.includes("JPN")) {
          const pointDiff = Math.abs(modelPrice - livePrice);
          if (pointDiff > 50) {
            console.error(`[VISION-PLAN] Index price mismatch: Reported=${modelPrice}, Actual=${livePrice}, Diff=${pointDiff.toFixed(1)} points`);
            return res.status(400).json({ 
              ok: false, 
              reason: `Price reading error: Model read ${modelPrice} but actual is ${livePrice} (${pointDiff.toFixed(1)} points difference).` 
            });
          }
        } else {
          const pipValue = instrument.includes("JPY") ? 0.01 : 0.0001;
          const pipDiff = Math.abs(modelPrice - livePrice) / pipValue;
          const maxPipDiff = 5;
          
          if (pipDiff > maxPipDiff) {
            console.error(`[VISION-PLAN] FX price mismatch: Reported=${modelPrice}, Actual=${livePrice}, Diff=${pipDiff.toFixed(1)} pips`);
            return res.status(400).json({ 
              ok: false, 
              reason: `Price reading error: Model read ${modelPrice} but actual is ${livePrice} (${pipDiff.toFixed(1)} pips difference).` 
            });
          }
        }
      }
    }

    if (livePrice && (aiMetaFull.currentPrice == null || !isFinite(Number(aiMetaFull.currentPrice)))) {
      aiMetaFull.currentPrice = livePrice;
    }

   textFull = await enforceOption1(MODEL, instrument, textFull);
    textFull = await enforceOption2(MODEL, instrument, textFull);
    textFull = await enforceStrategyTournament(MODEL, instrument, textFull);
    textFull = await enforceAllSections(MODEL, instrument, textFull);
    // Ensure both options have strategy names
    const opt1HasStrategy = /Option\s*1[\s\S]{50,300}Strategy[^:]*:\s*\w+/i.test(textFull);
    const opt2HasStrategy = /Option\s*2[\s\S]{50,300}Strategy[^:]*:\s*\w+/i.test(textFull);
    
    if (!opt1HasStrategy || !opt2HasStrategy) {
      const messages = [
        { role: "system", content: "Add missing strategy names. Each option MUST start with '• Strategy: [Strategy Name]'. Use tournament winner for Option 1, runner-up for Option 2." },
        { role: "user", content: `${instrument}\n\n${textFull}\n\nAdd strategy attribution lines.` }
      ];
      textFull = await callOpenAI(MODEL, messages);
    }
    // Validate tournament was actually used
    const tournamentMatch = textFull.match(/Strategy Tournament Results:[\s\S]{200,800}/i);
    const option1Match = textFull.match(/Option 1[\s\S]{100,500}Strategy.*?:\s*(\w+)/i);
    const option2Match = textFull.match(/Option 2[\s\S]{100,500}Strategy.*?:\s*(\w+)/i);
    
    if (tournamentMatch && option1Match && option2Match) {
      const strategy1 = option1Match[1];
      const strategy2 = option2Match[1];
      
      // Check if strategies are actually different and valid
     const validStrategies = [
  "Structure Break & Retest", "BOS Strategy", "Structure",
  "Order Block Reaction", "OB Strategy", "Order Block",
  "Reversal at Extremes", "Reversal Strategy", "Reversal",
  "Liquidity Grab", "Liquidity Strategy", "Liquidity",
  "Fair Value Gap Fill", "FVG Strategy", "FVG", "Fair Value"
];
const isValid1 = validStrategies.some(s => strategy1.toLowerCase().includes(s.toLowerCase()));
const isValid2 = validStrategies.some(s => strategy2.toLowerCase().includes(s.toLowerCase()));
      
      if (!isValid1 || !isValid2) {
        console.warn(`[VISION-PLAN] Tournament strategies not properly applied: ${strategy1} / ${strategy2}`);
      }
    }
if (tournamentMatch && option1Match && option2Match) {
      const strategy1 = option1Match[1];
      const strategy2 = option2Match[1];
      
      // Check if strategies are actually different and valid
      const validStrategies = ["Structure", "Order", "Reversal", "Liquidity", "Fair", "FVG", "BOS", "OB"];
      const isValid1 = validStrategies.some(s => strategy1.includes(s));
      const isValid2 = validStrategies.some(s => strategy2.includes(s));
      
      if (!isValid1 || !isValid2) {
        console.warn(`[VISION-PLAN] Tournament strategies not properly applied: ${strategy1} / ${strategy2}`);
      }
    }

    // Validate conviction differentiation between options
    const conv1Match = textFull.match(/Option\s*1[\s\S]{200,600}Conviction:\s*(\d+)%/i);
    const conv2Match = textFull.match(/Option\s*2[\s\S]{200,600}Conviction:\s*(\d+)%/i);
    
    if (conv1Match && conv2Match) {
      const conv1 = parseInt(conv1Match[1]);
      const conv2 = parseInt(conv2Match[1]);
      const diff = Math.abs(conv1 - conv2);
      
      if (diff < 5) {
        console.warn(`[VISION-PLAN] Conviction too similar: Opt1=${conv1}%, Opt2=${conv2}%, Diff=${diff}%`);
        const messages = [
          { role: "system", content: "FIX: Option 2 conviction must be 10-25% lower than Option 1 (it's the runner-up). Reduce Option 2 conviction by 15%. Keep all other content unchanged." },
          { role: "user", content: `${instrument}\n\n${textFull}\n\nFIX: Convictions too close (${conv1}% vs ${conv2}%). Reduce Option 2.` }
        ];
        textFull = await callOpenAI(MODEL, messages);
      }
      
      if (conv2 > conv1) {
        console.error(`[VISION-PLAN] Option 2 conviction higher than Option 1: ${conv2}% > ${conv1}%`);
        return res.status(400).json({
          ok: false,
          reason: `Logic error: Option 2 conviction (${conv2}%) cannot exceed Option 1 (${conv1}%). Runner-up must have lower conviction.`
        });
      }
    }

    if (livePrice) {
      textFull = await validateOrderTypeLogic(MODEL, instrument, textFull, livePrice);
    }
    if (livePrice) {
      textFull = await validateOrderTypeLogic(MODEL, instrument, textFull, livePrice);
    }
    textFull = await enforceEntryFormat(MODEL, instrument, textFull);

    // Validate directional consistency
    const dirMatches = textFull.matchAll(/Direction:\s*(Long|Short)/gi);
    const directions = Array.from(dirMatches).map(m => m[1].toLowerCase());
    if (directions.length >= 2) {
      const allLong = directions.every(d => d === 'long');
      const allShort = directions.every(d => d === 'short');
      if (!allLong && !allShort) {
        console.error(`[VISION-PLAN] Directional conflict: ${directions.join(', ')}`);
        return res.status(400).json({ 
          ok: false, 
          reason: `Analysis quality error: Conflicting trade directions detected (${directions.join(' vs ')}). System generated inconsistent recommendations. Please regenerate.` 
        });
      }
    }

    // Validate Option 2 entry price logic separately
    const option2Block = textFull.match(/Option\s*2[\s\S]{400,1000}/i)?.[0] || "";
    if (option2Block && livePrice) {
      const opt2Entry = option2Block.match(/Entry[^:]*:\s*([\d.]+(?:-[\d.]+)?)/i)?.[1];
      const opt2Order = option2Block.match(/Order Type:\s*(Limit|Stop|Market)/i)?.[1]?.toLowerCase();
      const opt2Dir = option2Block.match(/Direction:\s*(Long|Short)/i)?.[1]?.toLowerCase();
      
      if (opt2Entry && opt2Order && opt2Dir) {
        const entryNums = opt2Entry.split('-').map(Number);
        const avgEntry = entryNums.reduce((a, b) => a + b, 0) / entryNums.length;
        
        // Market orders must be at current price
        if (opt2Order === "market") {
          const priceDiff = Math.abs(avgEntry - livePrice);
          const pipValue = instrument.includes("JPY") ? 0.01 : 0.0001;
          const pipDiff = priceDiff / pipValue;
          
          if (pipDiff > 2) {
            console.error(`[VISION-PLAN] OPTION 2 VALIDATION FAILED - Market order at wrong price: Entry=${avgEntry}, Live=${livePrice}, Diff=${Math.abs(avgEntry-livePrice).toFixed(5)}`);
            return res.status(400).json({
              ok: false,
              reason: `Option 2 error: Market orders execute at current price (${livePrice}), not ${avgEntry}. Entry must match current price within 2 pips.`
            });
          }
        }
        
        // Limit order direction check
        if (opt2Order === "limit") {
          if (opt2Dir === "long" && avgEntry >= livePrice) {
            console.error(`[VISION-PLAN] Option 2 impossible long limit: ${avgEntry} >= ${livePrice}`);
            return res.status(400).json({
              ok: false,
              reason: `Option 2 error: Long Limit must be BELOW current price ${livePrice}, not at ${avgEntry}.`
            });
          }
          if (opt2Dir === "short" && avgEntry <= livePrice) {
            console.error(`[VISION-PLAN] Option 2 impossible short limit: ${avgEntry} <= ${livePrice}`);
            return res.status(400).json({
              ok: false,
              reason: `Option 2 error: Short Limit must be ABOVE current price ${livePrice}, not at ${avgEntry}.`
            });
          }
        }
      }
    }

    // Consolidated validation
    if (livePrice && aiMetaFull) {
      const entries: number[] = [];
      const entryMatch = textFull.match(/Entry.*?:.*?([\d.]+)/i);
      if (entryMatch) entries.push(Number(entryMatch[1]));
      if (aiMetaFull.zone?.min) entries.push(Number(aiMetaFull.zone.min));
      if (aiMetaFull.zone?.max) entries.push(Number(aiMetaFull.zone.max));
      
      const dirMatch = textFull.match(/Direction:\s*(Long|Short)/i);
      const orderMatch = textFull.match(/Order Type:\s*(Limit|Stop|Market)/i);
      
      if (dirMatch && orderMatch && entries.length > 0) {
        const direction = dirMatch[1].toLowerCase();
        const orderType = orderMatch[1].toLowerCase();
        const avgEntry = entries.reduce((a, b) => a + b, 0) / entries.length;
        
        for (const entry of entries) {
          if (isFinite(entry) && entry > 0) {
            const pctDiff = Math.abs((entry - livePrice) / livePrice);
            const maxDiff = scalpingMode === "hard" ? 0.08 : 0.20;
            
            if (pctDiff > 0.50) {
              return res.status(400).json({ 
                ok: false, 
                reason: `Entry too far from current price: ${entry} vs live ${livePrice} (${(pctDiff*100).toFixed(1)}% away). Charts may be stale.` 
              });
            }
            
            if (pctDiff > maxDiff) {
              console.warn(`[VISION-PLAN] Entry distant from current: Live=${livePrice}, Entry=${entry}, Diff=${(pctDiff*100).toFixed(1)}%`);
            }
          }
        }
        
        if (orderType === "limit") {
          if (direction === "long" && avgEntry >= livePrice) {
            console.error(`[VISION-PLAN] IMPOSSIBLE Long Limit: ${avgEntry} at/above current ${livePrice}`);
            return res.status(400).json({ 
              ok: false, 
              reason: `IMPOSSIBLE ORDER: Long Limit at ${avgEntry} must be BELOW current price ${livePrice}. Use Market order OR Limit BELOW current.` 
            });
          }
          
          if (direction === "short" && avgEntry <= livePrice) {
            console.error(`[VISION-PLAN] IMPOSSIBLE Short Limit: ${avgEntry} at/below current ${livePrice}`);
            return res.status(400).json({ 
              ok: false, 
              reason: `IMPOSSIBLE ORDER: Short Limit at ${avgEntry} must be ABOVE current price ${livePrice}. Use Market order OR Limit ABOVE current.` 
            });
          }
          
          const minDistance = scalpingMode === "hard" ? 0.0005 : 0.0015;
          const priceDistance = Math.abs(avgEntry - livePrice) / livePrice;
          if (priceDistance < minDistance) {
            console.warn(`[VISION-PLAN] Limit order close to market: ${avgEntry} vs ${livePrice} (${(priceDistance*10000).toFixed(1)} pips)`);
          }
        }
      }
    }

    // R:R validation
    const entryMatches = textFull.matchAll(/Entry[^:]*:\s*(\d+\.\d+)/gi);
    const slMatches = textFull.matchAll(/Stop Loss[^:]*:\s*(\d+\.\d+)/gi);
    const tpMatches = textFull.matchAll(/TP1[^:]*(\d+\.\d+)/gi);
    
    if (entryMatches && slMatches && tpMatches) {
      const entries = Array.from(entryMatches).map(m => Number(m[1]));
      const stops = Array.from(slMatches).map(m => Number(m[1]));
      const tps = Array.from(tpMatches).map(m => Number(m[1]));
      
      for (let i = 0; i < Math.min(entries.length, stops.length, tps.length); i++) {
        const risk = Math.abs(entries[i] - stops[i]);
        const reward = Math.abs(tps[i] - entries[i]);
        const ratio = reward / risk;
        
        if (ratio < 1.5) {
          console.error(`[VISION-PLAN] Trade ${i+1} R:R too low: ${ratio.toFixed(2)}:1`);
          return res.status(400).json({
            ok: false,
            reason: `Trade option ${i+1} has poor risk-reward ratio: ${ratio.toFixed(2)}:1 (minimum 1.5:1 required). Entry: ${entries[i]}, SL: ${stops[i]}, TP1: ${tps[i]}`
          });
        }
      }
    }

    const usedM5Full = !!m5 && /(\b5m\b|\b5\-?min|\b5\s*minute)/i.test(textFull);
    textFull = stampM5Used(textFull, usedM5Full);
    const usedM1Full = !!m1 && /(\b1m\b|\b1\-?min|\b1\s*minute)/i.test(textFull);
    textFull = stampM1Used(textFull, usedM1Full);

    textFull = applyConsistencyGuards(textFull, {
      instrument,
      headlinesSign: headlinesSign,
      csmSign: csmData.sign,
      calendarSign: calendarSign
    });

    const footer = buildServerProvenanceFooter({
      headlines_provider: headlinesProvider || "unknown",
      calendar_status: calendarStatus,
      calendar_provider: calendarProvider,
      csm_time: csm.tsISO,
      extras: { vp_version: VP_VERSION, model: MODEL, pre_release: preReleaseOnly, debug_ocr: !!debugOCR, scalping_mode: scalpingMode },
    });
    textFull = `${textFull}\n${footer}`;

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text: textFull,
      meta: {
        instrument, vp_version: VP_VERSION, model: MODEL,
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
    console.error("[vision-plan] Handler error:", err);
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}
