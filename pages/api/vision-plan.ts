
/**
 * CHANGE MANIFEST — /pages/api/vision-plan.ts
 *
 * Baseline: Your last approved /pages/api/vision-plan.ts with:
 * - Option 2 enforcement
 * - Calendar warning + bias/evidence
 * - Headlines+CSM sentiment
 *
 * ✅ What changed (minimal, non-breaking; speed-focused):
 * 1) Removed all COT network calls/caches (CFTC/Tradingster/stale-cache). Reason: latency + flakiness.  (unchanged)
 * 2) Added an **optional headlines-only COT cue** detector: (unchanged)
 *    - If headlines mention “COT/Commitments” with “net long/short” (per currency), surface a one-liner.
 *    - Provenance sets: cot_used=true, cot_method="headline_fallback", cot_report_date=null.
 *    - If no cue, cot_used=false and cot_error="no cot cues".
 * 3) Fundamentals = **Calendar + CSM + Headlines** (COT entirely optional via cues).  (unchanged)
 * 4) Option 2 clarity guard retained.  (unchanged)
 * 5) Provenance polish (unchanged) + **NEW** headline bias fields:
 *    - meta.sources now also includes:
 *      headlines_bias_label ("bullish" | "bearish" | "neutral" | "unavailable")
 *      headlines_bias_score (number | null)
 *      cot_bias_summary (string | null)
 *
 * 🆕 NEW (your request):
 * - Sentiment snapshot now shows:
 *   • “Headlines bias (48h): <label> (<avgScore>)”
 *   • “COT: <summary>”  OR  “COT news not found.”
 *
 * ❗ What did NOT change:
 * - API shape, output template/section names, fast/full/expand modes.
 * - Headlines fallback chain (/api/news), image handling, price sanity chain, SHOW_COST behavior.
 * - Primary Option 1 enforcement and order sanity fixes.
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
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// Market data keys (free tiers ok)
const TD_KEY = process.env.TWELVEDATA_API_KEY || "";
const FH_KEY =
  process.env.FINNHUB_API_KEY || process.env.FINNHUB_APT_KEY || "";
const POLY_KEY = process.env.POLYGON_API_KEY || "";

// ---------- small utils ----------
const IMG_MAX_BYTES = 12 * 1024 * 1024; // absolute safety cap
const BASE_W = 1280; // base width
const MAX_W = 1500; // upper bound for adaptive
const TARGET_MIN = 420 * 1024;
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
  return sharp(buf)
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality, progressive: true, mozjpeg: true })
    .toBuffer();
}
async function processAdaptiveToDataUrl(buf: Buffer): Promise<string> {
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
async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p =
    file.filepath ||
    file.path ||
    file._writeStream?.path ||
    file.originalFilepath;
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
  const host =
    (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}
function absoluteUrl(base: string, maybe: string) {
  try {
    return new URL(maybe, base).toString();
  } catch {
    return maybe;
  }
}
function htmlFindOgImage(html: string): string | null {
  const re1 =
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;
  const m1 = html.match(re1);
  if (m1?.[1]) return m1[1];
  const re2 =
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i;
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
        accept:
          "text/html,application/xhtml+xml,application/xml,image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
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
    const out = await processAdaptiveToDataUrl(raw);
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[vision-plan] link processed size=${dataUrlSizeBytes(out)}B from ${url}`
      );
    }
    return out;
  }
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
    console.log(
      `[vision-plan] og:image processed size=${dataUrlSizeBytes(out2)}B from ${resolved}`
    );
  }
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

// ---------- headlines helpers ----------
type AnyHeadline = {
  title?: string;
  description?: string;
  source?: string;
  published_at?: string;
  ago?: string;
  sentiment?: { score?: number } | null;
} & Record<string, any>;

function headlinesToPromptLines(
  items: AnyHeadline[],
  limit = 6
): string | null {
  const take = (items || []).slice(0, limit);
  if (!take.length) return null;
  const lines = take.map((it: AnyHeadline) => {
    const s =
      typeof it?.sentiment?.score === "number"
        ? (it.sentiment!.score as number)
        : null;
    const lab = s == null ? "neu" : s > 0.05 ? "pos" : s < -0.05 ? "neg" : "neu";
    const t = String(it?.title || "").slice(0, 200);
    const src = it?.source || "";
    const when = it?.ago || "";
    return `• ${t} — ${src}${when ? `, ${when}` : ""} — ${lab};`;
  });
  return lines.join("\n");
}

// NEW: compute simple headlines bias from sentiment scores
type HeadlineBias = {
  label: "bullish" | "bearish" | "neutral" | "unavailable";
  avg: number | null;
  count: number;
};
function computeHeadlinesBias(items: AnyHeadline[]): HeadlineBias {
  if (!Array.isArray(items) || items.length === 0)
    return { label: "unavailable", avg: null, count: 0 };
  const scores = items
    .map((h) =>
      typeof h?.sentiment?.score === "number" ? Number(h.sentiment!.score) : null
    )
    .filter((v) => Number.isFinite(v)) as number[];
  if (scores.length === 0)
    return { label: "unavailable", avg: null, count: 0 };
  const avg =
    scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  const label =
    avg > 0.05 ? "bullish" : avg < -0.05 ? "bearish" : "neutral";
  return { label, avg, count: scores.length };
}

// NOTE: now returns provider as well, for provenance.
async function fetchedHeadlinesViaServer(
  req: NextApiRequest,
  instrument: string
): Promise<{ items: AnyHeadline[]; promptText: string | null; provider: string }> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(
      instrument
    )}&hours=48&max=12&_t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    const items: AnyHeadline[] = Array.isArray(j?.items) ? j.items : [];
    const provider = String(j?.provider || "unknown");
    return { items, promptText: headlinesToPromptLines(items, 6), provider };
  } catch {
    return { items: [], promptText: null, provider: "unknown" };
  }
}

// ---------- refusal & ai_meta helpers ----------
function refusalLike(s: string) {
  const t = (s || "").toLowerCase();
  if (!t) return false;
  return (
    /\b(can'?t|cannot)\s+assist\b|\bnot able to comply\b|\brefuse/i.test(t)
  );
}
function extractAiMeta(text: string) {
  if (!text) return null;
  const fences = [
    /\nai_meta\s*({[\s\S]*?})\s*\n/i,
    /\njson\s*({[\s\S]*?})\s*\n/i,
  ];
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
function needsPendingLimit(aiMeta: any): boolean {
  const et = String(aiMeta?.entryType || "").toLowerCase();
  if (et !== "market") return false;
  const bp = aiMeta?.breakoutProof || {};
  const ok = !!(
    bp?.bodyCloseBeyond === true &&
    (bp?.retestHolds === true || bp?.sfpReclaim === true)
  );
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
  if (o === "sell limit" && dir === "short") {
    if (Math.max(zmin, zmax) <= p) return "sell-limit-below-price";
  }
  if (o === "buy limit" && dir === "long") {
    if (Math.min(zmin, zmax) >= p) return "buy-limit-above-price";
  }
  return null;
}

// ---------- CSM (intraday) ----------
const G8 = ["USD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD"];
const USD_PAIRS = [
  "EURUSD",
  "GBPUSD",
  "AUDUSD",
  "NZDUSD",
  "USDJPY",
  "USDCHF",
  "USDCAD",
];
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
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
      sym
    )}&interval=15min&outputsize=30&apikey=${TD_KEY}&dp=6`;
    const r = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!Array.isArray(j?.values)) return null;
    const vals = [...j.values].reverse(); // ascending
    const t = vals.map((v: any) => new Date(v.datetime).getTime() / 1000);
    const c = vals.map((v: any) => Number(v.close));
    if (!c.every((x: number) => isFinite(x))) return null;
    return { t, c };
  } catch {
    return null;
  }
}
async function fhSeries15(pair: string): Promise<Series | null> {
  if (!FH_KEY) return null;
  try {
    const sym = `OANDA:${pair.slice(0, 3)}_${pair.slice(3)}`;
    const to = Math.floor(Date.now() / 1000);
    const from = to - 60 * 60 * 6; // 6h
    const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(
      sym
    )}&resolution=15&from=${from}&to=${to}&token=${FH_KEY}`;
    const r = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (j?.s !== "ok" || !Array.isArray(j?.c)) return null;
    const t: number[] = (j.t as number[]).map((x: number) => x);
    const c: number[] = (j.c as number[]).map((x: number) => Number(x));
    if (!c.every((x: number) => isFinite(x))) return null;
    return { t, c };
  } catch {
    return null;
  }
}
async function polySeries15(pair: string): Promise<Series | null> {
  if (!POLY_KEY) return null;
  try {
    const ticker = `C:${pair}`;
    const to = new Date();
    const from = new Date(to.getTime() - 6 * 60 * 60 * 1000);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
        2,
        "0"
      )}-${String(d.getDate()).padStart(2, "0")}`;
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(
      ticker
    )}/range/15/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&apiKey=${POLY_KEY}`;
    const r = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!Array.isArray(j?.results)) return null;
    const t: number[] = j.results.map((x: any) => Math.floor(x.t / 1000));
    const c: number[] = j.results.map((x: any) => Number(x.c));
    if (!c.every((x: number) => isFinite(x))) return null;
    return { t, c };
  } catch {
    return null;
  }
}
async function fetchSeries15(pair: string): Promise<Series | null> {
  const td = await tdSeries15(pair);
  if (td) return td;
  const fh = await fhSeries15(pair);
  if (fh) return fh;
  const pg = await polySeries15(pair);
  if (pg) return pg;
  return null;
}
function computeCSMFromPairs(
  seriesMap: Record<string, Series | null>
): CsmSnapshot | null {
  const weights = { r60: 0.6, r240: 0.4 };
  const curScore: Record<string, number> = Object.fromEntries(
    G8.map((c) => [c, 0])
  );

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
  const sd =
    Math.sqrt(
      vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length
    ) || 1;
  const z: Record<string, number> = {};
  for (const c of G8) z[c] = (curScore[c] - mean) / sd;
  const ranks = [...G8].sort((a, b) => z[b] - z[a]);
  return {
    tsISO: new Date().toISOString(),
    ranks,
    scores: z,
    ttl: Date.now() + 15 * 60 * 1000,
  };
}
async function getCSM(): Promise<CsmSnapshot> {
  if (CSM_CACHE && Date.now() < CSM_CACHE.ttl) return CSM_CACHE;
  const seriesMap: Record<string, Series | null> = {};
  await Promise.all(
    USD_PAIRS.map(async (p) => {
      seriesMap[p] = await fetchSeries15(p);
    })
  );
  const snap = computeCSMFromPairs(seriesMap);
  if (!snap) {
    if (CSM_CACHE) return CSM_CACHE; // stale ok
    throw new Error("CSM unavailable (fetch failed and no cache).");
  }
  CSM_CACHE = snap;
  return snap;
}

// ---------- Headlines-only COT cue (optional) ----------
type CotCue = {
  method: "headline_fallback";
  reportDate: null;
  summary: string;
  net: Record<string, number>;
};
function detectCotCueFromHeadlines(headlines: AnyHeadline[]): CotCue | null {
  if (!Array.isArray(headlines) || !headlines.length) return null;
  const text = headlines
    .map((h) => [h?.title || "", h?.description || ""].join(" "))
    .join(" • ")
    .toLowerCase();

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
    if (regs.some((re) => re.test(text))) {
      const neg = new RegExp(`${regs[0].source}[\\s\\S]{0,60}?net\\s+short`, "i");
      const pos = new RegExp(`${regs[0].source}[\\s\\S]{0,60}?net\\s+long`, "i");
      if (neg.test(text)) {
        net[cur] = -1;
        any = true;
        continue;
      }
      if (pos.test(text)) {
        net[cur] = 1;
        any = true;
        continue;
      }
      const incShort = new RegExp(
        `${regs[0].source}[\\s\\S]{0,80}?(increase|added|boosted).{0,12}short`,
        "i"
      );
      const incLong = new RegExp(
        `${regs[0].source}[\\s\\S]{0,80}?(increase|added|boosted).{0,12}long`,
        "i"
      );
      if (incShort.test(text)) {
        net[cur] = -1;
        any = true;
        continue;
      }
      if (incLong.test(text)) {
        net[cur] = 1;
        any = true;
        continue;
      }
    }
  }

  if (!any) return null;
  const parts = Object.entries(net).map(
    ([c, v]) => `${c}:${v > 0 ? "net long" : "net short"}`
  );
  return {
    method: "headline_fallback",
    reportDate: null,
    summary: `COT cues (headlines): ${parts.join(", ")}`,
    net,
  };
}

// ---------- sentiment text (CSM + Headlines bias + optional COT cue) ----------
function sentimentSummary(
  csm: CsmSnapshot,
  cotCue: CotCue | null,
  headlineBias: HeadlineBias
): {
  text: string;
  provenance: {
    csm_used: boolean;
    csm_time: string;
    cot_used: boolean;
    cot_report_date: string | null;
    cot_error?: string | null;
    cot_method?: string | null;
    headlines_bias_label: HeadlineBias["label"];
    headlines_bias_score: number | null;
    cot_bias_summary: string | null;
  };
} {
  const ranksLine = `CSM (60–240m): ${csm.ranks
    .slice(0, 4)
    .join(" > ")} ... ${csm.ranks.slice(-3).join(" < ")}`;
  const hBiasLine =
    headlineBias.label === "unavailable"
      ? "Headlines bias (48h): unavailable"
      : `Headlines bias (48h): ${headlineBias.label}${
          headlineBias.avg != null ? ` (${headlineBias.avg.toFixed(2)})` : ""
        }`;

  const cotLine = cotCue ? `COT: ${cotCue.summary}` : "COT news not found.";

  const prov = {
    csm_used: true,
    csm_time: csm.tsISO,
    cot_used: !!cotCue,
    cot_report_date: null as string | null,
    cot_error: cotCue ? null : "no cot cues",
    cot_method: cotCue ? cotCue.method : null,
    headlines_bias_label: headlineBias.label,
    headlines_bias_score: headlineBias.avg,
    cot_bias_summary: cotCue ? cotCue.summary : null,
  };

  return {
    text: `${ranksLine}\n${hBiasLine}\n${cotLine}`,
    provenance: prov,
  };
}

// ---------- calendar helpers & fundamentals evidence ----------
function calendarShortText(resp: any, pair: string): string | null {
  if (!resp?.ok) return null;
  const instrBias = resp?.bias?.instrument;
  const parts: string[] = [];
  if (instrBias && instrBias.pair === pair) {
    parts.push(`Instrument bias: ${instrBias.label} (${instrBias.score})`);
  }
  const per = resp?.bias?.perCurrency || {};
  const base = pair.slice(0, 3),
    quote = pair.slice(3);
  const b = per[base]?.label ? `${base}:${per[base].label}` : null;
  const q = per[quote]?.label ? `${quote}:${per[quote].label}` : null;
  if (b || q) parts.push(`Per-currency: ${[b, q].filter(Boolean).join(" / ")}`);
  if (!parts.length) parts.push("No strong calendar bias.");
  return `Calendar bias for ${pair}: ${parts.join("; ")}`;
}
function nearestHighImpactWithin(resp: any, minutes: number): number | null {
  if (!resp?.ok || !Array.isArray(resp?.items)) return null;
  const nowMs = Date.now();
  let best: number | null = null;
  for (const it of resp.items) {
    if (String(it?.impact || "") !== "High") continue;
    const t = new Date(it.time).getTime();
    if (t >= nowMs) {
      const mins = Math.floor((t - nowMs) / 60000);
      if (mins <= minutes) {
        best = best == null ? mins : Math.min(best, mins);
      }
    }
  }
  return best;
}
function postResultBiasNote(resp: any, pair: string): string | null {
  if (!resp?.ok) return null;
  const base = pair.slice(0, 3),
    quote = pair.slice(3);
  const per = resp?.bias?.perCurrency || {};
  const b = per[base]?.label || "neutral";
  const q = per[quote]?.label || "neutral";
  const instr = resp?.bias?.instrument?.label || null;
  const scores = resp?.bias?.instrument ? `(score ${resp.bias.instrument.score})` : "";
  const line = `Per-currency: ${base} ${b} vs ${quote} ${q}${
    instr ? `; Instrument bias: ${instr} ${scores}` : ""
  }`;
  return line;
}
async function fetchCalendarRaw(
  req: NextApiRequest,
  instrument: string
): Promise<any | null> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/calendar?instrument=${encodeURIComponent(
      instrument
    )}&windowHours=120&_t=${Date.now()}`;
    const r = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const j: any = await r.json().catch(() => ({}));
    return j?.ok ? j : null;
  } catch {
    return null;
  }
}
function goodIfHigher(title: string): boolean | null {
  const t = title.toLowerCase();
  if (/(cpi|core cpi|ppi|inflation)/.test(t)) return true;
  if (
    /(gdp|retail sales|industrial production|manufacturing production|consumer credit|housing starts|building permits|durable goods)/.test(
      t
    )
  )
    return true;
  if (/(pmi|ism|confidence|sentiment)/.test(t)) return true;
  if (/unemployment|jobless|initial claims|continuing claims/.test(t))
    return false; // lower is bullish
  if (/(nonfarm|nfp|employment change|payrolls|jobs)/.test(t)) return true;
  if (/trade balance|current account/.test(t)) return true;
  if (
    /interest rate|rate decision|refi rate|deposit facility|bank rate|cash rate|ocr/.test(
      t
    )
  )
    return true;
  return null;
}
function evidenceLine(it: any, cur: string): string | null {
  const a = Number.isFinite(Number(it.actual)) ? Number(it.actual) : null;
  const f = Number.isFinite(Number(it.forecast)) ? Number(it.forecast) : null;
  const p = Number.isFinite(Number(it.previous)) ? Number(it.previous) : null;
  if (a == null || (f == null && p == null)) return null;
  const dir = goodIfHigher(String(it.title));
  let comp: string[] = [];
  if (f != null) comp.push(a < f ? "< forecast" : a > f ? "> forecast" : "= forecast");
  if (p != null) comp.push(a < p ? "< previous" : a > p ? "> previous" : "= previous");
  let verdict = "neutral";
  if (dir === true) {
    verdict =
      a > (f ?? a) && a > (p ?? a)
        ? "bullish"
        : a < (f ?? a) && a < (p ?? a)
        ? "bearish"
        : "mixed";
  } else if (dir === false) {
    verdict =
      a < (f ?? a) && a < (p ?? a)
        ? "bullish"
        : a > (f ?? a) && a > (p ?? a)
        ? "bearish"
        : "mixed";
  }
  const comps = comp.join(" and ");
  return `${cur} — ${it.title}: actual ${a}${
    f != null || p != null ? ` ${comps}` : ""
  } → ${verdict} ${cur}`;
}
function buildCalendarEvidence(resp: any, pair: string): string[] {
  if (!resp?.ok || !Array.isArray(resp?.items)) return [];
  const base = pair.slice(0, 3),
    quote = pair.slice(3);
  const nowMs = Date.now(),
    lo = nowMs - 72 * 3600 * 1000;
  const done = resp.items
    .filter((it: any) => {
      const t = new Date(it.time).getTime();
      return (
        t <= nowMs &&
        t >= lo &&
        (it.actual != null || it.forecast != null || it.previous != null) &&
        (it.currency === base || it.currency === quote)
      );
    })
    .slice(0, 12);
  const lines: string[] = [];
  for (const it of done) {
    const line = evidenceLine(it, it.currency || "");
    if (line) lines.push(line);
  }
  return lines;
}
async function fetchCalendarForAdvisory(
  req: NextApiRequest,
  instrument: string
): Promise<{
  text: string | null;
  status: "api" | "unavailable";
  provider: string | null;
  warningMinutes: number | null;
  advisoryText: string | null;
  biasNote: string | null;
  raw?: any | null;
  evidence?: string[] | null;
}> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/calendar?instrument=${encodeURIComponent(
      instrument
    )}&windowHours=48&_t=${Date.now()}`;
    const r = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (j?.ok) {
      const t =
        calendarShortText(j, instrument) ||
        `Calendar bias for ${instrument}: (no strong signal)`;
      const warn = nearestHighImpactWithin(j, 60);
      const bias = postResultBiasNote(j, instrument);
      const advisory = [
        warn != null ? `⚠️ High-impact event in ~${warn} min.` : null,
        bias ? `Recent result alignment: ${bias}.` : null,
      ]
        .filter(Boolean)
        .join("\n");
      const rawFull = await fetchCalendarRaw(req, instrument);
      const evidence = rawFull
        ? buildCalendarEvidence(rawFull, instrument)
        : buildCalendarEvidence(j, instrument);
      return {
        text: t,
        status: "api",
        provider: String(j?.provider || "mixed"),
        warningMinutes: warn ?? null,
        advisoryText: advisory || null,
        biasNote: bias || null,
        raw: j,
        evidence,
      };
    }
    return {
      text: "Calendar unavailable — upload an image if you need the panel parsed.",
      status: "unavailable",
      provider: null,
      warningMinutes: null,
      advisoryText: null,
      biasNote: null,
      raw: null,
      evidence: [],
    };
  } catch {
    return {
      text: "Calendar unavailable — upload an image if you need the panel parsed.",
      status: "unavailable",
      provider: null,
      warningMinutes: null,
      advisoryText: null,
      biasNote: null,
      raw: null,
      evidence: [],
    };
  }
}

// ---------- prompts ----------
function systemCore(
  instrument: string,
  calendarAdvisory?: { warningMinutes?: number | null; biasNote?: string | null }
) {
  const warn =
    (calendarAdvisory?.warningMinutes ?? null) != null
      ? calendarAdvisory!.warningMinutes
      : null;
  const bias = calendarAdvisory?.biasNote || null;

  return [
    "You are a professional discretionary trader.",
    "Perform **visual** price-action market analysis from the images (no numeric candles).",
    "Multi-timeframe alignment: 15m execution, 1H context, 4H HTF.",
    "Tournament mode: evaluate and pick the **single best** candidate (no defaults):",
    "- Pullback to OB/FVG/SR confluence",
    "- Breakout + Retest (proof: body close beyond + retest hold or SFP reclaim)",
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
    "Market entry allowed only when **explicit proof**; otherwise EntryType: Pending and use Buy/Sell LIMIT zone.",
    "Stops are price-action based (behind swing/OB/SR); if too tight, step to the next valid zone.",
    "Only reference **Headlines / Calendar / CSM** if their respective blocks are present below. (COT only if headline cue is present.)",
    `Keep instrument alignment with ${instrument}.`,
    warn !== null
      ? `\nCALENDAR WARNING: High-impact event within ~${warn} min. If trading into event, cap conviction to ≤35% and avoid new Market execution in final pre-event window.`
      : "",
    bias
      ? `\nPOST-RESULT ALIGNMENT: ${bias}. If this conflicts with the technical setup, cap conviction to ≤25% or convert to Pending.`
      : "",
    "",
    // ── Option 2 enforcement directive ──
    "Always include **Option 2** when a viable secondary exists (e.g., Break + Retest, Trendline break, SFP).",
    "Option 2 must include: direction, order type, explicit trigger (e.g., close above X then retest hold at Y), entry, SL, TP1/TP2, and its own conviction %. Do NOT collapse Option 2 into a generic pullback fallback.",
    "",
    // ── Fundamentals narrative directive ──
    "Under **Fundamental View**, explicitly name key events (e.g., NFP, CPI, ISM), compare Actual vs Forecast vs Previous, state the directional interpretation per currency (bullish/bearish/neutral), and add one line on how that influenced the trade decision.",
  ].join("\n");
}

function buildUserPartsBase(args: {
  instrument: string;
  dateStr: string;
  m15: string;
  h1: string;
  h4: string;
  calendarDataUrl?: string | null;
  calendarText?: string | null;
  headlinesText?: string | null;
  sentimentText?: string | null;
  calendarAdvisoryText?: string | null;
  calendarEvidence?: string[] | null;
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
  if (!args.calendarDataUrl && args.calendarText) {
    parts.push({ type: "text", text: `Calendar snapshot:\n${args.calendarText}` });
  }
  if (args.calendarAdvisoryText) {
    parts.push({
      type: "text",
      text: `Calendar advisory:\n${args.calendarAdvisoryText}`,
    });
  }
  if (args.calendarEvidence && args.calendarEvidence.length) {
    parts.push({
      type: "text",
      text: `Calendar fundamentals evidence:\n- ${args.calendarEvidence.join(
        "\n- "
      )}`,
    });
  }
  if (args.headlinesText) {
    parts.push({
      type: "text",
      text: `Recent headlines snapshot (used for bias; list shown in Stage-2):\n${args.headlinesText}`,
    });
  }
  if (args.sentimentText) {
    parts.push({
      type: "text",
      text: `Sentiment snapshot (CSM + Headlines bias + optional COT cue):\n${args.sentimentText}`,
    });
  }
  return parts;
}

// FULL card (legacy)
function messagesFull(args: {
  instrument: string;
  dateStr: string;
  m15: string;
  h1: string;
  h4: string;
  calendarDataUrl?: string | null;
  calendarText?: string | null;
  headlinesText?: string | null;
  sentimentText?: string | null;
  calendarAdvisory?: {
    warningMinutes?: number | null;
    biasNote?: string | null;
    advisoryText?: string | null;
    evidence?: string[] | null;
  };
}) {
  const system = [
    systemCore(args.instrument, args.calendarAdvisory),
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
    "• Option 2 (Market): Provide the secondary structured play with explicit triggers; if no viable secondary exists, state why.",
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
    "\nai_meta",
    `{ "selectedStrategy": string,`,
    `  "entryType": "Pending" | "Market",`,
    `  "entryOrder": "Sell Limit" | "Buy Limit" | "Sell Stop" | "Buy Stop" | "Market",`,
    `  "direction": "Long" | "Short" | "Flat",`,
    `  "currentPrice": number | null,`,
    `  "zone": { "min": number, "max": number, "tf": "15m" | "1H" | "4H", "type": "OB" | "FVG" | "SR" | "Other" },`,
    `  "stop": number, "tp1": number, "tp2": number,`,
    `  "breakoutProof": { "bodyCloseBeyond": boolean, "retestHolds": boolean, "sfpReclaim": boolean },`,
    `  "candidateScores": [{ "name": string, "score": number, "reason": string }],`,
    `  "sources": { "headlines_used": number, "headlines_instrument": string, "headlines_provider": string | null, "calendar_used": boolean, "calendar_status": string, "calendar_provider": string | null, "csm_used": boolean, "csm_time": string, "cot_used": boolean, "cot_report_date": string | null, "cot_error": string | null, "cot_method": string | null, "calendar_warning_minutes": number | null, "calendar_bias_note": string | null, "calendar_evidence": string[] | null, "headlines_bias_label": "bullish" | "bearish" | "neutral" | "unavailable", "headlines_bias_score": number | null, "cot_bias_summary": string | null } }`,
    "\n",
  ].join("\n");

  return [
    { role: "system", content: system },
    {
      role: "user",
      content: buildUserPartsBase({
        instrument: args.instrument,
        dateStr: args.dateStr,
        m15: args.m15,
        h1: args.h1,
        h4: args.h4,
        calendarDataUrl: args.calendarDataUrl,
        calendarText: args.calendarText,
        headlinesText: args.headlinesText,
        sentimentText: args.sentimentText,
        calendarAdvisoryText: args.calendarAdvisory?.advisoryText || null,
        calendarEvidence: args.calendarAdvisory?.evidence || null,
      }),
    },
  ];
}

// FAST Stage-1: Quick Plan + Management + ai_meta
function messagesFastStage1(args: {
  instrument: string;
  dateStr: string;
  m15: string;
  h1: string;
  h4: string;
  calendarDataUrl?: string | null;
  calendarText?: string | null;
  headlinesText?: string | null;
  sentimentText?: string | null;
  calendarAdvisory?: {
    warningMinutes?: number | null;
    biasNote?: string | null;
    advisoryText?: string | null;
    evidence?: string[] | null;
  };
  provenance?: {
    headlines_used: number;
    headlines_instrument: string;
    headlines_provider: string | null;
    calendar_used: boolean;
    calendar_status: string;
    calendar_provider: string | null;
    csm_used: boolean;
    csm_time: string;
    cot_used: boolean;
    cot_report_date: string | null;
    cot_error?: string | null;
    cot_method?: string | null;
    calendar_warning_minutes?: number | null;
    calendar_bias_note?: string | null;
    calendar_evidence?: string[] | null;
    headlines_bias_label?: HeadlineBias["label"];
    headlines_bias_score?: number | null;
    cot_bias_summary?: string | null;
  };
}) {
  const system = [
    systemCore(args.instrument, args.calendarAdvisory),
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
    "• Option 2 (Market): Provide the secondary structured play with explicit triggers; if no viable secondary exists, state why.",
    "",
    "Management",
    "- Turn the plan into a brief, actionable playbook (filled/not filled, trail/move to BE, invalidation behaviors).",
    "",
    "At the very end, append ONLY a fenced JSON block labeled ai_meta as specified below.",
    "\nai_meta",
    `{ "selectedStrategy": string,`,
    `  "entryType": "Pending" | "Market",`,
    `  "entryOrder": "Sell Limit" | "Buy Limit" | "Sell Stop" | "Buy Stop" | "Market",`,
    `  "direction": "Long" | "Short" | "Flat",`,
    `  "currentPrice": number | null,`,
    `  "zone": { "min": number, "max": number, "tf": "15m" | "1H" | "4H", "type": "OB" | "FVG" | "SR" | "Other" },`,
    `  "stop": number, "tp1": number, "tp2": number,`,
    `  "breakoutProof": { "bodyCloseBeyond": boolean, "retestHolds": boolean, "sfpReclaim": boolean },`,
    `  "candidateScores": [{ "name": string, "score": number, "reason": string }],`,
    `  "sources": { "headlines_used": number, "headlines_instrument": string, "headlines_provider": string | null, "calendar_used": boolean, "calendar_status": string, "calendar_provider": string | null, "csm_used": boolean, "csm_time": string, "cot_used": boolean, "cot_report_date": string | null, "cot_error": string | null, "cot_method": string | null, "calendar_warning_minutes": number | null, "calendar_bias_note": string | null, "calendar_evidence": string[] | null, "headlines_bias_label": "bullish" | "bearish" | "neutral" | "unavailable", "headlines_bias_score": number | null, "cot_bias_summary": string | null } }`,
    "\n",
  ].join("\n");

  const parts = buildUserPartsBase({
    instrument: args.instrument,
    dateStr: args.dateStr,
    m15: args.m15,
    h1: args.h1,
    h4: args.h4,
    calendarDataUrl: args.calendarDataUrl,
    calendarText: !args.calendarDataUrl && args.calendarText ? args.calendarText : undefined,
    headlinesText: args.headlinesText || undefined,
    sentimentText: args.sentimentText || undefined,
    calendarAdvisoryText: args.calendarAdvisory?.advisoryText || null,
    calendarEvidence: args.calendarAdvisory?.evidence || null,
  });

  if (args.provenance) {
    parts.push({
      type: "text",
      text: `provenance:\n${JSON.stringify(args.provenance)}`,
    });
  }

  return [{ role: "system", content: system }, { role: "user", content: parts }];
}

// Stage-2 Expand: ONLY the remaining sections
function messagesExpandStage2(args: {
  instrument: string;
  dateStr: string;
  m15: string;
  h1: string;
  h4: string;
  calendarDataUrl?: string | null;
  calendarText?: string | null;
  headlinesText?: string | null;
  sentimentText?: string | null;
  aiMetaHint?: any;
  calendarAdvisory?: {
    warningMinutes?: number | null;
    biasNote?: string | null;
    advisoryText?: string | null;
    evidence?: string[] | null;
  };
}) {
  const system = [
    systemCore(args.instrument, args.calendarAdvisory),
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
    instrument: args.instrument,
    dateStr: args.dateStr,
    m15: args.m15,
    h1: args.h1,
    h4: args.h4,
    calendarDataUrl: args.calendarDataUrl,
    calendarText: args.calendarText,
    headlinesText: args.headlinesText,
    sentimentText: args.sentimentText,
    calendarAdvisoryText: args.calendarAdvisory?.advisoryText || null,
    calendarEvidence: args.calendarAdvisory?.evidence || null,
  });

  if (args.aiMetaHint)
    userParts.push({
      type: "text",
      text: `ai_meta_hint:\n${JSON.stringify(args.aiMetaHint, null, 2)}`,
    });

  return [{ role: "system", content: system }, { role: "user", content: userParts }];
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
  if (!rsp.ok)
    throw new Error(
      `OpenAI vision request failed: ${rsp.status} ${JSON.stringify(json)}`
    );
  const out =
    json?.choices?.[0]?.message?.content ??
    (Array.isArray(json?.choices?.[0]?.message?.content)
      ? json.choices[0].message.content
          .map((c: any) => c?.text || "")
          .join("\n")
      : "");
  return String(out || "");
}

// ---------- enforcement passes ----------
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
      content: `Instrument: ${instrument}\n\nCurrent Price: ${
        aiMeta?.currentPrice
      }\nProvided Zone: ${JSON.stringify(
        aiMeta?.zone
      )}\n\nCard:\n${text}\n\nFix only the LIMIT zone side and entry, keep format.`,
    },
  ];
  return callOpenAI(messages);
}

// Ensure Option 2 is present and explicit
function hasCompliantOption2(text: string): boolean {
  const re = /Option\s*2/i;
  if (!re.test(text || "")) return false;
  const block = (text.match(/Option\s*2[\s\S]{0,800}/i)?.[0] || "").toLowerCase();
  const must = ["direction", "trigger", "entry", "stop", "tp", "conviction"];
  return must.every((k) => block.includes(k));
}
async function enforceOption2(instrument: string, text: string) {
  if (hasCompliantOption2(text)) return text;
  const messages = [
    {
      role: "system",
      content:
        "Add a compliant **Option 2** to this trade card. Keep Option 1 exactly as-is (numbers and wording). Option 2 must be a secondary structured play (e.g., Break + Retest, Trendline break, SFP), and MUST include: - Direction, Order Type - Explicit trigger instructions (e.g., \"Wait for a 1H close above X, then retest hold at Y\") - Entry level(s) - Stop Loss - TP1 and TP2 - Its own Conviction % (may differ from Option 1) Do not remove or alter any other sections or text.",
    },
    {
      role: "user",
      content: `Instrument: ${instrument}\n\n${text}\n\nAdd Option 2 below the existing Option 1 with the required details.`,
    },
  ];
  return callOpenAI(messages);
}

// ---------- live price helpers ----------
async function fetchLivePrice(pair: string): Promise<number | null> {
  // 1) TwelveData
  if (TD_KEY) {
    try {
      const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
      const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(
        sym
      )}&apikey=${TD_KEY}&dp=5`;
      const r = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(1800),
      });
      const j: any = await r.json().catch(() => ({}));
      const p = Number(j?.price);
      if (isFinite(p) && p > 0) return p;
    } catch {}
  }
  // 2) Finnhub last 15m close
  if (FH_KEY) {
    try {
      const sym = `OANDA:${pair.slice(0, 3)}_${pair.slice(3)}`;
      const to = Math.floor(Date.now() / 1000);
      const from = to - 60 * 60 * 3;
      const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(
        sym
      )}&resolution=15&from=${from}&to=${to}&token=${FH_KEY}`;
      const r = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(1800),
      });
      const j: any = await r.json().catch(() => ({}));
      const c = Array.isArray(j?.c) ? j.c : [];
      const last = Number(c[c.length - 1]);
      if (isFinite(last) && last > 0) return last;
    } catch {}
  }
  // 3) Polygon last agg
  if (POLY_KEY) {
    try {
      const ticker = `C:${pair}`;
      const to = new Date();
      const from = new Date(to.getTime() - 60 * 60 * 1000);
      const fmt = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
          2,
          "0"
        )}-${String(d.getDate()).padStart(2, "0")}`;
      const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(
        ticker
      )}/range/1/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=desc&limit=1&apiKey=${POLY_KEY}`;
      const r = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(1500),
      });
      const j: any = await r.json().catch(() => ({}));
      const res = Array.isArray(j?.results) ? j.results[0] : null;
      const last = Number(res?.c);
      if (isFinite(last) && last > 0) return last;
    } catch {}
  }
  // 4) fallback
  try {
    const S = await fetchSeries15(pair);
    const last = S?.c?.[S.c.length - 1];
    if (isFinite(Number(last)) && Number(last) > 0) return Number(last);
  } catch {}
  return null;
}

// ---------- handler ----------
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Ok | Err>
) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY)
      return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    // mode selection
    const urlMode = String((req.query.mode as string) || "").toLowerCase();
    let mode: "full" | "fast" | "expand" =
      urlMode === "fast" ? "fast" : urlMode === "expand" ? "expand" : "full";

    // expand path
    if (mode === "expand") {
      const cacheKey = String(req.query.cache || "").trim();
      const c = getCache(cacheKey);
      if (!c)
        return res
          .status(400)
          .json({ ok: false, reason: "Expand failed: cache expired or not found." });
      if (!c.sentimentText)
        return res
          .status(503)
          .json({ ok: false, reason: "Missing sentiment snapshot for expand." });

      const dateStr = new Date().toISOString().slice(0, 10);
      const calAdv = await fetchCalendarForAdvisory(req, c.instrument);
      const messages = messagesExpandStage2({
        instrument: c.instrument,
        dateStr,
        m15: c.m15,
        h1: c.h1,
        h4: c.h4,
        calendarDataUrl: c.calendar || undefined,
        headlinesText: c.headlinesText || undefined,
        sentimentText: c.sentimentText || undefined,
        aiMetaHint: null,
        calendarAdvisory: {
          warningMinutes: calAdv.warningMinutes,
          biasNote: calAdv.biasNote,
          advisoryText: calAdv.advisoryText,
          evidence: calAdv.evidence || [],
        },
      });
      const text = await callOpenAI(messages);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        text,
        meta: { instrument: c.instrument, cacheKey },
      });
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
    if (process.env.NODE_ENV !== "production")
      console.log(`[vision-plan] parsed in ${dt(tParse)}`);

    const instrument = String(fields.instrument || fields.code || "EURUSD")
      .toUpperCase()
      .replace(/\s+/g, "");
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

    // Build images
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
    const h1 = h1FromFile || h1FromUrl;
    const h4 = h4FromFile || h4FromUrl;

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[vision-plan] images ready ${dt(tImg)} (m15=${dataUrlSizeBytes(
          m15
        )}B, h1=${dataUrlSizeBytes(h1)}B, h4=${dataUrlSizeBytes(
          h4
        )}B, cal=${dataUrlSizeBytes(calUrl)}B)`
      );
    }
    if (!m15 || !h1 || !h4) {
      return res.status(400).json({
        ok: false,
        reason:
          "Provide all three charts: m15, h1, h4 — either as files or valid TradingView/Gyazo direct image links.",
      });
    }

    // ----- Headlines -----
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
      } catch {
        // fall through to server fetch
      }
    }
    if (!headlinesText) {
      const viaServer = await fetchedHeadlinesViaServer(req, instrument);
      headlineItems = viaServer.items;
      headlinesText = viaServer.promptText;
      headlinesProvider = viaServer.provider || "unknown";
    }

    // NEW: compute headline bias
    const hBias = computeHeadlinesBias(headlineItems);

    // ----- Calendar -----
    let calendarText: string | null = null;
    let calendarStatus: "image" | "api" | "unavailable" = "unavailable";
    let calendarProvider: string | null = null;

    const calAdv = await fetchCalendarForAdvisory(req, instrument);
    if (calUrl) {
      calendarStatus = "image";
      calendarProvider = "image";
      calendarText = calAdv.text; // include bias text too
    } else {
      calendarText = calAdv.text;
      calendarStatus = calAdv.status;
      calendarProvider = calAdv.provider;
    }

    // ----- Sentiment: CSM mandatory; optional headline-based COT cue -----
    let csm: CsmSnapshot;
    try {
      csm = await getCSM();
    } catch (e: any) {
      return res.status(503).json({
        ok: false,
        reason: `CSM unavailable: ${e?.message || "fetch failed"}.`,
      });
    }
    const cotCue = detectCotCueFromHeadlines(headlineItems);
    const { text: sentimentText, provenance: sentProv } = sentimentSummary(
      csm,
      cotCue,
      hBias
    );

    // ----- Live price -----
    const livePrice = await fetchLivePrice(instrument);
    const dateStr = new Date().toISOString().slice(0, 10);

    // ---------- Stage 1 (fast) or Full ----------
    let text = "";
    let aiMeta: any = null;

    const provForModel = {
      headlines_used: Math.min(
        6,
        Array.isArray(headlineItems) ? headlineItems.length : 0
      ),
      headlines_instrument: instrument,
      headlines_provider: headlinesProvider || "unknown",
      calendar_used: !!calUrl || calendarStatus === "api",
      calendar_status: calendarStatus,
      calendar_provider: calendarProvider,
      csm_used: true,
      csm_time: csm.tsISO,
      cot_used: !!cotCue,
      cot_report_date: null as string | null,
      cot_error: cotCue ? null : "no cot cues",
      cot_method: cotCue ? "headline_fallback" : null,
      calendar_warning_minutes: calAdv.warningMinutes ?? null,
      calendar_bias_note: calAdv.biasNote || null,
      calendar_evidence: calAdv.evidence || [],
      // NEW provenance fields
      headlines_bias_label: hBias.label,
      headlines_bias_score: hBias.avg,
      cot_bias_summary: cotCue ? cotCue.summary : null,
    };

    if (mode === "fast") {
      const messages = messagesFastStage1({
        instrument,
        dateStr,
        m15,
        h1,
        h4,
        calendarDataUrl: calUrl || undefined,
        calendarText: !calUrl && calendarText ? calendarText : undefined,
        headlinesText: headlinesText || undefined,
        sentimentText: sentimentText,
        calendarAdvisory: {
          warningMinutes: calAdv.warningMinutes,
          biasNote: calAdv.biasNote,
          advisoryText: calAdv.advisoryText,
          evidence: calAdv.evidence || [],
        },
        provenance: provForModel,
      });

      if (livePrice) {
        (messages[0] as any).content =
          (messages[0] as any).content +
          `\n\nNote: Current price hint ~ ${livePrice};`;
      }

      text = await callOpenAI(messages);
      aiMeta = extractAiMeta(text) || {};
      if (livePrice && (aiMeta.currentPrice == null || !isFinite(Number(aiMeta.currentPrice)))) {
        aiMeta.currentPrice = livePrice;
      }

      // enforcement passes
      if (aiMeta && needsPendingLimit(aiMeta)) {
        text = await rewriteAsPending(instrument, text);
        aiMeta = extractAiMeta(text) || aiMeta;
      }

      const bp = aiMeta?.breakoutProof || {};
      const hasProof = !!(
        bp?.bodyCloseBeyond === true &&
        (bp?.retestHolds === true || bp?.sfpReclaim === true)
      );
      if (
        String(aiMeta?.selectedStrategy || "")
          .toLowerCase()
          .includes("breakout") &&
        !hasProof
      ) {
        text = await normalizeBreakoutLabel(text);
        aiMeta = extractAiMeta(text) || aiMeta;
      }

      if (aiMeta) {
        if (livePrice && aiMeta.currentPrice !== livePrice)
          aiMeta.currentPrice = livePrice;
        const bad = invalidOrderRelativeToPrice(aiMeta);
        if (bad) {
          text = await fixOrderVsPrice(instrument, text, aiMeta);
          aiMeta = extractAiMeta(text) || aiMeta;
        }
      }

      // Ensure Option 2 present & explicit
      text = await enforceOption2(instrument, text);
      aiMeta = extractAiMeta(text) || aiMeta;

      // Cache stage-1
      const cacheKey = setCache({
        instrument,
        m15,
        h1,
        h4,
        calendar: calUrl || null,
        headlinesText: headlinesText || null,
        sentimentText,
      });

      if (!text || refusalLike(text)) {
        const fb = fallbackCard(instrument, provForModel);
        return res.status(200).json({
          ok: true,
          text: fb,
          meta: {
            instrument,
            mode,
            cacheKey,
            headlinesCount: headlineItems.length,
            fallbackUsed: true,
            aiMeta: extractAiMeta(fb),
            sources: provForModel,
          },
        });
      }

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        text,
        meta: {
          instrument,
          mode,
          cacheKey,
          headlinesCount: headlineItems.length,
          fallbackUsed: false,
          aiMeta,
          sources: provForModel,
        },
      });
    }

    // FULL (legacy)
    const messages = messagesFull({
      instrument,
      dateStr,
      m15,
      h1,
      h4,
      calendarDataUrl: calUrl || undefined,
      calendarText: !calUrl && calendarText ? calendarText : undefined,
      headlinesText: headlinesText || undefined,
      sentimentText,
      calendarAdvisory: {
        warningMinutes: calAdv.warningMinutes,
        biasNote: calAdv.biasNote,
        advisoryText: calAdv.advisoryText,
        evidence: calAdv.evidence || [],
      },
    });

    if (livePrice) {
      (messages[0] as any).content =
        (messages[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice};`;
    }

    text = await callOpenAI(messages);
    aiMeta = extractAiMeta(text) || {};
    if (livePrice && (aiMeta.currentPrice == null || !isFinite(Number(aiMeta.currentPrice)))) {
      aiMeta.currentPrice = livePrice;
    }

    if (aiMeta && needsPendingLimit(aiMeta)) {
      text = await rewriteAsPending(instrument, text);
      aiMeta = extractAiMeta(text) || aiMeta;
    }

    {
      const bp = aiMeta?.breakoutProof || {};
      const hasProof = !!(
        bp?.bodyCloseBeyond === true &&
        (bp?.retestHolds === true || bp?.sfpReclaim === true)
      );
      if (
        String(aiMeta?.selectedStrategy || "")
          .toLowerCase()
          .includes("breakout") &&
        !hasProof
      ) {
        text = await normalizeBreakoutLabel(text);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    if (aiMeta) {
      if (livePrice && aiMeta.currentPrice !== livePrice)
        aiMeta.currentPrice = livePrice;
      const bad = invalidOrderRelativeToPrice(aiMeta);
      if (bad) {
        text = await fixOrderVsPrice(instrument, text, aiMeta);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // Ensure Option 2 present & explicit
    text = await enforceOption2(instrument, text);
    aiMeta = extractAiMeta(text) || aiMeta;

    if (!text || refusalLike(text)) {
      const fb = fallbackCard(instrument, provForModel);
      return res.status(200).json({
        ok: true,
        text: fb,
        meta: {
          instrument,
          mode,
          headlinesCount: headlineItems.length,
          fallbackUsed: true,
          aiMeta: extractAiMeta(fb),
          sources: provForModel,
        },
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text,
      meta: {
        instrument,
        mode,
        headlinesCount: headlineItems.length,
        fallbackUsed: false,
        aiMeta,
        sources: provForModel,
      },
    });
  } catch (err: any) {
    return res
      .status(500)
      .json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}

// ---------- fallback (keeps structure + sources) ----------
function fallbackCard(
  instrument: string,
  sources: {
    headlines_used: number;
    headlines_instrument: string;
    headlines_provider: string | null;
    calendar_used: boolean;
    calendar_status: string;
    calendar_provider: string | null;
    csm_used: boolean;
    csm_time: string;
    cot_used: boolean;
    cot_report_date: string | null;
    cot_error?: string | null;
    cot_method?: string | null;
    calendar_warning_minutes?: number | null;
    calendar_bias_note?: string | null;
    calendar_evidence?: string[] | null;
    headlines_bias_label?: HeadlineBias["label"];
    headlines_bias_score?: number | null;
    cot_bias_summary?: string | null;
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
    "| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |",
    `| ${instrument} | Neutral | Wait for trigger | Structure-based | Prior swing | Next liquidity | 30% |`,
    "",
    "\nai_meta",
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
        breakoutProof: {
          bodyCloseBeyond: false,
          retestHolds: false,
          sfpReclaim: false,
        },
        candidateScores: [],
        sources,
        note: "Fallback used due to refusal/empty output.",
      },
      null,
      2
    ),
    "\n",
  ].join("\n");
}
