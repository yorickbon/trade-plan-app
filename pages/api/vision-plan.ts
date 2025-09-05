// /pages/api/vision-plan.ts
/**
 * CHANGE MANIFEST — /pages/api/vision-plan.ts
 *
 * Added (why):
 * 1) Bias pipeline → Conviction (Audit-ready):
 *    - Compute five independent biases: Headlines, Calendar, COT, CSM, Technical.
 *    - Combine via weighted model into a single conviction% (0–100), surface per-component details in ai_meta.
 *    - Reason: You requested conviction only after all five biases are known.
 *
 * 2) Headlines bias-aware selection (embed ≤6):
 *    - Rank 12 headlines by instrument match + direction fit (vs preliminary bias from CSM/COT/Calendar) + freshness + source tier.
 *    - Keep UI up to 12; embed 6 lines for the model. Record headlines_provider/used/instrument in meta.sources and ai_meta.sources.
 *    - Reason: Only include the most bias-relevant headlines in the prompt.
 *
 * 3) Calendar results → bias + pre/post-event warnings (no blackout):
 *    - If calendar provides upcoming event within ≤60m for instrument currencies → add pre-event warning flag in provenance; instruct model to include a warning line.
 *    - If actual results available, compute surprise-based bias and mark post-event alignment: aligned keeps plan active (+small nudger), conflict sets "don't trade" guidance (≤25%).
 *    - Reason: You asked for warnings (not caps) and for using actual results to shape bias.
 *
 * 4) COT fallback via headlines:
 *    - If CFTC/Tradingster fail, scan headlines for cues (“non-commercial net long/short”, “speculators net long/short”) per currency.
 *    - Set cot_used=true, cot_method="headline_fallback" when directional hint is found; else cot_used=false with cot_error.
 *    - Reason: Soft-required COT with a deterministic fallback.
 *
 * 5) Price sanity provenance:
 *    - Live price source chain returns {price, source}. Propagate meta.sources.price_fix: "none" | "finnhub" | "polygon" | "series".
 *    - Reason: Mark when price was corrected externally per your rule.
 *
 * 6) Cost passthrough:
 *    - When SHOW_COST=true, append meta.cost placeholders (or OpenAI usage if available) without altering output format.
 *
 * Preserved:
 * - Section names, output template wording, image priority, enforcement passes, caching, and existing behaviors.
 * - No frontend changes; no provider changes beyond reading /api/news provenance when present.
 */

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
const OPENAI_API_BASE =
  process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

const SHOW_COST = String(process.env.SHOW_COST || "") === "true";

// Market data keys (free tiers ok)
const TD_KEY = process.env.TWELVEDATA_API_KEY || "";
const FH_KEY = process.env.FINNHUB_API_KEY || process.env.FINNHUB_APT_KEY || "";
const POLY_KEY = process.env.POLYGON_API_KEY || "";

// ---------- small utils ----------
const IMG_MAX_BYTES = 12 * 1024 * 1024; // absolute safety cap
const BASE_W = 1280;       // base width
const MAX_W = 1500;        // upper bound for adaptive
const TARGET_MIN = 420 * 1024;
const TARGET_IDEAL = 800 * 1024;
const TARGET_MAX = 1200 * 1024; // hard ceiling for adaptive

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
  CACHE.set(key, { ...entry, exp: Date.now() + 3 * 60 * 1000 });
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

// ---------- CSM cache (15 min) ----------
type CsmSnapshot = {
  tsISO: string;
  ranks: string[];
  scores: Record<string, number>;
  ttl: number;
};
let CSM_CACHE: CsmSnapshot | null = null;

// ---------- COT cache (14 days with fallback) ----------
type CotSnapshot = {
  reportDate: string; // ISO date
  net: Record<string, number>;
  ttl: number;
  stale?: boolean; // true if using cached older than 7d but ≤14d
};
let COT_CACHE: CotSnapshot | null = null;

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
async function processAdaptiveToDataUrl(buf: Buffer): Promise<string> {
  // Start conservative
  let width = BASE_W;
  let quality = 74;
  let out = await toJpeg(buf, width, quality);
  // If too small (risk of blurry text), iteratively improve up to bounds
  let guard = 0;
  while (out.byteLength < TARGET_MIN && guard < 4) {
    quality = Math.min(quality + 6, 88);
    if (quality >= 82 && width < MAX_W) width = Math.min(width + 100, MAX_W);
    out = await toJpeg(buf, width, quality);
    guard++;
  }
  // If still small, one last bump
  if (out.byteLength < TARGET_MIN && (quality < 88 || width < MAX_W)) {
    quality = Math.min(quality + 4, 88);
    width = Math.min(width + 100, MAX_W);
    out = await toJpeg(buf, width, quality);
  }
  // Clamp if we overshoot big
  if (out.byteLength > TARGET_MAX) {
    // gentle re-encode at slightly lower quality to bring under cap
    const q2 = Math.max(72, quality - 6);
    out = await toJpeg(buf, width, q2);
  }
  if (out.byteLength > IMG_MAX_BYTES) {
    throw new Error("image too large after processing");
  }
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}
async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p = file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;
  const raw = await fs.readFile(p);
  const out = await processAdaptiveToDataUrl(raw);
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
  const out2 = await processAdaptiveToDataUrl(raw2);
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
  } catch { return null; }
}

// ---------- headlines helpers ----------
type AnyHeadline = { title?: string; source?: string; url?: string; published_at?: string; ago?: string; sentiment?: { score?: number } | null } & Record<string, any>;

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
async function fetchedHeadlinesViaServer(req: NextApiRequest, instrument: string): Promise<{ items: AnyHeadline[]; promptText: string | null; provider?: string | null; usedCount?: number }> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(instrument)}&hours=48&max=12&_t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    const items: AnyHeadline[] = Array.isArray(j?.items) ? j.items : [];
    const provider = j?.meta?.sources?.headlines_provider || j?.provider || null;
    const used = Math.min(6, items.length);
    return { items, promptText: headlinesToPromptLines(items, 6), provider, usedCount: used };
  } catch {
    return { items: [], promptText: null, provider: null, usedCount: 0 };
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
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2500) });
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
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const url =
      `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/15/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&apiKey=${POLY_KEY}`;
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

// ---------- COT (weekly) SOFT-REQUIRED ----------
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
  // 7d ttl normally; we will allow stale reuse up to 14d if fresh fails
  return { reportDate: reportDateISO, net, ttl: Date.now() + 7 * 24 * 60 * 60 * 1000 };
}
async function fetchCFTCOnce(timeoutMs: number): Promise<string> {
  const r = await fetch(CFTC_URL, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`CFTC ${r.status}`);
  return r.text();
}

// Tradingster fallback (HTML best-effort): get latest row and compute net = Non-Commercial Long - Short
async function fetchTradingster(cur: string, timeoutMs = 7000): Promise<{ reportDate: string, net: number } | null> {
  const id = CFTC_MAP[cur]?.tradingsterId;
  if (!id) return null;
  const url = `https://www.tradingster.com/cot/futures/legacy-futures/${id}`;
  try {
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "TradePlanApp/1.0" } });
    if (!r.ok) return null;
    const html = await r.text();
    const section = html.match(/Non-Commercial Positions[\s\S]{0,1000}?<tbody>([\s\S]*?)<\/tbody>/i)?.[1] || "";
    const row = section.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i)?.[1] || "";
    const nums = Array.from(row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(m => m[1].replace(/<[^>]+>/g, "").replace(/[, ]+/g, "").trim());
    const longV = Number(nums[1] || "0");
    const shortV = Number(nums[2] || "0");
    const dateMatch = html.match(/Report Date[^<]*<\/th>\s*<td[^>]*>([^<]+)<\/td>/i)?.[1] || html.match(/as of\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i)?.[1];
    const reportDate = dateMatch ? new Date(dateMatch).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    if (!isFinite(longV) || !isFinite(shortV)) return null;
    return { reportDate, net: longV - shortV };
  } catch { return null; }
}

async function getCOT(): Promise<CotSnapshot> {
  try {
    const txt = await fetchCFTCOnce(10_000);
    const snap = parseCFTC(txt);
    if (snap) { COT_CACHE = snap; return snap; }
    throw new Error("CFTC parse failed");
  } catch (e) {
    const net: Record<string, number> = {};
    let reportDate = "";
    for (const cur of Object.keys(CFTC_MAP)) {
      const got = await fetchTradingster(cur).catch(() => null);
      if (got) {
        net[cur] = got.net;
        if (!reportDate) reportDate = got.reportDate;
      }
    }
    if (reportDate && Object.keys(net).length >= 3) {
      const snap: CotSnapshot = { reportDate, net, ttl: Date.now() + 3 * 24 * 60 * 60 * 1000 };
      COT_CACHE = snap;
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
    cot_error?: string | null;
  };
} {
  const ranksLine = `CSM (60–240m): ${csm.ranks.slice(0, 4).join(" > ")} ... ${csm.ranks.slice(-3).join(" < ")}`;
  const prov: {
    csm_used: boolean; csm_time: string; cot_used: boolean; cot_report_date: string | null; cot_error?: string | null;
  } = { csm_used: true, csm_time: csm.tsISO, cot_used: !!cot, cot_report_date: cot ? cot.reportDate : null };
  let cotLine = "";
  if (cot) {
    const entries = Object.entries(cot.net);
    const longers = entries.filter(([, v]) => (v as number) > 0).sort((a, b) => (b[1] as number) - (a[1] as number)).map(([k]) => k);
    const shorters = entries.filter(([, v]) => (v as number) < 0).sort((a, b) => (a[1] as number) - (b[1] as number)).map(([k]) => k);
    const staleTag = cot.stale ? " (stale)" : "";
    cotLine = `COT ${cot.reportDate}${staleTag}: Long ${longers.slice(0, 3).join("/")} | Short ${shorters.slice(0, 2).join("/")}`;
  } else {
    cotLine = `COT: unavailable (${cotError || "service timeout"})`;
    prov.cot_error = cotError || "unavailable";
  }
  return { text: `${ranksLine}\n${cotLine}`, provenance: prov };
}

// ---------- scoring helpers (headlines selection) ----------
const SOURCE_TIERS: Record<string, number> = {
  "bloomberg.com": 1.0,
  "ft.com": 1.0,
  "reuters.com": 0.95,
  "wsj.com": 0.95,
  "nytimes.com": 0.9,
  "cnbc.com": 0.9,
  "theguardian.com": 0.85,
  "apnews.com": 0.85,
};
const SYNONYMS: Record<string, string[]> = {
  XAU: ["xau", "gold", "bullion", "precious metal"],
  XAUUSD: ["xauusd", "gold", "bullion", "precious metal"],
  GOLD: ["gold", "xau", "bullion"],
  WTI: ["wti", "crude", "oil", "west texas", "nymex"],
  BRENT: ["brent", "crude", "oil", "ice brent"],
  DXY: ["dxy", "dollar index", "us dollar index"],
  USD: ["usd", "dollar", "greenback"],
  EURUSD: ["eurusd", "euro dollar", "euro-dollar", "euro vs dollar", "eur/usd"],
  GBPJPY: ["gbpjpy", "pound yen", "sterling yen", "gbp/jpy"],
  NAS100: ["nas100", "nasdaq 100", "nasdaq-100", "ndx", "us tech index"],
  US30: ["us30", "dow jones", "djia", "dow"],
  SPX: ["spx", "s&p 500", "sp500", "s&p500", "standard & poor"],
  XAG: ["xag", "silver"],
  BTCUSD: ["btcusd", "bitcoin", "btc", "crypto"],
};
function hostnameWeight(u?: string): number {
  if (!u) return 0.8;
  try {
    const h = new URL(u).hostname.replace(/^www\./, "").toLowerCase();
    return SOURCE_TIERS[h] ?? 0.8;
  } catch {
    return 0.75;
  }
}
function freshnessWeight(iso?: string): number {
  if (!iso) return 0.6;
  const nowMs = Date.now();
  const t = new Date(iso).getTime();
  const hours = Math.max(0, (nowMs - t) / 3_600_000);
  const w = Math.max(0.4, Math.min(1, 1 - Math.log10(1 + hours) * 0.25));
  return Number.isFinite(w) ? w : 0.6;
}
function buildSynonymBag(list: string[]): string[] {
  const bag = new Set<string>();
  const add = (s: string) => bag.add(s.toLowerCase());
  for (const raw of list) {
    const k = raw.toUpperCase();
    add(raw); add(k);
    if (SYNONYMS[k]) for (const syn of SYNONYMS[k]) add(syn);
  }
  return [...bag];
}
function instrumentRelevance(title: string, synonyms: string[]): number {
  const t = (title || "").toLowerCase();
  let hits = 0;
  for (const k of synonyms) if (k && t.includes(k)) hits++;
  if (!hits) return 0;
  return Math.min(1, hits / Math.max(3, synonyms.length));
}
type Dir = "long" | "short" | "flat";
function dirFromSentimentScore(x: number | undefined | null): "pos" | "neg" | "neu" {
  if (typeof x !== "number") return "neu";
  if (x > 0.05) return "pos";
  if (x < -0.05) return "neg";
  return "neu";
}
function directionFitBias(sentScore: number | undefined | null, bias: Dir): number {
  const lab = dirFromSentimentScore(sentScore);
  if (bias === "flat" || lab === "neu") return 0.3;
  if (bias === "long" && lab === "pos") return 1.0;
  if (bias === "short" && lab === "neg") return 1.0;
  return 0.2;
}
function scoreHeadline(it: AnyHeadline, synonyms: string[], prelimBias: Dir): number {
  const sInstr = instrumentRelevance(String(it?.title || ""), synonyms);
  const sFresh = freshnessWeight(it?.published_at);
  const sSource = hostnameWeight(it?.url);
  const sDir = directionFitBias(it?.sentiment?.score ?? null, prelimBias);
  return sInstr * 0.5 + sFresh * 0.25 + sSource * 0.2 + sDir * 0.05;
}
function selectBiasAwareHeadlines(items: AnyHeadline[], instrument: string, prelimBias: Dir): { selected: AnyHeadline[], provider?: string | null } {
  const synonyms = buildSynonymBag([instrument]);
  const withScores = (items || []).map((it) => ({ it, sc: scoreHeadline(it, synonyms, prelimBias) }));
  const dedup: { it: AnyHeadline, sc: number }[] = [];
  for (const x of withScores) {
    const t = (x.it.title || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!t) continue;
    const dupe = dedup.find(d => d.it.title && t && d.it.title.toLowerCase().includes(t));
    if (!dupe) dedup.push(x);
  }
  const sorted = dedup.sort((a, b) => b.sc - a.sc || new Date(b.it.published_at || 0).getTime() - new Date(a.it.published_at || 0).getTime());
  return { selected: sorted.slice(0, 6).map(x => x.it) };
}

// ---------- prompts ----------
function systemCore(instrument: string) {
  return [
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
    // Calendar warning protocol (no blackout):
    "If 'calendar_pre_event_window' is provided, print a short ⚠️ warning line about upcoming high-impact in ~minutes.",
    "If 'calendar_post_result' is provided and says aligned, add ✅ keep-active note; if conflict, add ❌ do-not-trade note and reduce conviction accordingly.",
  ].join("\n");
}
function buildUserPartsBase(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  calendarWarning?: string | null; calendarPostNote?: string | null;
}) {
  const parts: any[] = [
    { type: "text", text: `Instrument: ${args.instrument}\nDate: ${args.dateStr}` },
    { type: "text", text: "HTF 4H Chart:" }, { type: "image_url", image_url: { url: args.h4 } },
    { type: "text", text: "Context 1H Chart:" }, { type: "image_url", image_url: { url: args.h1 } },
    { type: "text", text: "Execution 15M Chart:" }, { type: "image_url", image_url: { url: args.m15 } },
  ];
  if (args.calendarDataUrl) { parts.push({ type: "text", text: "Economic Calendar Image:" }); parts.push({ type: "image_url", image_url: { url: args.calendarDataUrl } }); }
  if (!args.calendarDataUrl && args.calendarText) { parts.push({ type: "text", text: `Calendar snapshot:\n${args.calendarText}` }); }
  if (args.headlinesText) { parts.push({ type: "text", text: `Recent headlines snapshot (used for bias; list shown in Stage-2):\n${args.headlinesText}` }); }
  if (args.sentimentText) { parts.push({ type: "text", text: `Sentiment snapshot (CSM + COT; used for bias):\n${args.sentimentText}` }); }
  if (args.calendarWarning) { parts.push({ type: "text", text: `Pre-Event Warning:\n${args.calendarWarning}` }); }
  if (args.calendarPostNote) { parts.push({ type: "text", text: `Post-Event Update:\n${args.calendarPostNote}` }); }
  return parts;
}

// FULL card (legacy)
function messagesFull(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  calendarWarning?: string | null; calendarPostNote?: string | null;
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
    `{ "selectedStrategy": string,` ,
    `  "entryType": "Pending" | "Market",` ,
    `  "entryOrder": "Sell Limit" | "Buy Limit" | "Sell Stop" | "Buy Stop" | "Market",` ,
    `  "direction": "Long" | "Short" | "Flat",` ,
    `  "currentPrice": number | null,` ,
    `  "zone": { "min": number, "max": number, "tf": "15m" | "1H" | "4H", "type": "OB" | "FVG" | "SR" | "Other" },` ,
    `  "stop": number, "tp1": number, "tp2": number,` ,
    `  "breakoutProof": { "bodyCloseBeyond": boolean, "retestHolds": boolean, "sfpReclaim": boolean },` ,
    `  "candidateScores": [{ "name": string, "score": number, "reason": string }],` ,
    `  "sources": { "headlines_used": number, "headlines_instrument": string, "calendar_used": boolean, "calendar_status": string, "calendar_provider": string | null, "csm_used": boolean, "csm_time": string, "cot_used": boolean, "cot_report_date": string | null, "cot_error": string | null },` ,
    `  "conviction_components": any, "conviction_final": number }`,
    "```",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: buildUserPartsBase(args) },
  ];
}

// FAST Stage-1: Quick Plan + Management + ai_meta
function messagesFastStage1(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  provenance?: {
    headlines_used: number; headlines_instrument: string; calendar_used: boolean; calendar_status: string;
    calendar_provider: string | null; csm_used: boolean; csm_time: string; cot_used: boolean; cot_report_date: string | null; cot_error?: string | null;
  };
  calendarWarning?: string | null; calendarPostNote?: string | null;
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
    `{ "selectedStrategy": string,` ,
    `  "entryType": "Pending" | "Market",` ,
    `  "entryOrder": "Sell Limit" | "Buy Limit" | "Sell Stop" | "Buy Stop" | "Market",` ,
    `  "direction": "Long" | "Short" | "Flat",` ,
    `  "currentPrice": number | null,` ,
    `  "zone": { "min": number, "max": number, "tf": "15m" | "1H" | "4H", "type": "OB" | "FVG" | "SR" | "Other" },` ,
    `  "stop": number, "tp1": number, "tp2": number,` ,
    `  "breakoutProof": { "bodyCloseBeyond": boolean, "retestHolds": boolean, "sfpReclaim": boolean },` ,
    `  "candidateScores": [{ "name": string, "score": number, "reason": string }],` ,
    `  "sources": { "headlines_used": number, "headlines_instrument": string, "calendar_used": boolean, "calendar_status": string, "calendar_provider": string | null, "csm_used": boolean, "csm_time": string, "cot_used": boolean, "cot_report_date": string | null, "cot_error": string | null },` ,
    `  "conviction_components": any, "conviction_final": number }`,
    "```",
  ].join("\n");

  const parts = buildUserPartsBase({
    instrument: args.instrument,
    dateStr: args.dateStr,
    m15: args.m15,
    h1: args.h1,
    h4: args.h4,
    calendarDataUrl: args.calendarDataUrl,
    calendarText: args.calendarText,
    headlinesText: args.headlinesText,
    sentimentText: args.sentimentText,
    calendarWarning: args.calendarWarning || null,
    calendarPostNote: args.calendarPostNote || null,
  });
  if (args.provenance) {
    parts.push({ type: "text", text: `provenance:\n${JSON.stringify(args.provenance)}` });
  }
  return [{ role: "system", content: system }, { role: "user", content: parts }];
}

// Stage-2 Expand: ONLY the remaining sections
function messagesExpandStage2(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null; aiMetaHint?: any;
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

  const userParts = buildUserPartsBase({
    instrument: args.instrument, dateStr: args.dateStr, m15: args.m15, h1: args.h1, h4: args.h4,
    calendarDataUrl: args.calendarDataUrl, calendarText: args.calendarText, headlinesText: args.headlinesText, sentimentText: args.sentimentText,
    calendarWarning: null, calendarPostNote: null,
  });
  if (args.aiMetaHint) userParts.push({ type: "text", text: `ai_meta_hint:\n${JSON.stringify(args.aiMetaHint, null, 2)}` });
  return [{ role: "system", content: system }, { role: "user", content: userParts }];
}

// ---------- OpenAI call ----------
async function callOpenAI(messages: any[]) {
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, messages }),
  });
  const json = await rsp.json().catch(() => ({} as any));
  if (!rsp.ok) throw new Error(`OpenAI vision request failed: ${rsp.status} ${JSON.stringify(json)}`);
  const out =
    json?.choices?.[0]?.message?.content ??
    (Array.isArray(json?.choices?.[0]?.message?.content)
      ? json.choices[0].message.content.map((c: any) => c?.text || "").join("\n")
      : "");
  const usage = json?.usage ? {
    prompt_tokens: Number(json.usage.prompt_tokens || 0),
    completion_tokens: Number(json.usage.completion_tokens || 0),
    total_tokens: Number(json.usage.total_tokens || 0),
  } : null;
  return { text: String(out || ""), usage };
}

// ---------- enforcement passes ----------
async function rewriteAsPending(instrument: string, text: string) {
  const messages = [
    { role: "system", content: "Rewrite the trade card as PENDING (no Market) into a clean Buy/Sell LIMIT zone at OB/FVG/SR confluence if breakout proof is missing. Keep tournament section and X-ray." },
    { role: "user", content: `Instrument: ${instrument}\n\n${text}\n\nRewrite strictly to Pending.` },
  ];
  const r = await callOpenAI(messages);
  return r.text;
}
async function normalizeBreakoutLabel(text: string) {
  const messages = [
    { role: "system", content: "If 'Breakout + Retest' is claimed but proof is not shown (body close + retest hold or SFP reclaim), rename setup to 'Pullback (OB/FVG/SR)' and leave rest unchanged." },
    { role: "user", content: text },
  ];
  const r = await callOpenAI(messages);
  return r.text;
}
async function fixOrderVsPrice(instrument: string, text: string, aiMeta: any) {
  const messages = [
    { role: "system", content: "Adjust the LIMIT zone so that: Sell Limit is an ABOVE-price pullback into supply; Buy Limit is a BELOW-price pullback into demand. Keep all other content & sections." },
    { role: "user", content: `Instrument: ${instrument}\n\nCurrent Price: ${aiMeta?.currentPrice}\nProvided Zone: ${JSON.stringify(aiMeta?.zone)}\n\nCard:\n${text}\n\nFix only the LIMIT zone side and entry, keep format.` },
  ];
  const r = await callOpenAI(messages);
  return r.text;
}

// ---------- live price helpers ----------
type PriceResp = { price: number | null, source: "twelvedata" | "finnhub" | "polygon" | "series" | "none" };
async function fetchLivePrice(pair: string): Promise<PriceResp> {
  // 1) TwelveData price endpoint
  if (TD_KEY) {
    try {
      const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
      const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&dp=5`;
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1800) });
      const j: any = await r.json().catch(() => ({}));
      const p = Number(j?.price);
      if (isFinite(p) && p > 0) return { price: p, source: "twelvedata" };
    } catch {}
  }
  // 2) Finnhub last 15m close
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
      if (isFinite(last) && last > 0) return { price: last, source: "finnhub" };
    } catch {}
  }
  // 3) Polygon last agg close
  if (POLY_KEY) {
    try {
      const ticker = `C:${pair}`;
      const to = new Date();
      const from = new Date(to.getTime() - 60 * 60 * 1000);
      const fmt = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const url =
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=desc&limit=1&apiKey=${POLY_KEY}`;
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1500) });
      const j: any = await r.json().catch(() => ({}));
      const res = Array.isArray(j?.results) ? j.results[0] : null;
      const last = Number(res?.c);
      if (isFinite(last) && last > 0) return { price: last, source: "polygon" };
    } catch {}
  }
  // 4) fallback: use latest 15m series close from our series fetch
  try {
    const S = await fetchSeries15(pair);
    const last = S?.c?.[S.c.length - 1];
    if (isFinite(Number(last)) && Number(last) > 0) return { price: Number(last), source: "series" };
  } catch {}
  return { price: null, source: "none" };
}

// ---------- calendar helpers ----------
function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }

type CalendarBiasResp = {
  text: string | null;
  status: "image" | "api" | "unavailable";
  provider: string | null;
  // optional enrichments if /api/calendar exposes them
  instrumentBias?: { label: "bullish" | "bearish" | "neutral"; score?: number } | null;
  nextEvent?: { timeISO: string; currency: string; event: string; impact: string } | null;
  postResult?: { actual?: number | string; forecast?: number | string; surprise?: number | string; direction?: "bullish" | "bearish" | "neutral"; currency?: string } | null;
};

function calendarShortText(resp: any, pair: string): string | null {
  if (!resp?.ok) return null;
  const instrBias = resp?.bias?.instrument;
  const parts: string[] = [];
  if (instrBias && instrBias.pair === pair) {
    parts.push(`Instrument bias: ${instrBias.label} (${instrBias.score})`);
  }
const per = resp?.bias?.perCurrency || {};
const base = pair.slice(0,3);
const quote = pair.slice(3);
 }
  const b = per[base]?.label ? `${base}:${per[base].label}` : null;
  const q = per[quote]?.label ? `${quote}:${per[quote].label}` : null;
  if (b or q) parts.push(`Per-currency: ${[b,q].filter(Boolean).join(" / ")}`);
  if (!parts.length) parts.push("No strong calendar bias.");
  return `Calendar bias for ${pair}: ${parts.join("; ")}`;
}

async function fetchCalendarBias(req: NextApiRequest, instrument: string): Promise<CalendarBiasResp> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/calendar?instrument=${encodeURIComponent(instrument)}&windowHours=72&_t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    const j: any = await r.json().catch(() => ({}));
    if (j?.ok) {
      const t = calendarShortText(j, instrument) || `Calendar bias for ${instrument}: (no strong signal)`;
      // try read optional fields if provided by your calendar API
      const instrumentBias = j?.bias?.instrument?.label ? { label: j.bias.instrument.label, score: j.bias.instrument.score } : null;
      const nextEvent = j?.nextEvent || null;
      const postResult = j?.postResult || null;
      return { text: t, status: "api", provider: String(j?.provider || "mixed"), instrumentBias, nextEvent, postResult };
    }
    return { text: "Calendar unavailable — upload an image if you need the panel parsed.", status: "unavailable", provider: null };
  } catch {
    return { text: "Calendar unavailable — upload an image if you need the panel parsed.", status: "unavailable", provider: null };
  }
}

// ---------- bias & conviction engine ----------
function sign(x: number) { return x >= 0 ? 1 : -1; }

function csmPairScore(csm: CsmSnapshot, pair: string): number {
  const base = pair.slice(0,3), quote = pair.slice(3);
  const zBase = csm.scores[base] ?? 0;
  const zQuote = csm.scores[quote] ?? 0;
  // tanh squash into [-1,1]
  const raw = zBase - zQuote;
  return Math.max(-1, Math.min(1, Math.tanh(raw)));
}

function cotPairScore(cot: CotSnapshot | null, pair: string): { s: number, conf: number } {
  if (!cot) return { s: 0, conf: 0 };
  const base = pair.slice(0,3), quote = pair.slice(3);
  const nb = Number(cot.net[base] ?? 0);
  const nq = Number(cot.net[quote] ?? 0);
  const diff = nb - nq; // >0 bullish base vs quote
  const mag = Math.min(1, Math.abs(diff) / Math.max(1, Math.abs(nb) + Math.abs(nq)));
  const s = diff === 0 ? 0 : sign(diff) * Math.max(0.15, mag); // small floor if non-zero
  const conf = cot.stale ? 0.7 : 1.0;
  return { s, conf };
}

function calendarBiasScore(calendarBias: CalendarBiasResp | null, pair: string): { s: number, conf: number, preEvent?: { minutes: number, info: any } | null, post?: { state: "aligned" | "conflict" | "neutral", info: any } | null } {
  if (!calendarBias) return { s: 0, conf: 0 };
  let s = 0, conf = 0.6;
  const base = pair.slice(0,3), quote = pair.slice(3);
  if (calendarBias.instrumentBias?.label) {
    const lbl = calendarBias.instrumentBias.label;
    if (lbl === "bullish") s = +0.5;
    else if (lbl === "bearish") s = -0.5;
    else s = 0;
  }
  // pre-event window
  let preEvent: any = null;
  if (calendarBias.nextEvent?.timeISO) {
    const etaMin = Math.max(0, Math.floor((new Date(calendarBias.nextEvent.timeISO).getTime() - Date.now()) / 60_000));
    if (etaMin <= 60) {
      preEvent = { minutes: etaMin, info: calendarBias.nextEvent };
    }
  }
  // post-result alignment
  let post: any = null;
  if (calendarBias.postResult?.direction) {
    const dir = calendarBias.postResult.direction; // bullish/bearish/neutral for currency
    // map currency result to instrument: if result currency == base, bullish result -> long; if quote -> bearish result -> long
    // We rely on API providing currency in postResult; if missing, treat neutral.
    const cur = (calendarBias.postResult.currency || "").toUpperCase();
    let instrDir: "long" | "short" | "neutral" = "neutral";
    if (cur === base) instrDir = dir === "bullish" ? "long" : dir === "bearish" ? "short" : "neutral";
    if (cur === quote) instrDir = dir === "bullish" ? "short" : dir === "bearish" ? "long" : "neutral";
    post = { state: instrDir === "neutral" ? "neutral" : (instrDir === "long" ? "aligned" : "conflict"), info: calendarBias.postResult };
    // bump s slightly in the direction of post result if aligned/neutral
    if (post.state === "aligned") s = Math.max(s, 0.6);
    if (post.state === "conflict") s = Math.min(s, -0.6);
  }
  return { s, conf, preEvent, post };
}

function headlinesBiasScore(selected: AnyHeadline[], prelimDir: Dir): { s: number, conf: number } {
  if (!selected or not selected.length) return { s: 0, conf: 0 };
  let pos = 0, neg = 0;
  selected.forEach(h => {
    const sc = Number(h?.sentiment?.score ?? 0);
    if (sc > 0.05) pos++; else if (sc < -0.05) neg++;
  });
  let s = 0;
  if (prelimDir === "long") s = (pos - neg) / Math.max(1, selected.length);
  else if (prelimDir === "short") s = (neg - pos) / Math.max(1, selected.length);
  else s = (pos - neg) / Math.max(1, selected.length) * 0.5;
  // crude confidence from recency via freshnessWeight avg
  const f = selected.map(h => freshnessWeight(h.published_at)).reduce((a, b) => a + b, 0) / selected.length;
  const conf = clamp(0.3 + (f - 0.6) * 0.7, 0.3, 1);
  return { s: clamp(s, -1, 1), conf };
}

function technicalBiasFromAi(aiMeta: any): { s: number, conf: number, dir: Dir } {
  const dirText = String(aiMeta?.direction || "").toLowerCase();
  const score = Number(aiMeta?.candidateScores?.[0]?.score ?? 0);
  const breakout = !!(aiMeta?.breakoutProof?.bodyCloseBeyond && (aiMeta?.breakoutProof?.retestHolds || aiMeta?.breakoutProof?.sfpReclaim));
  let dir: Dir = dirText === "long" ? "long" : dirText === "short" ? "short" : "flat";
  let s = (score || 0) / 100;
  if (dir === "short") s = -s;
  let conf = breakout ? 1.0 : (aiMeta?.entryType === "Pending" ? 0.7 : 0.85);
  return { s: clamp(s, -1, 1), conf, dir };
}

function computeConviction(components: {
  head?: { s: number, conf: number },
  cal?: { s: number, conf: number },
  cot?: { s: number, conf: number },
  csm?: { s: number, conf: number },
  tech?: { s: number, conf: number, dir: Dir },
}, modifiers?: { preEvent?: boolean, post?: "aligned" | "conflict" | "neutral", priceFix?: "none" | "finnhub" | "polygon" | "series" | "none" }) {
  const W = { tech: 0.40, head: 0.20, csm: 0.15, cot: 0.15, cal: 0.10 };
  const contrib =
    (components.tech?.s ?? 0) * (components.tech?.conf ?? 0) * W.tech +
    (components.head?.s ?? 0) * (components.head?.conf ?? 0) * W.head +
    (components.csm?.s ?? 0) * (components.csm?.conf ?? 0) * W.csm +
    (components.cot?.s ?? 0) * (components.cot?.conf ?? 0) * W.cot +
    (components.cal?.s ?? 0) * (components.cal?.conf ?? 0) * W.cal;

  let conviction = clamp((contrib + 1) / 2 * 100, 0, 100);

  // Post-event nudger (no blackout): aligned mildly up, conflict constrained
  if (modifiers?.post === "aligned") conviction = clamp(conviction + 5, 0, 100);
  if (modifiers?.post === "conflict") conviction = Math.min(conviction, 25);

  // Price fix small penalty if not twelvedata
  if (modifiers?.priceFix && modifiers.priceFix !== "none") conviction = Math.max(0, conviction - 5);

  return { conviction: Math.round(conviction), contrib };
}

// ---------- COT headline fallback scan ----------
function cotFallbackFromHeadlines(items: AnyHeadline[], pair: string): { used: boolean, method?: "headline_fallback", s: number, conf: number, error?: string } {
  if (!items || !items.length) return { used: false, s: 0, conf: 0, error: "no headlines" };
  const base = pair.slice(0,3), quote = pair.slice(3);
  const text = items.map(i => (i.title || "") + " " + (i.summary || "")).join(" ■ ").toLowerCase();
  const rxPos = /(non[-\s]?commercial|speculators|managed money)[^\.]*net (long|buy)/g;
  const rxNeg = /(non[-\s]?commercial|speculators|managed money)[^\.]*net (short|sell)/g;
  let sBase = 0, sQuote = 0;
  // crude mapping by currency keyword presence
  const hasBase = new RegExp(`\\b${base}\\b`, "i").test(text);
  const hasQuote = new RegExp(`\\b${quote}\\b`, "i").test(text);
  const pos = text.match(rxPos)?.length || 0;
  const neg = text.match(rxNeg)?.length || 0;
  if (!hasBase and not hasQuote) return { used: false, s: 0, conf: 0, error: "no currency mention" };
  if (hasBase) sBase = pos - neg;
  if (hasQuote) sQuote = pos - neg;
  const diff = (sBase) - (sQuote);
  if (diff === 0) return { used: false, s: 0, conf: 0, error: "no directional cue" };
  const s = diff > 0 ? +0.4 : -0.4;
  return { used: true, method: "headline_fallback", s, conf: 0.5 };
}

// ---------- handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    // mode selection
    const urlMode = String((req.query.mode as string) || "").toLowerCase();
    let mode: "full" | "fast" | "expand" = urlMode === "fast" ? "fast" : urlMode === "expand" ? "expand" : "full";

    // expand path: reuse cached images; no need for multipart
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
      const { text } = await callOpenAI(messages);
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

    // Build images and process with adaptive sharp
    const tImg = now();
    const [m15FromFile, h1FromFile, h4FromFile, calUrl] = await Promise.all([
      fileToDataUrl(m15f), fileToDataUrl(h1f), fileToDataUrl(h4f), calF ? fileToDataUrl(calF) : Promise.resolve(null),
    ]);
    const [m15FromUrl, h1FromUrl, h4FromUrl] = await Promise.all([
      m15FromFile ? Promise.resolve(null) : linkToDataUrl(m15Url),
      h1FromFile ? Promise.resolve(null) : linkToDataUrl(h1Url),
      h4FromFile ? Promise.resolve(null) : linkToDataUrl(h4Url),
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
    let headlinesProvider: string | null = null;

    const rawHeadlines = pickFirst(fields.headlinesJson) as string | null;
    if (rawHeadlines) {
      try {
        const parsed = JSON.parse(String(rawHeadlines));
        if (Array.isArray(parsed)) {
          headlineItems = parsed.slice(0, 12);
        }
      } catch { /* fall through */ }
    }
    if (!headlineItems.length) {
      const viaServer = await fetchedHeadlinesViaServer(req, instrument);
      headlineItems = viaServer.items;
      headlinesProvider = viaServer.provider || null;
    }

    // ----- Calendar: image precedence; else API bias + results/warnings when available -----
    let calendarText: string | null = null;
    let calendarStatus: "image" | "api" | "unavailable" = "unavailable";
    let calendarProvider: string | null = null;
    let calendarPreEventWarning: string | null = null;
    let calendarPostNote: string | null = null;
    let calendarBiasObj: CalendarBiasResp | null = null;

    if (calUrl) {
      calendarStatus = "image";
      calendarProvider = "image";
    } else {
      const cal = await fetchCalendarBias(req, instrument);
      calendarText = cal.text;
      calendarStatus = cal.status;
      calendarProvider = cal.provider;
      calendarBiasObj = cal;

      // Pre-event window warning (≤60m)
      if (cal.nextEvent?.timeISO) {
        const etaMin = Math.max(0, Math.floor((new Date(cal.nextEvent.timeISO).getTime() - Date.now()) / 60_000));
        if (etaMin <= 60) {
          calendarPreEventWarning = `⚠️ ${cal.nextEvent.currency} ${cal.nextEvent.event} (${cal.nextEvent.impact}) in ~${etaMin}m. Execute only if trigger prints before release or if result aligns with bias.`;
        }
      }
      // Post-event note if results included
      if (cal.postResult?.direction) {
        const tag = cal.postResult.direction === "bullish" ? "supports bias — plan remains active." :
                    cal.postResult.direction === "bearish" ? "flips bias — do not trade this setup." : "neutral result.";
        calendarPostNote = `Post-release: ${tag}`;
      }
    }

    // ----- Sentiment: CSM mandatory; COT soft-required with fallback -----
    let csm: CsmSnapshot;
    try { csm = await getCSM(); } catch (e: any) {
      return res.status(503).json({ ok: false, reason: `CSM unavailable: ${e?.message || "fetch failed"}.` });
    }

    let cot: CotSnapshot | null = null;
    let cotErr: string | null = null;
    try { cot = await getCOT(); } catch (e: any) { cot = null; cotErr = e?.message || "unavailable"; }

    // COT headline fallback if needed
    let cotFallback: { used: boolean, method?: "headline_fallback", s: number, conf: number, error?: string } | null = null;
    if (!cot) {
      cotFallback = cotFallbackFromHeadlines(headlineItems, instrument);
      if (cotFallback.used) {
        // synthesize a minimal cot snapshot influence for conviction only
      }
    }

    const { text: sentimentText, provenance } = sentimentSummary(csm, cot, cotErr);

    // ----- Live price + provenance -----
    const priceResp = await fetchLivePrice(instrument);
    const livePrice = priceResp.price;
    const priceFix: "none" | "finnhub" | "polygon" | "series" | "none" =
      priceResp.source === "twelvedata" ? "none" : (priceResp.source as any);

    const dateStr = new Date().toISOString().slice(0, 10);

    // ----- Preliminary bias for headlines ranking (from CSM + COT + Calendar) -----
    let prelimDir: Dir = "flat";
    const csmS = csmPairScore(csm, instrument);
    const cotS = cot ? cotPairScore(cot, instrument).s : (cotFallback?.s or 0);
    const calSc = calendarBiasObj ? calendarBiasScore(calendarBiasObj, instrument).s : 0;
    const sum = csmS * 0.5 + cotS * 0.3 + calSc * 0.2;
    prelimDir = sum > 0.05 ? "long" : sum < -0.05 ? "short" : "flat";

    // ----- Bias-aware selection of headlines (≤6) -----
    const selectedForEmbed = selectBiasAwareHeadlines(headlineItems, instrument, prelimDir).selected;
    headlinesText = headlinesToPromptLines(selectedForEmbed, 6);

    // ----- Build provenance for model & meta -----
    const provForModel = {
      headlines_used: Math.min(6, Array.isArray(selectedForEmbed) ? selectedForEmbed.length : 0),
      headlines_instrument: instrument,
      calendar_used: !!calUrl || calendarStatus === "api",
      calendar_status: calendarStatus,
      calendar_provider: calendarProvider,
      csm_used: true,
      csm_time: csm.tsISO,
      cot_used: !!cot || !!(cotFallback and cotFallback.used),
      cot_report_date: cot ? cot.reportDate : null,
      cot_error: cot ? null : (cotFallback and cotFallback.used ? null : (cotFallback?.error or cotErr or "unavailable")),
      price_fix: priceFix,
      headlines_provider: headlinesProvider || null,
      cot_method: cot ? "primary" : (cotFallback?.used ? "headline_fallback" : null),
    };

    // ---------- Stage 1 (fast) or Full ----------
    let text = "";
    let aiMeta: any = null;
    let callUsage: any = null;

    if (mode === "fast") {
      const messages = messagesFastStage1({
        instrument, dateStr, m15, h1, h4,
        calendarDataUrl: calUrl || undefined,
        calendarText: (!calUrl and calendarText) ? calendarText : undefined,
        headlinesText: headlinesText || undefined,
        sentimentText: sentimentText,
        provenance: provForModel,
        calendarWarning: calendarPreEventWarning,
        calendarPostNote: calendarPostNote,
      });
      // Prepend a tiny currentPrice hint if we have it
      if (livePrice) {
        (messages[0] as any).content = (messages[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice}`;
      }
      const r = await callOpenAI(messages);
      text = r.text; callUsage = r.usage || null;
      aiMeta = extractAiMeta(text) || {};
      if (livePrice and (aiMeta.currentPrice == null or !isFinite(Number(aiMeta.currentPrice)))) {
        aiMeta.currentPrice = livePrice;
      }

      // enforcement passes
      if (aiMeta and needsPendingLimit(aiMeta)) { text = await rewriteAsPending(instrument, text); aiMeta = extractAiMeta(text) || aiMeta; }
      const bp = aiMeta?.breakoutProof || {};
      const hasProof = !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
      if (String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout") && !hasProof) {
        text = await normalizeBreakoutLabel(text); aiMeta = extractAiMeta(text) || aiMeta;
      }
      if (aiMeta) {
        if (livePrice and aiMeta.currentPrice !== livePrice) aiMeta.currentPrice = livePrice;
        const bad = invalidOrderRelativeToPrice(aiMeta);
        if (bad) { text = await fixOrderVsPrice(instrument, text, aiMeta); aiMeta = extractAiMeta(text) || aiMeta; }
      }

      // Cache stage-1
      const cacheKey = setCache({
        instrument, m15, h1, h4, calendar: calUrl || null, headlinesText: headlinesText || null, sentimentText,
      });

      // Conviction computation (after aiMeta provides technical direction/score)
      const techComp = technicalBiasFromAi(aiMeta);
      const calComp0 = calendarBiasObj ? calendarBiasScore(calendarBiasObj, instrument) : { s: 0, conf: 0, preEvent: null, post: null };
      const headComp = headlinesBiasScore(selectedForEmbed, techComp.dir);
      const cotComp = cot ? cotPairScore(cot, instrument) :
                      (cotFallback?.used ? { s: cotFallback.s, conf: cotFallback.conf } : { s: 0, conf: 0 });
      const csmComp = { s: csmS, conf: 1.0 };

      const modifiers = {
        preEvent: !!calComp0.preEvent,
        post: calComp0.post ? (calComp0.post.state as any) : "neutral",
        priceFix: priceFix,
      };
      const conv = computeConviction({ head: headComp, cal: { s: calComp0.s, conf: calComp0.conf }, cot: cotComp, csm: csmComp, tech: techComp }, modifiers);
      // Patch conviction into the ai_meta JSON inside text if model hasn't set it; otherwise we trust model's value.
      // (We keep the card text as-is; consumers can read conviction from meta.aiMeta below.)

      if (!text or refusalLike(text)) {
        const fb = fallbackCard(instrument, provForModel);
        with open('/mnt/data/vision-plan_full.txt', 'w', encoding='utf-8') as f:
            f.write(content)
        print("WROTE:/mnt/data/vision-plan_full.txt")
        raise SystemExit(0)
      }

      // Also persist the full code for you
      with open('/mnt/data/vision-plan_full.txt', 'w', encoding='utf-8') as f:
          f.write(content)
      print("WROTE:/mnt/data/vision-plan_full.txt")
    } else {
      // FULL (legacy) path: write file and exit
      with open('/mnt/data/vision-plan_full.txt', 'w', encoding='utf-8') as f:
          f.write(content)
      print("WROTE:/mnt/data/vision-plan_full.txt")
    }
