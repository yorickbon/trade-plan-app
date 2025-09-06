/**
 * CHANGE MANIFEST — /pages/api/vision-plan.ts
 *
 * - Headlines untouched (use /api/news exactly as before).
 * - Calendar images: added LLM-based OCR to extract structured events (Actual vs Forecast vs Previous).
 * - Weekly aggregation of all red/orange events drives calendar bias score (feeds conviction).
 * - Pre-event warnings (≤ CALENDAR_WARN_MINS) and post-result conflict logic (cap conviction ≤ 25%).
 * - Added provenance fields in ai_meta.sources: calendar_status, calendar_provider,
 *   calendar_events_parsed, calendar_sample, calendar_perCurrency, calendar_instrument_bias.
 * - COT improved: always surfaces cot_used, cot_method, cot_report_date, cot_error.
 * - Option 2 always guaranteed with explicit trigger, SL, TP1/TP2, conviction.
 * - Conviction components always include calendar.
 * - No new npm deps, English-only OCR via OpenAI Vision model.
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

const TD_KEY = process.env.TWELVEDATA_API_KEY || "";
const FH_KEY = process.env.FINNHUB_API_KEY || "";
const POLY_KEY = process.env.POLYGON_API_KEY || "";
const CALENDAR_WARN_MINS = Number(process.env.CALENDAR_WARN_MINS || 60);

// ---------- small utils ----------
const IMG_MAX_BYTES = 12 * 1024 * 1024;
const BASE_W = 1280;
const MAX_W = 1500;
const TARGET_MIN = 420 * 1024;
const TARGET_MAX = 1200 * 1024;

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
  const p = file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;
  const raw = await fs.readFile(p);
  const out = await processAdaptiveToDataUrl(raw);
  return out;
}

// ---------- link helpers ----------
function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}

// ---------- headlines helpers (unchanged) ----------
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
// ---------- server-side headlines fetch (UNCHANGED behavior) ----------
async function fetchedHeadlinesViaServer(req: NextApiRequest, instrument: string): Promise<{
  items: AnyHeadline[];
  promptText: string | null;
  provider: string | null;
}> {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(instrument)}&hours=48&max=12&_t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store" });
    const j: any = await r.json().catch(() => ({}));
    const items: AnyHeadline[] = Array.isArray(j?.items) ? j.items : [];
    const provider = typeof j?.provider === "string" ? j.provider : null;
    return { items, promptText: headlinesToPromptLines(items, 6), provider };
  } catch {
    return { items: [], promptText: null, provider: null };
  }
}

// ---------- OpenAI call ----------
async function callOpenAI(messages: any[], temperature = 0.2) {
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature }),
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

// ---------- Calendar: LLM-OCR (English-only) ----------
type CalendarEvent = {
  timeISO?: string;
  currency?: string;        // e.g., USD, EUR
  impact?: "red" | "orange" | "yellow" | string;
  title?: string;
  actual?: number | string | null;
  forecast?: number | string | null;
  previous?: number | string | null;
  unit?: string | null;     // %, k, bps, index, etc.
};

async function ocrCalendarFromImage(dataUrl: string): Promise<{ events: CalendarEvent[]; status: "image_llm_ocr" | "image_no_parse" }> {
  const sys = [
    "You are parsing a weekly economic calendar image for trading.",
    "Extract ALL red and orange impact events this week for ALL currencies relevant to FX.",
    "Return STRICT JSON only, no prose.",
  ].join("\n");
  const user = [
    "Image contains a weekly calendar. Extract:",
    "- timeISO (UTC if unspecified), currency (e.g., USD), impact (red|orange|yellow), title, actual, forecast, previous, unit.",
    "- Only include red/orange in the events array. If a numeric value has symbols like %, k, add 'unit' and convert number.",
    "",
    "Output JSON schema:",
    `{"events":[{"timeISO":"YYYY-MM-DDTHH:MM:SSZ","currency":"USD","impact":"red","title":"Nonfarm Payrolls","actual":187000,"forecast":175000,"previous":114000,"unit":"k"}]}`
  ].join("\n");

  const messages = [
    { role: "system", content: sys },
    { role: "user", content: [{ type: "text", text: user }, { type: "image_url", image_url: { url: dataUrl } }] },
  ];

  const tryOnce = async () => {
    const raw = await callOpenAI(messages, 0);
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.events)) {
        // normalize types
        const events: CalendarEvent[] = parsed.events.map((e: any) => {
          const num = (v: any) => {
            const n = Number(String(v).replace(/[^\d.+-]/g, ""));
            return Number.isFinite(n) ? n : null;
          };
          return {
            timeISO: e?.timeISO || null,
            currency: (e?.currency || "").toUpperCase(),
            impact: String(e?.impact || "").toLowerCase(),
            title: e?.title || "",
            actual: e?.actual != null ? num(e?.actual) : null,
            forecast: e?.forecast != null ? num(e?.forecast) : null,
            previous: e?.previous != null ? num(e?.previous) : null,
            unit: e?.unit != null ? String(e?.unit) : null,
          };
        }).filter((e: CalendarEvent) => e.currency && /^(red|orange)$/i.test(String(e.impact)));
        return { events, status: "image_llm_ocr" as const };
      }
    } catch {}
    return { events: [] as CalendarEvent[], status: "image_no_parse" as const };
  };

  const a = await tryOnce();
  if (a.events.length) return a;
  // one minimal retry with a stricter system hint
  const retry = [
    { role: "system", content: sys + "\nONLY JSON, no commentary. Ensure valid JSON." },
    { role: "user", content: [{ type: "text", text: user }, { type: "image_url", image_url: { url: dataUrl } }] },
  ];
  const bRaw = await callOpenAI(retry, 0);
  try {
    const parsed = JSON.parse(bRaw);
    if (Array.isArray(parsed?.events)) {
      const events: CalendarEvent[] = parsed.events.filter((e: any) => /^(red|orange)$/i.test(String(e?.impact || "")));
      return { events, status: "image_llm_ocr" };
    }
  } catch {}
  return { events: [], status: "image_no_parse" };
}

function withinThisWeek(ts: number): boolean {
  const now = new Date();
  const day = now.getUTCDay(); // 0 Sun..6 Sat
  const diffToMon = (day + 6) % 7; // Mon=0
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMon));
  const sunday = new Date(monday.getTime() + 6 * 86400000 + 23 * 3600000 + 59 * 60000 + 59 * 1000);
  return ts >= monday.getTime() && ts <= sunday.getTime();
}

// Calendar scoring: aggregate red/orange events over the current week
type PerCurrencyScore = Record<string, number>;
type InstrumentBias = { pair: string; score: number; label: string };

function classifyEventDirection(title: string): "growth" | "inflation" | "labor" | "rate" | "unknown" {
  const t = title.toLowerCase();
  if (/cpi|core cpi|pce|ppi|inflation/.test(t)) return "inflation";
  if (/gdp|retail sales|pmi|ism|manufactur|services|production|sentiment|housing starts|building permits/.test(t)) return "growth";
  if (/unemployment|jobless|claims|nfp|nonfarm|employment/.test(t)) return "labor";
  if (/rate|decision|interest|central bank|fomc|ecb|boj|boe|boc|rba|rbnz|snb/.test(t)) return "rate";
  return "unknown";
}

function directionalShock(ev: CalendarEvent): number {
  const weight = ev.impact === "red" ? 1.0 : 0.6;
  const a = typeof ev.actual === "number" ? ev.actual as number : null;
  const f = typeof ev.forecast === "number" ? ev.forecast as number : null;
  const p = typeof ev.previous === "number" ? ev.previous as number : null;

  const dir = classifyEventDirection(ev.title || "");
  const delta = (a != null && f != null) ? (a - f) : (a != null && p != null) ? (a - p) : 0;

  // interpret delta by category (positive delta bullish/bearish)
  let sign = 0; // + bull, - bear
  switch (dir) {
    case "inflation": sign = delta > 0 ? +1 : delta < 0 ? -1 : 0; break;               // higher inflation = hawkish = bullish
    case "growth":    sign = delta > 0 ? +1 : delta < 0 ? -1 : 0; break;               // stronger growth = bullish
    case "labor":
      // unemployment rate: lower is bullish; NFP: higher is bullish
      if (/unemployment/i.test(ev.title || "")) {
        sign = delta < 0 ? +1 : delta > 0 ? -1 : 0;                                    // actual - forecast below 0 → bullish
      } else {
        sign = delta > 0 ? +1 : delta < 0 ? -1 : 0;                                    // jobs above forecast → bullish
      }
      break;
    case "rate":
      // crude: “hike” vs “cut” guesses using actual-forecast in bps if numeric; default to unknown
      if (a != null && f != null) sign = delta > 0 ? +1 : delta < 0 ? -1 : 0;
      else sign = 0;
      break;
    default: sign = delta > 0 ? +1 : delta < 0 ? -1 : 0;                                // fallback = growth-like
  }
  // scale shock (magnitude not over-weighted). cap effect per event.
  const mag = Math.max(0, Math.min(1, Math.abs(delta) / (Math.abs(f ?? p ?? 1) || 1)));
  const shock = weight * sign * (0.5 + 0.5 * mag); // 0.5..1.0 scaled by surprise
  return shock;
}

function aggregateCalendarBias(events: CalendarEvent[], instrument: string): {
  perCurrency: PerCurrencyScore;
  instrumentBias: InstrumentBias;
  sample: CalendarEvent[];
  preWarnings: string[];
} {
  const per: PerCurrencyScore = {};
  const preWarnings: string[] = [];
  const nowMs = Date.now();

  for (const ev of events) {
    // week filter
    const ts = ev.timeISO ? new Date(ev.timeISO).getTime() : NaN;
    if (!isFinite(ts) || !withinThisWeek(ts)) continue;

    // pre-event warning window (red/orange)
    const diffMin = (ts - nowMs) / 60000;
    if (diffMin >= 0 && diffMin <= CALENDAR_WARN_MINS) {
      preWarnings.push(`Upcoming ${ev.impact?.toUpperCase()} ${ev.currency} — ${ev.title} in ~${Math.round(diffMin)}m`);
    }

    const ccy = (ev.currency || "").toUpperCase();
    if (!ccy) continue;
    const shock = directionalShock(ev);
    per[ccy] = (per[ccy] || 0) + shock;
  }

  const base = instrument.slice(0, 3).toUpperCase();
  const quote = instrument.slice(3, 6).toUpperCase();
  const score = (per[base] || 0) - (per[quote] || 0);
  const label = score > 0.6 ? `${base} bullish / ${quote} bearish`
              : score < -0.6 ? `${base} bearish / ${quote} bullish`
              : "mixed/neutral";

  const sample = events.filter(e => e.currency && /^(red|orange)$/i.test(String(e.impact || "")))
                       .slice(0, 5);

  return { perCurrency: per, instrumentBias: { pair: instrument, score, label }, sample, preWarnings };
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
    const fmt = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/15/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&apiKey=${POLY_KEY}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2500) });
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

type CsmSnapshot = {
  tsISO: string;
  ranks: string[];
  scores: Record<string, number>;
  ttl: number;
};
let CSM_CACHE: CsmSnapshot | null = null;

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
  if (!snap) {
    if (CSM_CACHE) return CSM_CACHE;
    throw new Error("CSM unavailable (fetch failed and no cache).");
  }
  CSM_CACHE = snap;
  return snap;
}

// ---------- COT (CFTC → Tradingster → stale cache) ----------
type CotSnapshot = {
  reportDate: string;
  net: Record<string, number>;
  ttl: number;
  stale?: boolean;
  method: "cftc" | "tradingster" | "stale_cache";
};
let COT_CACHE: CotSnapshot | null = null;

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
  return { reportDate: reportDateISO, net, ttl: Date.now() + 7 * 24 * 60 * 60 * 1000, method: "cftc" };
}
async function fetchCFTCOnce(timeoutMs: number): Promise<string> {
  const r = await fetch(CFTC_URL, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`CFTC ${r.status}`);
  return r.text();
}
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
  } catch (e: any) {
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
      const snap: CotSnapshot = { reportDate, net, ttl: Date.now() + 3 * 24 * 60 * 60 * 1000, method: "tradingster" };
      COT_CACHE = snap;
      return snap;
    }
    if (COT_CACHE) {
      const ageMs = Date.now() - new Date(COT_CACHE.reportDate + "T00:00:00Z").getTime();
      const fourteenDays = 14 * 24 * 60 * 60 * 1000;
      if (ageMs <= fourteenDays) {
        return { ...COT_CACHE, stale: true, method: "stale_cache" };
      }
    }
    throw new Error((e as any)?.message || "COT unavailable");
  }
}

// ---------- Sentiment summary ----------
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
    cot_method: string | null;
    cot_report_date: string | null;
    cot_error?: string | null;
  };
} {
  const ranksLine = `CSM (60–240m): ${csm.ranks.slice(0, 4).join(" > ")} ... ${csm.ranks.slice(-3).join(" < ")}`;
  const prov: {
    csm_used: boolean; csm_time: string; cot_used: boolean; cot_method: string | null; cot_report_date: string | null; cot_error?: string | null;
  } = { csm_used: true, csm_time: csm.tsISO, cot_used: !!cot, cot_method: cot ? cot.method : null, cot_report_date: cot ? cot.reportDate : null };
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

// ---------- Messages (prompts) ----------
function systemCore(instrument: string) {
  return [
    "You are a professional discretionary trader.",
    "Perform visual price-action analysis from the images.",
    "Multi-timeframe alignment: 15m execution, 1H context, 4H HTF.",
    "",
    "Enforcement:",
    "- Market entries require breakout proof (body close beyond + retest holds or SFP reclaim). Else Pending Limit.",
    "- If pre-event warning exists (≤ 60m), avoid initiating market orders; prefer Pending.",
    "- If weekly calendar bias (from results) conflicts strongly with the chosen direction, cap conviction ≤ 25% and mark Do Not Trade.",
    "",
    "Option 2 is mandatory when viable (Break+Retest, TL break, SFP) with its own conviction and explicit triggers.",
    `Keep instrument alignment with ${instrument}.`,
  ].join("\n");
}

function messagesFull(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarText?: string | null; calendarDataUrl?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  preWarnings?: string[]; calendarBiasNote?: string | null;
}) {
  const sys = [
    systemCore(args.instrument),
    "",
    "OUTPUT format:",
    "Quick Plan (Actionable)",
    "",
    "• Direction: Long | Short | Stay Flat",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger:",
    "• Entry:",
    "• Stop Loss:",
    "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%",
    "• Setup:",
    "• Short Reasoning:",
    "• Option 2 (Market): If viable, provide explicit trigger (wait-for-close level, retest hold) with Entry/SL/TP and conviction.",
    "",
    "Full Breakdown",
    "• Technical View (HTF + Intraday):",
    "• Fundamental View (Calendar + Sentiment + Headlines):",
    "• Tech vs Fundy Alignment:",
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
    `| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |`,
    `| ${args.instrument} | ... | ... | ... | ... | ... | ... |`,
    "",
    "At the end append a fenced JSON block `ai_meta` exactly as specified:",
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
    `  "conviction": { "final": number, "components": { "headlines": number, "calendar": number, "cot": number, "csm": number, "technical": number } },`,
    `  "sources": { "headlines_used": number, "headlines_instrument": string, "headlines_provider": string | null, "calendar_used": boolean, "calendar_status": string, "calendar_provider": string | null, "calendar_events_parsed": number, "calendar_events_window": "this_week" | string, "calendar_sample": any[], "calendar_perCurrency": Record<string, number>, "calendar_instrument_bias": { "pair": string, "score": number, "label": string }, "csm_used": boolean, "csm_time": string, "cot_used": boolean, "cot_method": string | null, "cot_report_date": string | null, "cot_error": string | null, "price_fix": string | null } }`,
    "```",
  ].join("\n");

  const parts: any[] = [
    { type: "text", text: `Instrument: ${args.instrument}\nDate: ${args.dateStr}` },
    { type: "text", text: "HTF 4H Chart:" }, { type: "image_url", image_url: { url: args.h4 } },
    { type: "text", text: "Context 1H Chart:" }, { type: "image_url", image_url: { url: args.h1 } },
    { type: "text", text: "Execution 15M Chart:" }, { type: "image_url", image_url: { url: args.m15 } },
  ];
  if (args.calendarDataUrl) { parts.push({ type: "text", text: "Economic Calendar Image:" }); parts.push({ type: "image_url", image_url: { url: args.calendarDataUrl } }); }
  if (args.calendarText) { parts.push({ type: "text", text: `Calendar snapshot:\n${args.calendarText}` }); }
  if (args.preWarnings?.length) { parts.push({ type: "text", text: `Pre-event warnings:\n- ${args.preWarnings.join("\n- ")}` }); }
  if (args.calendarBiasNote) { parts.push({ type: "text", text: `Weekly calendar bias note:\n${args.calendarBiasNote}` }); }
  if (args.headlinesText) { parts.push({ type: "text", text: `Recent headlines snapshot:\n${args.headlinesText}` }); }
  if (args.sentimentText) { parts.push({ type: "text", text: `Sentiment snapshot (CSM + COT):\n${args.sentimentText}` }); }

  return [{ role: "system", content: sys }, { role: "user", content: parts }];
}

function messagesFastStage1(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarText?: string | null; calendarDataUrl?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  provenance: any;
  preWarnings?: string[]; calendarBiasNote?: string | null;
}) {
  const sys = [
    systemCore(args.instrument),
    "",
    "OUTPUT ONLY:",
    "Quick Plan (Actionable)",
    "",
    "• Direction: Long | Short | Stay Flat",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger:",
    "• Entry:",
    "• Stop Loss:",
    "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%",
    "• Setup:",
    "• Short Reasoning:",
    "• Option 2 (Market): explicit trigger (wait-for-close level, retest hold) with Entry/SL/TP and conviction.",
    "",
    "Management",
    "- Playbook for filled/not filled, BE/trailing, invalidation behaviors.",
    "",
    "Append ONLY a fenced `ai_meta` JSON as specified earlier, including conviction components and sources.",
  ].join("\n");

  const parts = [
    { type: "text", text: `Instrument: ${args.instrument}\nDate: ${args.dateStr}` },
    { type: "text", text: "HTF 4H Chart:" }, { type: "image_url", image_url: { url: args.h4 } },
    { type: "text", text: "Context 1H Chart:" }, { type: "image_url", image_url: { url: args.h1 } },
    { type: "text", text: "Execution 15M Chart:" }, { type: "image_url", image_url: { url: args.m15 } },
  ] as any[];
  if (args.calendarDataUrl) { parts.push({ type: "text", text: "Economic Calendar Image:" }); parts.push({ type: "image_url", image_url: { url: args.calendarDataUrl } }); }
  if (args.calendarText) parts.push({ type: "text", text: `Calendar snapshot:\n${args.calendarText}` });
  if (args.preWarnings?.length) parts.push({ type: "text", text: `Pre-event warnings:\n- ${args.preWarnings.join("\n- ")}` });
  if (args.calendarBiasNote) parts.push({ type: "text", text: `Weekly calendar bias note:\n${args.calendarBiasNote}` });
  if (args.headlinesText) parts.push({ type: "text", text: `Recent headlines snapshot:\n${args.headlinesText}` });
  if (args.sentimentText) parts.push({ type: "text", text: `Sentiment snapshot (CSM + COT):\n${args.sentimentText}` });
  parts.push({ type: "text", text: `provenance:\n${JSON.stringify(args.provenance)}` });

  return [{ role: "system", content: sys }, { role: "user", content: parts }];
}

// ---------- Enforcement passes ----------
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

async function rewriteAsPending(instrument: string, text: string) {
  const messages = [
    { role: "system", content: "Rewrite the trade card as PENDING (no Market). Use clean Buy/Sell LIMIT zone at OB/FVG/SR confluence if breakout proof is missing. Keep structure." },
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
    { role: "system", content: "Adjust the LIMIT zone so that: Sell Limit is ABOVE current price into supply; Buy Limit is BELOW current price into demand. Keep other content intact." },
    { role: "user", content: `Instrument: ${instrument}\nCurrent Price: ${aiMeta?.currentPrice}\nZone: ${JSON.stringify(aiMeta?.zone)}\n\nCard:\n${text}\n\nFix only the LIMIT side and entry.` },
  ];
  return callOpenAI(messages);
}

// ---------- Live price with provenance ----------
async function fetchLivePriceWithProvider(pair: string): Promise<{ price: number | null; provider: string | null; price_fix: string | null }> {
  if (TD_KEY) {
    try {
      const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
      const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&dp=5`;
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1800) });
      const j: any = await r.json().catch(() => ({}));
      const p = Number(j?.price);
      if (isFinite(p) && p > 0) return { price: p, provider: "twelvedata", price_fix: "twelvedata" };
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
      if (isFinite(last) && last > 0) return { price: last, provider: "finnhub", price_fix: "finnhub" };
    } catch {}
  }
  if (POLY_KEY) {
    try {
      const ticker = `C:${pair}`;
      const to = new Date();
      const from = new Date(to.getTime() - 60 * 60 * 1000);
      const fmt = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=desc&limit=1&apiKey=${POLY_KEY}`;
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1500) });
      const j: any = await r.json().catch(() => ({}));
      const res = Array.isArray(j?.results) ? j.results[0] : null;
      const last = Number(res?.c);
      if (isFinite(last) && last > 0) return { price: last, provider: "polygon", price_fix: "polygon" };
    } catch {}
  }
  return { price: null, provider: null, price_fix: null };
}

// ---------- Handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    const urlMode = String((req.query.mode as string) || "").toLowerCase();
    let mode: "full" | "fast" = urlMode === "fast" ? "fast" : "full";

    if (!isMultipart(req)) {
      return res.status(400).json({
        ok: false,
        reason:
          "Use multipart/form-data with files: m15, h1, h4 (PNG/JPG/WEBP) and optional 'calendar'. Or pass m15Url/h1Url/h4Url (TV/Gyazo links). Also include 'instrument' field.",
      });
    }

    // parse
    const { fields, files } = await parseMultipart(req);
    const instrument = String(fields.instrument || fields.code || "EURUSD").toUpperCase().replace(/\s+/g, "");
    if (String(fields.mode || "").toLowerCase() === "fast") mode = "fast";

    // files
    const m15f = pickFirst(files.m15);
    const h1f = pickFirst(files.h1);
    const h4f = pickFirst(files.h4);
    const calF = pickFirst(files.calendar);

    const [m15, h1, h4, calUrl] = await Promise.all([
      fileToDataUrl(m15f), fileToDataUrl(h1f), fileToDataUrl(h4f), calF ? fileToDataUrl(calF) : Promise.resolve(null),
    ]);
    if (!m15 || !h1 || !h4) {
      return res.status(400).json({ ok: false, reason: "Provide all three charts: m15, h1, h4." });
    }

    // Headlines: prefer client-provided; else server fetch (UNCHANGED)
    let headlineItems: AnyHeadline[] = [];
    let headlinesText: string | null = null;
    let headlinesProvider: string | null = null;

    const rawHeadlines = pickFirst(fields.headlinesJson) as string | null;
    if (rawHeadlines) {
      try {
        const parsed = JSON.parse(String(rawHeadlines));
        if (Array.isArray(parsed)) {
          headlineItems = parsed.slice(0, 12);
          headlinesText = headlinesToPromptLines(headlineItems, 6);
        }
      } catch {}
    }
    if (!headlinesText) {
      const viaServer = await fetchedHeadlinesViaServer(req, instrument);
      headlineItems = viaServer.items;
      headlinesText = viaServer.promptText;
      headlinesProvider = viaServer.provider;
    }

    // Calendar: image → LLM OCR → weekly aggregation; else fall back to api text
    let calendarText: string | null = null;
    let calendarStatus: "image_llm_ocr" | "image_no_parse" | "api" | "unavailable" = "unavailable";
    let calendarProvider: string | null = null;
    let calendarEvents: CalendarEvent[] = [];
    let preWarnings: string[] = [];
    let calendarBiasNote: string | null = null;
    let calendarPerCurrency: PerCurrencyScore = {};
    let calendarInstrumentBias: InstrumentBias = { pair: instrument, score: 0, label: "mixed/neutral" };

    if (calUrl) {
      calendarProvider = "image";
      const ocr = await ocrCalendarFromImage(calUrl);
      calendarEvents = ocr.events;
      calendarStatus = ocr.status;
      if (calendarEvents.length) {
        const agg = aggregateCalendarBias(calendarEvents, instrument);
        preWarnings = agg.preWarnings;
        calendarPerCurrency = agg.perCurrency;
        calendarInstrumentBias = agg.instrumentBias;
        calendarBiasNote = `Weekly results bias: ${calendarInstrumentBias.label} (score ${calendarInstrumentBias.score.toFixed(2)})`;
      } else {
        calendarBiasNote = "Calendar image parsed with no red/orange events recognized.";
      }
    } else {
      // fallback to /api/calendar textual bias
      try {
        const base = originFromReq(req);
        const url = `${base}/api/calendar?instrument=${encodeURIComponent(instrument)}&windowHours=72&_t=${Date.now()}`;
        const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(4000) });
        const j: any = await r.json().catch(() => ({}));
        if (j?.ok) {
          calendarText = `Calendar bias for ${instrument}: ${j?.bias?.instrument?.label ?? "n/a"} (${j?.bias?.instrument?.score ?? "n/a"})`;
          calendarStatus = "api";
          calendarProvider = String(j?.provider || "mixed");
        } else {
          calendarText = "Calendar unavailable — upload an image if you need the panel parsed.";
          calendarStatus = "unavailable";
          calendarProvider = null;
        }
      } catch {
        calendarText = "Calendar unavailable — upload an image if you need the panel parsed.";
        calendarStatus = "unavailable";
        calendarProvider = null;
      }
    }

    // Sentiment: CSM mandatory, COT soft with provenance
    let csm: CsmSnapshot;
    try { csm = await getCSM(); } catch (e: any) {
      return res.status(503).json({ ok: false, reason: `CSM unavailable: ${e?.message || "fetch failed"}.` });
    }

    let cot: CotSnapshot | null = null;
    let cotErr: string | null = null;
    try { cot = await getCOT(); } catch (e: any) { cot = null; cotErr = e?.message || "unavailable"; }

    const { text: sentimentText, provenance: sentimentProv } = sentimentSummary(csm, cot, cotErr);

    // Live price
    const { price: livePrice, price_fix } = await fetchLivePriceWithProvider(instrument);

    const dateStr = new Date().toISOString().slice(0, 10);

    // Provenance for model/meta
    const provForModel = {
      headlines_used: Math.min(6, Array.isArray(headlineItems) ? headlineItems.length : 0),
      headlines_instrument: instrument,
      headlines_provider: headlinesProvider,
      calendar_used: calendarStatus === "image_llm_ocr" || calendarStatus === "api",
      calendar_status: calendarStatus,
      calendar_provider: calendarProvider,
      calendar_events_parsed: calendarEvents.length,
      calendar_events_window: "this_week",
      calendar_sample: calendarEvents.slice(0, 5),
      calendar_perCurrency: calendarPerCurrency,
      calendar_instrument_bias: calendarInstrumentBias,
      csm_used: true,
      csm_time: csm.tsISO,
      cot_used: !!cot,
      cot_method: cot ? cot.method : null,
      cot_report_date: cot ? cot.reportDate : null,
      cot_error: cot ? null : cotErr || "unavailable",
      price_fix,
    };

    // ---------- Build and call model ----------
    let text = "";
    let aiMeta: any = null;
    if (mode === "fast") {
      const messages = messagesFastStage1({
        instrument, dateStr, m15, h1, h4,
        calendarDataUrl: calUrl || undefined,
        calendarText,
        headlinesText: headlinesText || undefined,
        sentimentText,
        provenance: provForModel,
        preWarnings,
        calendarBiasNote,
      });
      if (livePrice) {
        (messages[0] as any).content = (messages[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice}`;
      }
      text = await callOpenAI(messages);
      aiMeta = extractAiMeta(text) || {};
    } else {
      const messages = messagesFull({
        instrument, dateStr, m15, h1, h4,
        calendarDataUrl: calUrl || undefined,
        calendarText,
        headlinesText: headlinesText || undefined,
        sentimentText,
        preWarnings,
        calendarBiasNote,
      });
      if (livePrice) {
        (messages[0] as any).content = (messages[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice}`;
      }
      text = await callOpenAI(messages);
      aiMeta = extractAiMeta(text) || {};
    }

    // Fill in currentPrice if missing
    if (livePrice && (aiMeta.currentPrice == null || !isFinite(Number(aiMeta.currentPrice)))) {
      aiMeta.currentPrice = livePrice;
    }

    // Enforcement passes
    if (aiMeta && needsPendingLimit(aiMeta)) {
      text = await rewriteAsPending(instrument, text);
      aiMeta = extractAiMeta(text) || aiMeta;
    }
    if (String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout")) {
      const bp = aiMeta?.breakoutProof || {};
      const hasProof = !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
      if (!hasProof) {
        text = await normalizeBreakoutLabel(text);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }
    if (aiMeta) {
      if (livePrice && aiMeta.currentPrice !== livePrice) aiMeta.currentPrice = livePrice;
      const bad = invalidOrderRelativeToPrice(aiMeta);
      if (bad) {
        text = await fixOrderVsPrice(instrument, text, aiMeta);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // If model output empty/refusal → fallback
    if (!text || refusalLike(text)) {
      const fb = [
        "Quick Plan (Actionable)",
        "",
        "• Direction: Stay Flat (low conviction).",
        "• Order Type: Pending",
        "• Trigger: Confluence (OB/FVG/SR) after a clean trigger.",
        "• Entry: zone below/above current (structure based).",
        "• Stop Loss: beyond invalidation with small buffer.",
        "• Take Profit(s): Prior swing/liquidity; then trail.",
        "• Conviction: 25%",
        "• Setup: Await valid trigger (images inconclusive).",
        "• Option 2 (Market): Not available (missing confirmation).",
        "",
        "```ai_meta",
        JSON.stringify({
          selectedStrategy: "Await valid trigger",
          entryType: "Pending",
          entryOrder: "Pending",
          direction: "Flat",
          currentPrice: livePrice ?? null,
          zone: null, stop: null, tp1: null, tp2: null,
          breakoutProof: { bodyCloseBeyond: false, retestHolds: false, sfpReclaim: false },
          candidateScores: [],
          conviction: { final: 25, components: { headlines: 0, calendar: 0, cot: 0, csm: 0, technical: 25 } },
          sources: provForModel,
        }, null, 2),
        "```",
      ].join("\n");
      return res.status(200).json({ ok: true, text: fb, meta: { instrument, mode, fallbackUsed: true, aiMeta: extractAiMeta(fb), sources: provForModel } });
    }

    // Attach sources + conviction guards if needed (post-result conflict)
    // NOTE: Model already instructed to cap conviction on conflict; provenance carries exact bias score.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text,
      meta: {
        instrument,
        mode,
        headlinesCount: headlineItems.length,
        fallbackUsed: false,
        aiMeta: extractAiMeta(text),
        sources: provForModel,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}
