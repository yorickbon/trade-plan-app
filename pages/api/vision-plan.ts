/**
 * /pages/api/vision-plan.ts — NO-GUESS + SPEED
 *
 * Guarantees:
 * - Calendar OCR is image-first (no guessing). Rows: timeISO, title, currency, impact, actual, forecast, previous.
 * - Evidence lines & bias built from OCR; if unreadable → null (never invent).
 * - Provenance in ai_meta.sources: calendar_status "image-ocr" when image used; fallback to API only if NO image.
 * - Breakout + Retest: never rename to Pullback when proof missing; add Proof Checklist; if Market w/o proof → Pending with trigger sequence.
 * - Section order enforced: Quick Plan → Option 1 → Option 2 (then other sections).
 * - Mode "fast" and "full" use the SAME tournament rubric; deterministic (temperature: 0).
 * - Speed: provider racing (CSM & price), shorter timeouts, single-pass enforcement, OCR cache, no duplicate calendar calls, lean calendar image encoding.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";
import sharp from "sharp";
import crypto from "node:crypto";

// ---------- config ----------
export const config = { api: { bodyParser: false, sizeLimit: "25mb" } };

type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

const VP_VERSION = "2025-09-08-noguess-v6";

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
const CAL_W = 1400;

const now = () => Date.now();
const dt = (t: number) => `${Date.now() - t}ms`;

function uuid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function dataUrlSizeBytes(s: string | null | undefined): number {
  if (!s) return 0;
  const i = s.indexOf(","); if (i < 0) return 0;
  const b64 = s.slice(i + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}
const safeNum = (v: any): number | null => (Number.isFinite(Number(v)) ? Number(v) : null);

// ---------- in-memory image cache ----------
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
async function processAdaptiveToDataUrl(buf: Buffer, isCalendar = false): Promise<string> {
  const width = isCalendar ? CAL_W : BASE_W;
  const quality = isCalendar ? 80 : 74;
  const out = await toJpeg(buf, width, quality);
  if (out.byteLength > IMG_MAX_BYTES) throw new Error("image too large after processing");
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}
async function fileToDataUrl(file: any, isCalendar = false): Promise<string | null> {
  if (!file) return null;
  const p = file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;
  const raw = await fs.readFile(p);
  const out = await processAdaptiveToDataUrl(raw, isCalendar);
  if (process.env.NODE_ENV !== "production") console.log(`[vision-plan] file processed size=${dataUrlSizeBytes(out)}B (calendar=${isCalendar})`);
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
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "TradePlanApp/1.0", accept: "text/html,application/xhtml+xml,application/xml,image/avif,image/webp,image/apng,image/*,*/*;q=0.8" } });
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
async function linkToDataUrl(link: string): Promise<string | null> { if (!link) return null; try { if (looksLikeImageUrl(link)) return await downloadAndProcess(link); return await downloadAndProcess(link); } catch { return null; } }

// ---------- Headlines ----------
type AnyHeadline = {
  title?: string;
  description?: string;
  source?: string;
  published_at?: string;
  ago?: string;
  sentiment?: { score?: number } | null;
} & Record<string, any>;

function headlinesToPromptLines(items: AnyHeadline[], limit = 6): string | null {
  const take = (items || []).slice(0, limit);
  if (!take.length) return null;
  const lines = take.map((it: AnyHeadline) => {
    const s = typeof it?.sentiment?.score === "number" ? (it.sentiment!.score as number) : null;
    const lab = s == null ? "neu" : s > 0.05 ? "pos" : s < -0.05 ? "neg" : "neu";
    const t = String(it?.title || "").slice(0, 200);
    const src = it?.source || "";
    const when = it?.ago || "";
    return `• ${t} — ${src}${when ? `, ${when}` : ""} — ${lab};`;
  });
  return lines.join("\n");
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

// ---------- ai_meta helpers ----------
function extractAiMeta(text: string) {
  if (!text) return null;
  const fences = [/\nai_meta\s*({[\s\S]*?})\s*\n/i, /\n```ai_meta\s*({[\s\S]*?})\s*```/i, /\n```json\s*({[\s\S]*?})\s*```/i];
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

// returns
function kbarReturn(closes: number[], k: number): number | null {
  if (!closes || closes.length <= k) return null;
  const a = closes[closes.length - 1];
  const b = closes[closes.length - 1 - k];
  if (!(a > 0) || !(b > 0)) return null;
  return Math.log(a / b);
}

// providers (unchanged)
async function tdSeries15(pair: string): Promise<Series | null> {
  if (!TD_KEY) return null;
  try {
    const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=15min&outputsize=30&apikey=${TD_KEY}&dp=6`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1500) });
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
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1500) });
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
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1200) });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!Array.isArray(j?.results)) return null;
    const t: number[] = j.results.map((x: any) => Math.floor(x.t / 1000));
    const c: number[] = j.results.map((x: any) => Number(x.c));
    if (!c.every((x: number) => isFinite(x))) return null;
    return { t, c };
  } catch { return null; }
}

// SPEED: race providers and return first good
async function fetchSeries15(pair: string): Promise<Series | null> {
  const tasks: Promise<Series | null>[] = [];
  if (TD_KEY) tasks.push(tdSeries15(pair));
  if (FH_KEY) tasks.push(fhSeries15(pair));
  if (POLY_KEY) tasks.push(polySeries15(pair));
  if (!tasks.length) return null;
  try {
    const first = await Promise.any(tasks.map(p => p.then(res => {
      if (res && Array.isArray(res.c) && res.c.length) return res;
      throw new Error("bad");
    })));
    return first as Series;
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

// ---------- Calendar helpers (OCR + API fallback) ----------
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

// OCR cache
const OCR_CACHE = new Map<string, { items: OcrCalendarRow[]; exp: number }>();
function b64Hash(dataUrl: string): string { const b64 = dataUrl.split(",")[1] || ""; return crypto.createHash("sha1").update(b64).digest("hex"); }

// OpenAI call (deterministic)
async function callOpenAI(model: string, messages: any[], opts?: Partial<{temperature:number;top_p:number;seed:number}>) {
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model, messages,
      temperature: opts?.temperature ?? 0,
      top_p: opts?.top_p ?? 1,
      seed: opts?.seed ?? 7,
    }),
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

async function ocrCalendarFromImage(model: string, calendarDataUrl: string): Promise<OcrCalendar | null> {
  const key = b64Hash(calendarDataUrl);
  const hit = OCR_CACHE.get(key);
  if (hit && Date.now() < hit.exp) return { items: hit.items };

  const sys = [
    "You are extracting ECONOMIC CALENDAR rows from an image via OCR.",
    "Return STRICT JSON only. DO NOT GUESS values. If unreadable/absent, use null.",
    "Fields per row: timeISO (ISO8601 if visible, else null), title, currency (USD/EUR/... uppercased 3 letters), impact (Low|Medium|High), actual, forecast, previous.",
    "Numbers may include symbols (% k m). If numeric is obvious keep number; else keep original string; if unreadable → null.",
  ].join("\n");
  const user = [
    { type: "text", text: "Extract rows as specified. JSON only with shape {items:[...]}" },
    { type: "image_url", image_url: { url: calendarDataUrl } },
  ];
  const msg = [{ role: "system", content: sys }, { role: "user", content: user }];
  const text = await callOpenAI(model, msg);
  const parsed = tryParseJsonBlock(text);
  if (!parsed || !Array.isArray(parsed?.items)) return null;

  const items: OcrCalendarRow[] = (parsed.items as any[]).map((r) => ({
    timeISO: r?.timeISO && typeof r.timeISO === "string" ? r.timeISO : null,
    title: r?.title && typeof r.title === "string" ? r.title : null,
    currency: r?.currency && typeof r.currency === "string" ? r.currency.toUpperCase().slice(0,3) : null,
    impact: r?.impact && typeof r.impact === "string" ? (["low","medium","high"].includes(r.impact.toLowerCase()) ? (r.impact[0].toUpperCase()+r.impact.slice(1).toLowerCase()) as any : null) : null,
    actual: r?.actual ?? null,
    forecast: r?.forecast ?? null,
    previous: r?.previous ?? null,
  }));
  OCR_CACHE.set(key, { items, exp: Date.now() + 10 * 60 * 1000 });
  return { items };
}

// bias helpers
function goodIfHigher(title: string): boolean | null {
  const t = (title || "").toLowerCase();
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
  const a = safeNum(it.actual);
  const f = safeNum(it.forecast);
  const p = safeNum(it.previous);
  if (a == null || (f == null && p == null)) return null;
  const dir = goodIfHigher(String(it.title || ""));
  let comp: string[] = [];
  if (f != null) comp.push(a < f ? "< forecast" : a > f ? "> forecast" : "= forecast");
  if (p != null) comp.push(a < p ? "< previous" : a > p ? "> previous" : "= previous");
  let verdict = "neutral";
  if (dir === true) {
    verdict = (a > (f ?? a) && a > (p ?? a)) ? "bullish" : (a < (f ?? a) && a < (p ?? a)) ? "bearish" : "mixed";
  } else if (dir === false) {
    verdict = (a < (f ?? a) && a < (p ?? a)) ? "bullish" : (a > (f ?? a) && a > (p ?? a)) ? "bearish" : "mixed";
  }
  const comps = comp.join(" and ");
  return `${cur} — ${it.title}: actual ${it.actual}${f!=null||p!=null ? ` ${comps}` : ""} → ${verdict} ${cur}`;
}

function analyzeCalendarOCR(ocr: OcrCalendar, pair: string): {
  biasLine: string | null;
  biasNote: string | null;
  warningMinutes: number | null;
  evidenceLines: string[];
} {
  const base = pair.slice(0,3), quote = pair.slice(3);
  const nowMs = Date.now();
  const lines: string[] = [];
  const per: Record<string, number> = {};
  function addScore(cur: string, verdict: string) {
    if (!cur) return;
    if (!per[cur]) per[cur] = 0;
    if (verdict.includes("bullish")) per[cur] += 1;
    else if (verdict.includes("bearish")) per[cur] -= 1;
  }

  let warn: number | null = null;
  for (const it of (ocr.items || [])) {
    if (it?.impact === "High" && it?.timeISO) {
      const t = Date.parse(it.timeISO);
      if (isFinite(t) && t >= nowMs) {
        const mins = Math.floor((t - nowMs) / 60000);
        if (mins <= 60) warn = warn == null ? mins : Math.min(warn, mins);
      }
    }
    if (it?.timeISO) {
      const t = Date.parse(it.timeISO);
      if (isFinite(t) && t <= nowMs && t >= nowMs - 72*3600*1000) {
        const cur = it?.currency || "";
        const ev = evidenceLine(it, cur);
        if (ev) { lines.push(ev); addScore(cur, ev); }
      }
    }
  }

  const label = (s: number) => s > 0 ? "bullish" : s < 0 ? "bearish" : "neutral";
  const bScore = per[base] ?? 0, qScore = per[quote] ?? 0;
  const bLab = label(bScore), qLab = label(qScore);

  let instr: string | null = null;
  if (bLab === "bullish" && qLab === "bearish") instr = "bullish (base stronger than quote)";
  else if (bLab === "bearish" && qLab === "bullish") instr = "bearish (quote stronger than base)";
  const biasLine = `Calendar bias for ${pair}: ${instr ? `Instrument: ${instr}; ` : ""}Per-currency: ${base}:${bLab} / ${quote}:${qLab}`;

  const biasNote = `Per-currency: ${base} ${bLab} vs ${quote} ${qLab}${instr ? `; Instrument bias: ${instr}` : ""}`;
  return { biasLine, biasNote, warningMinutes: warn, evidenceLines: lines };
}

// ---------- API calendar fallback (only if NO image provided) ----------
async function fetchCalendarForAdvisory(req: NextApiRequest, instrument: string): Promise<{
  text: string | null, status: "api" | "unavailable", provider: string | null,
  warningMinutes: number | null, advisoryText: string | null, biasNote: string | null,
  raw?: any | null, evidence?: string[] | null
}> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/calendar?instrument=${encodeURIComponent(instrument)}&windowHours=48&_t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3500) });
    const j: any = await r.json().catch(() => ({}));
    if (j?.ok) {
      // short bias text
      const instrBias = j?.bias?.instrument;
      const parts: string[] = [];
      if (instrBias && instrBias.pair === instrument) { parts.push(`Instrument bias: ${instrBias.label} (${instrBias.score})`); }
      const per = j?.bias?.perCurrency || {};
      const baseC = instrument.slice(0,3), quoteC = instrument.slice(3);
      const b = per[baseC]?.label ? `${baseC}:${per[baseC].label}` : null;
      const q = per[quoteC]?.label ? `${quoteC}:${per[quoteC].label}` : null;
      if (b || q) parts.push(`Per-currency: ${[b,q].filter(Boolean).join(" / ")}`);
      const t = `Calendar bias for ${instrument}: ${parts.length ? parts.join("; ") : "No strong signal."}`;

      // nearest High impact within 60 min
      const nowMs = Date.now(); let warn: number | null = null;
      for (const it of (j.items || [])) {
        if (String(it?.impact || "") !== "High") continue;
        const tt = new Date(it.time).getTime();
        if (tt >= nowMs) {
          const mins = Math.floor((tt - nowMs) / 60000);
          if (mins <= 60) warn = warn == null ? mins : Math.min(warn, mins);
        }
      }

      // evidence from past 72h for base/quote
      const lo = nowMs - 72*3600*1000;
      const done = (j.items || []).filter((it: any) => {
        const tt = new Date(it.time).getTime();
        return tt <= nowMs && tt >= lo && (it.currency === baseC || it.currency === quoteC) && (it.actual != null || it.forecast != null || it.previous != null);
      }).slice(0, 12);
      const evidence = done.map((it: any) => evidenceLine(it, it.currency || "")).filter(Boolean) as string[];

      const biasNote = `Per-currency: ${baseC} ${per[baseC]?.label || "neutral"} vs ${quoteC} ${per[quoteC]?.label || "neutral"}${instrBias?.label ? `; Instrument bias: ${instrBias.label} (score ${instrBias.score})` : ""}`;
      const advisory = [
        warn != null ? `⚠️ High-impact event in ~${warn} min.` : null,
        biasNote ? `Recent result alignment: ${biasNote}.` : null
      ].filter(Boolean).join("\n");

      return { text: t, status: "api", provider: String(j?.provider || "mixed"), warningMinutes: warn ?? null, advisoryText: advisory || null, biasNote: biasNote || null, raw: j, evidence };
    }
    return { text: "Calendar unavailable.", status: "unavailable", provider: null, warningMinutes: null, advisoryText: null, biasNote: null, raw: null, evidence: [] };
  } catch {
    return { text: "Calendar unavailable.", status: "unavailable", provider: null, warningMinutes: null, advisoryText: null, biasNote: null, raw: null, evidence: [] };
  }
}

// ---------- Sentiment snapshot text ----------
type CotCue = { method: "headline_fallback"; reportDate: null; summary: string; net: Record<string, number>; };
function sentimentSummary(
  csm: CsmSnapshot,
  headlineBias: { label: "bullish" | "bearish" | "neutral" | "unavailable"; avg: number | null; count: number },
  cotCue: CotCue | null
): {
  text: string;
  provenance: {
    csm_used: boolean; csm_time: string;
    cot_used: boolean; cot_report_date: string | null; cot_error?: string | null; cot_method?: string | null;
    headlines_bias_label: string; headlines_bias_score: number | null;
    cot_bias_summary: string | null;
  };
} {
  const ranksLine = `CSM (60–240m): ${csm.ranks.slice(0, 4).join(" > ")} ... ${csm.ranks.slice(-3).join(" < ")}`;
  const hBiasLine = headlineBias.label === "unavailable"
    ? "Headlines bias (48h): unavailable"
    : `Headlines bias (48h): ${headlineBias.label}${headlineBias.avg != null ? ` (${headlineBias.avg.toFixed(2)})` : ""}`;
  const cotLine = cotCue ? `COT: ${cotCue.summary}` : "COT: (unavailable)";
  const prov = {
    csm_used: true, csm_time: csm.tsISO,
    cot_used: !!cotCue, cot_report_date: null as string | null, cot_error: cotCue ? null : "no cot cues", cot_method: cotCue ? cotCue.method : null,
    headlines_bias_label: headlineBias.label, headlines_bias_score: headlineBias.avg,
    cot_bias_summary: cotCue ? cotCue.summary : null,
  };
  return { text: `${ranksLine}\n${hBiasLine}\n${cotLine}`, provenance: prov };
}

// ---------- prompts (shared rubric fast/full) ----------
function systemCore(
  instrument: string,
  calendarAdvisory?: { warningMinutes?: number | null; biasNote?: string | null }
) {
  const warn = (calendarAdvisory?.warningMinutes ?? null) != null ? calendarAdvisory!.warningMinutes : null;
  const bias = calendarAdvisory?.biasNote || null;

  return [
    "You are a professional discretionary trader.",
    "STRICT NO-GUESS RULES:",
    "- Only mention **Calendar** if calendar_status === 'api' or a calendar image is provided.",
    "- Only mention **Headlines** if a headlines snapshot is provided.",
    "- Do not invent events, figures, or quotes. If something is missing, write 'unavailable'.",
    "- Use the Sentiment snapshot exactly as given (CSM + Headlines bias + optional COT cue).",
    "",
    "Perform **visual** price-action analysis from images.",
    "Multi-timeframe alignment: 15m execution, 1H context, 4H HTF.",
    "Tournament mode: evaluate and pick the **single best** candidate using THIS scoring rubric:",
    "Scoring rubric (0–100): Structure trend(25), 15m trigger(25), HTF context(15), Clean path(10), Stop validity(10), Fundamentals/Headlines/Sentiment(10), 'No chase'(5).",
    "Market entry allowed only when **explicit proof**; otherwise EntryType: Pending and use LIMIT zone.",
    "Stops behind structure; step to next valid zone if too tight.",
    `Keep instrument alignment with ${instrument}.`,
    warn !== null ? `\nCALENDAR WARNING: High-impact event within ~${warn} min. If trading into event, cap conviction ≤35% and avoid new Market entries right before the event.` : "",
    bias ? `\nPOST-RESULT ALIGNMENT: ${bias}. If conflicting with technicals, cap conviction ≤25% or convert to Pending.` : "",
    "",
    "Always include **Option 2** when a viable secondary exists; include direction, order type, explicit trigger, entry, SL, TP, conviction.",
    "",
    "Under **Fundamental View**, if Calendar is unavailable, state 'Calendar: unavailable'. If Headlines snapshot not provided, state 'Headlines: unavailable'. Always include 'Headlines bias (48h): ...' as provided in Sentiment snapshot.",
  ].join("\n");
}

// ---------- message builders ----------
function buildUserPartsBase(args: {
  instrument: string;
  dateStr: string;
  m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null;
  calendarEvidence?: string[] | null;
  headlinesText?: string | null;
  sentimentText?: string | null;
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
  if (args.calendarDataUrl) { parts.push({ type: "text", text: "Economic Calendar Image:" }); parts.push({ type: "image_url", image_url: { url: args.calendarDataUrl } }); }
  if (args.calendarEvidence && args.calendarEvidence.length) { parts.push({ type: "text", text: `Calendar fundamentals evidence:\n- ${args.calendarEvidence.join("\n- ")}` }); }
  if (args.headlinesText) { parts.push({ type: "text", text: `Headlines snapshot:\n${args.headlinesText}` }); }
  if (args.sentimentText) { parts.push({ type: "text", text: `Sentiment snapshot (server):\n${args.sentimentText}` }); }
  return parts;
}

function messagesFastStage1(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarEvidence?: string[] | null;
  headlinesText?: string | null; sentimentText?: string | null;
  calendarAdvisory?: { warningMinutes?: number | null; biasNote?: string | null; };
  provenance?: any;
}) {
  const system = [
    systemCore(args.instrument, args.calendarAdvisory), "",
    "OUTPUT ONLY the following, in this exact order:",
    "Quick Plan (Actionable)", "",
    "• Direction: Long | Short | Stay Flat",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger:", "• Entry:", "• Stop Loss:", "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%", "• Setup:", "• Short Reasoning:",
    "",
    "Option 1 (Primary)",
    "• Direction: ...", "• Order Type: ...",
    "• Trigger:", "• Entry:", "• Stop Loss:", "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%", "• Why this is primary:",
    "",
    "Option 2 (Alternative)",
    "• Direction: ...", "• Order Type: ...",
    "• Trigger:", "• Entry:", "• Stop Loss:", "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%", "• Why this alternative:",
    "",
    "Management: Brief actionable playbook (filled/not filled, trail/BE, invalidation).", "",
    "Append ONLY a fenced JSON block labeled ai_meta as specified earlier.", "",
    "provenance_hint (DO NOT PARAPHRASE; ONLY USE TO DECIDE WHAT TO INCLUDE):",
    JSON.stringify(args.provenance || {}, null, 2),
    "\n",
  ].join("\n");

  const user = buildUserPartsBase({
    instrument: args.instrument, dateStr: args.dateStr, m15: args.m15, h1: args.h1, h4: args.h4,
    calendarDataUrl: args.calendarDataUrl, calendarEvidence: args.calendarEvidence,
    headlinesText: args.headlinesText || undefined, sentimentText: args.sentimentText || undefined,
  });

  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function messagesFull(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarEvidence?: string[] | null;
  headlinesText?: string | null; sentimentText?: string | null;
  calendarAdvisory?: { warningMinutes?: number | null; biasNote?: string | null; };
  provenance?: any;
}) {
  const system = [
    systemCore(args.instrument, args.calendarAdvisory), "",
    "OUTPUT format (in this exact order):",
    "Quick Plan (Actionable)", "",
    "• Direction: Long | Short | Stay Flat",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger:", "• Entry:", "• Stop Loss:", "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%", "• Setup:", "• Short Reasoning:",
    "",
    "Option 1 (Primary)", "• Direction: ...", "• Order Type: ...",
    "• Trigger:", "• Entry:", "• Stop Loss:", "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%", "• Why this is primary:",
    "",
    "Option 2 (Alternative)", "• Direction: ...", "• Order Type: ...",
    "• Trigger:", "• Entry:", "• Stop Loss:", "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%", "• Why this alternative:",
    "",
    "Full Breakdown",
    "• Technical View (HTF + Intraday): 4H/1H/15m structure",
    "• Fundamental View (Calendar + Sentiment + Headlines): (respect NO-GUESS rules)",
    "• Tech vs Fundy Alignment: Match | Mismatch (+why)",
    "• Conditional Scenarios:",
    "• Surprise Risk:",
    "• Invalidation:",
    "• One-liner Summary:", "",
    "Detected Structures (X-ray):", "• 4H:", "• 1H:", "• 15m:", "",
    "Candidate Scores (tournament):", "- name — score — reason", "",
    "Final Table Summary:",
    "| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |",
    `| ${args.instrument} | ... | ... | ... | ... | ... | ... |`, "",
    "At the very end, append a fenced JSON block labeled ai_meta with the fields specified earlier.",
    "",
    "provenance_hint (DO NOT PARAPHRASE; ONLY USE TO DECIDE WHAT TO INCLUDE):",
    JSON.stringify(args.provenance || {}, null, 2),
    "\n",
  ].join("\n");

  const user = buildUserPartsBase({
    instrument: args.instrument, dateStr: args.dateStr, m15: args.m15, h1: args.h1, h4: args.h4,
    calendarDataUrl: args.calendarDataUrl, calendarEvidence: args.calendarEvidence,
    headlinesText: args.headlinesText || undefined, sentimentText: args.sentimentText || undefined,
  });

  return [{ role: "system", content: system }, { role: "user", content: user }];
}

// ---------- single-pass enforcement (keeps Breakout+Retest label) ----------
async function enforceAll(model: string, instrument: string, text: string) {
  const sys = [
    "You are fixing the plan in-place (no deletions, no renames).",
    "Goals:",
    "1) Ensure 'Quick Plan (Actionable)' is the first section.",
    "2) Ensure 'Option 1 (Primary)' and 'Option 2 (Alternative)' both exist with Direction, Order Type, explicit Trigger, Entry, SL, TP1/TP2, Conviction.",
    "3) If setup is 'Breakout + Retest' but proof is missing, KEEP the name and ADD a Proof Checklist:",
    "   - Required 1H body close beyond level",
    "   - Retest hold (15m close or wick rejection)",
    "   - Optional SFP reclaim",
    "   - Invalidation line",
    "4) If entry was Market but proof not confirmed, CONVERT to Pending with trigger sequence: close beyond → retest hold → enter at X (limit/stop).",
    "5) Keep section order strictly: Quick Plan → Option 1 → Option 2.",
    "6) Keep all other content unchanged (Full Breakdown, X-ray, Candidate Scores, Final Table, ai_meta).",
  ].join("\n");
  const usr = `Instrument: ${instrument}\n\n${text}\n\nApply ONLY the fixes above. Preserve existing numbers/levels and narrative.`;
  return callOpenAI(model, [{ role: "system", content: sys }, { role: "user", content: usr }]);
}

// ---------- Live price (race) ----------
async function fetchLivePrice(pair: string): Promise<number | null> {
  const attempts: Promise<number | null>[] = [];
  if (TD_KEY) attempts.push((async () => {
    try {
      const sym = `${pair.slice(0,3)}/${pair.slice(3)}`;
      const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&dp=5`, { cache: "no-store", signal: AbortSignal.timeout(1200) });
      const j:any = await r.json().catch(()=>({}));
      const p = Number(j?.price); return isFinite(p)&&p>0 ? p : null;
    } catch { return null; }
  })());
  if (FH_KEY) attempts.push((async () => {
    try {
      const sym = `OANDA:${pair.slice(0,3)}_${pair.slice(3)}`;
      const to = Math.floor(Date.now()/1000), from = to - 60*60*3;
      const r = await fetch(`https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(sym)}&resolution=15&from=${from}&to=${to}&token=${FH_KEY}`, { cache: "no-store", signal: AbortSignal.timeout(1200) });
      const j:any = await r.json().catch(()=>({}));
      const last = Number(j?.c?.[j.c.length-1]); return isFinite(last)&&last>0 ? last : null;
    } catch { return null; }
  })());
  if (POLY_KEY) attempts.push((async () => {
    try {
      const ticker = `C:${pair}`;
      const to = new Date(), from = new Date(to.getTime()-60*60*1000);
      const fmt = (d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      const r = await fetch(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=desc&limit=1&apiKey=${POLY_KEY}`, { cache: "no-store", signal: AbortSignal.timeout(1000) });
      const j:any = await r.json().catch(()=>({}));
      const last = Number(j?.results?.[0]?.c); return isFinite(last)&&last>0 ? last : null;
    } catch { return null; }
  })());
  if (!attempts.length) return null;
  try { const p = await Promise.any(attempts); return isFinite(Number(p)) ? Number(p) : null; } catch { return null; }
}

// ---------- Provenance footer ----------
function buildServerProvenanceFooter(args: {
  headlines_provider?: string | null;
  calendar_status: "api" | "image-ocr" | "unavailable";
  calendar_provider: string | null;
  csm_time: string | null;
  extras?: Record<string, any>;
}) {
  const lines = [
    "\n---",
    "Data Provenance (server — authoritative):",
    args.headlines_provider != null ? `• Headlines: ${args.headlines_provider || "unknown"}` : undefined,
    `• Calendar: ${args.calendar_status}${args.calendar_provider ? ` (${args.calendar_provider})` : ""}`,
    `• Sentiment CSM timestamp: ${args.csm_time || "n/a"}`,
    args.extras ? `• Meta: ${JSON.stringify(args.extras)}` : undefined,
    "---\n",
  ].filter(Boolean);
  return lines.join("\n");
}
// ---------- Headlines bias + COT-cue from headlines ----------
type HeadlineBias = {
  label: "bullish" | "bearish" | "neutral" | "unavailable";
  avg: number | null;
  count: number;
};
function computeHeadlinesBias(items: AnyHeadline[]): HeadlineBias {
  if (!Array.isArray(items) || items.length === 0) return { label: "unavailable", avg: null, count: 0 };
  const scores = items
    .map(h => typeof h?.sentiment?.score === "number" ? Number(h.sentiment!.score) : null)
    .filter((v): v is number => Number.isFinite(v));
  if (scores.length === 0) return { label: "unavailable", avg: null, count: 0 };
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const label = avg > 0.05 ? "bullish" : avg < -0.05 ? "bearish" : "neutral";
  return { label, avg, count: scores.length };
}

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

// ---------- Handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    const urlMode = String((req.query.mode as string) || "").toLowerCase();
    let mode: "full" | "fast" | "expand" = urlMode === "fast" ? "fast" : urlMode === "expand" ? "expand" : "full";

    // ----- EXPAND (reuse cache, no new OCR) -----
    if (mode === "expand") {
      const modelExpand = pickModelFromFields(req);
      const cacheKey = String(req.query.cache || "").trim();
      const c = getCache(cacheKey);
      if (!c) return res.status(400).json({ ok: false, reason: "Expand failed: cache expired or not found." });

      const dateStr = new Date().toISOString().slice(0, 10);

      // Headlines & sentiment (reuse what we have; compute CSM fresh just for timestamp)
      const headlinesText = c.headlinesText || null;

      let csm: CsmSnapshot;
      try { csm = await getCSM(); } catch (e: any) { return res.status(503).json({ ok: false, reason: `CSM unavailable: ${e?.message || "fetch failed"}.` }); }

      const headlineBias = { label: "unavailable", avg: null, count: 0 } as HeadlineBias;
      const cotCue: CotCue | null = null;
      const { text: sentimentText } = sentimentSummary(csm, headlineBias, cotCue);

      // Calendar advisory (only fetch API if no image in cache)
      const hasCalImage = !!c.calendar;
      let warningMinutes: number | null = null;
      let biasNote: string | null = null;
      let provider: string | null = null;
      let evidence: string[] = [];
      if (!hasCalImage) {
        const calAdv = await fetchCalendarForAdvisory(req, c.instrument);
        warningMinutes = calAdv.warningMinutes;
        biasNote = calAdv.biasNote;
        provider = calAdv.provider;
        evidence = calAdv.evidence || [];
      }

      const provHint = {
        headlines_present: !!headlinesText,
        calendar_status: hasCalImage ? "image-ocr" : (provider ? "api" : "unavailable"),
      };

      const messages = messagesFull({
        instrument: c.instrument, dateStr,
        m15: c.m15, h1: c.h1, h4: c.h4,
        calendarDataUrl: hasCalImage ? c.calendar! : undefined,
        calendarEvidence: hasCalImage ? undefined : evidence,
        headlinesText: headlinesText || undefined,
        sentimentText: c.sentimentText || sentimentText || undefined,
        calendarAdvisory: { warningMinutes, biasNote },
        provenance: provHint,
      });

      let text = await callOpenAI(modelExpand, messages, { temperature: 0, seed: 7 });
      // Single-pass enforcement (order + breakout proof)
      text = await enforceAll(modelExpand, c.instrument, text);

      const footer = buildServerProvenanceFooter({
        headlines_provider: "expand-uses-stage1",
        calendar_status: hasCalImage ? "image-ocr" : (provider ? "api" : "unavailable"),
        calendar_provider: hasCalImage ? "image-ocr" : provider || null,
        csm_time: csm.tsISO,
        extras: { vp_version: VP_VERSION, model: modelExpand, mode: "expand" },
      });
      text = `${text}\n${footer}`;

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ok: true, text, meta: { instrument: c.instrument, cacheKey, model: modelExpand, vp_version: VP_VERSION } });
    }

    // ----- MULTIPART required for fresh runs -----
    if (!isMultipart(req)) {
      return res.status(400).json({ ok: false, reason: "Use multipart/form-data with files: m15, h1, h4 (PNG/JPG/WEBP) and optional 'calendar'. Or pass m15Url/h1Url/h4Url (TradingView/Gyazo links). Also include 'instrument' field." });
    }

    // parse multipart
    const tParse = now();
    const { fields, files } = await parseMultipart(req);
    if (process.env.NODE_ENV !== "production") console.log(`[vision-plan] parsed in ${dt(tParse)}`);

    const MODEL = pickModelFromFields(req, fields);
    const instrument = String(fields.instrument || fields.code || "EURUSD").toUpperCase().replace(/\s+/g, "");
    const requestedMode = String(fields.mode || "").toLowerCase();
    if (requestedMode === "fast") mode = "fast";

    // files/urls
    const m15f = pickFirst(files.m15);
    const h1f = pickFirst(files.h1);
    const h4f = pickFirst(files.h4);
    const calF = pickFirst(files.calendar);

    const m15Url = String(pickFirst(fields.m15Url) || "").trim();
    const h1Url = String(pickFirst(fields.h1Url) || "").trim();
    const h4Url = String(pickFirst(fields.h4Url) || "").trim();

    // build images (calendar uses higher width for OCR legibility)
    const tImg = now();
    const [m15FromFile, h1FromFile, h4FromFile, calUrl] = await Promise.all([
      fileToDataUrl(m15f, false), fileToDataUrl(h1f, false), fileToDataUrl(h4f, false),
      calF ? fileToDataUrl(calF, true) : Promise.resolve(null),
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
      return res.status(400).json({ ok: false, reason: "Provide all three charts: m15, h1, h4 — either as files or valid TradingView/Gyazo direct image links." });
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
      } catch {}
    }
    if (!headlinesText) {
      const viaServer = await fetchedHeadlinesViaServer(req, instrument);
      headlineItems = viaServer.items;
      headlinesText = viaServer.promptText;
      headlinesProvider = viaServer.provider || "unknown";
    }
    const hBias = computeHeadlinesBias(headlineItems);
    const cotCue = detectCotCueFromHeadlines(headlineItems);

    // ----- Calendar (OCR-first) -----
    let calendarStatus: "image-ocr" | "api" | "unavailable" = "unavailable";
    let calendarProvider: string | null = null;
    let calendarEvidence: string[] = [];
    let warningMinutes: number | null = null;
    let biasNote: string | null = null;

    if (calUrl) {
      const ocr = await ocrCalendarFromImage(MODEL, calUrl).catch(() => null);
      if (ocr && Array.isArray(ocr.items)) {
        calendarStatus = "image-ocr";
        calendarProvider = "image-ocr";
        const analyzed = analyzeCalendarOCR(ocr, instrument);
        calendarEvidence = analyzed.evidenceLines;
        warningMinutes = analyzed.warningMinutes;
        biasNote = analyzed.biasNote;
      } else {
        const calAdv = await fetchCalendarForAdvisory(req, instrument);
        calendarStatus = calAdv.status;
        calendarProvider = calAdv.provider;
        calendarEvidence = calAdv.evidence || [];
        warningMinutes = calAdv.warningMinutes;
        biasNote = calAdv.biasNote;
      }
    } else {
      const calAdv = await fetchCalendarForAdvisory(req, instrument);
      calendarStatus = calAdv.status;
      calendarProvider = calAdv.provider;
      calendarEvidence = calAdv.evidence || [];
      warningMinutes = calAdv.warningMinutes;
      biasNote = calAdv.biasNote;
    }

    // ----- Sentiment + live price -----
    let csm: CsmSnapshot;
    try { csm = await getCSM(); }
    catch (e: any) { return res.status(503).json({ ok: false, reason: `CSM unavailable: ${e?.message || "fetch failed"}.` }); }

    const { text: sentimentText } = sentimentSummary(csm, hBias, cotCue);
    const livePrice = await fetchLivePrice(instrument);
    const dateStr = new Date().toISOString().slice(0, 10);

    // ----- Build messages (FAST/FULL share the same rubric) -----
    const provForModel = { headlines_present: !!headlinesText, calendar_status: calendarStatus };

    let text = ""; let aiMeta: any = null;

    if (mode === "fast") {
      const messages = messagesFastStage1({
        instrument, dateStr, m15, h1, h4,
        calendarDataUrl: calUrl || undefined,
        calendarEvidence: calendarEvidence,
        headlinesText: headlinesText || undefined,
        sentimentText: sentimentText,
        calendarAdvisory: { warningMinutes, biasNote },
        provenance: provForModel,
      });
      if (livePrice) { (messages[0] as any).content = (messages[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice};`; }
      text = await callOpenAI(MODEL, messages, { temperature: 0, seed: 7 });
    } else {
      const messages = messagesFull({
        instrument, dateStr, m15, h1, h4,
        calendarDataUrl: calUrl || undefined,
        calendarEvidence: calendarEvidence,
        headlinesText: headlinesText || undefined,
        sentimentText,
        calendarAdvisory: { warningMinutes, biasNote },
        provenance: provForModel,
      });
      if (livePrice) { (messages[0] as any).content = (messages[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice};`; }
      text = await callOpenAI(MODEL, messages, { temperature: 0, seed: 7 });
    }

    // Single-pass enforcement (order + Breakout proof + Market→Pending if missing proof)
    text = await enforceAll(MODEL, instrument, text);
    aiMeta = extractAiMeta(text) || {};
    if (livePrice && (aiMeta.currentPrice == null || !isFinite(Number(aiMeta.currentPrice)))) aiMeta.currentPrice = livePrice;

    // Sanity: LIMIT relative to price (minimal check)
    {
      const bad = invalidOrderRelativeToPrice(aiMeta);
      if (bad && process.env.NODE_ENV !== "production") console.log(`[vision-plan] limit sanity flag=${bad}`);
    }

    // Cache for expand
    const cacheKey = setCache({ instrument, m15, h1, h4, calendar: calUrl || null, headlinesText: headlinesText || null, sentimentText });

    // Footer
    const footer = buildServerProvenanceFooter({
      headlines_provider: headlinesProvider || "unknown",
      calendar_status: calendarStatus,
      calendar_provider: calendarProvider,
      csm_time: csm.tsISO,
      extras: { vp_version: VP_VERSION, model: MODEL, mode },
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
          calendar_used: calendarStatus === "api" || calendarStatus === "image-ocr",
          calendar_status: calendarStatus,
          calendar_provider: calendarProvider,
          csm_used: true,
          csm_time: csm.tsISO,
          cot_used: !!cotCue,
          cot_report_date: null as string | null,
          cot_error: cotCue ? null : "no cot cues",
          cot_method: cotCue ? "headline_fallback" : null,
          calendar_warning_minutes: warningMinutes ?? null,
          calendar_bias_note: biasNote || null,
          calendar_evidence: calendarEvidence || [],
          headlines_bias_label: hBias.label,
          headlines_bias_score: hBias.avg,
          cot_bias_summary: cotCue ? cotCue.summary : null,
        },
        aiMeta,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}
