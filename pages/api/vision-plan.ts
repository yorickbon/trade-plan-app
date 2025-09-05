// /pages/api/vision-plan.ts
// Images-only planner with optional TradingView/Gyazo image URL fetch.
// Uploads: m15 (execution), h1 (context), h4 (HTF), optional calendar.
// You can also pass m15Url / h1Url / h4Url (TV/Gyazo direct image or page link).
// -----------------------------------------------------------------------------
// Two-stage support (non-breaking):
//   • mode=full (default): full card (legacy).
//   • mode=fast: full analysis (images + calendar + headlines + **CSM mandatory + COT soft-required**),
//                OUTPUT ONLY: Quick Plan (+Option 2) + Management + trailing ai_meta.
//   • mode=expand&cache=<id>: reuse processed images/headlines/sentiment from Stage-1 and return
//                ONLY the remaining sections (Full Breakdown, X-ray, Candidate Scores, Final Table).
//
// Headlines: fetch 12; embed **6** into model prompt (fetch behavior unchanged).
// Calendar: precedence **image > API > unavailable**; API = /api/calendar (FairEconomy→TE guest).
// Image downscale: sharp @ max 1280px, JPEG ~70%, strip EXIF, ≤ ~600 KB (best-effort).
// Strategy playbook: expanded (no “default”) incl. **Fibonacci retracement confluence (38.2–61.8%)**.
// Enforcement: same micro-passes (Pending proof, Breakout rename, Limit sanity). Option 2 is a
//              **conditional** runner-up with its own conviction when viable (>=45%).
// CSM (intraday) is **mandatory**. COT is **soft-required** (use if available; else proceed & mark unavailable).
// Price sanity: fetch live price (TD→Finnhub→Polygon). If the model mis-scales levels, we ask it to correct.
// Provenance: we **force** ai_meta.sources to server-truth and replace the fenced block in the card.
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
const OPENAI_API_BASE =
  process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// Market data keys (free tiers ok)
const TD_KEY = process.env.TWELVEDATA_API_KEY || "";
const FH_KEY = process.env.FINNHUB_API_KEY || process.env.FINNHUB_APT_KEY || "";
const POLY_KEY = process.env.POLYGON_API_KEY || "";

// ---------- small utils ----------
const IMG_MAX_BYTES = 12 * 1024 * 1024; // safety cap
const MAX_W = 1280; // downscale target
const JPEG_Q = 70; // ~70%
const TARGET_MAX = 600 * 1024; // best-effort clamp

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
  calendar?: string | null;       // image (if provided)
  calendarText?: string | null;   // API summary (if fetched)
  calendarProvider?: string | null;
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
type CsmSnapshot = {
  tsISO: string;
  ranks: string[];
  scores: Record<string, number>;
  ttl: number;
};
let CSM_CACHE: CsmSnapshot | null = null;

// ---------- COT cache (7 days) ----------
type CotSnapshot = {
  reportDate: string; // ISO date
  net: Record<string, number>;
  ttl: number;
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
  const form = formidable({ multiples: false, maxFiles: 25, maxFileSize: 25 * 1024 * 1024 });
  return new Promise<{ fields: Record<string, any>; files: Record<string, any> }>((resolve, reject) => {
    form.parse(req as any, (err: any, fields: any, files: any) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}
function pickFirst<T = any>(x: T | T[] | undefined | null): T | null {
  if (!x) return null;
  return Array.isArray(x) ? (x[0] ?? null) : (x as any);
}

// ---------- image processing ----------
async function toJpeg(buf: Buffer, width = MAX_W, quality = JPEG_Q): Promise<Buffer> {
  return sharp(buf).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality, progressive: true, mozjpeg: true }).toBuffer();
}
async function processToDataUrl(buf: Buffer): Promise<string> {
  let q = JPEG_Q;
  let out = await sharp(buf).rotate().resize({ width: MAX_W, withoutEnlargement: true }).jpeg({ quality: q, progressive: true, mozjpeg: true }).toBuffer();
  if (out.byteLength > TARGET_MAX) { q = 64; out = await toJpeg(buf, MAX_W, q); }
  if (out.byteLength > TARGET_MAX) { q = 58; out = await toJpeg(buf, MAX_W, q); }
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}
async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p = file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;
  const raw = await fs.readFile(p);
  const out = await processToDataUrl(raw);
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
async function fetchWithTimeout(url: string, ms: number) {
  const ac = new AbortController(); const id = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "TradePlanApp/1.0", accept: "text/html,application/xhtml+xml,application/xml,image/avif,image/webp,image/apng,image/*,*/*;q=0.8" } }); }
  finally { clearTimeout(id); }
}
async function downloadAndProcess(url: string): Promise<string | null> {
  const r = await fetchWithTimeout(url, 8000); if (!r || !r.ok) return null;
  const ct = String(r.headers.get("content-type") || "").toLowerCase();
  const mime = ct.split(";")[0].trim();
  const ab = await r.arrayBuffer(); const raw = Buffer.from(ab);
  if (raw.byteLength > IMG_MAX_BYTES) return null;
  if (mime.startsWith("image/")) { const out = await processToDataUrl(raw); if (process.env.NODE_ENV !== "production") console.log(`[vision-plan] link processed size=${dataUrlSizeBytes(out)}B from ${url}`); return out; }
  const html = raw.toString("utf8"); const og = htmlFindOgImage(html); if (!og) return null;
  const resolved = absoluteUrl(url, og); const r2 = await fetchWithTimeout(resolved, 8000);
  if (!r2 || !r2.ok) return null;
  const ab2 = await r2.arrayBuffer(); const raw2 = Buffer.from(ab2);
  if (raw2.byteLength > IMG_MAX_BYTES) return null;
  const out2 = await processToDataUrl(raw2); if (process.env.NODE_ENV !== "production") console.log(`[vision-plan] og:image processed size=${dataUrlSizeBytes(out2)}B from ${resolved}`);
  return out2;
}
async function linkToDataUrl(link: string): Promise<string | null> {
  if (!link) return null;
  try { return await downloadAndProcess(link); } catch { return null; }
}

// ---------- headlines: fetch 12; embed **6** ----------
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
      return `• ${t} — ${src}${when ? `, ${when}` : ""} — ${lab}`;
    }).join("\n");
    return { items, promptText: lines || null };
  } catch { return { items: [], promptText: null }; }
}

// ---------- calendar API snapshot (image > api > unavailable) ----------
async function fetchedCalendar(req: NextApiRequest, instrument: string): Promise<{ status: "image" | "api" | "unavailable"; text: string | null; provider: string | null }> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/calendar?instrument=${encodeURIComponent(instrument)}&windowHours=48&_t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store" });
    const j: any = await r.json().catch(() => ({}));
    if (j?.ok && Array.isArray(j?.items)) {
      const prov = String(j?.provider || "api");
      const ib = j?.bias?.instrument;
      const pc = j?.bias?.perCurrency || {};
      const per = Object.entries(pc).slice(0, 6).map(([k, v]: any) => `${k}:${Math.round((v?.score ?? 0) * 10) / 10}(${v?.label || "neutral"})`).join(" ");
      const highSoon = (j.items as any[]).filter((x) => String(x?.impact) === "High").slice(0, 6).map((x) => `• ${x.currency || x.country}: ${x.title} @ ${x.time}${x.isBlackout ? " [±90m blackout]" : ""}`).join("\n");
      const lines = [
        `Calendar provider: ${prov}`,
        ib ? `Instrument bias: ${ib.pair} ${ib.score} (${ib.label})` : null,
        per ? `Per-currency bias: ${per}` : null,
        highSoon ? `Upcoming high-impact:\n${highSoon}` : null,
      ].filter(Boolean).join("\n");
      return { status: "api", text: lines || null, provider: prov };
    }
    return { status: "unavailable", text: null, provider: null };
  } catch { return { status: "unavailable", text: null, provider: null }; }
}

// ---------- refusal & ai_meta helpers ----------
function refusalLike(s: string) {
  const t = (s || "").toLowerCase(); if (!t) return false;
  return /\b(can'?t|cannot)\s+assist\b|\bnot able to comply\b|\brefuse/i.test(t);
}
function extractAiMeta(text: string) {
  if (!text) return null;
  const fences = [/```ai_meta\s*({[\s\S]*?})\s*```/i, /```json\s*({[\s\S]*?})\s*```/i];
  for (const re of fences) { const m = text.match(re); if (m && m[1]) { try { return JSON.parse(m[1]); } catch {} } }
  return null;
}
function replaceAiMeta(text: string, obj: any) {
  const json = JSON.stringify(obj, null, 2);
  if (/```ai_meta[\s\S]*?```/i.test(text)) {
    return text.replace(/```ai_meta[\s\S]*?```/i, "```ai_meta\n" + json + "\n```");
  }
  // if the model used ```json, normalize to ai_meta
  if (/```json[\s\S]*?```/i.test(text)) {
    return text.replace(/```json[\s\S]*?```/i, "```ai_meta\n" + json + "\n```");
  }
  // no fenced meta was printed (edge); append it
  return text + "\n\n```ai_meta\n" + json + "\n```";
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

// ---------- CSM (intraday) mandatory ----------
const G8 = ["USD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD"];
const USD_PAIRS = ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDJPY", "USDCHF", "USDCAD"];

type Series = { t: number[]; c: number[] };
function kbarReturn(closes: number[], k: number): number | null {
  if (!closes || closes.length <= k) return null;
  const a = closes[closes.length - 1]; const b = closes[closes.length - 1 - k];
  if (!(a > 0) || !(b > 0)) return null; return Math.log(a / b);
}
async function tdSeries15(pair: string): Promise<Series | null> {
  if (!TD_KEY) return null;
  try {
    const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=15min&outputsize=30&apikey=${TD_KEY}&dp=6`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1800) });
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
    const to = new Date(); const from = new Date(to.getTime() - 6 * 60 * 60 * 1000);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/15/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&apiKey=${POLY_KEY}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2000) });
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
async function getLivePrice(pair: string): Promise<number | null> {
  const S = await fetchSeries15(pair);
  if (!S || !S.c?.length) return null;
  const last = S.c[S.c.length - 1];
  return Number.isFinite(last) ? last : null;
}
function needsRescale(vModel: number, vLive: number): { scale: number; apply: boolean } {
  if (!(isFinite(vModel) && isFinite(vLive))) return { scale: 1, apply: false };
  const candidates = [1, 10, 0.1, 100, 0.01];
  let best = 1; let bestErr = Math.abs(vModel - vLive);
  for (const k of candidates) { const err = Math.abs(vModel * k - vLive); if (err < bestErr) { bestErr = err; best = k; } }
  const improved = bestErr < Math.abs(vModel - vLive) / 5; // at least 5x better fit
  return { scale: best, apply: improved && best !== 1 };
}

// ---------- COT (weekly) SOFT-REQUIRED with tolerant parser + fallback ----------
const CFTC_URL = "https://www.cftc.gov/dea/newcot/f_disagg.txt";
const CFTC_URL_FALLBACK = "https://www.cftc.gov/dea/futures/deacotdisagg.txt";
const CFTC_MAP: Record<string, { name: string }> = {
  EUR: { name: "EURO FX - CHICAGO MERCANTILE EXCHANGE" },
  JPY: { name: "JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE" },
  GBP: { name: "BRITISH POUND STERLING - CHICAGO MERCANTILE EXCHANGE" },
  CAD: { name: "CANADIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE" },
  AUD: { name: "AUSTRALIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE" },
  CHF: { name: "SWISS FRANC - CHICAGO MERCANTILE EXCHANGE" },
  NZD: { name: "NEW ZEALAND DOLLAR - CHICAGO MERCANTILE EXCHANGE" },
  USD: { name: "U.S. DOLLAR INDEX - ICE FUTURES U.S." },
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

  // normalize headers: underscores -> spaces, lowercase
  const headerRaw = csvSplit(lines[0]);
  const header = headerRaw.map((s) => s.replace(/_/g, " ").toLowerCase());

  const idxMarket = header.findIndex((h) => /market\s+and\s+exchange\s+names?/.test(h));
  const idxDate = header.findIndex((h) => /report\s+date|reporting\s+date|as\s+of/.test(h));
  const idxLong = header.findIndex((h) => /(non\s*comm|non-?commercial).*long/.test(h));
  const idxShort = header.findIndex((h) => /(non\s*comm|non-?commercial).*short/.test(h));
  if (idxMarket < 0 || idxDate < 0 || idxLong < 0 || idxShort < 0) return null;

  const net: Record<string, number> = {};
  let latestDate = "";

  for (let i = 1; i < lines.length; i++) {
    const colsRaw = csvSplit(lines[i]);
    // pad row if truncated
    const cols = Array.from({ length: header.length }, (_, k) => colsRaw[k] ?? "");
    const name = (cols[idxMarket] || "").toUpperCase().trim();
    const longV = Number(String(cols[idxLong] || "").replace(/[^0-9.-]/g, ""));
    const shortV = Number(String(cols[idxShort] || "").replace(/[^0-9.-]/g, ""));
    const d = (cols[idxDate] || "").trim();
    if (d && !latestDate) latestDate = d;

    for (const cur of Object.keys(CFTC_MAP)) {
      if (name === CFTC_MAP[cur].name.toUpperCase()) {
        net[cur] = (isFinite(longV) ? longV : 0) - (isFinite(shortV) ? shortV : 0);
      }
    }
  }
  if (!latestDate || Object.keys(net).length < 3) return null;
  const reportDateISO = new Date(latestDate).toISOString().slice(0, 10);
  return { reportDate: reportDateISO, net, ttl: Date.now() + 7 * 24 * 60 * 60 * 1000 };
}
async function fetchCFTCOnce(url: string, timeoutMs: number): Promise<string> {
  const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`CFTC ${r.status}`);
  return r.text();
}
async function getCOT(): Promise<CotSnapshot> {
  if (COT_CACHE && Date.now() < COT_CACHE.ttl) return COT_CACHE;

  let txt: string | null = null;
  try { txt = await fetchCFTCOnce(CFTC_URL, 10_000); }
  catch {
    try { txt = await fetchCFTCOnce(CFTC_URL_FALLBACK, 10_000); }
    catch { /* ignore; handled below */ }
  }
  if (!txt && COT_CACHE) return COT_CACHE; // allow stale
  if (!txt) throw new Error("CFTC fetch failed");
  const snap = parseCFTC(txt);
  if (!snap) throw new Error("CFTC parse failed");
  COT_CACHE = snap;
  return snap;
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
  const prov: { csm_used: boolean; csm_time: string; cot_used: boolean; cot_report_date: string | null; cot_error?: string | null } =
    { csm_used: true, csm_time: csm.tsISO, cot_used: !!cot, cot_report_date: cot ? cot.reportDate : null };
  let cotLine = "";
  if (cot) {
    const entries = Object.entries(cot.net);
    const longers = entries.filter(([, v]) => (v as number) > 0).sort((a, b) => (b[1] as number) - (a[1] as number)).map(([k]) => k);
    const shorters = entries.filter(([, v]) => (v as number) < 0).sort((a, b) => (a[1] as number) - (b[1] as number)).map(([k]) => k);
    cotLine = `COT ${cot.reportDate}: Long ${longers.slice(0, 3).join("/")} | Short ${shorters.slice(0, 2).join("/")}`;
  } else { cotLine = `COT: unavailable (${cotError || "service timeout"})`; prov.cot_error = cotError || "unavailable"; }
  return { text: `${ranksLine}\n${cotLine}`, provenance: prov };
}

// ---------- prompts ----------
function systemCore(instrument: string) {
  return [
    "You are a professional discretionary trader.",
    "Perform **visual** price-action market analysis from the images (no numeric candles).",
    "Multi-timeframe alignment: 15m execution, 1H context, 4H HTF.",
    "Tournament mode: evaluate and pick the **single best** candidate and one **conditional runner-up**:",
    "- Pullback to OB/FVG/SR confluence",
    "- Breakout + Retest (proof: body close beyond + retest holds or SFP reclaim)",
    "- SFP / Liquidity grab + reclaim",
    "- Range reversion at extremes",
    "- Trendline / Channel retest",
    "- Double-tap / retest of origin",
    "- Breaker Block retest (failed OB flips)",
    "- Imbalance / FVG mitigation with structure hold",
    "- Quasimodo (QM) / CHOCH reversal",
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
  ].join("\n");
}
function buildUserPartsBase(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
}) {
  const parts: any[] = [
    { type: "text", text: `Instrument: ${args.instrument}\nDate: ${args.dateStr}` },
    { type: "text", text: "HTF 4H Chart:" }, { type: "image_url", image_url: { url: args.h4 } },
    { type: "text", text: "Context 1H Chart:" }, { type: "image_url", image_url: { url: args.h1 } },
    { type: "text", text: "Execution 15M Chart:" }, { type: "image_url", image_url: { url: args.m15 } },
  ];
  if (args.calendarDataUrl) { parts.push({ type: "text", text: "Economic Calendar Image (use first if present):" }); parts.push({ type: "image_url", image_url: { url: args.calendarDataUrl } }); }
  if (args.calendarText) { parts.push({ type: "text", text: `Calendar snapshot (API):\n${args.calendarText}` }); }
  if (args.headlinesText) { parts.push({ type: "text", text: `Recent headlines snapshot (used for bias; list shown in Stage-2):\n${args.headlinesText}` }); }
  if (args.sentimentText) { parts.push({ type: "text", text: `Sentiment snapshot (CSM + COT; used for bias):\n${args.sentimentText}` }); }
  return parts;
}

// FULL card with Option 2 + conviction split + context + fundy note
function messagesFull(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
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
    "• Stop Loss: <level> (behind swing/OB/SR; step to the next zone if too tight)",
    "• Take Profit(s): TP1 <level> / TP2 <level>",
    "• Conviction: <0–100>%  — Conviction split: Structure / Trigger / Fundamentals",
    "• Setup: <Chosen Strategy>",
    "• Why chosen: <one-liner on edge>",
    "• Fundamental alignment: <one-liner tying Calendar/Headlines/CSM/COT to the idea>",
    "• Option 2 (Conditional Runner-up): <Strategy name> — provide conditional instructions; include its **own conviction %**. Show only if runner-up score ≥ 45; else print 'Not available (no viable second candidate)'.",
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
    "If a breakout candidate was downgraded to Pullback due to missing proof, **add a one-liner note** under Quick Plan.",
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
    `  "sources": { "headlines_used": number, "headlines_instrument": string, "calendar_used": boolean, "calendar_status": "image" | "api" | "unavailable", "calendar_provider": string | null, "csm_used": boolean, "csm_time": string, "cot_used": boolean, "cot_report_date": string | null, "cot_error": string | null } }`,
    "```",
  ].join("\n");

  return [{ role: "system", content: system }, { role: "user", content: buildUserPartsBase(args) }];
}

// FAST Stage-1 (with Option 2)
function messagesFastStage1(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  provenance?: { headlines_used: number; headlines_instrument: string; calendar_used: boolean; calendar_status: "image" | "api" | "unavailable"; calendar_provider: string | null; csm_used: boolean; csm_time: string; cot_used: boolean; cot_report_date: string | null; cot_error?: string | null; };
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
    "• Conviction: <0–100>%  — Conviction split: Structure / Trigger / Fundamentals",
    "• Setup:",
    "• Why chosen: <one-liner>",
    "• Fundamental alignment: <one-liner tying Calendar/Headlines/CSM/COT to the idea>",
    "• Option 2 (Conditional Runner-up): If second-best exists with score ≥45, print its strategy and conditional steps; include its own conviction %. Else print 'Not available (no viable second candidate)'.",
    "",
    "Management",
    "- Brief actionable playbook (filled/not filled, trail/BE, invalidation).",
    "- If Option 2 triggers first, add a one-liner on managing it (tight invalidation).",
    "- If breakout candidate downgraded to pullback due to missing proof, add a note.",
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
    `  "sources": { "headlines_used": number, "headlines_instrument": string, "calendar_used": boolean, "calendar_status": "image" | "api" | "unavailable", "calendar_provider": string | null, "csm_used": boolean, "csm_time": string, "cot_used": boolean, "cot_report_date": string | null, "cot_error": string | null } }`,
    "```",
  ].join("\n");

  const parts = buildUserPartsBase(args);
  if (args.provenance) parts.push({ type: "text", text: `provenance:\n${JSON.stringify(args.provenance)}` });
  return [{ role: "system", content: system }, { role: "user", content: parts }];
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
  return String(out || "");
}

// ---------- enforcement & correction passes ----------
async function rewriteAsPending(instrument: string, text: string) {
  const messages = [
    { role: "system", content: "Rewrite the **primary** trade plan as PENDING (no Market) into a clean Buy/Sell LIMIT zone at OB/FVG/SR confluence if breakout proof is missing. Keep tournament section and X-ray. **Do not remove or alter the 'Option 2 (Conditional Runner-up)'.** Add a one-liner note about the downgrade." },
    { role: "user", content: `Instrument: ${instrument}\n\n${text}\n\nRewrite primary to Pending; keep Option 2 unchanged.` },
  ];
  return callOpenAI(messages);
}
async function normalizeBreakoutLabel(text: string) {
  const messages = [
    { role: "system", content: "If 'Breakout + Retest' is claimed for the **primary** plan but proof is missing (body close + retest hold or SFP reclaim), rename to 'Pullback (OB/FVG/SR)'. Keep Option 2 as conditional breakout if present. Add a one-liner note under Quick Plan." },
    { role: "user", content: text },
  ];
  return callOpenAI(messages);
}
async function fixOrderVsPrice(instrument: string, text: string, aiMeta: any) {
  const messages = [
    { role: "system", content: "Adjust only the **primary** LIMIT zone so that: Sell Limit is ABOVE current price; Buy Limit is BELOW current price. Keep Option 2 unchanged. Keep format." },
    { role: "user", content: `Instrument: ${instrument}\nCurrent Price: ${aiMeta?.currentPrice}\nProvided Zone: ${JSON.stringify(aiMeta?.zone)}\n\nCard:\n${text}\n\nFix only the primary LIMIT side and entry; do not change Option 2.` },
  ];
  return callOpenAI(messages);
}
async function fixCurrentPriceAndLevels(instrument: string, text: string, livePrice: number, scale: number) {
  const messages = [
    { role: "system", content: "The numeric levels appear mis-scaled vs live price. **Rescale all numeric levels** (Entry, SL, TP1, TP2, current price, and zone bounds) by the provided factor to align with live price, preserving structure. Keep Option 2 intact except numeric scaling. Keep formatting identical." },
    { role: "user", content: `Instrument: ${instrument}\nLive Price: ${livePrice}\nRescale Factor: ${scale}\n\nCard:\n${text}\n\nRescale numbers; keep structure and sections.` },
  ];
  return callOpenAI(messages);
}

// ---------- handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    // mode selection
    const urlMode = String((req.query.mode as string) || "").toLowerCase();
    let mode: "full" | "fast" | "expand" = urlMode === "fast" ? "fast" : urlMode === "expand" ? "expand" : "full";

    // expand path
    if (mode === "expand") {
      const cacheKey = String(req.query.cache || "").trim();
      const c = getCache(cacheKey);
      if (!c) return res.status(400).json({ ok: false, reason: "Expand failed: cache expired or not found." });
      if (!c.sentimentText) return res.status(503).json({ ok: false, reason: "Missing sentiment snapshot for expand." });
      const dateStr = new Date().toISOString().slice(0, 10);
      const messages = [
        { role: "system", content: [
          systemCore(c.instrument),
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
          `| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |\n| ${c.instrument} | ... | ... | ... | ... | ... | ... |`,
          "",
          "Append NOTHING after these sections (no ai_meta here).",
        ].join("\n") },
        { role: "user", content: buildUserPartsBase({
            instrument: c.instrument, dateStr, m15: c.m15, h1: c.h1, h4: c.h4,
            calendarDataUrl: c.calendar || undefined, calendarText: c.calendarText || undefined,
            headlinesText: c.headlinesText || undefined, sentimentText: c.sentimentText || undefined,
          })
        },
      ];
      const text = await callOpenAI(messages);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ok: true, text, meta: { instrument: c.instrument, cacheKey } });
    }

    if (!isMultipart(req)) {
      return res.status(400).json({
        ok: false,
        reason: "Use multipart/form-data with files: m15, h1, h4 and optional 'calendar'. Or pass m15Url/h1Url/h4Url links. Include 'instrument'.",
      });
    }

    // parse
    const tParse = now();
    const { fields, files } = await parseMultipart(req);
    if (process.env.NODE_ENV !== "production") console.log(`[vision-plan] parsed in ${dt(tParse)}`);

    const instrument = String(fields.instrument || fields.code || "EURUSD").toUpperCase().replace(/\s+/g, "");
    const requestedMode = String(fields.mode || "").toLowerCase();
    if (requestedMode === "fast") mode = "fast";

    // files & urls
    const m15f = pickFirst(files.m15), h1f = pickFirst(files.h1), h4f = pickFirst(files.h4), calF = pickFirst(files.calendar);
    const m15Url = String(pickFirst(fields.m15Url) || "").trim();
    const h1Url = String(pickFirst(fields.h1Url) || "").trim();
    const h4Url = String(pickFirst(fields.h4Url) || "").trim();

    // images
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
      return res.status(400).json({ ok: false, reason: "Provide all three charts: m15, 1h, 4h — either files or valid TV/Gyazo image links." });
    }

    // headlines (12 fetch; 6 embed)
    const tNews = now();
    const { items: headlineItems, promptText: headlinesText } = await fetchedHeadlines(req, instrument);
    if (process.env.NODE_ENV !== "production") console.log(`[vision-plan] news fetched ${dt(tNews)} (items=${headlineItems.length})`);

    // calendar (image > api > unavailable)
    const calApi = await fetchedCalendar(req, instrument);
    const calendarStatus: "image" | "api" | "unavailable" = calUrl ? "image" : calApi.status;
    const calendarText = calUrl ? null : calApi.text;

    // sentiment (CSM mandatory; COT soft-required)
    let csm: CsmSnapshot;
    try {
      if (!CSM_CACHE || Date.now() >= CSM_CACHE.ttl) {
        const seriesMap: Record<string, Series | null> = {};
        await Promise.all(USD_PAIRS.map(async (p) => { seriesMap[p] = await fetchSeries15(p); }));
        const weights = { r60: 0.6, r240: 0.4 };
        const curScore: Record<string, number> = Object.fromEntries(G8.map((c) => [c, 0]));
        for (const pair of USD_PAIRS) {
          const S = seriesMap[pair]; if (!S || !S.c || S.c.length < 17) continue;
          const r60 = kbarReturn(S.c, 4) ?? 0; const r240 = kbarReturn(S.c, 16) ?? 0;
          const r = r60 * weights.r60 + r240 * weights.r240;
          const base = pair.slice(0, 3); const quote = pair.slice(3);
          curScore[base] += r; curScore[quote] -= r;
        }
        const vals = G8.map((c) => curScore[c]);
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
        const z: Record<string, number> = {}; for (const c of G8) z[c] = (curScore[c] - mean) / sd;
        const ranks = [...G8].sort((a, b) => z[b] - z[a]);
        CSM_CACHE = { tsISO: new Date().toISOString(), ranks, scores: z, ttl: Date.now() + 15 * 60 * 1000 };
      }
      csm = CSM_CACHE!;
    } catch (e: any) {
      return res.status(503).json({ ok: false, reason: `CSM unavailable: ${e?.message || "fetch failed"}.` });
    }

    let cot: CotSnapshot | null = null;
    let cotErr: string | null = null;
    try { cot = await getCOT(); } catch (e: any) { cot = null; cotErr = e?.message || "unavailable"; }
    const { text: sentimentText, provenance } = sentimentSummary(csm, cot, cotErr);

    const dateStr = new Date().toISOString().slice(0, 10);

    // provenance (server-truth) that we will **force** into ai_meta.sources
    const provForModel = {
      headlines_used: Math.min(6, headlineItems.length),
      headlines_instrument: instrument,
      calendar_used: calendarStatus !== "unavailable",
      calendar_status: calendarStatus,
      calendar_provider: calUrl ? "image" : (calApi.provider || null),
      csm_used: true,
      csm_time: csm.tsISO,
      cot_used: !!cot,
      cot_report_date: cot ? cot.reportDate : null,
      cot_error: cot ? null : cotErr || "unavailable",
    };

    // ---------- Stage 1 (fast) or Full ----------
    let text = "";
    let aiMeta: any = null;

    if (mode === "fast") {
      const messages = messagesFastStage1({
        instrument, dateStr, m15, h1, h4,
        calendarDataUrl: calUrl || undefined, calendarText: calendarText || undefined,
        headlinesText: headlinesText || undefined, sentimentText,
        provenance: provForModel,
      });
      text = await callOpenAI(messages);
      aiMeta = extractAiMeta(text) || {};

      // enforcement passes
      if (aiMeta && needsPendingLimit(aiMeta)) { text = await rewriteAsPending(instrument, text); aiMeta = extractAiMeta(text) || aiMeta; }
      const bp = aiMeta?.breakoutProof || {};
      const hasProof = !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
      if (String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout") && !hasProof) {
        text = await normalizeBreakoutLabel(text); aiMeta = extractAiMeta(text) || aiMeta;
      }
      if (aiMeta) {
        const bad = invalidOrderRelativeToPrice(aiMeta);
        if (bad) { text = await fixOrderVsPrice(instrument, text, aiMeta); aiMeta = extractAiMeta(text) || aiMeta; }
      }

      // price sanity
      const live = await getLivePrice(instrument);
      if (isFinite(Number(aiMeta?.currentPrice)) && isFinite(live as number)) {
        const { scale, apply } = needsRescale(Number(aiMeta.currentPrice), Number(live));
        if (apply) { text = await fixCurrentPriceAndLevels(instrument, text, Number(live), scale); aiMeta = extractAiMeta(text) || aiMeta; }
      }

      // **force server-truth sources** into ai_meta + replace fenced block
      aiMeta = { ...(aiMeta || {}), sources: provForModel };
      text = replaceAiMeta(text, aiMeta);

      const cacheKey = setCache({
        instrument, m15, h1, h4,
        calendar: calUrl || null, calendarText: calendarText || null, calendarProvider: provForModel.calendar_provider,
        headlinesText: headlinesText || null, sentimentText,
      });

      if (!text || refusalLike(text)) {
        const fb = fallbackCard(instrument, provForModel);
        return res.status(200).json({ ok: true, text: fb, meta: { instrument, mode, cacheKey, headlinesCount: headlineItems.length, fallbackUsed: true, aiMeta: extractAiMeta(fb), sources: provForModel } });
      }

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ok: true, text, meta: { instrument, mode, cacheKey, headlinesCount: headlineItems.length, fallbackUsed: false, aiMeta, sources: provForModel } });
    }

    // FULL
    const messages = [{ role: "system", content: messagesFull({
      instrument, dateStr, m15, h1, h4,
      calendarDataUrl: calUrl || undefined, calendarText: calendarText || undefined,
      headlinesText: headlinesText || undefined, sentimentText,
    })[0].content }, { role: "user", content: buildUserPartsBase({
      instrument, dateStr, m15, h1, h4,
      calendarDataUrl: calUrl || undefined, calendarText: calendarText || undefined,
      headlinesText: headlinesText || undefined, sentimentText,
    }) }];
    text = await callOpenAI(messages);
    aiMeta = extractAiMeta(text) || {};

    if (aiMeta && needsPendingLimit(aiMeta)) { text = await rewriteAsPending(instrument, text); aiMeta = extractAiMeta(text) || aiMeta; }
    const bp = aiMeta?.breakoutProof || {};
    const hasProof = !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
    if (String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout") && !hasProof) {
      text = await normalizeBreakoutLabel(text); aiMeta = extractAiMeta(text) || aiMeta;
    }
    if (aiMeta) {
      const bad = invalidOrderRelativeToPrice(aiMeta);
      if (bad) { text = await fixOrderVsPrice(instrument, text, aiMeta); aiMeta = extractAiMeta(text) || aiMeta; }
    }

    // price sanity
    {
      const live = await getLivePrice(instrument);
      if (isFinite(Number(aiMeta?.currentPrice)) && isFinite(live as number)) {
        const { scale, apply } = needsRescale(Number(aiMeta.currentPrice), Number(live));
        if (apply) { text = await fixCurrentPriceAndLevels(instrument, text, Number(live), scale); aiMeta = extractAiMeta(text) || aiMeta; }
      }
    }

    // **force server-truth sources** into ai_meta + replace fenced block
    aiMeta = { ...(aiMeta || {}), sources: provForModel };
    text = replaceAiMeta(text, aiMeta);

    if (!text || refusalLike(text)) {
      const fb = fallbackCard(instrument, provForModel);
      return res.status(200).json({ ok: true, text: fb, meta: { instrument, mode, headlinesCount: headlineItems.length, fallbackUsed: true, aiMeta: extractAiMeta(fb), sources: provForModel } });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, text, meta: { instrument, mode, headlinesCount: headlineItems.length, fallbackUsed: false, aiMeta, sources: provForModel } });
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
    calendar_status: "image" | "api" | "unavailable";
    calendar_provider: string | null;
    csm_used: boolean;
    csm_time: string;
    cot_used: boolean;
    cot_report_date: string | null;
    cot_error?: string | null;
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
    "• Conviction: 30%  — Conviction split: Structure 10 / Trigger 10 / Fundamentals 10",
    "• Setup: Await valid trigger (images inconclusive).",
    "• Why chosen: No clear HTF/15m alignment.",
    "• Fundamental alignment: Mixed/Unavailable.",
    "• Option 2 (Conditional Runner-up): Not available (no viable second candidate).",
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
