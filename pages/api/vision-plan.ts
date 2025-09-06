/** (file header unchanged from your current baseline, trimmed here for brevity)
 * CHANGE MANIFEST — /pages/api/vision-plan.ts
 * … previous manifest content …
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

/* ---------------- NEW: shared provenance type ---------------- */
type ProvenanceSources = {
  headlines_used: number;
  headlines_instrument: string;
  calendar_used: boolean;
  calendar_status: "image" | "api" | "unavailable";
  calendar_provider: string | null;
  calendar_warning_minutes: number | null;
  calendar_bias_note: string | null;
  calendar_evidence: string[] | null;
  csm_used: boolean;
  csm_time: string;
  cot_used: boolean;
  cot_report_date: null;
  cot_error: string | null;
  cot_method: "headline" | null;
};
/* ------------------------------------------------------------- */

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
    return await downloadAndProcess(link);
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
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    const items: AnyHeadline[] = Array.isArray(j?.items) ? j.items : [];
    return { items, promptText: headlinesToPromptLines(items, 6) };
  } catch {
    return { items: [], promptText: null };
  }
}

// --- COT headlines-only cue (soft signal) ---
const CUR_CODES = ["USD","EUR","JPY","GBP","CHF","CAD","AUD","NZD"];
function extractCotCuesFromHeadlines(items: AnyHeadline[]): { text: string | null, used: boolean, per: Record<string, "net long"|"net short"> } {
  const per: Record<string, "net long"|"net short"> = {};
  const cues = (items || []).map(h => String(h?.title || "")).filter(Boolean);
  const reCot = /(commitments? of traders|cot\b|imm positioning|leveraged funds|speculators)/i;
  const reLong = /\b(net\s+)?long(s)?\b/i;
  const reShort = /\b(net\s+)?short(s)?\b/i;

  for (const t of cues) {
    if (!reCot.test(t)) continue;
    for (const cur of CUR_CODES) {
      const reCur = new RegExp(`\\b${cur}\\b`, "i");
      if (!reCur.test(t)) continue;
      if (reLong.test(t) && !per[cur]) per[cur] = "net long";
      if (reShort.test(t) && !per[cur]) per[cur] = "net short";
    }
  }

  const keys = Object.keys(per);
  if (!keys.length) return { text: null, used: false, per };
  const parts = keys.slice(0, 6).map(k => `${k}: ${per[k]}`);
  return { text: `COT (headline): ${parts.join("; ")}`, used: true, per };
}

// ---------- refusal & ai_meta helpers ----------
function refusalLike(s: string) { const t = (s || "").toLowerCase(); return !!t && /\b(can'?t|cannot)\s+assist\b|\bnot able to comply\b|\brefuse/i.test(t); }
function extractAiMeta(text: string) {
  if (!text) return null;
  const fences = [/```ai_meta\s*({[\s\S]*?})\s*```/i, /```json\s*({[\s\S]*?})\s*```/i];
  for (const re of fences) {
    const m = text.match(re);
    if (m && m[1]) { try { return JSON.parse(m[1]); } catch {} }
  }
  return null;
}
function needsPendingLimit(aiMeta: any): boolean {
  const et = String(aiMeta?.entryType || "").toLowerCase();
  if (et !== "market") return false;
  const bp = aiMeta?.breakoutProof || {};
  return !(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
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
  const a = closes[closes.length - 1], b = closes[closes.length - 1 - k];
  if (!(a > 0) || !(b > 0)) return null;
  return Math.log(a / b);
}
async function tdSeries15(pair: string): Promise<Series | null> { /* unchanged */ try {
  if (!TD_KEY) return null;
  const sym = `${pair.slice(0,3)}/${pair.slice(3)}`;
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=15min&outputsize=30&apikey=${TD_KEY}&dp=6`;
  const r = await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(2500)});
  if(!r.ok) return null; const j:any=await r.json(); if(!Array.isArray(j?.values)) return null;
  const vals=[...j.values].reverse(); const t=vals.map((v:any)=>new Date(v.datetime).getTime()/1000); const c=vals.map((v:any)=>Number(v.close));
  if(!c.every((x:number)=>isFinite(x))) return null; return {t,c}; } catch { return null; } }
async function fhSeries15(pair: string): Promise<Series | null> { /* unchanged */ try {
  if(!FH_KEY) return null; const sym=`OANDA:${pair.slice(0,3)}_${pair.slice(3)}`; const to=Math.floor(Date.now()/1000); const from=to-60*60*6;
  const url=`https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(sym)}&resolution=15&from=${from}&to=${to}&token=${FH_KEY}`;
  const r=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(2500)}); if(!r.ok) return null; const j:any=await r.json(); if(j?.s!=="ok"||!Array.isArray(j?.c)) return null;
  const t:number[]=(j.t as number[]).map((x:number)=>x); const c:number[]=(j.c as number[]).map((x:number)=>Number(x)); if(!c.every((x:number)=>isFinite(x))) return null; return {t,c}; } catch { return null; } }
async function polySeries15(pair: string): Promise<Series | null> { /* unchanged */ try {
  if(!POLY_KEY) return null; const ticker=`C:${pair}`; const to=new Date(); const from=new Date(to.getTime()-6*60*60*1000);
  const fmt=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const url=`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/15/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&apiKey=${POLY_KEY}`;
  const r=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(2500)}); if(!r.ok) return null; const j:any=await r.json(); if(!Array.isArray(j?.results)) return null;
  const t:number[]=j.results.map((x:any)=>Math.floor(x.t/1000)); const c:number[]=j.results.map((x:any)=>Number(x.c)); if(!c.every((x:number)=>isFinite(x))) return null; return {t,c}; } catch { return null; } }
async function fetchSeries15(pair: string): Promise<Series | null> { const td=await tdSeries15(pair); if(td) return td; const fh=await fhSeries15(pair); if(fh) return fh; const pg=await polySeries15(pair); if(pg) return pg; return null; }
function computeCSMFromPairs(seriesMap: Record<string, Series | null>): CsmSnapshot | null { /* unchanged */ const weights={r60:0.6,r240:0.4};
  const curScore:Record<string,number>=Object.fromEntries(G8.map(c=>[c,0])); for(const pair of USD_PAIRS){ const S=seriesMap[pair]; if(!S||!Array.isArray(S.c)||S.c.length<17) continue;
  const r60=kbarReturn(S.c,4)??0; const r240=kbarReturn(S.c,16)??0; const r=r60*weights.r60+r240*weights.r240; const base=pair.slice(0,3); const quote=pair.slice(3); curScore[base]+=r; curScore[quote]-=r; }
  const vals=G8.map(c=>curScore[c]); const mean=vals.reduce((a,b)=>a+b,0)/vals.length; const sd=Math.sqrt(vals.reduce((a,b)=>a+(b-mean)**2,0)/vals.length)||1;
  const z:Record<string,number>={}; for(const c of G8) z[c]=(curScore[c]-mean)/sd; const ranks=[...G8].sort((a,b)=>z[b]-z[a]); return {tsISO:new Date().toISOString(),ranks,scores:z,ttl:Date.now()+15*60*1000}; }
async function getCSM(): Promise<CsmSnapshot> { if(CSM_CACHE&&Date.now()<CSM_CACHE.ttl) return CSM_CACHE; const seriesMap:Record<string,Series|null>={}; await Promise.all(USD_PAIRS.map(async p=>{seriesMap[p]=await fetchSeries15(p);})); const snap=computeCSMFromPairs(seriesMap); if(!snap){ if(CSM_CACHE) return CSM_CACHE; throw new Error("CSM unavailable (fetch failed and no cache)."); } CSM_CACHE=snap; return snap; }

// ---------- sentiment snapshot ----------
function sentimentSummary(
  csm: CsmSnapshot,
  cotHeadline: { text: string | null, used: boolean }
): {
  text: string;
  provenance: {
    csm_used: boolean;
    csm_time: string;
    cot_used: boolean;
    cot_report_date: null;
    cot_error?: string | null;
    cot_method: "headline" | null;
  };
} {
  const ranksLine = `CSM (60–240m): ${csm.ranks.slice(0, 4).join(" > ")} ... ${csm.ranks.slice(-3).join(" < ")}`;
  const prov = {
    csm_used: true,
    csm_time: csm.tsISO,
    cot_used: !!cotHeadline.used,
    cot_report_date: null as null,
    cot_error: cotHeadline.used ? null : "no cot headlines",
    cot_method: cotHeadline.used ? "headline" as const : null,
  };
  const lines = [ranksLine];
  if (cotHeadline.used && cotHeadline.text) lines.push(cotHeadline.text);
  return { text: lines.join("\n"), provenance: prov };
}

// ---------- prompts ----------
function systemCore(instrument: string) { /* unchanged text */ return [
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
  "Only reference **Headlines / Calendar / CSM** and optional **COT (headline cues)** if present.",
  "Keep instrument alignment with " + instrument + ".",
].join("\n"); }
function buildUserPartsBase(/* unchanged */ args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
}) { /* unchanged body */ const parts: any[] = [
  { type: "text", text: `Instrument: ${args.instrument}\nDate: ${args.dateStr}` },
  { type: "text", text: "HTF 4H Chart:" }, { type: "image_url", image_url: { url: args.h4 } },
  { type: "text", text: "Context 1H Chart:" }, { type: "image_url", image_url: { url: args.h1 } },
  { type: "text", text: "Execution 15M Chart:" }, { type: "image_url", image_url: { url: args.m15 } },
];
if (args.calendarDataUrl) { parts.push({ type: "text", text: "Economic Calendar Image:" }); parts.push({ type: "image_url", image_url: { url: args.calendarDataUrl } }); }
if (!args.calendarDataUrl && args.calendarText) { parts.push({ type: "text", text: `Calendar snapshot:\n${args.calendarText}` }); }
if (args.headlinesText) { parts.push({ type: "text", text: `Recent headlines snapshot (used for bias; list shown in Stage-2):\n${args.headlinesText}` }); }
if (args.sentimentText) { parts.push({ type: "text", text: `Sentiment snapshot (CSM + optional COT cues):\n${args.sentimentText}` }); }
return parts; }

// FULL / FAST / EXPAND message builders — (unchanged except for the provenance type usage)
function messagesFull(/* unchanged signature */ args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
}) { /* unchanged large template */ /* ... */ }

// FAST Stage-1 (update provenance type)
function messagesFastStage1(args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null;
  provenance?: ProvenanceSources;
}) { /* unchanged body building the system and parts */ /* ... full body unchanged ... */ }

// Stage-2 Expand (unchanged)
function messagesExpandStage2(/* unchanged */ args: {
  instrument: string; dateStr: string; m15: string; h1: string; h4: string;
  calendarDataUrl?: string | null; calendarText?: string | null;
  headlinesText?: string | null; sentimentText?: string | null; aiMetaHint?: any;
}) { /* unchanged body */ /* ... */ }

// ---------- OpenAI, enforcement, price helpers ----------
// (all functions unchanged from the previously approved file)

// ---------- calendar helpers ----------
// (unchanged except for types already compatible)

// ---------- handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    let mode: "full" | "fast" | "expand" = String((req.query.mode as string) || "").toLowerCase() === "fast" ? "fast"
      : String((req.query.mode as string) || "").toLowerCase() === "expand" ? "expand" : "full";

    if (mode === "expand") { /* unchanged */ const cacheKey=String(req.query.cache||"").trim(); const c=getCache(cacheKey);
      if(!c) return res.status(400).json({ok:false,reason:"Expand failed: cache expired or not found."});
      if(!c.sentimentText) return res.status(503).json({ok:false,reason:"Missing sentiment snapshot for expand."});
      const dateStr=new Date().toISOString().slice(0,10);
      const messages=messagesExpandStage2({instrument:c.instrument,dateStr,m15:c.m15,h1:c.h1,h4:c.h4,calendarDataUrl:c.calendar||undefined,headlinesText:c.headlinesText||undefined,sentimentText:c.sentimentText||undefined,aiMetaHint:null});
      const text=await callOpenAI(messages); res.setHeader("Cache-Control","no-store"); return res.status(200).json({ok:true,text,meta:{instrument:c.instrument,cacheKey}}); }

    if (!isMultipart(req)) { return res.status(400).json({ ok:false, reason:"Use multipart/form-data with files: m15, h1, h4 …" }); }

    const { fields, files } = await parseMultipart(req);
    const instrument = String(fields.instrument || fields.code || "EURUSD").toUpperCase().replace(/\s+/g,"");
    const requestedMode = String(fields.mode || "").toLowerCase(); if (requestedMode === "fast") mode = "fast";

    const m15f=pickFirst(files.m15), h1f=pickFirst(files.h1), h4f=pickFirst(files.h4), calF=pickFirst(files.calendar);
    const m15Url=String(pickFirst(fields.m15Url)||"").trim(), h1Url=String(pickFirst(fields.h1Url)||"").trim(), h4Url=String(pickFirst(fields.h4Url)||"").trim();

    const [m15FromFile,h1FromFile,h4FromFile,calUrl]=await Promise.all([fileToDataUrl(m15f),fileToDataUrl(h1f),fileToDataUrl(h4f),calF?fileToDataUrl(calF):Promise.resolve(null)]);
    const [m15FromUrl,h1FromUrl,h4FromUrl]=await Promise.all([m15FromFile?Promise.resolve(null):linkToDataUrl(m15Url),h1FromFile?Promise.resolve(null):linkToDataUrl(h1Url),h4FromFile?Promise.resolve(null):linkToDataUrl(h4Url)]);
    const m15=m15FromFile||m15FromUrl, h1=h1FromFile||h1FromUrl, h4=h4FromFile||h4FromUrl;
    if(!m15||!h1||!h4) return res.status(400).json({ ok:false, reason:"Provide all three charts: m15, h1, h4 …" });

    // Headlines
    let headlineItems: AnyHeadline[] = []; let headlinesText: string | null = null;
    const rawHeadlines = pickFirst(fields.headlinesJson) as string | null;
    if (rawHeadlines) { try { const parsed = JSON.parse(String(rawHeadlines)); if (Array.isArray(parsed)) { headlineItems = parsed.slice(0,12); headlinesText = headlinesToPromptLines(headlineItems, 6); } } catch {} }
    if (!headlinesText) { const viaServer = await fetchedHeadlinesViaServer(req, instrument); headlineItems = viaServer.items; headlinesText = viaServer.promptText; }

    // Calendar
    let calendarText: string | null = null;
    let calendarStatus: "image" | "api" | "unavailable" = "unavailable";
    let calendarProvider: string | null = null;
    let calendarWarningMinutes: number | null = null;
    let calendarBiasNote: string | null = null;
    let calendarEvidence: string[] | null = null;

    if (calUrl) { calendarStatus = "image"; calendarProvider = "image"; }
    else { const cal = await fetchCalendarBias(req, instrument);
      calendarText = cal.text; calendarStatus = cal.status; calendarProvider = cal.provider;
      calendarWarningMinutes = cal.warningMinutes; calendarBiasNote = cal.biasNote; calendarEvidence = cal.evidence; }

    // Sentiment (CSM + COT headlines cue)
    const csm = await getCSM().catch((e:any)=>{ throw new Error(`CSM unavailable: ${e?.message||"fetch failed"}`); });
    const cotCue = extractCotCuesFromHeadlines(headlineItems);
    const { text: sentimentText, provenance } = sentimentSummary(csm, { text: cotCue.text, used: cotCue.used });

    const livePrice = await fetchLivePrice(instrument);
    const dateStr = new Date().toISOString().slice(0,10);

    /* ----------- provenance object typed to ProvenanceSources ----------- */
    const provForModel: ProvenanceSources = {
      headlines_used: Math.min(6, Array.isArray(headlineItems) ? headlineItems.length : 0),
      headlines_instrument: instrument,
      calendar_used: !!calUrl || calendarStatus === "api",
      calendar_status: calendarStatus,
      calendar_provider: calendarProvider,
      calendar_warning_minutes: calendarWarningMinutes,
      calendar_bias_note: calendarBiasNote,
      calendar_evidence: calendarEvidence,
      csm_used: true,
      csm_time: csm.tsISO,
      cot_used: !!cotCue.used,
      cot_report_date: null,
      cot_error: cotCue.used ? null : "no cot headlines",
      cot_method: cotCue.used ? "headline" as const : null,
    };
    /* ------------------------------------------------------------------- */

    let text = ""; let aiMeta: any = null;

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
      text = await callOpenAI(messages);
      aiMeta = extractAiMeta(text) || {}; if (livePrice && (aiMeta.currentPrice == null || !isFinite(Number(aiMeta.currentPrice)))) aiMeta.currentPrice = livePrice;

      if (aiMeta && needsPendingLimit(aiMeta)) { text = await rewriteAsPending(instrument, text); aiMeta = extractAiMeta(text) || aiMeta; }
      const bp = aiMeta?.breakoutProof || {}; const hasProof = !!(bp?.bodyCloseBeyond===true && (bp?.retestHolds===true || bp?.sfpReclaim===true));
      if (String(aiMeta?.selectedStrategy||"").toLowerCase().includes("breakout") && !hasProof) { text = await normalizeBreakoutLabel(text); aiMeta = extractAiMeta(text) || aiMeta; }
      if (aiMeta) { if (livePrice && aiMeta.currentPrice !== livePrice) aiMeta.currentPrice = livePrice; const bad = invalidOrderRelativeToPrice(aiMeta); if (bad) { text = await fixOrderVsPrice(instrument, text, aiMeta); aiMeta = extractAiMeta(text) || aiMeta; } }

      const cacheKey = setCache({ instrument, m15, h1, h4, calendar: calUrl || null, headlinesText: headlinesText || null, sentimentText });
      if (!text || refusalLike(text)) { const fb = fallbackCard(instrument, provForModel);
        return res.status(200).json({ ok:true, text:fb, meta:{ instrument, mode, cacheKey, headlinesCount: headlineItems.length, fallbackUsed:true, aiMeta: extractAiMeta(fb), sources: provForModel } }); }
      res.setHeader("Cache-Control","no-store");
      return res.status(200).json({ ok:true, text, meta:{ instrument, mode, cacheKey, headlinesCount: headlineItems.length, fallbackUsed:false, aiMeta, sources: provForModel } });
    }

    // FULL
    const messages = messagesFull({ instrument, dateStr, m15, h1, h4, calendarDataUrl: calUrl || undefined, calendarText: (!calUrl && calendarText) ? calendarText : undefined, headlinesText: headlinesText || undefined, sentimentText });
    if (livePrice) { (messages[0] as any).content = (messages[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice}`; }
    text = await callOpenAI(messages);
    aiMeta = extractAiMeta(text) || {}; if (livePrice && (aiMeta.currentPrice == null || !isFinite(Number(aiMeta.currentPrice)))) aiMeta.currentPrice = livePrice;

    if (aiMeta && needsPendingLimit(aiMeta)) { text = await rewriteAsPending(instrument, text); aiMeta = extractAiMeta(text) || aiMeta; }
    const bp = aiMeta?.breakoutProof || {}; const hasProof = !!(bp?.bodyCloseBeyond===true && (bp?.retestHolds===true || bp?.sfpReclaim===true));
    if (String(aiMeta?.selectedStrategy||"").toLowerCase().includes("breakout") && !hasProof) { text = await normalizeBreakoutLabel(text); aiMeta = extractAiMeta(text) || aiMeta; }
    if (aiMeta) { if (livePrice && aiMeta.currentPrice !== livePrice) aiMeta.currentPrice = livePrice; const bad = invalidOrderRelativeToPrice(aiMeta); if (bad) { text = await fixOrderVsPrice(instrument, text, aiMeta); aiMeta = extractAiMeta(text) || aiMeta; } }

    if (!text || refusalLike(text)) { const fb = fallbackCard(instrument, provForModel);
      return res.status(200).json({ ok:true, text:fb, meta:{ instrument, mode, headlinesCount: headlineItems.length, fallbackUsed:true, aiMeta: extractAiMeta(fb), sources: provForModel } }); }
    res.setHeader("Cache-Control","no-store");
    return res.status(200).json({ ok:true, text, meta:{ instrument, mode, headlinesCount: headlineItems.length, fallbackUsed:false, aiMeta, sources: provForModel } });

  } catch (err: any) {
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}

// ---------- fallback (unchanged except for ProvenanceSources type) ----------
function fallbackCard(
  instrument: string,
  sources: ProvenanceSources
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
