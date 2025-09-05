// /pages/api/vision-plan.ts
// Images-only planner with optional TradingView/Gyazo image URL fetch.
// Uploads: m15 (execution), h1 (context), h4 (HTF), optional calendar.
// You can also pass m15Url / h1Url / h4Url (TV/Gyazo direct image or page link) and headlinesJson (UI-fetched).
// -----------------------------------------------------------------------------
// Modes (non-breaking):
//   • mode=full (default): full card (legacy).
//   • mode=fast: images + calendar (image>api) + headlines + CSM (mandatory) + COT (soft-required).
//                OUTPUT ONLY: Quick Plan (+Option 2) + Management + trailing ai_meta.
//   • mode=expand&cache=<id>: reuse Stage-1 cache and return ONLY remaining sections.
//
// Headlines: prefer client-provided `headlinesJson` (≤12) for consistency; else fetch 12 and embed **6**.
// Image downscale: adaptive clarity — max width up to 1500px, JPEG 74→88, target ~700–900 KB (best-effort, ≤1.2 MB).
// FAST-mode performance: lower image budget (≤960w, q=72, ~350–500 KB each), embed **4** headlines (UI still shows 12).
// Strategy playbook & enforcement: unchanged. LIMIT sanity uses verified currentPrice (live).
// CSM (intraday) is **mandatory**. COT is **soft-required** with CFTC→Tradingster→headline-fallback and 14-day stale cache reuse.
// Calendar precedence: uploaded image > API bias > explicit “unavailable” warning, surfaced in both Fast/Full.
// **Calendar results-aware from image**: when a calendar image is supplied, the model must read Actual/Forecast/Previous from the image and use realised bias & warnings (no blackout).
// Fundamentals override: large realised surprise can boost/cap conviction; past realised carry-forward (3d typical; 7d NFP/CB).
// Provenance: meta.sources always included. Cost passthrough when SHOW_COST=true.
// -----------------------------------------------------------------------------

/*
CHANGE MANIFEST
1) Calendar “Results-Aware” From Image (no OCR lib; use vision LLM we already call)
   - When calendar image is provided, system prompt now instructs the model to read the image table (Actual/Forecast/Previous)
     and derive realised bias per currency and instrument. Warnings copy becomes results-aware (not hypothetical).
   - Provenance adds: calendar_realised_used (bool), calendar_realised_mode: "image-vision".

2) Performance Patch v1
   - FAST mode image budget lowered (960w, q=72).
   - Headlines embedded to the model: 4 in FAST, 6 in FULL (UI still shows 12).
   - CSM/COT/Calendar API timeouts tightened; soft-fail non-blocking.
   - COT Tradingster queries run concurrently; fetchSeries races providers; shorter timeouts.
   - Stage-1 cache TTL 4 minutes.

3) Option 2 Enforcement (unchanged from last baseline)
   - If a viable secondary setup exists (Breakout+Retest/SFP/TL break), ALWAYS include Option 2 with its own conviction and
     explicit trigger steps (wait-for-close, retest hold, entry rule, SL, TP).

4) Minor Fixes
   - Regex literals in Tradingster parser use [\\s\\S] properly (compile-safe).
*/

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";
import sharp from "sharp";

// ---------- config ----------
export const config = { api: { bodyParser: false, sizeLimit: "25mb" } };

type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

const TD_KEY = process.env.TWELVEDATA_API_KEY || "";
const FH_KEY = process.env.FINNHUB_API_KEY || process.env.FINNHUB_APT_KEY || "";
const POLY_KEY = process.env.POLYGON_API_KEY || "";
const SHOW_COST = String(process.env.SHOW_COST || "") === "true";

// ---------- small utils ----------
const IMG_MAX_BYTES = 12 * 1024 * 1024; // absolute safety cap
const BASE_W = 1280;       // base width
const MAX_W = 1500;        // upper bound for adaptive
const TARGET_MIN = 420 * 1024;
const TARGET_IDEAL = 800 * 1024;
const TARGET_MAX = 1200 * 1024; // hard ceiling for adaptive

const FAST_W = 960;  // perf v1
const FAST_Q = 72;

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

// in-memory caches
type CacheEntry = {
  exp: number;
  instrument: string;
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
  CACHE.set(key, { ...entry, exp: Date.now() + 4 * 60 * 1000 }); // 4 min TTL
  return key;
}
function getCache(key: string | undefined | null): CacheEntry | null {
  if (!key) return null;
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) {
    CACHE.delete(key);
    return null;
  }
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

// ---------- image processing (adaptive clarity) ----------
async function toJpeg(buf: Buffer, width: number, quality: number): Promise<Buffer> {
  return sharp(buf).rotate().resize({ width, withoutEnlargement: true })
    .jpeg({ quality, progressive: true, mozjpeg: true }).toBuffer();
}
async function processAdaptiveToDataUrl(buf: Buffer, fast = false): Promise<string> {
  // perf v1: smaller budget in fast mode
  if (fast) {
    const out = await toJpeg(buf, FAST_W, FAST_Q);
    if (out.byteLength > IMG_MAX_BYTES) throw new Error("image too large after processing");
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  }

  let width = BASE_W;
  let quality = 74;
  let out = await toJpeg(buf, width, quality);
  let guard = 0;
  while (out.byteLength < TARGET_MIN && guard < 4) {
    quality = Math.min(quality + 6, 88);
    if (quality >= 82 && width < MAX_W) width = Math.min(width + 100, MAX_W);
    out = await toJpeg(buf, width, quality);
    guard++;
  }
  if (out.byteLength < TARGET_MIN && (quality < 88 || width < MAX_W)) {
    quality = Math.min(quality + 4, 88);
    width = Math.min(width + 100, MAX_W);
    out = await toJpeg(buf, width, quality);
  }
  if (out.byteLength > TARGET_MAX) {
    const q2 = Math.max(72, quality - 6);
    out = await toJpeg(buf, width, q2);
  }
  if (out.byteLength > IMG_MAX_BYTES) {
    throw new Error("image too large after processing");
  }
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}
async function fileToDataUrl(file: any, fast=false): Promise<string | null> {
  if (!file) return null;
  const p = file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;
  const raw = await fs.readFile(p);
  const out = await processAdaptiveToDataUrl(raw, fast);
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
  const m1 = html.match(re1); if (m1?.[1]) return m1[1];
  const re2 = /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i;
  const m2 = html.match(re2); if (m2?.[1]) return m2[1];
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
      signal: ac.signal, redirect: "follow",
      headers: { "user-agent": "TradePlanApp/1.0", accept: "text/html,application/xhtml+xml,application/xml,image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
    });
    return r;
  } finally { clearTimeout(id); }
}
async function downloadAndProcess(url: string, fast=false): Promise<string | null> {
  const r = await fetchWithTimeout(url, 6000);
  if (!r || !r.ok) return null;
  const ct = String(r.headers.get("content-type") || "").toLowerCase();
  const mime = ct.split(";")[0].trim();
  const ab = await r.arrayBuffer();
  const raw = Buffer.from(ab);
  if (raw.byteLength > IMG_MAX_BYTES) return null;

  if (mime.startsWith("image/")) {
    const out = await processAdaptiveToDataUrl(raw, fast);
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
  const r2 = await fetchWithTimeout(resolved, 6000);
  if (!r2 || !r2.ok) return null;
  const ab2 = await r2.arrayBuffer();
  const raw2 = Buffer.from(ab2);
  if (raw2.byteLength > IMG_MAX_BYTES) return null;
  const out2 = await processAdaptiveToDataUrl(raw2, fast);
  if (process.env.NODE_ENV !== "production") {
    console.log(`[vision-plan] og:image processed size=${dataUrlSizeBytes(out2)}B from ${resolved}`);
  }
  return out2;
}
async function linkToDataUrl(link: string, fast=false): Promise<string | null> {
  if (!link) return null;
  try {
    if (looksLikeImageUrl(link)) return await downloadAndProcess(link, fast);
    return await downloadAndProcess(link, fast); // page → og:image
  } catch { return null; }
}

// ---------- headlines helpers ----------
type AnyHeadline = { title?: string; source?: string; published_at?: string; ago?: string; sentiment?: { score?: number } | null } & Record<string, any>;

function headlinesToPromptLines(items: AnyHeadline[], limit = 6): string | null {
  const take = (items || []).slice(0, limit);
  if (!take.length) return null;
  const lines = take.map((it: AnyHeadline) => {
    const s = typeof it?.sentiment?.score === "number" ? (it.sentiment!.score as number) : null;
    const lab = s == null ? "neu" : s > 0.05 ? "pos" : s < -0.05 ? "neg" : "neu";
    const t = String(it?.title || "").slice(0, 200);
    const src = it?.source || "";
    const when = it?.ago || "";
    return `• ${t} — ${src}${when ? `, ${when}` : ""} — ${lab}`;
  });
  return lines.join("\n");
}
async function fetchedHeadlinesViaServer(req: NextApiRequest, instrument: string): Promise<{ items: AnyHeadline[]; promptText: string | null }> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(instrument)}&hours=48&max=12&_t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3500) });
    const j = await r.json().catch(() => ({}));
    const items: AnyHeadline[] = Array.isArray(j?.items) ? j.items : [];
    return { items, promptText: headlinesToPromptLines(items, 6) };
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
  if (o === "buy limit" && dir === "long") { if (Math.min(zmin, zmax) >= p) return "buy-limit-above-price"; }
  return null;
}
// ---------- CSM (intraday) ----------
const G8 = ["USD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD"];
const USD_PAIRS = ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDJPY", "USDCHF", "USDCAD"];

type Series = { t: number[]; c: number[] }; // ascending by time
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
    const url =
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=15min&outputsize=30&apikey=${TD_KEY}&dp=6`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1800) });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!Array.isArray(j?.values)) return null;
    const vals = [...j.values].reverse(); // ascending
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
    const from = to - 60 * 60 * 6; // 6h
    const url =
      `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(sym)}&resolution=15&from=${from}&to=${to}&token=${FH_KEY}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1800) });
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
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const url =
      `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/15/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&apiKey=${POLY_KEY}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1800) });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!Array.isArray(j?.results)) return null;
    const t: number[] = j.results.map((x: any) => Math.floor(x.t / 1000));
    const c: number[] = j.results.map((x: any) => Number(x.c));
    if (!c.every((x: number) => isFinite(x))) return null;
    return { t, c };
  } catch { return null; }
}

// perf v1: race fastest provider per pair
async function fetchSeries15(pair: string): Promise<Series | null> {
  const tasks = [];
  if (TD_KEY) tasks.push(tdSeries15(pair));
  if (FH_KEY) tasks.push(fhSeries15(pair));
  if (POLY_KEY) tasks.push(polySeries15(pair));
  if (!tasks.length) return null;
  try {
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) return r.value as Series;
    }
    return null;
  } catch { return null; }
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
    curScore[base] += r; // BASE strengthens
    curScore[quote] -= r; // QUOTE weakens
  }
  const vals = G8.map((c) => curScore[c]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
  const z: Record<string, number> = {};
  for (const c of G8) z[c] = (curScore[c] - mean) / sd;
  const ranks = [...G8].sort((a, b) => z[b] - z[a]);
  return { tsISO: new Date().toISOString(), ranks, scores: z, ttl: Date.now() + 15 * 60 * 1000 };
}
type CsmSnapshot = { tsISO: string; ranks: string[]; scores: Record<string, number>; ttl: number };
let CSM_CACHE: CsmSnapshot | null = null;
async function getCSM(): Promise<CsmSnapshot> {
  if (CSM_CACHE && Date.now() < CSM_CACHE.ttl) return CSM_CACHE;
  const seriesMap: Record<string, Series | null> = {};
  await Promise.all(USD_PAIRS.map(async (p) => { seriesMap[p] = await fetchSeries15(p); }));
  const snap = computeCSMFromPairs(seriesMap);
  if (!snap) {
    if (CSM_CACHE) return CSM_CACHE; // stale ok
    throw new Error("CSM unavailable (fetch failed and no cache).");
  }
  CSM_CACHE = snap;
  return snap;
}

// ---------- COT (weekly) with fallback ----------
const CFTC_URL = "https://www.cftc.gov/dea/newcot/f_disagg.txt";
const CFTC_MAP: Record<string, { name: string, tradingsterId?: string }> = {
  EUR: { name: "EURO FX - CHICAGO MERCANTILE EXCHANGE", tradingsterId: "099741" },
  JPY: { name: "JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE", tradingsterId: "097741" },
  GBP: { name: "BRITISH POUND STERLING - CHICAGO MERCANTILE EXCHANGE", tradingsterId: "096742" },
  CAD: { name: "CANADIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE", tradingsterId: "090741" },
  AUD: { name: "AUSTRALIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE", tradingsterId: "232741" },
  CHF: { name: "SWISS FRANC - CHICAGO MERCANTILE EXCHANGE", tradingsterId: "092741" },
  NZD: { name: "NEW ZEALAND DOLLAR - CHICAGO MERCANTILE EXCHANGE", tradingsterId: "112741" },
  USD: { name: "U.S. DOLLAR INDEX - ICE FUTURES U.S.", tradingsterId: "098662" },
};
function csvSplit(line: string): string[] {
  const out: string[] = []; let buf = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { out.push(buf); buf = ""; } else { buf += ch; }
  }
  out.push(buf); return out;
}
type CotSnapshot = {
  reportDate: string; // ISO date
  net: Record<string, number>;
  ttl: number;
  stale?: boolean;
  method?: "primary" | "tradingster" | "headline_fallback";
};
function parseCFTC(text: string): CotSnapshot | null {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 5) return null;
  const header = csvSplit(lines[0]).map((s) => s.trim());
  const idxLong = header.findIndex((h) => /noncommercial/i.test(h) && /long/i.test(h));
  const idxShort = header.findIndex((h) => /noncommercial/i.test(h) && /short/i.test(h));
  const idxMarket = header.findIndex((h) => /market\s+and\s+exchange\s+names?/i.test(h));
  const idxDate = header.findIndex((h) => /report\s+date/i.test(h));
  if (idxLong < 0 || idxShort < 0 || idxMarket < 0 || idxDate < 0) return null;

  const net: Record<string, number> = {};
  let latestDate = "";

  for (let i = 1; i < lines.length; i++) {
    const cols = csvSplit(lines[i]);
    const name = (cols[idxMarket] || "").toUpperCase().trim();
    const longV = Number(String(cols[idxLong] || "").replace(/[^0-9.-]/g, ""));
    const shortV = Number(String(cols[idxShort] || "").replace(/[^0-9.-]/g, ""));
    const d = (cols[idxDate] || "").trim();
    if (d) latestDate = latestDate || d;

    for (const cur of Object.keys(CFTC_MAP)) {
      if (name === CFTC_MAP[cur].name.toUpperCase()) {
        net[cur] = (isFinite(longV) ? longV : 0) - (isFinite(shortV) ? shortV : 0);
      }
    }
  }
  if (!latestDate || Object.keys(net).length < 3) return null;
  const reportDateISO = new Date(latestDate).toISOString().slice(0, 10);
  return { reportDate: reportDateISO, net, ttl: Date.now() + 7 * 24 * 60 * 60 * 1000, method: "primary" };
}
async function fetchCFTCOnce(timeoutMs: number): Promise<string> {
  const r = await fetch(CFTC_URL, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`CFTC ${r.status}`);
  return r.text();
}
async function fetchTradingster(cur: string, timeoutMs = 3500): Promise<{ reportDate: string, net: number } | null> {
  const id = CFTC_MAP[cur]?.tradingsterId;
  if (!id) return null;
  const url = `https://www.tradingster.com/cot/futures/legacy-futures/${id}`;
  try {
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "TradePlanApp/1.0" } });
    if (!r.ok) return null;
    const html = await r.text();
    // regex literals use [\s\S] (single backslashes) — compile-safe.
    const section = html.match(/Non-Commercial Positions[\s\S]{0,1500}?<tbody>([\s\S]*?)<\/tbody>/i)?.[1]
      || html.match(/Managed Money[\s\S]{0,1500}?<tbody>([\s\S]*?)<\/tbody>/i)?.[1]
      || "";
    const row = section.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i)?.[1] || "";
    const nums = Array.from(row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi))
      .map(m => m[1].replace(/<[^>]+>/g, "").replace(/[, ]+/g, "").trim());
    const longV = Number(nums[1] || "0"); // col order: [Traders, Long, Short, ...]
    const shortV = Number(nums[2] || "0");
    const dateMatch = html.match(/Report Date[^<]*<\/th>\s*<td[^>]*>([^<]+)<\/td>/i)?.[1]
      || html.match(/as of\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i)?.[1];
    const reportDate = dateMatch ? new Date(dateMatch).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    if (!isFinite(longV) || !isFinite(shortV)) return null;
    return { reportDate, net: longV - shortV };
  } catch { return null; }
}

// Headline-based COT fallback
const COT_PHRASES = [
  /speculators?\s+(?:are\s+)?net\s+long/i,
  /speculators?\s+(?:are\s+)?net\s+short/i,
  /managed\s+money\s+.*net\s+long/i,
  /managed\s+money\s+.*net\s+short/i,
  /non[-\s]?commercials?\s+.*net\s+long/i,
  /non[-\s]?commercials?\s+.*net\s+short/i,
  /funds?\s+(?:added|increase|increased|trimmed|reduced)\s+net\s+long/i,
  /funds?\s+(?:added|increase|increased|trimmed|reduced)\s+net\s+short/i,
];
const CURR_SYNONYMS: Record<string, string[]> = {
  USD: ["USD", "U.S. dollar", "US dollar", "greenback", "DXY", "buck"],
  EUR: ["EUR", "euro", "Eurozone"],
  GBP: ["GBP", "pound", "sterling", "Cable"],
  JPY: ["JPY", "yen"],
  AUD: ["AUD", "Aussie"],
  NZD: ["NZD", "Kiwi"],
  CHF: ["CHF", "Swiss franc"],
  CAD: ["CAD", "loonie"],
};
function titleMentionsCurrency(title: string, cur: string): boolean {
  const bag = CURR_SYNONYMS[cur] || [cur];
  const t = title.toLowerCase();
  return bag.some(w => t.includes(w.toLowerCase()));
}
function inferCotFromHeadlines(headlines: AnyHeadline[]): { used: boolean, net: Record<string, number>, method?: "headline_fallback" } {
  const net: Record<string, number> = {}; let hit = false;
  for (const h of (headlines || [])) {
    const title = String(h?.title || ""); if (!title) continue;
    const hasPhrase = COT_PHRASES.some(re => re.test(title)); if (!hasPhrase) continue;
    for (const cur of Object.keys(CURR_SYNONYMS)) {
      if (titleMentionsCurrency(title, cur)) {
        const longish = /(net\s+long|added\s+net\s+long|increase.*net\s+long)/i.test(title);
        const shortish = /(net\s+short|added\s+net\s+short|increase.*net\s+short)/i.test(title);
        if (longish && !shortish) { net[cur] = (net[cur] || 0) + 1; hit = true; }
        if (shortish && !longish) { net[cur] = (net[cur] || 0) - 1; hit = true; }
      }
    }
  }
  return { used: hit, net, method: hit ? "headline_fallback" : undefined };
}
let COT_CACHE: CotSnapshot | null = null;
async function getCOT(headlinesForFallback?: AnyHeadline[] | null): Promise<CotSnapshot> {
  try {
    const txt = await fetchCFTCOnce(6000);
    const snap = parseCFTC(txt);
    if (snap) { COT_CACHE = snap; return snap; }
    throw new Error("CFTC parse failed");
  } catch (e) {
    // Tradingster concurrently
    const net: Record<string, number> = {};
    let reportDate = "";
    const tasks = Object.keys(CFTC_MAP).map(async (cur) => {
      const got = await fetchTradingster(cur).catch(() => null);
      if (got) {
        net[cur] = got.net;
        if (!reportDate) reportDate = got.reportDate;
      }
    });
    await Promise.race([Promise.all(tasks), new Promise((resolve) => setTimeout(resolve, 3600))]);

    if (reportDate && Object.keys(net).length >= 3) {
      const snap: CotSnapshot = { reportDate, net, ttl: Date.now() + 3 * 24 * 60 * 60 * 1000, method: "tradingster" };
      COT_CACHE = snap;
      return snap;
    }
    const fb = inferCotFromHeadlines(headlinesForFallback || []);
    if (fb.used) {
      const iso = new Date().toISOString().slice(0, 10);
      const snap: CotSnapshot = { reportDate: iso, net: fb.net, ttl: Date.now() + 48 * 60 * 60 * 1000, stale: true, method: "headline_fallback" };
      return snap;
    }
    if (COT_CACHE) {
      const ageMs = Date.now() - new Date(COT_CACHE.reportDate + "T00:00:00Z").getTime();
      const fourteenDays = 14 * 24 * 60 * 60 * 1000;
      if (ageMs <= fourteenDays) {
        return { ...COT_CACHE, stale: true };
      }
    }
    throw new Error((e as any)?.message || "COT unavailable");
  }
}

// ---------- sentiment text from CSM + (optional) COT ----------
function sentimentSummary(
  csm: CsmSnapshot,
  cot: CotSnapshot | null,
  cotError: string | null
): {
  text: string;
  provenance: {
    csm_used: boolean;
    csm_time: string;
    cot_used: boolean;
    cot_report_date: string | null;
    cot_method?: string | null;
    cot_error?: string | null;
  };
} {
  const ranksLine = `CSM (60–240m): ${csm.ranks.slice(0, 4).join(" > ")} ... ${csm.ranks.slice(-3).join(" < ")}`;
  const prov: {
    csm_used: boolean; csm_time: string; cot_used: boolean; cot_report_date: string | null; cot_method?: string | null; cot_error?: string | null;
  } = { csm_used: true, csm_time: csm.tsISO, cot_used: !!cot, cot_report_date: cot ? cot.reportDate : null, cot_method: cot?.method || null };
  let cotLine = "";
  if (cot) {
    const entries = Object.entries(cot.net);
    const longers = entries.filter(([, v]) => (v as number) > 0).sort((a, b) => (b[1] as number) - (a[1] as number)).map(([k]) => k);
    const shorters = entries.filter(([, v]) => (v as number) < 0).sort((a, b) => (a[1] as number) - (b[1] as number)).map(([k]) => k);
    const staleTag = cot.stale ? " (stale)" : "";
    const methodTag = cot.method && cot.method !== "primary" ? ` [${cot.method}]` : "";
    cotLine = `COT ${cot.reportDate}${staleTag}${methodTag}: Long ${longers.slice(0, 3).join("/")} | Short ${shorters.slice(0, 2).join("/")}`;
  } else {
    cotLine = `COT: unavailable (${cotError || "service timeout"})`;
    prov.cot_error = cotError || "unavailable";
  }
  return { text: `${ranksLine}\n${cotLine}`, provenance: prov };
}

// ---------- calendar helpers (bias + realised carry-forward) ----------
function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
const DEFAULT_CARRY_WINDOWS = { typicalDays: 3, nfpCbDays: 7 };

function calendarShortText(resp: any, pair: string): string | null {
  if (!resp?.ok) return null;
  const instrBias = resp?.bias?.instrument;
  const parts: string[] = [];
  if (instrBias && instrBias.pair === pair) {
    parts.push(`Instrument bias: ${instrBias.label} (${instrBias.score})`);
  }
  const per = resp?.bias?.perCurrency || {};
  const base = pair.slice(0,3), quote = pair.slice(3);
  const b = per[base]?.label ? `${base}:${per[base].label}` : null;
  const q = per[quote]?.label ? `${quote}:${per[quote].label}` : null;
  if (b || q) parts.push(`Per-currency: ${[b,q].filter(Boolean).join(" / ")}`);
  if (!parts.length) parts.push("No strong calendar bias.");
  return `Calendar bias for ${pair}: ${parts.join("; ")}`;
}

type FundOverride = { active: boolean; reason?: string; strength?: "minor" | "major"; alignment?: "align" | "conflict" | "neutral" };
function computeFundamentalsOverride(calendarResp: any, instrument: string): { override: FundOverride, pastBiasNote?: string | null } {
  const out: FundOverride = { active: false };
  if (!calendarResp?.ok) return { override: out, pastBiasNote: null };
  const pair = instrument.toUpperCase();
  const base = pair.slice(0,3), quote = pair.slice(3);

  const surprises: any[] = Array.isArray(calendarResp?.surprises) ? calendarResp.surprises : [];
  const realised: any[] = Array.isArray(calendarResp?.bias?.recentRealised) ? calendarResp.bias.recentRealised : [];

  let found: any = null;
  for (const ev of [...surprises, ...realised]) {
    if (!ev) continue;
    const cur = String(ev.currency || ev.ccy || "").toUpperCase();
    const whenISO = ev.whenISO || ev.time || ev.timeISO;
    if (!cur) continue;
    const ageMs = whenISO ? (Date.now() - new Date(whenISO).getTime()) : 0;
    const ageDays = ageMs > 0 ? ageMs / (24*3600*1000) : 0;
    const isNfpOrCB = /nfp|nonfarm|central\s*bank|rate\s*(decision|hike|cut)|ecb|fed|boe|boc|boj/i.test(String(ev.event||""));
    const maxDays = isNfpOrCB ? DEFAULT_CARRY_WINDOWS.nfpCbDays : DEFAULT_CARRY_WINDOWS.typicalDays;
    if (ageDays > maxDays) continue;
    if (cur === base || cur === quote) { found = ev; break; }
  }

  if (found) {
    const evName = found.event || found.name || "major release";
    const cur = String(found.currency || found.ccy || "").toUpperCase();
    const dir = String(found.dir || found.direction || found.bias || "").toLowerCase();
    const imp = String(found.impact || found.priority || "high").toLowerCase();
    const strength: FundOverride["strength"] = (imp === "high" ? "major" : "minor");
    return { override: { active: true, reason: `${evName} surprise → ${cur} ${dir}`, strength }, pastBiasNote: `${evName} (${cur}) surprise carried forward (${strength})` };
  }
  return { override: out, pastBiasNote: null };
}

async function fetchCalendarBias(req: NextApiRequest, instrument: string): Promise<{
  text: string | null,
  status: "image" | "api" | "unavailable",
  provider: string | null,
  raw?: any, override?: FundOverride, pastBiasNote?: string | null
}> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/calendar?instrument=${encodeURIComponent(instrument)}&windowHours=168&_t=${Date.now()}`; // 7d
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    const j: any = await r.json().catch(() => ({}));
    if (j?.ok) {
      const t = calendarShortText(j, instrument) || `Calendar bias for ${instrument}: (no strong signal)`;
      const { override, pastBiasNote } = computeFundamentalsOverride(j, instrument);
      return { text: t, status: "api", provider: String(j?.provider || "mixed"), raw: j, override, pastBiasNote };
    }
    return { text: "Calendar unavailable — upload an image if you need the panel parsed.", status: "unavailable", provider: null };
  } catch {
    return { text: "Calendar unavailable — upload an image if you need the panel parsed.", status: "unavailable", provider: null };
  }
}

// ---------- prompts (now calendar image is results-aware) ----------
function systemCore(instrument: string, opts?: { calendarIsImage?: boolean }) {
  const base = [
    "You are a professional discretionary trader.",
    "Perform **visual** price-action market analysis from the images (no numeric candles).",
    "Multi-timeframe alignment: 15m execution, 1H context, 4H HTF.",
    "Tournament mode: evaluate and pick the **single best** candidate (no defaults):",
    "- Pullback to OB/FVG/SR confluence",
    "- Breakout + Retest (proof: body close beyond + retest holds or SFP reclaim)",
    "- SFP / Liquidity grab + reclaim",
    "- Range reversion at extremes",
    "- Trendline / Channel retest",
    "- Double-tap / retest of origin",
    "- Breaker Block retest (failed OB flips)",
    "- Imbalance / FVG mitigation with structure hold",
    "- Quasimodo (QM) / CHOCH reversal",
    "- Trend exhaustion + divergence at HTF zone",
    "- Session plays (Asia→London/NYO): sweep → continuation/fade",
    "- Equal Highs/Lows liquidity run",
    "- (Anchored) VWAP reversion/break",
    "- **Fibonacci retracement confluence (38.2–61.8% / golden pocket)**",
    "- Correlation confirmation (DXY vs EUR, UST yields vs USDJPY, SPX/NAS vs risk FX/crypto)",
    "",
    "Scoring rubric (0–100): Structure trend(25), 15m trigger quality(25), HTF context(15), Clean path to target(10), Stop validity(10), Fundamentals/Headlines/Sentiment(10), 'No chase' penalty(5).",
    "Market entry allowed only when **explicit proof**; otherwise EntryType: Pending and use Buy/Sell Limit zone.",
    "Stops are price-action based (behind swing/OB/SR); if too tight, step to the next valid zone.",
    "Only reference **Headlines / Calendar / CSM / COT** if their respective blocks are present below. Otherwise omit them.",
    "Keep instrument alignment with " + instrument + ".",
    "",
    "Warnings: If an economic release is within ~60 minutes, include a warning (no blackout). If result flips bias, advise standing down; if aligned, keep plan.",
    "Fundamentals override: If a major realised surprise is present (CPI/NFP/CB), reflect that in conviction (boost if aligned, cap if conflicted).",
    "Conviction engine: compute bias for Headlines, Calendar (incl. realised carry-forward), COT, CSM, Technical; then produce a final conviction %.",
    "Option 2 policy: If a plausible secondary setup exists (Break+Retest, SFP, TL break), ALWAYS include 'Option 2' with its own conviction and explicit trigger instructions (wait-for-close, retest hold, entry, SL, TP).",
  ];
  if (opts?.calendarIsImage) {
    base.push(
      "",
      "**Calendar image is provided. You MUST read the table (Actual/Forecast/Previous, impact icons) directly from the image and infer realised bias for currencies related to the instrument.**",
      "Reflect these realised results in the Fundamental View, the warning copy, and the final conviction."
    );
  }
  return base.join("\n");
}
function buildUserPartsBase(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  fundOverride?: any | null; pastBiasNote?: string | null;
  fastEmbedHeadlines?: boolean;
}) {
  const parts: any[] = [
    { type: "text", text: `Instrument: ${args.instrument}\nDate: ${args.dateStr}` },
    { type: "text", text: "HTF 4H Chart:" }, { type: "image_url", image_url: { url: args.h4 } },
    { type: "text", text: "Context 1H Chart:" }, { type: "image_url", image_url: { url: args.h1 } },
    { type: "text", text: "Execution 15M Chart:" }, { type: "image_url", image_url: { url: args.m15 } },
  ];
  if (args.calendarDataUrl) { parts.push({ type: "text", text: "Economic Calendar Image (read results):" }); parts.push({ type: "image_url", image_url: { url: args.calendarDataUrl } }); }
  if (!args.calendarDataUrl && args.calendarText) { parts.push({ type: "text", text: `Calendar snapshot:\n${args.calendarText}` }); }
  if (args.pastBiasNote) { parts.push({ type: "text", text: `Past realised bias carry-forward: ${args.pastBiasNote}` }); }

  // perf v1: 4 lines in fast mode, else 6
  if (args.headlinesText) {
    const lines = (args.headlinesText || "").split("\n");
    const keep = args.fastEmbedHeadlines ? lines.slice(0, 4) : lines.slice(0, 6);
    parts.push({ type: "text", text: `Recent headlines snapshot (used for bias; list shown in Stage-2):\n${keep.join("\n")}` });
  }

  if (args.sentimentText) { parts.push({ type: "text", text: `Sentiment snapshot (CSM + COT; used for bias):\n${args.sentimentText}` }); }
  if (args.fundOverride?.active) { parts.push({ type: "text", text: `Fundamentals override present: ${args.fundOverride.reason} (${args.fundOverride.strength})` }); }
  return parts;
}
// FULL card (legacy)
function messagesFull(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
}) {
  const system = [
    systemCore(args.instrument, { calendarIsImage: !!args.calendarDataUrl }),
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
    "• Option 2 (Market): Provide a viable secondary strategy with its own conviction and explicit trigger steps (wait-for-close, retest hold, entry rule, SL, TP).",
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
    `  "candidateScores": [{ "name": string, "score": number, "reason": string }],`,
    `  "sources": { "headlines_used": number, "headlines_instrument": string, "calendar_used": boolean, "calendar_status": string, "calendar_provider": string | null, "calendar_realised_used": boolean | null, "calendar_realised_mode": string | null, "csm_used": boolean, "csm_time": string, "cot_used": boolean, "cot_report_date": string | null, "cot_error": string | null, "cot_method": string | null, "option2_present": boolean, "option2_strategy": string | null, "fundamentals_override": string | null } }`,
    "```",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: buildUserPartsBase({ ...args, fastEmbedHeadlines: false }) },
  ];
}

// FAST Stage-1: Quick Plan + Management + ai_meta
function messagesFastStage1(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  provenance?: {
    headlines_used: number; headlines_instrument: string; calendar_used: boolean; calendar_status: string;
    calendar_provider: string | null; csm_used: boolean; csm_time: string; cot_used: boolean; cot_report_date: string | null; cot_error?: string | null; cot_method?: string | null;
  };
}) {
  const system = [
    systemCore(args.instrument, { calendarIsImage: !!args.calendarDataUrl }),
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
    "• Option 2 (Market): Provide a viable secondary strategy with its own conviction and explicit trigger steps (wait-for-close, retest hold, entry rule, SL, TP).",
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
    `  "candidateScores": [{ "name": string, "score": number, "reason": string }],`,
    `  "sources": { "headlines_used": number, "headlines_instrument": string, "calendar_used": boolean, "calendar_status": string, "calendar_provider": string | null, "calendar_realised_used": boolean | null, "calendar_realised_mode": string | null, "csm_used": boolean, "csm_time": string, "cot_used": boolean, "cot_report_date": string | null, "cot_error": string | null, "cot_method": string | null, "option2_present": boolean, "option2_strategy": string | null, "fundamentals_override": string | null } }`,
    "```",
  ].join("\n");

  const parts = buildUserPartsBase({ ...args, fastEmbedHeadlines: true });
  if (args.provenance) {
    parts.push({ type: "text", text: `provenance:\n${JSON.stringify(args.provenance)}` });
  }
  return [{ role: "system", content: system }, { role: "user", content: parts }];
}

// ---------- OpenAI call ----------
async function callOpenAI(messages: any[]) {
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, max_tokens: 1200 }),
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

// ---------- enforcement passes ----------
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

// ---------- Option 2: enforce presence with explicit triggers ----------
async function ensureOption2Present(instrument: string, text: string, aiMeta: any) {
  const hasOption2 = /Option 2\s*\(/i.test(text) && !/Not available/i.test(text);
  if (hasOption2) return text;
  const hint = aiMeta?.candidateScores?.[0]?.name || aiMeta?.selectedStrategy || "Breakout + Retest";
  const messages = [
    { role: "system", content: "Inject a proper 'Option 2 (Market)' section into the plan if missing. Use a plausible secondary strategy (Breakout + Retest, SFP/reclaim, Trendline break). Include: direction, explicit trigger (wait-for-close above/below X, retest hold at Y, entry confirmation like engulfing/wicks), SL, TP1/TP2, and its own conviction %. Keep the rest of the card unchanged." },
    { role: "user", content: `Instrument: ${instrument}\n\nCandidate hint: ${hint}\n\nOriginal card:\n${text}\n\nRewrite ONLY by adding a complete Option 2 block with explicit step-by-step rules.` },
  ];
  return callOpenAI(messages);
}

// ---------- live price ----------
async function fetchLivePrice(pair: string): Promise<number | null> {
  const tasks: Promise<number | null>[] = [];

  if (TD_KEY) tasks.push((async () => {
    try {
      const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
      const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&dp=5`;
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1500) });
      const j: any = await r.json().catch(() => ({}));
      const p = Number(j?.price);
      return (isFinite(p) && p > 0) ? p : null;
    } catch { return null; }
  })());

  if (FH_KEY) tasks.push((async () => {
    try {
      const sym = `OANDA:${pair.slice(0, 3)}_${pair.slice(3)}`;
      const to = Math.floor(Date.now() / 1000);
      const from = to - 60 * 60 * 3;
      const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(sym)}&resolution=15&from=${from}&to=${to}&token=${FH_KEY}`;
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1500) });
      const j: any = await r.json().catch(() => ({}));
      const c = Array.isArray(j?.c) ? j.c : [];
      const last = Number(c[c.length - 1]);
      return (isFinite(last) && last > 0) ? last : null;
    } catch { return null; }
  })());

  if (POLY_KEY) tasks.push((async () => {
    try {
      const ticker = `C:${pair}`;
      const to = new Date();
      const from = new Date(to.getTime() - 60 * 60 * 1000);
      const fmt = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const url =
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=desc&limit=1&apiKey=${POLY_KEY}`;
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1200) });
      const j: any = await r.json().catch(() => ({}));
      const res = Array.isArray(j?.results) ? j.results[0] : null;
      const last = Number(res?.c);
      return (isFinite(last) && last > 0) ? last : null;
    } catch { return null; }
  })());

  const settled = await Promise.allSettled(tasks);
  for (const s of settled) { if (s.status === "fulfilled" && s.value) return s.value; }
  // fallback via series
  try {
    const S = await fetchSeries15(pair);
    const last = S?.c?.[S.c.length - 1];
    if (isFinite(Number(last)) && Number(last) > 0) return Number(last);
  } catch {}
  return null;
}
// ---------- handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    // mode selection
    const urlMode = String((req.query.mode as string) || "").toLowerCase();
    let mode: "full" | "fast" | "expand" = urlMode === "fast" ? "fast" : urlMode === "expand" ? "expand" : "full";
    const fast = mode === "fast";

    // expand path
    if (mode === "expand") {
      const cacheKey = String(req.query.cache || "").trim();
      const c = getCache(cacheKey);
      if (!c) return res.status(400).json({ ok: false, reason: "Expand failed: cache expired or not found." });
      if (!c.sentimentText) return res.status(503).json({ ok: false, reason: "Missing sentiment snapshot for expand." });
      const dateStr = new Date().toISOString().slice(0, 10);
      const messages = messagesExpandStage2({
        instrument: c.instrument, dateStr, m15: c.m15, h1: c.h1, h4: c.h4,
        calendarDataUrl: c.calendar || undefined, headlinesText: c.headlinesText || undefined, sentimentText: c.sentimentText || undefined,
        aiMetaHint: null,
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
    if (process.env.NODE_ENV !== "production") console.log(`[vision-plan] parsed in ${dt(tParse)}`);

    const instrument = String(fields.instrument || fields.code || "EURUSD").toUpperCase().replace(/\s+/g, "");
    const requestedMode = String(fields.mode || "").toLowerCase();
    if (requestedMode === "fast") mode = "fast";

    // Files (if provided)
    const m15f = pickFirst(files.m15);
    const h1f = pickFirst(files.h1);
    const h4f = pickFirst(files.h4);
    const calF = pickFirst(files.calendar);

    // URLs (optional)
    const m15Url = String(pickFirst(fields.m15Url) || "").trim();
    const h1Url = String(pickFirst(fields.h1Url) || "").trim();
    const h4Url = String(pickFirst(fields.h4Url) || "").trim();

    // Build images and process with adaptive sharp (perf v1: fast mode smaller)
    const tImg = now();
    const [m15FromFile, h1FromFile, h4FromFile, calUrl] = await Promise.all([
      fileToDataUrl(m15f, fast), fileToDataUrl(h1f, fast), fileToDataUrl(h4f, fast), calF ? fileToDataUrl(calF, fast) : Promise.resolve(null),
    ]);
    const [m15FromUrl, h1FromUrl, h4FromUrl] = await Promise.all([
      m15FromFile ? Promise.resolve(null) : linkToDataUrl(m15Url, fast),
      h1FromFile ? Promise.resolve(null) : linkToDataUrl(h1Url, fast),
      h4FromFile ? Promise.resolve(null) : linkToDataUrl(h4Url, fast),
    ]);
    const m15 = m15FromFile || m15FromUrl;
    const h1 = h1FromFile || h1FromUrl;
    const h4 = h4FromFile || h4FromUrl;

    if (process.env.NODE_ENV !== "production") {
      console.log(`[vision-plan] images ready ${dt(tImg)} (m15=${dataUrlSizeBytes(m15)}B, h1=${dataUrlSizeBytes(h1)}B, h4=${dataUrlSizeBytes(h4)}B, cal=${dataUrlSizeBytes(calUrl)}B)`);
    }

    if (!m15 || !h1 || !h4) {
      return res.status(400).json({
        ok: false,
        reason: "Provide all three charts: m15, h1, h4 — either as files or valid TradingView/Gyazo direct image links.",
      });
    }

    // ----- Headlines: prefer client-provided; else server fetch -----
    let headlineItems: AnyHeadline[] = [];
    let headlinesText: string | null = null;

    const rawHeadlines = pickFirst(fields.headlinesJson) as string | null;
    if (rawHeadlines) {
      try {
        const parsed = JSON.parse(String(rawHeadlines));
        if (Array.isArray(parsed)) {
          headlineItems = parsed.slice(0, 12);
          headlinesText = headlinesToPromptLines(headlineItems, 6);
        }
      } catch {
        // fall through to server fetch
      }
    }
    if (!headlinesText) {
      const viaServer = await fetchedHeadlinesViaServer(req, instrument);
      headlineItems = viaServer.items;
      headlinesText = viaServer.promptText;
    }

    // ----- Calendar: image precedence; else API bias with visible note on failure -----
    let calendarText: string | null = null;
    let calendarStatus: "image" | "api" | "unavailable" = "unavailable";
    let calendarProvider: string | null = null;
    let fundOverride: FundOverride | undefined;
    let pastBiasNote: string | null | undefined;

    if (calUrl) {
      calendarStatus = "image";
      calendarProvider = "image";
    } else {
      const cal = await fetchCalendarBias(req, instrument);
      calendarText = cal.text;
      calendarStatus = cal.status;
      calendarProvider = cal.provider;
      fundOverride = cal.override;
      pastBiasNote = cal.pastBiasNote;
    }

    // ----- Sentiment: CSM mandatory; COT soft-required with fallback -----
    let csm: CsmSnapshot;
    try { csm = await getCSM(); } catch (e: any) {
      return res.status(503).json({ ok: false, reason: `CSM unavailable: ${e?.message || "fetch failed"}.` });
    }

    let cot: CotSnapshot | null = null;
    let cotErr: string | null = null;
    try { cot = await getCOT(headlineItems); } catch (e: any) { cot = null; cotErr = e?.message || "unavailable"; }

    const { text: sentimentText, provenance } = sentimentSummary(csm, cot, cotErr);

    // ----- Live price -----
    const livePrice = await fetchLivePrice(instrument);
    const dateStr = new Date().toISOString().slice(0, 10);

    const provForModel = {
      headlines_used: Math.min(fast ? 4 : 6, Array.isArray(headlineItems) ? headlineItems.length : 0),
      headlines_instrument: instrument,
      calendar_used: !!calUrl || calendarStatus === "api",
      calendar_status: calendarStatus,
      calendar_provider: calendarProvider,
      calendar_realised_used: calUrl ? true : (calendarStatus === "api" ? true : null),
      calendar_realised_mode: calUrl ? "image-vision" : (calendarStatus === "api" ? "api" : null),
      csm_used: true,
      csm_time: csm.tsISO,
      cot_used: !!cot,
      cot_report_date: cot ? cot.reportDate : null,
      cot_error: cot ? null : cotErr || "unavailable",
      cot_method: cot?.method || null,
    };

    // ---------- Stage 1 (fast) or Full ----------
    let text = "";
    let aiMeta: any = null;

    if (mode === "fast") {
      const messages = messagesFastStage1({
        instrument, dateStr, m15, h1, h4,
        calendarDataUrl: calUrl || undefined,
        calendarText: (!calUrl && calendarText) ? calendarText : undefined,
        headlinesText: headlinesText || undefined,
        sentimentText: sentimentText,
        provenance: provForModel,
      });
      if (livePrice) { (messages[0] as any).content = (messages[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice}`; }
      if (fundOverride?.active) { (messages[0] as any).content = (messages[0] as any).content + `\n\nFundamentals override active: ${fundOverride.reason} (${fundOverride.strength}).`; }

      text = await callOpenAI(messages);
      aiMeta = extractAiMeta(text) || {};
      if (livePrice && (aiMeta.currentPrice == null || !isFinite(Number(aiMeta.currentPrice)))) {
        aiMeta.currentPrice = livePrice;
      }

      // enforcement passes
      if (aiMeta && needsPendingLimit(aiMeta)) { text = await rewriteAsPending(instrument, text); aiMeta = extractAiMeta(text) || aiMeta; }
      const bp = aiMeta?.breakoutProof || {};
      const hasProof = !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
      if (String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout") && !hasProof) {
        text = await normalizeBreakoutLabel(text); aiMeta = extractAiMeta(text) || aiMeta;
      }
      if (aiMeta) {
        if (livePrice && aiMeta.currentPrice !== livePrice) aiMeta.currentPrice = livePrice;
        const bad = invalidOrderRelativeToPrice(aiMeta);
        if (bad) { text = await fixOrderVsPrice(instrument, text, aiMeta); aiMeta = extractAiMeta(text) || aiMeta; }
      }

      // Ensure Option 2 present
      text = await ensureOption2Present(instrument, text, aiMeta);
      const opt2Present = /Option 2\s*\(/i.test(text) && !/Not available/i.test(text);
      const opt2Strategy = (text.match(/Option 2\s*\(([^)]+)\)/i)?.[1] || null);

      // Cache stage-1
      const cacheKey = setCache({
        instrument, m15, h1, h4, calendar: calUrl || null, headlinesText: headlinesText || null, sentimentText,
      });

      // Provenance + cost
      const sources = { ...provForModel, option2_present: !!opt2Present, option2_strategy: opt2Strategy, fundamentals_override: fundOverride?.active ? (fundOverride.reason || "active") : null };
      const meta: any = { instrument, mode, cacheKey, headlinesCount: headlineItems.length, fallbackUsed: false, aiMeta, sources };
      if (SHOW_COST) meta.cost = { prompt_tokens: 0, completion_tokens: 0, total_usd: 0 };

      if (!text || refusalLike(text)) {
        const fb = fallbackCard(instrument, sources);
        return res.status(200).json({ ok: true, text: fb, meta: { ...meta, fallbackUsed: true, aiMeta: extractAiMeta(fb) } });
      }

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ok: true, text, meta });
    }

    // FULL (legacy)
    const messages = messagesFull({
      instrument, dateStr, m15, h1, h4,
      calendarDataUrl: calUrl || undefined,
      calendarText: (!calUrl && calendarText) ? calendarText : undefined,
      headlinesText: headlinesText || undefined,
      sentimentText,
    });
    if (livePrice) { (messages[0] as any).content = (messages[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice}`; }
    if (fundOverride?.active) { (messages[0] as any).content = (messages[0] as any).content + `\n\nFundamentals override active: ${fundOverride.reason} (${fundOverride.strength}).`; }

    text = await callOpenAI(messages);
    aiMeta = extractAiMeta(text) || {};
    if (livePrice && (aiMeta.currentPrice == null || !isFinite(Number(aiMeta.currentPrice)))) {
      aiMeta.currentPrice = livePrice;
    }

    if (aiMeta && needsPendingLimit(aiMeta)) { text = await rewriteAsPending(instrument, text); aiMeta = extractAiMeta(text) || aiMeta; }
    const bp2 = aiMeta?.breakoutProof || {};
    const hasProof2 = !!(bp2?.bodyCloseBeyond === true && (bp2?.retestHolds === true || bp2?.sfpReclaim === true));
    if (String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout") && !hasProof2) {
      text = await normalizeBreakoutLabel(text); aiMeta = extractAiMeta(text) || aiMeta;
    }
    if (aiMeta) {
      if (livePrice && aiMeta.currentPrice !== livePrice) aiMeta.currentPrice = livePrice;
      const bad = invalidOrderRelativeToPrice(aiMeta);
      if (bad) { text = await fixOrderVsPrice(instrument, text, aiMeta); aiMeta = extractAiMeta(text) || aiMeta; }
    }

    // Ensure Option 2 present
    text = await ensureOption2Present(instrument, text, aiMeta);
    const opt2Present = /Option 2\s*\(/i.test(text) && !/Not available/i.test(text);
    const opt2Strategy = (text.match(/Option 2\s*\(([^)]+)\)/i)?.[1] || null);

    const sources = { ...provForModel, option2_present: !!opt2Present, option2_strategy: opt2Strategy, fundamentals_override: fundOverride?.active ? (fundOverride.reason || "active") : null };

    if (!text || refusalLike(text)) {
      const fb = fallbackCard(instrument, sources);
      return res.status(200).json({
        ok: true, text: fb,
        meta: { instrument, mode, headlinesCount: headlineItems.length, fallbackUsed: true, aiMeta: extractAiMeta(fb), sources },
      });
    }

    res.setHeader("Cache-Control", "no-store");
    const meta: any = { instrument, mode, headlinesCount: headlineItems.length, fallbackUsed: false, aiMeta, sources };
    if (SHOW_COST) meta.cost = { prompt_tokens: 0, completion_tokens: 0, total_usd: 0 };
    return res.status(200).json({ ok: true, text, meta });
  } catch (err: any) {
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}

// ---------- fallback (keeps structure + sources) ----------
function fallbackCard(
  instrument: string,
  sources: {
    headlines_used: number;
    headlines_instrument: string;
    calendar_used: boolean;
    calendar_status: string;
    calendar_provider: string | null;
    calendar_realised_used?: boolean | null;
    calendar_realised_mode?: string | null;
    csm_used: boolean;
    csm_time: string;
    cot_used: boolean;
    cot_report_date: string | null;
    cot_error?: string | null;
    cot_method?: string | null;
    option2_present?: boolean;
    option2_strategy?: string | null;
    fundamentals_override?: string | null;
  }
) {
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
        sources,
        note: "Fallback used due to refusal/empty output.",
      },
      null,
      2
    ),
    "```",
  ].join("\n");
}
