// /pages/api/vision-plan.ts
/**
 * OCR-first calendar (image priority) — improved acceptance of pre-release rows
 * - Accepts forecast-vs-previous (no actual yet) to derive expected bias.
 * - Only shows "Calendar provided, but no relevant info for <INSTRUMENT>." when OCR has zero rows for the pair’s currencies.
 * - Keeps API calendar fallback, but OCR should satisfy most cases now.
 * - Preserves section enforcement, consistency guard, conviction (0–100, no hard caps), caching, and provenance.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";
import sharp from "sharp";

// ---------- config ----------
export const config = { api: { bodyParser: false, sizeLimit: "25mb" } };

type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

const VP_VERSION = "2025-09-11-ocrv10-fund0to100+tournament+no-mixed";

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

// ---------- image processing ----------
async function toJpeg(buf: Buffer, width: number, quality: number): Promise<Buffer> {
  return sharp(buf).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality, progressive: true, mozjpeg: true }).toBuffer();
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
  const o = String(aiMeta?.entryOrder || "").toLowerCase();
  const dir = String(aiMeta?.direction || "").toLowerCase();
  const z = aiMeta?.zone || {};
  const p = Number(aiMeta?.currentPrice);
  const zmin = Number(z?.min);
  const zmax = Number(z?.max);
  if (!isFinite(p) || !isFinite(zmin) || !isFinite(zmax)) return null;
  if (o === "sell limit" && dir === "short") { if (Math.max(zmin, zmax) <= p) return "sell-limit-below-price"; }
  if (o === "buy limit" && dir === "long") { if (Math.min(zmin, zmax) >= p) return "buy-limit-above-price"; }
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

// (A) Evidence line — verdict strictly bullish/bearish/neutral (never "mixed")
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
    const gtRef = (f != null && a > f) || (p != null && a > p);
    const ltBoth = (f != null ? a < f : true) && (p != null ? a < p : true);
    const gtBoth = (f != null ? a > f : true) && (p != null ? a > p : true);
    verdict = gtBoth ? "bullish" : ltBoth ? "bearish" : "neutral";
  } else if (dir === false) {
    const ltRef = (f != null && a < f) || (p != null && a < p);
    const gtBoth = (f != null ? a > f : true) && (p != null ? a > p : true);
    const ltBoth = (f != null ? a < f : true) && (p != null ? a < p : true);
    verdict = ltBoth ? "bullish" : gtBoth ? "bearish" : "neutral";
  } else {
    verdict = "neutral";
  }
  const comps = comp.join(" and ");
  return `${cur} — ${it.title}: actual ${a}${f!=null||p!=null ? ` ${comps}` : ""} → ${verdict} ${cur}`;
}

// ---------- OpenAI core ----------
async function callOpenAI(model: string, messages: any[]) {
  // GPT-5 rejects non-default temperature. Keep temp=0 for 4o; omit for GPT-5.
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
  // Two-pass: strict JSON; retry w/ emphasized "JSON ONLY" if first parse fails.
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

    // Only include rows with actuals in the last 72h
    const ts = it.timeISO ? Date.parse(it.timeISO) : NaN;
    const isWithin72h = isFinite(ts) ? ts <= nowMs && nowMs - ts <= H72 : true;

    if (a != null && (f != null || p != null) && isWithin72h) {
      postRows.push({ ...it, actual: a, forecast: f, previous: p });
    }
  }

  // If no post-result rows → pre-release only
  if (postRows.length === 0) {
    const preLine = `Calendar: ${
      warn != null ? `High-impact events scheduled (≤${warn} min). ` : ""
    }Pre-release only, no confirmed bias until data is out.`;
    return {
      biasLine: preLine,
      biasNote: null,
      warningMinutes: warn,
      evidenceLines: [],
      preReleaseOnly: true,
      rowsForDebug,
    };
  }

  // --- Scoring setup ---
  const scoreByCur: Record<string, number> = {};
  const impactW: Record<string, number> = { Low: 0.5, Medium: 0.8, High: 1.0 };
  function add(cur: string, v: number) {
    scoreByCur[cur] = (scoreByCur[cur] ?? 0) + v;
  }

  for (const it of postRows) {
    const cur = (it.currency || "").toUpperCase();
    const dir = goodIfHigher(String(it.title || "")); // true=higher good; false=lower good
    if (dir == null) continue;

    const ref = (it.forecast ?? it.previous) as number | null;
    if (ref == null) continue;

    const aNum = Number(it.actual);
    const raw = (aNum - ref) / Math.max(Math.abs(ref), 1e-9);
    const clamped = Math.max(-0.25, Math.min(0.25, raw)); // limit ±25%

    // Score 0–10 scaled, impact-weighted
    const unsigned0to10 = Math.round((Math.abs(clamped) / 0.25) * 10);
    const w = impactW[it.impact as keyof typeof impactW] ?? 1.0;
    const lineScore = Math.round(unsigned0to10 * w);

    // Signed score (goodIfHigher flips)
    const signed = (dir ? Math.sign(clamped) : -Math.sign(clamped)) * lineScore;

    // Evidence line (never "mixed")
    const fNum = it.forecast != null ? Number(it.forecast) : null;
    const pNum = it.previous != null ? Number(it.previous) : null;
    let comp: string[] = [];
    if (fNum != null) comp.push(aNum < fNum ? "< forecast" : aNum > fNum ? "> forecast" : "= forecast");
    if (pNum != null) comp.push(aNum < pNum ? "< previous" : aNum > pNum ? "> previous" : "= previous");
    const comps = comp.join(" & ");

    const impactTag = it.impact ? ` (${it.impact})` : "";
    const signWord: "bullish" | "bearish" | "neutral" = signed > 0 ? "bullish" : signed < 0 ? "bearish" : "neutral";
    lines.push(`${cur} — ${it.title}: ${aNum}${comps ? " " + comps : ""} → ${signWord} ${cur} (${signed >= 0 ? "+" : ""}${signed}/10${impactTag})`);

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

// ---------- prompts (Updated per ALLOWED CHANGES A–E) ----------
function systemCore(instrument: string, calendarAdvisory?: { warningMinutes?: number | null; biasNote?: string | null }) {
  const warn = (calendarAdvisory?.warningMinutes ?? null) != null ? calendarAdvisory!.warningMinutes : null;
  const bias = calendarAdvisory?.biasNote || null;

  return [
    "You are a professional discretionary trader.",
    "STRICT NO-GUESS RULES:",
    "- Only mention **Calendar** if calendar_status === 'api' or calendar_status === 'image-ocr'.",
    "- Only mention **Headlines** if a headlines snapshot is provided.",
    "- Do not invent events, figures, or quotes. If something is missing, write 'unavailable'.",
    "- Use the Sentiment snapshot exactly as given (CSM + Headlines bias + optional COT cue).",
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
    "  • Order Blocks (OB) demand/supply; mitigations",
    "  • Fair Value Gaps (FVG)/Imbalance; gap fills",
    "  • Breakers/Breaker blocks",
    "  • Support/Resistance (HTF + intraday), Round numbers/psych levels",
    "  • Trendline breaks + retests; channels; wedges; triangles",
    "  • Liquidity sweeps/stop hunts; equal highs/lows raids; session liquidity (London/NY)",
    "  • Pullbacks (to MA/OB/FVG); 50%/61.8% fib retracements",
    "  • Moving average regime/cross; momentum ignition/breakout",
    "  • RSI divergence (regular/hidden); MACD impulse; Bollinger squeeze/expansion",
    "  • Mean reversion/range rotations; range high/low plays; session “kill zones” confluence",
    "- Score each candidate T_candidate = clamp( 0.5*HTF_fit(4H) + 0.3*Context_fit(1H) + 0.2*Trigger_fit(15m & optional 5m), 0, 100 ).",
    "- Penalize conflicts with HTF (-15 to -30). Reward multi-signal confluence (+10 to +20) and clean invalidation/asymmetric R:R (+5 to +15).",
    "- Pick TOP 1 as 'Option 1 (Primary)' and a DISTINCT runner-up for 'Option 2 (Alternative)'.",
    "- Provide a compact tournament table (name — score — reason).",
    "",
    "Fundamentals Scoring (0–100, no hard caps):",
    "- Determine calendar instrument sign from the calendar bias (bearish:-1, neutral:0, bullish:+1).",
    "- Compute:",
    "  • S_cal = 50 + 50*sign",
    "  • Headlines (48h): S_head = 25 (bearish) / 50 (neutral) / 75 (bullish); if unavailable, use 50",
    "  • CSM diff = z(base) - z(quote); S_csm = 50 + 25 * clamp(diff, -2, +2)/2",
    "  • COT (if cues detected): bump +5 if aligns with calendar sign, -5 if conflicts, 0 if none",
    "- Weights: w_cal=0.45, w_head=0.20, w_csm=0.30, w_cot=0.05",
    "- RawF = w_cal*S_cal + w_head*S_head + w_csm*S_csm + w_cot*(50+cotBump)",
    "- If a high-impact event is within ≤60 min, reduce by 25%: F = clamp( RawF * (1 - 0.25*proximityFlag), 0, 100 ), where proximityFlag=1 if warning ≤60 min else 0.",
    "- Unavailable components fall back to 50 (except calendar sign, which may be neutral).",
    "",
    "Conviction (0–100) from TECH & FUND alignment:",
    "- Compute T as the best tournament score (0–100).",
    "- Use the fundamentals F above (0–100).",
    "- Determine direction sign from technical primary vs fundamentals net sign; alignment bonus: +8 if same sign, else -8.",
    "- If a high-impact event is within ≤60 min, apply final scaling 15%: Conv = clamp( (0.55*T + 0.45*F + align) * (1 - 0.15*proximityFlag), 0, 100 ).",
    "- Do not apply any other caps.",
    "",
    "Consistency rule:",
    "- If Calendar/Headlines/CSM align, do not say 'contradicting'; say 'aligning'.",
    "- 'Tech vs Fundy Alignment' must be Match when aligned, Mismatch when conflicted.",
    "",
    `Keep instrument alignment with ${instrument}.`,
    warn !== null ? `\nCALENDAR WARNING: High-impact event within ~${warn} min. Avoid impulsive market entries right before release.` : "",
    bias ? `\nPOST-RESULT ALIGNMENT: ${bias}.` : "",
    "",
    "Calendar verdict rules:",
    "- Per event: compute verdict using domain direction (goodIfHigher); output only bullish/bearish/neutral.",
    "- Final calendar bias uses baseMinusQuote: net = baseSum - quoteSum; net>0 → bullish instrument; net<0 → bearish; only when BOTH currency sums are exactly 0 → neutral.",
    "- If no actuals in the last 72h for the pair’s currencies: 'Pre-release only, no confirmed bias until data is out.'",
    "",
    "Under **Fundamental View**, if Calendar is unavailable, write exactly 'Calendar: unavailable'.",
    "If Calendar is pre-release only, write exactly 'Pre-release only, no confirmed bias until data is out.' and do NOT claim a bullish/bearish/neutral calendar bias.",
  ].join("\n");
}

function buildUserPartsBase(args: {
  instrument: string;
  dateStr: string;
  m15: string; h1: string; h4: string;
  m5?: string | null;
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
  instrument: string; dateStr: string; m15: string; h1: string; h4: string; m5?: string | null;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  calendarAdvisory?: { warningMinutes?: number | null; biasNote?: string | null; advisoryText?: string | null; evidence?: string[] | null; debugRows?: any[] | null; preReleaseOnly?: boolean | null };
  provenance?: any;
}) {
  const system = [
    systemCore(args.instrument, args.calendarAdvisory), "",
    "OUTPUT format (in this exact order):",
    "Quick Plan (Actionable)",
    "• Direction: Long | Short | Stay Flat",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger:",
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
    "• Trigger:", "• Entry (zone or single):", "• Stop Loss:", "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%", "• Why this is primary:",
    "",
    "Option 2 (Alternative)",
    "• Direction: ...",
    "• Order Type: ...",
    "• Trigger:", "• Entry (zone or single):", "• Stop Loss:", "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%", "• Why this alternative:",
    "",
    "Full Breakdown",
    "• Technical View (HTF + Intraday): 4H/1H/15m structure (include 5m if used)",
    "• Fundamental View (Calendar + Sentiment + Headlines) — include explicit Calendar bias for <PAIR> when available; if pre-release, say: 'Pre-release only, no confirmed bias until data is out.'",
    "• Tech vs Fundy Alignment: Match | Mismatch (+why)",
    "• Conditional Scenarios:",
    "• Surprise Risk:",
    "• Invalidation:",
    "• One-liner Summary:",
    "",
    "Detected Structures (X-ray):",
    "• 4H:", "• 1H:", "• 15m:", "• 5m (if used):",
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
      instrument: args.instrument, dateStr: args.dateStr, m15: args.m15, h1: args.h1, h4: args.h4, m5: args.m5 || null,
      calendarDataUrl: args.calendarDataUrl, calendarText: args.calendarText,
      headlinesText: args.headlinesText, sentimentText: args.sentimentText,
      calendarAdvisoryText: args.calendarAdvisory?.advisoryText || null,
      calendarEvidence: args.calendarAdvisory?.evidence || null,
      debugOCRRows: args.calendarAdvisory?.debugRows || null,
    }) },
  ];
}

function messagesFastStage1(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string; m5?: string | null;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  calendarAdvisory?: { warningMinutes?: number | null; biasNote?: string | null; advisoryText?: string | null; evidence?: string[] | null; debugRows?: any[] | null; preReleaseOnly?: boolean | null };
  provenance?: any;
}) {
  const system = [
    systemCore(args.instrument, args.calendarAdvisory), "",
    "OUTPUT ONLY:",
    "Quick Plan (Actionable)",
    "• Direction: Long | Short | Stay Flat",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger:", "• Entry (zone or single):", "• Stop Loss:", "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%", "• Setup:", "• Short Reasoning:",
    "",
    "Option 1 (Primary)",
    "• Direction: ...",
    "• Order Type: ...",
    "• Trigger:", "• Entry (zone or single):", "• Stop Loss:", "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%", "• Why this is primary:",
    "",
    "Option 2 (Alternative)",
    "• Direction: ...",
    "• Order Type: ...",
    "• Trigger:", "• Entry (zone or single):", "• Stop Loss:", "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%", "• Why this alternative:",
    "",
    "Management: Brief actionable playbook.",
    "",
    "Append ONLY a fenced JSON block labeled ai_meta.",
    "",
    "provenance_hint:",
    JSON.stringify(args.provenance || {}, null, 2),
  ].join("\n");

  const parts = buildUserPartsBase({
    instrument: args.instrument, dateStr: args.dateStr, m15: args.m15, h1: args.h1, h4: args.h4, m5: args.m5 || null,
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

// ---------- Enforcement helpers ----------
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
function hasOption1(text: string): boolean { return /Option\s*1\s*\(?(Primary)?\)?/i.test(text || ""); }
async function enforceOption1(model: string, instrument: string, text: string) {
  if (hasOption1(text)) return text;
  const messages = [
    { role: "system", content: "Insert a labeled 'Option 1 (Primary)' block BEFORE 'Option 2'. Use the primary trade details already present. Include Direction, Order Type, Trigger, Entry (zone or single), SL, TP1/TP2, Conviction %. Keep other content unchanged." },
    { role: "user", content: `Instrument: ${instrument}\n\n${text}\n\nAdd/normalize 'Option 1 (Primary)' as specified.` },
  ];
  return callOpenAI(model, messages);
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

// ---------- Consistency + visibility guards ----------
function ensureCalendarVisibilityInQuickPlan(text: string, args: { instrument: string; preReleaseOnly: boolean; biasLine: string | null }) {
  if (!text) return text;
  const hasQP = /Quick\s*Plan\s*\(Actionable\)/i.test(text);
  if (!hasQP) return text;

  const qpBlock = text.match(/Quick\s*Plan\s*\(Actionable\)[\s\S]*?(?=\n\s*Option\s*1|\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i)?.[0] || "";
  const hasCalendarMention = /Calendar\s*:/i.test(qpBlock) || /Calendar\s*bias\s*for\s*/i.test(qpBlock);
  if (hasCalendarMention) return text; // already present

  const inject = args.preReleaseOnly
    ? `\n• Note: Pre-release only, no confirmed bias until data is out.`
    : (args.biasLine ? `\n• Calendar bias for ${args.instrument}: ${args.biasLine.replace(/^Calendar bias for\s*[^:]+:\s*/i, "")}` : "");

  if (!inject) return text;
  return text.replace(/(Quick\s*Plan\s*\(Actionable\)[^\n]*\n)/i, `$1${inject}\n`);
}

function stampM5Used(text: string, used: boolean) {
  if (!used) return text;
  const stamp = "• Used Chart: 5M execution";
  let out = text;
  // Add to Quick Plan
  if (/Quick\s*Plan\s*\(Actionable\)/i.test(out) && !/Used\s*Chart:\s*5M/i.test(out)) {
    out = out.replace(/(Quick\s*Plan\s*\(Actionable\)[\s\S]*?)(\n\s*Option\s*1)/i, (m, a, b) => {
      return /•\s*Used\s*Chart:\s*5M/i.test(a) ? m : `${a}\n${stamp}\n${b}`;
    });
  }
  // Add to Option 1
  if (/Option\s*1\s*\(?(Primary)?\)?/i.test(out) && !/Used\s*Chart:\s*5M/i.test(out)) {
    out = out.replace(/(Option\s*1[\s\S]*?)(\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i, (m, a, b) => {
      return /•\s*Used\s*Chart:\s*5M/i.test(a) ? m : `${a}\n${stamp}\n${b}`;
    });
  }
  return out;
}

function applyConsistencyGuards(text: string, args: { instrument: string; headlinesSign: number; csmSign: number; calendarSign: number; }) {
  let out = text || "";
  const signs = [args.headlinesSign, args.csmSign, args.calendarSign].filter((s) => s !== 0);
  const hasPos = signs.some((s) => s > 0);
  const hasNeg = signs.some((s) => s < 0);
  const aligned = signs.length > 0 && ((hasPos && !hasNeg) || (hasNeg && !hasPos));
  const mismatch = hasPos && hasNeg;

  if (aligned) out = out.replace(/contradict(?:ion|ing|s)?/gi, "aligning");
  const reTF = /(Tech\s*vs\s*Fundy\s*Alignment:\s*)(Match|Mismatch)/i;
  if (reTF.test(out)) {
    out = out.replace(reTF, (_, p1) => `${p1}${aligned ? "Match" : mismatch ? "Mismatch" : "Match"}`);
  }
  return out;
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

      // Guard against stale-cache instrument mismatches
      const qInstrument = String((req.query.instrument || "")).toUpperCase().replace(/\s+/g, "");
      if (qInstrument && qInstrument !== c.instrument) {
        return res.status(400).json({
          ok: false,
          reason: `Expand rejected: instrument mismatch (cache=${c.instrument}, query=${qInstrument}). Start a new run.`,
        });
      }

      const dateStr = new Date().toISOString().slice(0, 10);
      const calAdv = await fetchCalendarForAdvisory(req, c.instrument);

      // --------- Re-fetch fundamentals FRESH (no stale cache) ---------
      // Headlines (server-side, instrument-scoped)
      let headlineItems: AnyHeadline[] = [];
      let headlinesText: string | null = null;
      let headlinesProvider: string = "unknown";
      try {
        const viaServer = await fetchedHeadlinesViaServer(req, c.instrument);
        headlineItems = viaServer.items;
        headlinesText = viaServer.promptText;
        headlinesProvider = viaServer.provider || "unknown";
      } catch {}

      // Bias from headlines
      const hBias = computeHeadlinesBias(headlineItems);

      // CSM (fresh snapshot; 15-min cache inside getCSM)
      let csm: CsmSnapshot;
      try { csm = await getCSM(); }
      catch (e: any) {
        return res.status(503).json({ ok: false, reason: `CSM unavailable: ${e?.message || "fetch failed"}.` });
      }

      // Optional COT cue from headlines
      const cotCue = detectCotCueFromHeadlines(headlineItems);
      const { text: sentimentText } = sentimentSummary(csm, cotCue, hBias);

      // Provenance hint for the LLM (do NOT say unavailable if we have an image/API status)
      const provHint = {
        headlines_present: !!headlinesText,
        calendar_status: c.calendar ? "image-ocr" : (calAdv?.status || "unavailable"),
      };

      const messages = messagesFull({
        instrument: c.instrument,
        dateStr,
        m15: c.m15, h1: c.h1, h4: c.h4, m5: c.m5 || null,
        calendarDataUrl: c.calendar || undefined,
        // Use the fresh fundamentals we just fetched (never the cache)
        headlinesText: headlinesText || undefined,
        sentimentText: sentimentText || undefined,
        calendarAdvisory: {
          warningMinutes: calAdv.warningMinutes ?? null,
          biasNote: calAdv.biasNote || null,
          advisoryText: calAdv.advisoryText || null,
          evidence: calAdv.evidence || [],
        },
        provenance: provHint,
      });

      let text = await callOpenAI(modelExpand, messages);
      text = await enforceQuickPlan(modelExpand, c.instrument, text);

    // ---------- multipart ----------
    if (!isMultipart(req)) {
      return res.status(400).json({
        ok: false,
        reason: "Use multipart form with m15/h1/h4 (TV links or files), optional m5 and calendarUrl (Gyazo). 'instrument' is required.",
      });
    }

    const { fields, files } = await parseMultipart(req);

    const MODEL = pickModelFromFields(req, fields);

    // ---------- Instrument: NO DEFAULTS ----------
    const instrumentRaw = String(fields.instrument || fields.code || "").toUpperCase().replace(/\s+/g, "");
    if (!instrumentRaw) {
      return res.status(400).json({
        ok: false,
        reason: "Instrument is required. Provide 'instrument' (e.g., AUDUSD). No default is used.",
      });
    }
    const instrument = instrumentRaw;

    const requestedMode = String(fields.mode || "").toLowerCase();
    if (requestedMode === "fast") mode = "fast";

    // debug toggle
    const debugField = String(pickFirst(fields.debug) || "").trim() === "1";
    const debugOCR = debugQuery || debugField;

    // files + urls
    const m5f = pickFirst(files.m5);
    const m15f = pickFirst(files.m15);
    const h1f = pickFirst(files.h1);
    const h4f = pickFirst(files.h4);
    const calF = pickFirst(files.calendar);

    const m5Url = String(pickFirst(fields.m5Url) || "").trim();
    const m15Url = String(pickFirst(fields.m15Url) || "").trim();
    const h1Url = String(pickFirst(fields.h1Url) || "").trim();
    const h4Url = String(pickFirst(fields.h4Url) || "").trim();
    const calendarUrlField = String(pickFirst(fields.calendarUrl) || "").trim();

    const [m5FromFile, m15FromFile, h1FromFile, h4FromFile, calFromFile] = await Promise.all([
      m5f ? fileToDataUrl(m5f) : Promise.resolve(null),
      fileToDataUrl(m15f), fileToDataUrl(h1f), fileToDataUrl(h4f),
      calF ? fileToDataUrl(calF) : Promise.resolve(null),
    ]);
    const [m5FromUrl, m15FromUrl, h1FromUrl, h4FromUrl, calFromUrl] = await Promise.all([
      m5FromFile ? Promise.resolve(null) : linkToDataUrl(m5Url),
      m15FromFile ? Promise.resolve(null) : linkToDataUrl(m15Url),
      h1FromFile ? Promise.resolve(null) : linkToDataUrl(h1Url),
      h4FromFile ? Promise.resolve(null) : linkToDataUrl(h4Url),
      calFromFile ? Promise.resolve(null) : linkToDataUrl(calendarUrlField),
    ]);

    const m5 = m5FromFile || m5FromUrl || null;
    const m15 = m15FromFile || m15FromUrl;
    const h1 = h1FromFile || h1FromUrl;
    const h4 = h4FromFile || h4FromUrl;
    const calUrlOrig = calFromFile || calFromUrl || null;

    if (!m15 || !h1 || !h4) {
      return res.status(400).json({ ok: false, reason: "Provide all three charts: m15, h1, h4 — either files or TV/Gyazo image links. (5m optional)" });
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
      // Fundamentals hint inputs for LLM scoring per B-D:
      fundamentals_hint: {
        calendar_sign: parseInstrumentBiasFromNote(biasNote),
        headlines_label: hBias.label,
        csm_diff: computeCSMInstrumentSign(csm, instrument).zdiff,
        cot_cue_present: !!cotCue
      },
      proximity_flag: warningMinutes != null ? 1 : 0
    };

    // ---------- Stage-1 (fast) ----------
    if (mode === "fast") {
      const messages = messagesFastStage1({
        instrument, dateStr, m15, h1, h4, m5,
        calendarDataUrl: calDataUrlForPrompt || undefined,
        calendarText: (!calDataUrlForPrompt && calendarText) ? calendarText : undefined,
        headlinesText: headlinesText || undefined,
        sentimentText: sentimentText,
        calendarAdvisory: { warningMinutes, biasNote, advisoryText, evidence: calendarEvidence || [], debugRows: debugOCR ? debugRows || [] : [], preReleaseOnly },
        provenance: provForModel,
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

      // Ensure calendar visibility in Quick Plan
      text = ensureCalendarVisibilityInQuickPlan(text, { instrument, preReleaseOnly, biasLine: calendarText });

      // Stamp 5M execution if used
      const usedM5 = !!m5 && /(\b5m\b|\b5\-?min|\b5\s*minute)/i.test(text);
      text = stampM5Used(text, usedM5);

      text = applyConsistencyGuards(text, {
        instrument,
        headlinesSign: computeHeadlinesSign(hBias),
        csmSign: computeCSMInstrumentSign(csm, instrument).sign,
        calendarSign: parseInstrumentBiasFromNote(biasNote)
      });

      const cacheKey = setCache({ instrument, m5: m5 || null, m15, h1, h4, calendar: calDataUrlForPrompt || null, headlinesText: headlinesText || null, sentimentText });

      const footer = buildServerProvenanceFooter({
        headlines_provider: headlinesProvider || "unknown",
        calendar_status: calendarStatus,
        calendar_provider: calendarProvider,
        csm_time: csm.tsISO,
        extras: { vp_version: VP_VERSION, model: MODEL, mode, composite_cap: composite.cap, composite_align: composite.align, composite_conflict: composite.conflict, pre_release: preReleaseOnly, debug_ocr: !!debugOCR },
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
      instrument, dateStr, m15, h1, h4, m5,
      calendarDataUrl: calDataUrlForPrompt || undefined,
      calendarText: (!calDataUrlForPrompt && calendarText) ? calendarText : undefined,
      headlinesText: headlinesText || undefined,
      sentimentText,
      calendarAdvisory: { warningMinutes, biasNote, advisoryText, evidence: calendarEvidence || [], debugRows: debugOCR ? debugRows || [] : [], preReleaseOnly },
      provenance: provForModel,
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

    // Stamp 5M execution if used
    const usedM5Full = !!m5 && /(\b5m\b|\b5\-?min|\b5\s*minute)/i.test(textFull);
    textFull = stampM5Used(textFull, usedM5Full);

    textFull = applyConsistencyGuards(textFull, {
      instrument,
      headlinesSign: computeHeadlinesSign(hBias),
      csmSign: computeCSMInstrumentSign(csm, instrument).sign,
      calendarSign: parseInstrumentBiasFromNote(biasNote)
    });

    const footer = buildServerProvenanceFooter({
      headlines_provider: headlinesProvider || "unknown",
      calendar_status: calendarStatus,
      calendar_provider: calendarProvider,
      csm_time: csm.tsISO,
      extras: { vp_version: VP_VERSION, model: MODEL, mode, composite_cap: composite.cap, composite_align: composite.align, composite_conflict: composite.conflict, pre_release: preReleaseOnly, debug_ocr: !!debugOCR },
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
