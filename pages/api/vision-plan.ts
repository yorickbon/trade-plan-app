// /pages/api/vision-plan.ts
/**
 * Professional FX Trading Analysis API - Production Grade
 * Multi-timeframe institutional analysis with structure-based execution
 * Real-time price feeds, fundamental synthesis, validated entry logic
 * Version: 2.0 - Optimized for <60s execution with full analytical capability
 */

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";
import sharp from "sharp";
import { getBOSStatus, recordBOS, initializeBOSCache } from './bos-webhook';

// ---------- Configuration ----------
export const config = { api: { bodyParser: false, sizeLimit: "25mb" } };

// Response types
type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

const VP_VERSION = "2025-10-06-production-v2.0";

// API Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const DEFAULT_MODEL = process.env.OPENAI_MODEL_ALT || "gpt-4o";
const ALT_MODEL = process.env.OPENAI_MODEL || "gpt-5";

// Market data API keys
const TD_KEY = process.env.TWELVEDATA_API_KEY || "";
const FH_KEY = process.env.FINNHUB_API_KEY || process.env.FINNHUB_APT_KEY || "";
const POLY_KEY = process.env.POLYGON_API_KEY || "";
const OANDA_KEY = process.env.OANDA_API_KEY || "";
const OANDA_ACCOUNT = process.env.OANDA_ACCOUNT_ID || "";

// ---------- Image Processing Constants ----------
const IMG_MAX_BYTES = 12 * 1024 * 1024;
const BASE_W = 1280;
const MAX_W = 1500;
const TARGET_MIN = 420 * 1024;
const TARGET_MAX = 1200 * 1024;

// Enhanced TradingView chart settings
const TV_TARGET_MIN = 650 * 1024;
const TV_TARGET_MAX = 1800 * 1024;
const TV_BASE_W = 1400;
const TV_MAX_W = 1600;

// ---------- Core Type Definitions ----------
interface InstrumentConfig {
  type: 'forex' | 'crypto' | 'index' | 'commodity';
  decimals: number;
  pipValue: number;
  minDistance: number; // minimum pip distance for entries
  maxSpread: number;   // typical max spread in pips
}

interface PriceValidation {
  isValid: boolean;
  reason?: string;
  suggestedPrice?: number;
}

interface TradeValidation {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  rrRatio?: number;
}

// CSM types
type Series = { t: number[]; c: number[] };
interface CsmSnapshot {
  tsISO: string;
  ranks: string[];
  scores: Record<string, number>;
  ttl: number;
}

// Calendar types
interface OcrCalendarRow {
  timeISO: string | null;
  title: string | null;
  currency: string | null;
  impact: "Low" | "Medium" | "High" | null;
  actual: number | string | null;
  forecast: number | string | null;
  previous: number | string | null;
}

interface OcrCalendar {
  items: OcrCalendarRow[];
}

interface CalendarAnalysis {
  bias: string;
  reasoning: string[];
  evidence: string[];
  details: string;
}

// Headlines types
interface AnyHeadline {
  title?: string;
  description?: string;
  source?: string;
  published_at?: string;
  ago?: string;
  sentiment?: { score?: number } | null;
}

interface HeadlineBias {
  label: "bullish" | "bearish" | "neutral" | "unavailable";
  avg: number | null;
  count: number;
}

// Price source types
interface PriceSource {
  provider: string;
  price: number;
  latency: number;
  confidence: number;
}

// Cache types
interface CacheEntry {
  exp: number;
  instrument: string;
  m5?: string | null;
  m15: string;
  h1: string;
  h4: string;
  calendar?: string | null;
  headlinesText?: string | null;
  sentimentText?: string | null;
}

// Fundamental bias types
interface FundamentalBias {
  score: number; // -100 to +100
  label: 'bullish' | 'bearish' | 'neutral';
  confidence: number; // 0-100
  breakdown: {
    calendar: number;
    headlines: number;
    csm: number;
    cot: number;
  };
  reasoning: string[];
}

// COT types
type CotCue = {
  method: "headline_fallback";
  reportDate: null;
  summary: string;
  net: Record<string, number>;
};

// ---------- Utility Functions ----------
function uuid(): string {
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

function sanitizeInstrument(raw: string): string {
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
}

function parseNumberLoose(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  
  let s = String(v).trim().toLowerCase();
  if (!s || s === "n/a" || s === "na" || s === "-" || s === "—") return null;
  
  s = s.replace(/,/g, "").replace(/\s+/g, "");
  s = s.replace(/\u2212/g, "-"); // Unicode minus
  
  let mult = 1;
  if (s.endsWith("%")) s = s.slice(0, -1);
  else if (s.endsWith("k")) { mult = 1_000; s = s.slice(0, -1); }
  else if (s.endsWith("m")) { mult = 1_000_000; s = s.slice(0, -1); }
  else if (s.endsWith("b")) { mult = 1_000_000_000; s = s.slice(0, -1); }
  
  const n = parseFloat(s);
  return Number.isFinite(n) ? n * mult : null;
}

// Instrument configuration
function getInstrumentConfig(instrument: string): InstrumentConfig {
  const upper = instrument.toUpperCase();
  
  // Crypto
  if (upper.includes("BTC") || upper.includes("ETH") || upper.startsWith("CRYPTO")) {
    return { type: 'crypto', decimals: 2, pipValue: 1, minDistance: 50, maxSpread: 20 };
  }
  
  // Gold/Silver
  if (upper.includes("XAU") || upper.includes("GOLD") || upper.includes("XAG") || upper.includes("SILVER")) {
    return { type: 'commodity', decimals: 2, pipValue: 0.01, minDistance: 20, maxSpread: 5 };
  }
  
  // Indices
  if (upper.includes("NAS") || upper.includes("SPX") || upper.includes("GER") || 
      upper.includes("UK100") || upper.includes("JPN") || upper.includes("DAX") || 
      upper.includes("FTSE") || upper.includes("DOW")) {
    return { type: 'index', decimals: 2, pipValue: 1, minDistance: 30, maxSpread: 10 };
  }
  
  // JPY pairs
  if (upper.includes("JPY")) {
    return { type: 'forex', decimals: 3, pipValue: 0.01, minDistance: 15, maxSpread: 3 };
  }
  
  // Standard FX pairs
  return { type: 'forex', decimals: 5, pipValue: 0.0001, minDistance: 15, maxSpread: 3 };
}

// Calculate pip distance between two prices
function calculatePipDistance(price1: number, price2: number, instrument: string): number {
  const config = getInstrumentConfig(instrument);
  return Math.abs(price1 - price2) / config.pipValue;
}

// Format price to correct decimals
function formatPrice(price: number, instrument: string): string {
  const config = getInstrumentConfig(instrument);
  return price.toFixed(config.decimals);
}

// ---------- In-Memory Caches ----------
const CACHE = new Map<string, CacheEntry>();
let CSM_CACHE: CsmSnapshot | null = null;

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

// Clean up expired cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of CACHE.entries()) {
    if (now > entry.exp) CACHE.delete(key);
  }
}, 5 * 60 * 1000); // Every 5 minutes

// ---------- Formidable Integration ----------
async function getFormidable() {
  const mod: any = await import("formidable");
  return mod.default || mod;
}

function isMultipart(req: NextApiRequest): boolean {
  const t = String(req.headers["content-type"] || "");
  return t.includes("multipart/form-data");
}

async function parseMultipart(req: NextApiRequest): Promise<{
  fields: Record<string, any>;
  files: Record<string, any>;
}> {
  const formidable = await getFormidable();
  const form = formidable({
    multiples: false,
    maxFiles: 25,
    maxFileSize: 25 * 1024 * 1024,
  });

  return new Promise((resolve, reject) => {
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

function pickModelFromFields(req: NextApiRequest, fields?: Record<string, any>): string {
  const raw = String((fields?.model as string) || (req.query.model as string) || "")
    .trim()
    .toLowerCase();
  if (raw.startsWith("gpt-5")) return ALT_MODEL || "gpt-5";
  if (raw.startsWith("gpt-4o")) return DEFAULT_MODEL || "gpt-4o";
  return DEFAULT_MODEL || "gpt-4o";
}

// ---------- Image Processing ----------
async function processAdaptiveToDataUrl(
  buf: Buffer,
  isTradingView: boolean = false
): Promise<string> {
  // Select parameters based on content type
  let width = isTradingView ? TV_BASE_W : BASE_W;
  let quality = isTradingView ? 82 : 74;
  const maxWidth = isTradingView ? TV_MAX_W : MAX_W;
  const targetMin = isTradingView ? TV_TARGET_MIN : TARGET_MIN;
  const targetMax = isTradingView ? TV_TARGET_MAX : TARGET_MAX;

  // Enhanced processing for charts
  const sharpPipeline = sharp(buf)
    .rotate()
    .resize({ width, withoutEnlargement: true });

  if (isTradingView) {
    sharpPipeline.sharpen(1.2, 1.5, 2).modulate({ brightness: 1.05, saturation: 1.1 });
  }

  let out = await sharpPipeline
    .jpeg({ quality, progressive: true, mozjpeg: true })
    .toBuffer();

  // Helper function for rebuilding pipeline
  const buildPipeline = async (
    buffer: Buffer,
    w: number,
    q: number,
    enhance: boolean
  ) => {
    const pipeline = sharp(buffer).rotate().resize({ width: w, withoutEnlargement: true });
    if (enhance) {
      pipeline.sharpen(1.2, 1.5, 2).modulate({ brightness: 1.05, saturation: 1.1 });
    }
    return pipeline.jpeg({ quality: q, progressive: true, mozjpeg: true }).toBuffer();
  };

  // Iterative quality adjustment
  let guard = 0;
  while (out.byteLength < targetMin && guard < 4) {
    quality = Math.min(quality + (isTradingView ? 4 : 6), isTradingView ? 90 : 88);
    if (quality >= (isTradingView ? 85 : 82) && width < maxWidth) {
      width = Math.min(width + 100, maxWidth);
    }
    out = await buildPipeline(buf, width, quality, isTradingView);
    guard++;
  }

  // Final upscale if still too small
  if (out.byteLength < targetMin && (quality < (isTradingView ? 90 : 88) || width < maxWidth)) {
    quality = Math.min(quality + (isTradingView ? 2 : 4), isTradingView ? 90 : 88);
    width = Math.min(width + 100, maxWidth);
    out = await buildPipeline(buf, width, quality, isTradingView);
  }

  // Downscale if too large
  if (out.byteLength > targetMax) {
    const q2 = Math.max(isTradingView ? 75 : 72, quality - (isTradingView ? 8 : 6));
    out = await buildPipeline(buf, width, q2, isTradingView);
  }

  if (out.byteLength > IMG_MAX_BYTES) {
    throw new Error("Image too large after processing");
  }

  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p =
    file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;

  const raw = await fs.readFile(p);
  const out = await processAdaptiveToDataUrl(raw, false);

  if (process.env.NODE_ENV !== "production") {
    console.log(`[vision-plan] File processed size=${dataUrlSizeBytes(out)}B`);
  }

  return out;
}

// ---------- URL Fetching and Processing ----------
function originFromReq(req: NextApiRequest): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}

function absoluteUrl(base: string, maybe: string): string {
  try {
    return new URL(maybe, base).toString();
  } catch {
    return maybe;
  }
}

function htmlFindOgImage(html: string): string | null {
  const re1 = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;
  const m1 = html.match(re1);
  if (m1?.[1]) return m1[1];

  const re2 = /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i;
  const m2 = html.match(re2);
  if (m2?.[1]) return m2[1];

  return null;
}

function looksLikeImageUrl(u: string): boolean {
  const s = String(u || "").split("?")[0] || "";
  return /\.(png|jpe?g|webp|gif)$/i.test(s);
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(ms), redirect: "follow" });
}

async function downloadAndProcess(url: string): Promise<string | null> {
  try {
    const r = await fetchWithTimeout(url, 8000);
    if (!r || !r.ok) return null;

    const ct = String(r.headers.get("content-type") || "").toLowerCase();
    const mime = ct.split(";")[0].trim();
    const ab = await r.arrayBuffer();
    const raw = Buffer.from(ab);

    if (raw.byteLength > IMG_MAX_BYTES) return null;

    // Direct image
    if (mime.startsWith("image/")) {
      const out = await processAdaptiveToDataUrl(raw, false);
      if (process.env.NODE_ENV !== "production") {
        console.log(`[vision-plan] Link processed size=${dataUrlSizeBytes(out)}B from ${url}`);
      }
      return out;
    }

    // HTML with og:image
    const html = raw.toString("utf8");
    const og = htmlFindOgImage(html);
    if (!og) return null;

    const resolved = absoluteUrl(url, og);
    const isTradingView = url.includes("tradingview.com");

    const r2 = await fetchWithTimeout(resolved, isTradingView ? 12000 : 8000);
    if (!r2 || !r2.ok) return null;

    const ab2 = await r2.arrayBuffer();
    const raw2 = Buffer.from(ab2);
    if (raw2.byteLength > IMG_MAX_BYTES) return null;

    const out2 = await processAdaptiveToDataUrl(raw2, isTradingView);

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[vision-plan] ${isTradingView ? "TradingView" : "og:image"} processed size=${dataUrlSizeBytes(out2)}B from ${resolved}`
      );
    }

    return out2;
  } catch (err) {
    console.error(`[vision-plan] Download failed for ${url}:`, err);
    return null;
  }
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

// ---------- OpenAI Integration ----------
async function callOpenAI(model: string, messages: any[]): Promise<string> {
  const body: any = { model, messages };

  // Temperature control
  if (!/^gpt-5/i.test(model)) {
    body.temperature = 0;
  }

  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const json = await rsp.json().catch(() => ({} as any));

  if (!rsp.ok) {
    throw new Error(`OpenAI request failed: ${rsp.status} ${JSON.stringify(json)}`);
  }

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
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractAiMeta(text: string): any | null {
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

// ---------- Real-Time Price Feeds (Production Grade) ----------

// OANDA real-time (lowest latency, highest accuracy)
async function fetchOandaPrice(pair: string): Promise<PriceSource | null> {
  if (!OANDA_KEY || !OANDA_ACCOUNT) return null;
  
  const start = Date.now();
  try {
    const instrument = `${pair.slice(0, 3)}_${pair.slice(3)}`;
    const url = `https://api-fxpractice.oanda.com/v3/accounts/${OANDA_ACCOUNT}/pricing?instruments=${instrument}`;
    
    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${OANDA_KEY}`,
        'Content-Type': 'application/json'
      },
      cache: "no-store",
      signal: AbortSignal.timeout(2000)
    });
    
    const j: any = await r.json().catch(() => ({}));
    const pricing = j?.prices?.[0];
    
    if (!pricing) return null;
    
    // OANDA provides bid/ask - use mid for accuracy
    const bid = Number(pricing.closeoutBid);
    const ask = Number(pricing.closeoutAsk);
    const mid = (bid + ask) / 2;
    
    const timestamp = pricing.time ? Date.parse(pricing.time) : 0;
    const ageSeconds = (Date.now() - timestamp) / 1000;
    
    if (isFinite(mid) && mid > 0 && ageSeconds < 5) {
      return {
        provider: "OANDA-Live",
        price: mid,
        latency: Date.now() - start,
        confidence: 0.50 // Highest confidence
      };
    }
    
    console.warn(`[PRICE] OANDA quote too old: ${ageSeconds.toFixed(0)}s`);
    return null;
  } catch (err) {
    console.error('[PRICE] OANDA error:', err);
    return null;
  }
}

// TwelveData real-time quote
async function fetchTwelveDataPrice(pair: string): Promise<PriceSource | null> {
  if (!TD_KEY) return null;
  
  const start = Date.now();
  try {
    const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(
      sym
    )}&apikey=${TD_KEY}&dp=5`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    const j: any = await r.json().catch(() => ({}));
    
    const p = Number(j?.close);
    const timestamp = j?.timestamp ? Date.parse(j.timestamp) : 0;
    const ageSeconds = (Date.now() - timestamp) / 1000;
    
    if (isFinite(p) && p > 0 && ageSeconds < 60) {
      return { 
        provider: "TwelveData-RT", 
        price: p, 
        latency: Date.now() - start, 
        confidence: 0.45 
      };
    }
    
    console.warn(`[PRICE] TwelveData quote too old: ${ageSeconds.toFixed(0)}s`);
    return null;
  } catch (err) {
    console.error('[PRICE] TwelveData error:', err);
    return null;
  }
}

// Finnhub real-time quote
async function fetchFinnhubPrice(pair: string): Promise<PriceSource | null> {
  if (!FH_KEY) return null;
  
  const start = Date.now();
  try {
    const sym = `OANDA:${pair.slice(0, 3)}_${pair.slice(3)}`;
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
      sym
    )}&token=${FH_KEY}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    const j: any = await r.json().catch(() => ({}));
    
    const p = Number(j?.c);
    const timestamp = Number(j?.t) * 1000;
    const ageSeconds = (Date.now() - timestamp) / 1000;
    
    if (isFinite(p) && p > 0 && ageSeconds < 60) {
      return { 
        provider: "Finnhub-RT", 
        price: p, 
        latency: Date.now() - start, 
        confidence: 0.40 
      };
    }
    
    console.warn(`[PRICE] Finnhub quote too old: ${ageSeconds.toFixed(0)}s`);
    return null;
  } catch (err) {
    console.error('[PRICE] Finnhub error:', err);
    return null;
  }
}

// Polygon real-time with fallback
async function fetchPolygonPrice(pair: string): Promise<PriceSource | null> {
  if (!POLY_KEY) return null;
  
  const start = Date.now();
  try {
    const ticker = `C:${pair}`;
    const url = `https://api.polygon.io/v2/snapshot/locale/global/markets/forex/tickers/${encodeURIComponent(
      ticker
    )}?apiKey=${POLY_KEY}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    const j: any = await r.json().catch(() => ({}));
    
    const p = Number(j?.ticker?.lastTrade?.p);
    const timestamp = Number(j?.ticker?.lastTrade?.t);
    const ageSeconds = timestamp ? (Date.now() - timestamp) / 1000 : 999;
    
    if (isFinite(p) && p > 0 && ageSeconds < 60) {
      return { 
        provider: "Polygon-RT", 
        price: p, 
        latency: Date.now() - start, 
        confidence: 0.35 
      };
    }
    
    console.warn(`[PRICE] Polygon snapshot too old: ${ageSeconds.toFixed(0)}s, trying 1min aggregate`);
    
    // Fallback to 1-minute aggregate
    const to = new Date();
    const from = new Date(to.getTime() - 2 * 60 * 1000);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
    const urlAgg = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(
      ticker
    )}/range/1/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=desc&limit=1&apiKey=${POLY_KEY}`;
    const rAgg = await fetch(urlAgg, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    const jAgg: any = await rAgg.json().catch(() => ({}));
    
    const res = Array.isArray(jAgg?.results) ? jAgg.results[0] : null;
    const last = Number(res?.c);
    const tsAgg = Number(res?.t);
    const ageAgg = tsAgg ? (Date.now() - tsAgg) / 1000 : 999;
    
    if (isFinite(last) && last > 0 && ageAgg < 120) {
      return { 
        provider: "Polygon-1M", 
        price: last, 
        latency: Date.now() - start, 
        confidence: 0.30 
      };
    }
    
    return null;
  } catch (err) {
    console.error('[PRICE] Polygon error:', err);
    return null;
  }
}

// Price consensus with quality metrics
async function fetchLivePriceConsensus(
  pair: string
): Promise<{ consensus: number; sources: PriceSource[]; confidence: number; maxAge: number } | null> {
  const sources: Promise<PriceSource | null>[] = [];

  sources.push(fetchOandaPrice(pair));
  if (TD_KEY) sources.push(fetchTwelveDataPrice(pair));
  if (FH_KEY) sources.push(fetchFinnhubPrice(pair));
  if (POLY_KEY) sources.push(fetchPolygonPrice(pair));

  const results = await Promise.allSettled(sources);
  const validSources: PriceSource[] = results
    .filter((r): r is PromiseFulfilledResult<PriceSource> => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);

  if (validSources.length === 0) return null;

  const totalWeight = validSources.reduce((sum, s) => sum + s.confidence, 0);
  const consensus =
    validSources.reduce((sum, s) => sum + s.price * s.confidence, 0) / totalWeight;

  const maxDiff = Math.max(...validSources.map((s) => Math.abs(s.price - consensus) / consensus));
  const confidence = maxDiff < 0.0005 ? 95 : maxDiff < 0.001 ? 85 : maxDiff < 0.005 ? 70 : 50;

  const maxAge = Math.max(...validSources.map((s) => s.latency));

  if (process.env.NODE_ENV !== "production") {
    console.log(`[PRICE] ${pair} Consensus: ${consensus.toFixed(5)} from ${validSources.length} sources (confidence: ${confidence}%, max age: ${maxAge}ms)`);
    validSources.forEach(s => {
      console.log(`  - ${s.provider}: ${s.price.toFixed(5)} (${s.latency}ms, conf: ${s.confidence})`);
    });
  }

  return { consensus, sources: validSources, confidence, maxAge };
}

async function fetchLivePrice(pair: string): Promise<number | null> {
  const result = await fetchLivePriceConsensus(pair);
  return result?.consensus || null;
}

// ---------- CSM Calculation ----------
const G8 = ["USD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD"];
const USD_PAIRS = ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDJPY", "USDCHF", "USDCAD"];

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
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;

    const j: any = await r.json();
    if (!Array.isArray(j?.values)) return null;

    const vals = [...j.values].reverse();
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
    const from = to - 60 * 60 * 6;
    const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(
      sym
    )}&resolution=15&from=${from}&to=${to}&token=${FH_KEY}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2500) });
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
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(
      ticker
    )}/range/15/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&apiKey=${POLY_KEY}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2500) });
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
    if (CSM_CACHE) return CSM_CACHE;
    throw new Error("CSM unavailable (fetch failed and no cache).");
  }

  CSM_CACHE = snap;
  return snap;
}

// ---------- Headlines Processing ----------
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

function getSourceCredibility(source: string): number {
  const sourceLC = (source || "").toLowerCase();
  if (
    sourceLC.includes("reuters") ||
    sourceLC.includes("bloomberg") ||
    sourceLC.includes("wsj")
  )
    return 1.2;
  if (
    sourceLC.includes("cnbc") ||
    sourceLC.includes("marketwatch") ||
    sourceLC.includes("ft")
  )
    return 1.1;
  if (sourceLC.includes("yahoo") || sourceLC.includes("seeking alpha")) return 0.9;
  if (sourceLC.includes("twitter") || sourceLC.includes("reddit") || sourceLC.includes("blog"))
    return 0.7;
  return 1.0;
}

function computeHeadlinesBias(items: AnyHeadline[]): HeadlineBias {
  if (!Array.isArray(items) || items.length === 0)
    return { label: "unavailable", avg: null, count: 0 };

  const validItems = items
    .map((h) => ({
      score: typeof h?.sentiment?.score === "number" ? Number(h.sentiment.score) : null,
      published: h?.published_at || h?.ago || null,
      source: h?.source || "unknown",
    }))
    .filter((item) => item.score !== null && Number.isFinite(item.score));

  if (validItems.length === 0) return { label: "unavailable", avg: null, count: 0 };

  const now = Date.now();
  const weightedScores = validItems.map((item) => {
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
      weight: timeWeight * sourceWeight,
    };
  });

  const totalWeight = weightedScores.reduce((sum, item) => sum + item.weight, 0);
  const weightedAvg =
    weightedScores.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight;

  const label = weightedAvg > 0.015 ? "bullish" : weightedAvg < -0.015 ? "bearish" : "neutral";
  return { label, avg: weightedAvg, count: validItems.length };
}

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

function computeHeadlinesSign(hb: HeadlineBias): number {
  if (!hb) return 0;
  if (hb.label === "bullish") return 1;
  if (hb.label === "bearish") return -1;
  return 0;
}

function computeCSMInstrumentSign(
  csm: CsmSnapshot,
  instr: string
): { sign: number; zdiff: number | null } {
  const base = instr.slice(0, 3);
  const quote = instr.slice(3, 6);
  const zb = csm.scores[base];
  const zq = csm.scores[quote];
  if (typeof zb !== "number" || typeof zq !== "number") return { sign: 0, zdiff: null };
  const diff = zb - zq;
  const sign = diff > 0.4 ? 1 : diff < -0.4 ? -1 : 0;
  return { sign, zdiff: diff };
}

// ---------- Calendar Analysis Helpers ----------

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
  if (/unemployment|jobless|initial claims|continuing claims/.test(t)) return false;
  if (/(nonfarm|nfp|employment change|payrolls|jobs)/.test(t)) return true;
  if (/trade balance|current account/.test(t)) return true;
  if (
    /interest rate|rate decision|refi rate|deposit facility|bank rate|cash rate|ocr/.test(t)
  )
    return true;
  return null;
}

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

  const parts = Object.entries(net).map(([c, v]) => `${c}:${v > 0 ? "net long" : "net short"}`);
  return {
    method: "headline_fallback",
    reportDate: null,
    summary: `COT cues (headlines): ${parts.join(", ")}`,
    net,
  };
}

function parseInstrumentBiasFromNote(biasNote: string | null | undefined): number {
  if (!biasNote) return 0;
  const m = biasNote.match(/instrument[^:]*:\s*(bullish|bearish|neutral)/i);
  if (m?.[1])
    return m[1].toLowerCase() === "bullish" ? 1 : m[1].toLowerCase() === "bearish" ? -1 : 0;
  return 0;
}

// ---------- Fundamental Bias Synthesis (Production Grade) ----------

function synthesizeFundamentalBias(
  calendarSign: number, // -1, 0, 1
  headlinesBias: HeadlineBias,
  csmData: { sign: number; zdiff: number | null },
  cotCue: CotCue | null
): FundamentalBias {
  
  // Convert signs to 0-100 scale
  const calendarScore = (calendarSign + 1) * 50; // -1→0, 0→50, 1→100
  
  const headlinesScore = 
    headlinesBias.label === 'bullish' ? 75 :
    headlinesBias.label === 'bearish' ? 25 :
    50; // neutral or unavailable
  
  // CSM z-score diff to 0-100 scale
  let csmScore = 50; // neutral default
  if (csmData.zdiff !== null) {
    const clamped = Math.max(-2, Math.min(2, csmData.zdiff));
    csmScore = 50 + (25 * clamped); // -2→0, 0→50, +2→100
  }
  
  // COT bonus/penalty
  let cotScore = 50; // neutral default
  if (cotCue) {
    const cotNet = Object.values(cotCue.net).reduce((sum, v) => sum + v, 0);
    if (cotNet > 0 && calendarSign > 0) cotScore = 60; // bullish alignment
    else if (cotNet < 0 && calendarSign < 0) cotScore = 60; // bearish alignment
    else if ((cotNet > 0 && calendarSign < 0) || (cotNet < 0 && calendarSign > 0)) cotScore = 40; // conflict
  }
  
  // Weighted combination
  const weights = {
    calendar: 0.40,
    headlines: 0.25,
    csm: 0.25,
    cot: 0.10
  };
  
  const weightedScore = 
    (weights.calendar * calendarScore) +
    (weights.headlines * headlinesScore) +
    (weights.csm * csmScore) +
    (weights.cot * cotScore);
  
  // Normalize to -100 to +100
  const finalScore = (weightedScore - 50) * 2;
  
  // Determine label and confidence
  let label: 'bullish' | 'bearish' | 'neutral';
  let confidence: number;
  
  if (finalScore > 20) {
    label = 'bullish';
    confidence = Math.min(100, 50 + Math.abs(finalScore));
  } else if (finalScore < -20) {
    label = 'bearish';
    confidence = Math.min(100, 50 + Math.abs(finalScore));
  } else {
    label = 'neutral';
    confidence = 50 - Math.abs(finalScore);
  }
  
  // Build reasoning
  const reasoning: string[] = [];
  reasoning.push(`Calendar: ${calendarSign > 0 ? 'bullish' : calendarSign < 0 ? 'bearish' : 'neutral'} (${calendarScore.toFixed(0)}/100)`);
  reasoning.push(`Headlines: ${headlinesBias.label} (${headlinesScore.toFixed(0)}/100)`);
  reasoning.push(`CSM: ${csmData.sign > 0 ? 'bullish' : csmData.sign < 0 ? 'bearish' : 'neutral'} (${csmScore.toFixed(0)}/100)`);
  if (cotCue) reasoning.push(`COT: ${cotScore > 50 ? 'supportive' : cotScore < 50 ? 'conflicting' : 'neutral'} (${cotScore.toFixed(0)}/100)`);
  reasoning.push(`FINAL: ${label.toUpperCase()} (score: ${finalScore.toFixed(1)}, confidence: ${confidence.toFixed(0)}%)`);
  
  return {
    score: finalScore,
    label,
    confidence,
    breakdown: {
      calendar: calendarScore,
      headlines: headlinesScore,
      csm: csmScore,
      cot: cotScore
    },
    reasoning
  };
}

function sentimentSummary(
  csm: CsmSnapshot,
  cotCue: CotCue | null,
  headlineBias: HeadlineBias
): { text: string; provenance: any } {
  const ranksLine = `CSM (60–240m): ${csm.ranks.slice(0, 4).join(" > ")} ... ${csm.ranks
    .slice(-3)
    .join(" < ")}`;
  const hBiasLine =
    headlineBias.label === "unavailable"
      ? "Headlines bias (48h): unavailable"
      : `Headlines bias (48h): ${headlineBias.label}${
          headlineBias.avg != null ? ` (${headlineBias.avg.toFixed(2)})` : ""
        }`;
  const cotLine = cotCue ? `COT: ${cotCue.summary}` : "COT: no cues from headlines.";

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

  return { text: `${ranksLine}\n${hBiasLine}\n${cotLine}`, provenance: prov };
}

// ---------- Calendar OCR ----------
async function ocrCalendarFromImage(
  model: string,
  calendarDataUrl: string
): Promise<OcrCalendar | null> {
  const sys = [
    "You are extracting ECONOMIC CALENDAR rows via image OCR.",
    "Return STRICT JSON only. CRITICAL: Extract ALL numbers including grey/muted text - these are valid data points.",
    "Fields per row: timeISO (ISO8601 if visible, else null), title, currency (e.g., USD, EUR), impact (Low|Medium|High), actual, forecast, previous.",
    "For numbers: extract percentage values (0.5%), rates (<0.50%), and regular numbers. Grey/muted numbers are valid - do not skip them.",
    "If a cell appears empty or truly unreadable, use null. But if you see any number (colored or grey), extract it.",
  ].join("\n");

  const user = [
    {
      type: "text",
      text: "Extract rows as specified. JSON only. Schema: { items: OcrCalendarRow[] }",
    },
    { type: "image_url", image_url: { url: calendarDataUrl } },
  ];

  const msg = [
    { role: "system", content: sys },
    { role: "user", content: user },
  ];

  let text = await callOpenAI(model, msg);
  let parsed = tryParseJsonBlock(text);

  if (!parsed || !Array.isArray(parsed?.items)) {
    const msg2 = [
      {
        role: "system",
        content: sys + "\nREPLY WITH JSON ONLY. NO prose. If unsure, use nulls.",
      },
      { role: "user", content: user },
    ];
    text = await callOpenAI(model, msg2);
    parsed = tryParseJsonBlock(text);
    if (!parsed || !Array.isArray(parsed?.items)) return null;
  }

  const items: OcrCalendarRow[] = (parsed.items as any[]).map((r) => ({
    timeISO: r?.timeISO && typeof r.timeISO === "string" ? r.timeISO : null,
    title: r?.title && typeof r.title === "string" ? r.title : null,
    currency:
      r?.currency && typeof r.currency === "string"
        ? r.currency.toUpperCase().slice(0, 3)
        : null,
    impact:
      r?.impact && typeof r.impact === "string"
        ? ["low", "medium", "high"].includes(r.impact.toLowerCase())
          ? ((r.impact[0].toUpperCase() + r.impact.slice(1).toLowerCase()) as any)
          : null
        : null,
    actual: r?.actual ?? null,
    forecast: r?.forecast ?? null,
    previous: r?.previous ?? null,
  }));

  return { items };
}

// ---------- Institutional Calendar Analysis ----------
function applyInstitutionalCorrelations(
  scores: Record<string, number>,
  reasoning: string[],
  base: string,
  quote: string
): void {
  // Risk-on/off flows
  if (quote === "USD") {
    const riskCurrencies = ["AUD", "NZD", "CAD"];
    const riskOnScore = riskCurrencies.reduce((sum, curr) => sum + (scores[curr] || 0), 0);

    if (Math.abs(riskOnScore) > 2) {
      const usdAdjustment = riskOnScore * -0.4;
      scores["USD"] = (scores["USD"] || 0) + usdAdjustment;
      const sentiment = riskOnScore > 0 ? "risk-on" : "risk-off";
      reasoning.push(
        `${sentiment.toUpperCase()} environment → ${
          usdAdjustment > 0 ? "bullish" : "bearish"
        } USD (${usdAdjustment.toFixed(1)} pts)`
      );
    }
  }

  // Commodity currency correlations
  const commodCurrencies = ["CAD", "AUD", "NZD"];
  if (commodCurrencies.includes(base) || commodCurrencies.includes(quote)) {
    for (const curr1 of commodCurrencies) {
      for (const curr2 of commodCurrencies) {
        if (curr1 !== curr2 && scores[curr1] && Math.abs(scores[curr1]) > 2) {
          const correlation = 0.3;
          const adjustment = scores[curr1] * correlation;
          scores[curr2] = (scores[curr2] || 0) + adjustment;
          reasoning.push(
            `${curr1} ${scores[curr1] > 0 ? "strength" : "weakness"} → ${curr2} correlation (+${adjustment.toFixed(1)} pts)`
          );
        }
      }
    }
  }

  // EUR-GBP correlation
  if ((base === "EUR" || quote === "EUR") && scores["GBP"]) {
    const correlation = 0.25;
    const adjustment = scores["GBP"] * correlation;
    scores["EUR"] = (scores["EUR"] || 0) + adjustment;
    reasoning.push(
      `GBP-EUR correlation: ${adjustment > 0 ? "+" : ""}${adjustment.toFixed(1)} pts to EUR`
    );
  }

  // JPY safe-haven flows
  if (base === "JPY" || quote === "JPY") {
    const riskCurrencies = ["AUD", "NZD", "CAD"];
    const totalRisk = riskCurrencies.reduce((sum, curr) => sum + (scores[curr] || 0), 0);

    if (Math.abs(totalRisk) > 1.5) {
      const jpyAdjustment = totalRisk * -0.35;
      scores["JPY"] = (scores["JPY"] || 0) + jpyAdjustment;
      reasoning.push(
        `Risk sentiment → JPY safe-haven flow (${jpyAdjustment > 0 ? "+" : ""}${jpyAdjustment.toFixed(1)} pts)`
      );
    }
  }
}

function analyzeCalendarProfessional(
  ocrItems: OcrCalendarRow[],
  instrument: string
): CalendarAnalysis {
  const base = instrument.slice(0, 3);
  const quote = instrument.slice(3, 6);

  const nowMs = Date.now();
  const h72ago = nowMs - 72 * 3600 * 1000;

  const validEvents = ocrItems.filter((r) => {
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
      reasoning: [
        `Calendar: No valid data found in last 72h for ${instrument} currencies (${base}/${quote})`,
      ],
      evidence: [],
      details: `OCR extracted ${ocrItems.length} total rows, filtering for ${base}/${quote} relevance`,
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

    // Forecast surprise
    if (forecast !== null) {
      const surprise = actual - forecast;
      const surprisePercent = Math.abs(forecast) > 0 ? surprise / Math.abs(forecast) : 0;
      const surpriseWeight = Math.min(Math.abs(surprisePercent), 0.5);
      const surpriseDirection = direction === true ? Math.sign(surprise) : -Math.sign(surprise);
      eventScore += surpriseDirection * surpriseWeight * 10;
      comparison += `vs F:${forecast}`;
    }

    // Previous comparison
    if (previous !== null) {
      const change = actual - previous;
      const changePercent = Math.abs(previous) > 0 ? change / Math.abs(previous) : 0;
      const changeWeight = Math.min(Math.abs(changePercent), 0.3) * 0.5;
      const changeDirection = direction === true ? Math.sign(change) : -Math.sign(change);
      eventScore += changeDirection * changeWeight * 10;
      comparison += ` vs P:${previous}`;
    }

    // Impact multiplier
    const impactMultiplier = impact === "High" ? 2.0 : impact === "Medium" ? 1.0 : 0.5;
    const finalScore = eventScore * impactMultiplier;

    currencyScores[currency] = (currencyScores[currency] || 0) + finalScore;

    const sentiment = finalScore > 0.5 ? "bullish" : finalScore < -0.5 ? "bearish" : "neutral";
    reasoning.push(
      `${currency} ${title}: ${actual} ${comparison} = ${sentiment} ${currency} (${finalScore.toFixed(1)} pts)`
    );
    evidence.push(
      `${currency} — ${title}: A:${actual} F:${forecast ?? "n/a"} P:${previous ?? "n/a"}`
    );
  }

  // Apply institutional correlations
  applyInstitutionalCorrelations(currencyScores, reasoning, base, quote);

  const baseScore = currencyScores[base] || 0;
  const quoteScore = currencyScores[quote] || 0;
  const netScore = baseScore - quoteScore;

  let finalBias: string;
  const moderateThreshold = 1.0;

  if (
    Math.abs(netScore) < moderateThreshold &&
    Math.abs(baseScore) < moderateThreshold &&
    Math.abs(quoteScore) < moderateThreshold
  ) {
    finalBias = "neutral";
  } else if (netScore > moderateThreshold) {
    finalBias = "bullish";
  } else if (netScore < -moderateThreshold) {
    finalBias = "bearish";
  } else {
    finalBias = "neutral";
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[CALENDAR] ${base}${quote}: Base=${baseScore.toFixed(1)}, Quote=${quoteScore.toFixed(1)}, Net=${netScore.toFixed(1)}, Bias=${finalBias}`
    );
  }

  const summary = `Calendar: ${base} ${baseScore.toFixed(1)} vs ${quote} ${quoteScore.toFixed(1)} = ${finalBias} ${instrument} (net ${netScore > 0 ? "+" : ""}${netScore.toFixed(1)})`;

  return {
    bias: finalBias,
    reasoning: [summary, ...reasoning],
    evidence,
    details: `Professional analysis: ${validEvents.length} events, ${Object.keys(currencyScores).length} currencies impacted`,
  };
}

// ---------- OPTIMIZED System Prompts (Production Grade) ----------

function systemCore(
  instrument: string,
  calendarAdvisory?: { warningMinutes?: number | null; biasNote?: string | null },
  scalpingMode?: "soft" | "hard" | "off"
): string {
  return `Professional FX trader analyzing ${instrument}. Use ONLY provided data.

Chart reading: Look left-to-right. Find 3 recent swing highs + 3 recent swing lows (rightmost 20%). Both ascending=UP, both descending=DOWN, mixed=RANGE.

Entries: LONG at support/OB below current. SHORT at resistance/OB above current. Reference structure: "Entry 0.6545 (15M swing low)". SL format: "0.6530 (5 pips below 15M swing at 0.6535)".

${scalpingMode === "hard" ? "SCALPING: 15M/5M focus, 12-20 pip stops, 18-40 pip targets." : ""}
${calendarAdvisory?.warningMinutes ? `High-impact event in ${calendarAdvisory.warningMinutes}min.` : ""}`;
}

// ---------- Message Building ----------
function buildUserPartsBase(args: {
  instrument: string;
  dateStr: string;
  m15: string;
  h1: string;
  h4: string;
  m5?: string | null;
  m1?: string | null;
  currentPrice?: number | null;
  calendarDataUrl?: string | null;
  calendarText?: string | null;
  headlinesText?: string | null;
  sentimentText?: string | null;
  calendarAdvisoryText?: string | null;
  calendarEvidence?: string[] | null;
  debugOCRRows?: any[] | null;
}): any[] {
  const bos4H = getBOSStatus(args.instrument, "240");
  const bos1H = getBOSStatus(args.instrument, "60");
  const bos15M = getBOSStatus(args.instrument, "15");
  const bos5M = getBOSStatus(args.instrument, "5");

  const bosContext =
    bos4H !== "NONE" || bos1H !== "NONE" || bos15M !== "NONE" || bos5M !== "NONE"
      ? `\n\nBOS Status: 4H=${bos4H}, 1H=${bos1H}, 15M=${bos15M}, 5M=${bos5M}\n`
      : "\n\nBOS: No recent alerts\n";

  const parts: any[] = [
    {
      type: "text",
      text: `Instrument: ${args.instrument} | Date: ${args.dateStr}${args.currentPrice ? `\nCURRENT LIVE PRICE: ${args.currentPrice}` : ''}${bosContext}

CRITICAL: You must follow the MANDATORY CHART READING PROTOCOL for each timeframe.
Do NOT proceed to trade recommendations until all 3 timeframes analyzed using the protocol.
`
    },
    
    { type: "text", text: "4H BIAS CHART - Execute 5-step protocol (analyze last 130-150 candles, focus right 20%):" },
    { type: "image_url", image_url: { url: args.h4 } },
    
    { type: "text", text: "1H CONTEXT CHART - Execute 5-step protocol (analyze last 120-140 candles, recent = last 30):" },
    { type: "image_url", image_url: { url: args.h1 } },
    
    { type: "text", text: "15M STRUCTURE CHART - Execute 5-step protocol (analyze last 120-140 candles, entry from last 60):" },
    { type: "image_url", image_url: { url: args.m15 } },
  ];

  if (args.m5) {
    parts.push({ type: "text", text: "5M Scalp Chart:" });
    parts.push({ type: "image_url", image_url: { url: args.m5 } });
  }
  if (args.m1) {
    parts.push({ type: "text", text: "1M Timing Chart:" });
    parts.push({ type: "image_url", image_url: { url: args.m1 } });
  }
  if (args.calendarDataUrl) {
    parts.push({ type: "text", text: "Economic Calendar (OCR):" });
    parts.push({ type: "image_url", image_url: { url: args.calendarDataUrl } });
  }
  if (!args.calendarDataUrl && args.calendarText) {
    const calBlock =
      args.calendarEvidence && args.calendarEvidence.length > 0
        ? `Calendar:\n${args.calendarText}\n\nEvents:\n${args.calendarEvidence.join("\n")}`
        : `Calendar:\n${args.calendarText}`;
    parts.push({ type: "text", text: calBlock });
  }
  if (args.calendarAdvisoryText) {
    parts.push({ type: "text", text: `Advisory:\n${args.calendarAdvisoryText}` });
  }
  if (args.calendarEvidence && args.calendarEvidence.length && args.calendarDataUrl) {
    parts.push({
      type: "text",
      text: `MANDATORY calendar analysis:\n${args.calendarEvidence.join("\n")}`,
    });
  }
  if (args.headlinesText) {
    parts.push({ type: "text", text: `Headlines:\n${args.headlinesText}` });
  }
  if (args.sentimentText) {
    parts.push({ type: "text", text: `Sentiment:\n${args.sentimentText}` });
  }
  if (args.debugOCRRows && args.debugOCRRows.length) {
    const rows = args.debugOCRRows
      .map(
        (r) =>
          `${r.timeISO ?? "n/a"} | ${r.currency ?? "??"} | ${r.title ?? "??"} | A:${r.actual ?? "?"} F:${r.forecast ?? "?"} P:${r.previous ?? "?"}`
      )
      .join("\n");
    parts.push({ type: "text", text: `DEBUG OCR:\n${rows}` });
  }

  return parts;
}

function messagesFull(args: {
  instrument: string;
  dateStr: string;
  m15: string;
  h1: string;
  h4: string;
  m5?: string | null;
  m1?: string | null;
  currentPrice?: number | null;
  calendarDataUrl?: string | null;
  calendarText?: string | null;
  headlinesText?: string | null;
  sentimentText?: string | null;
  calendarAdvisory?: {
    warningMinutes?: number | null;
    biasNote?: string | null;
    advisoryText?: string | null;
    evidence?: string[] | null;
    debugRows?: any[] | null;
  };
  provenance?: any;
  scalpingMode?: "soft" | "hard" | "off";
}): any[] {
  const system = systemCore(args.instrument, args.calendarAdvisory, args.scalpingMode);

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
        m5: args.m5 || null,
        m1: args.m1 || null,
        currentPrice: args.currentPrice || null,
        calendarDataUrl: args.calendarDataUrl,
        calendarText: args.calendarText,
        headlinesText: args.headlinesText,
        sentimentText: args.sentimentText,
        calendarAdvisoryText: args.calendarAdvisory?.advisoryText || null,
        calendarEvidence: args.calendarAdvisory?.evidence || null,
        debugOCRRows: args.calendarAdvisory?.debugRows || null,
      }),
    },
  ];
}

// ---------- Enforcement Functions ----------
function hasCompliantOption2(text: string): boolean {
  if (!/Option\s*2/i.test(text || "")) return false;
  const block = (text.match(/Option\s*2[\s\S]{0,800}/i)?.[0] || "").toLowerCase();
  const must = ["direction", "order type", "entry", "stop", "tp", "conviction"];
  return must.every((k) => block.includes(k));
}

async function enforceOption2(model: string, instrument: string, text: string): Promise<string> {
  if (hasCompliantOption2(text)) return text;
  const messages = [
    {
      role: "system",
      content:
        "Add Option 2 (Alternative) with Direction, Order Type, Entry (with structure reference), SL, TP1/TP2, Conviction. Keep all else unchanged.",
    },
    { role: "user", content: `${instrument}\n\n${text}\n\nAdd Option 2 below Option 1.` },
  ];
  return callOpenAI(model, messages);
}

function hasOption1(text: string): boolean {
  return /Option\s*1\s*\(?(Primary)?\)?/i.test(text || "");
}

async function enforceOption1(model: string, instrument: string, text: string): Promise<string> {
  if (hasOption1(text)) return text;
  const messages = [
    {
      role: "system",
      content:
        "Insert 'Option 1 (Primary)' block BEFORE Option 2. Use primary trade details. Include Direction, Order Type, Entry (with structure reference), SL, TP1/TP2, Conviction.",
    },
    { role: "user", content: `${instrument}\n\n${text}\n\nAdd Option 1 (Primary).` },
  ];
  return callOpenAI(model, messages);
}

async function enforceStrategyTournament(
  model: string,
  instrument: string,
  text: string
): Promise<string> {
  if (/Strategy\s+Tournament\s+Results/i.test(text)) return text;
  const messages = [
    {
      role: "system",
      content:
        "Add 'Strategy Tournament Results' section BEFORE trade options. Score all 5 strategies (0-100) with detection checklist and brief reasoning. Winner=Option 1, Runner-up=Option 2.",
    },
    { role: "user", content: `${instrument}\n\n${text}\n\nAdd tournament results.` },
  ];
  return callOpenAI(model, messages);
}

async function validateOrderTypeLogic(
  model: string,
  instrument: string,
  text: string,
  currentPrice: number
): Promise<string> {
  const dirMatch = text.match(/Direction:\s*(Long|Short)/i);
  const orderMatch = text.match(/Order Type:\s*(Limit|Stop|Market)/i);
  const entryMatch = text.match(/Entry[^:]*:\s*([\d.]+(?:-[\d.]+)?)/i);

  if (!dirMatch || !orderMatch || !entryMatch) return text;

  const direction = dirMatch[1].toLowerCase();
  const orderType = orderMatch[1].toLowerCase();
  const entryStr = entryMatch[1];

  const entryNums = entryStr.split("-").map(Number);
  const minEntry = Math.min(...entryNums);
  const maxEntry = Math.max(...entryNums);

  if (orderType === "limit") {
    if (direction === "long" && minEntry >= currentPrice) {
      const messages = [
        {
          role: "system",
          content:
            "FIX: Long Limit MUST be BELOW current price at a visible structure level. Either Market order OR Limit further BELOW at support/OB. Keep other analysis.",
        },
        {
          role: "user",
          content: `Current ${instrument}: ${currentPrice}\n\n${text}\n\nFIX: Long Limit at ${entryStr} impossible.`,
        },
      ];
      return callOpenAI(model, messages);
    }

    if (direction === "short" && maxEntry <= currentPrice) {
      const messages = [
        {
          role: "system",
          content:
            "FIX: Short Limit MUST be ABOVE current price at a visible structure level. Either Market order OR Limit further ABOVE at resistance/OB. Keep other analysis.",
        },
        {
          role: "user",
          content: `Current ${instrument}: ${currentPrice}\n\n${text}\n\nFIX: Short Limit at ${entryStr} impossible.`,
        },
      ];
      return callOpenAI(model, messages);
    }
  }

  return text;
}

async function enforceEntryFormat(
  model: string,
  instrument: string,
  text: string
): Promise<string> {
  const limitSingleMatch = text.match(
    /Order Type:\s*Limit[\s\S]{0,300}Entry[^:]*:\s*(\d+\.\d+)\s*\([^)]*\)/i
  );
  if (limitSingleMatch && !/-/.test(limitSingleMatch[1])) {
    const messages = [
      {
        role: "system",
        content:
          "FIX: Limit orders MUST use range format for structure zones (e.g., '0.6555-0.6565'), not single point. Convert to range (10-15 pip width).",
      },
      {
        role: "user",
        content: `${instrument}\n\n${text}\n\nFIX: Convert "${limitSingleMatch[1]}" to range.`,
      },
    ];
    return callOpenAI(model, messages);
  }
  return text;
}

function stampM5Used(text: string, used: boolean): string {
  if (!used) return text;
  const stamp = "• Used Chart: 5M execution";
  if (/Option\s*1\s*\(?(Primary)?\)?/i.test(text) && !/Used\s*Chart:\s*5M/i.test(text)) {
    return text.replace(/(Option\s*1[\s\S]*?)(\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i, (m, a, b) =>
      /•\s*Used\s*Chart:\s*5M/i.test(a) ? m : `${a}\n${stamp}\n${b}`
    );
  }
  return text;
}

function stampM1Used(text: string, used: boolean): string {
  if (!used) return text;
  const stamp = "• Used Chart: 1M timing";
  if (/Option\s*1\s*\(?(Primary)?\)?/i.test(text) && !/Used\s*Chart:\s*1M/i.test(text)) {
    return text.replace(/(Option\s*1[\s\S]*?)(\n\s*Option\s*2|\n\s*Full\s*Breakdown|$)/i, (m, a, b) =>
      /•\s*Used\s*Chart:\s*1M/i.test(a) ? m : `${a}\n${stamp}\n${b}`
    );
  }
  return text;
}

function applyConsistencyGuards(
  text: string,
  args: { instrument: string; headlinesSign: number; csmSign: number; calendarSign: number }
): string {
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

  const fundamentalTechnicalConflict = (techBullish && fundyBearish) || (techBearish && fundyBullish);

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

function buildServerProvenanceFooter(args: {
  headlines_provider: string | null;
  calendar_status: "api" | "image-ocr" | "unavailable";
  calendar_provider: string | null;
  csm_time: string | null;
  extras?: Record<string, any>;
}): string {
  const lines = [
    "\n---",
    "Data Provenance:",
    `• Headlines: ${args.headlines_provider || "unknown"}`,
    `• Calendar: ${args.calendar_status}${args.calendar_provider ? ` (${args.calendar_provider})` : ""}`,
    `• CSM: ${args.csm_time || "n/a"}`,
    args.extras ? `• Meta: ${JSON.stringify(args.extras)}` : undefined,
    "---\n",
  ].filter(Boolean);
  return lines.join("\n");
}

// ---------- MANDATORY Output Validation ----------
interface ValidationResult {
  isValid: boolean;
  missing: string[];
}

function validateMandatorySections(text: string): ValidationResult {
  const missing: string[] = [];
  
  if (!/Strategy\s+Tournament\s+Results/i.test(text)) {
    missing.push("Strategy Tournament Results");
  }
  
  if (!/Market\s+Context.*Grade\s*:\s*[ABCD]/i.test(text)) {
    missing.push("Market Context Grade");
  }
  
  if (!/Option\s*1\s*\(.*Primary.*\)/i.test(text)) {
    missing.push("Option 1 (Primary)");
  }
  
  const opt1Block = text.match(/Option\s*1[\s\S]{0,1000}(?=Option\s*2|Full\s+Breakdown|$)/i)?.[0] || "";
  if (opt1Block && !opt1Block.includes("Direction:")) missing.push("Option 1 Direction");
  if (opt1Block && !opt1Block.includes("Entry")) missing.push("Option 1 Entry");
  if (opt1Block && !opt1Block.includes("Stop Loss")) missing.push("Option 1 Stop Loss");
  if (opt1Block && !opt1Block.includes("Conviction")) missing.push("Option 1 Conviction");
  
  if (!/Full\s+Breakdown/i.test(text)) {
    missing.push("Full Breakdown");
  }
  
  const fundBlock = text.match(/Fundamental[^:]*:([^\n]+)/i)?.[1] || "";
  if (fundBlock.toLowerCase().includes("unavailable") && text.includes("synthesized_score")) {
    missing.push("Fundamental synthesis (data exists but showing unavailable)");
  }
  
  return { isValid: missing.length === 0, missing };
}

// ---------- Main API Handler ----------
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Ok | Err>
): Promise<void> {
  try {
    // Method check
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, reason: "Method not allowed" });
    }

    // API key check
    if (!OPENAI_API_KEY) {
      return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });
    }

    const urlMode = String((req.query.mode as string) || "").toLowerCase();
    const debugQuery = String(req.query.debug || "").trim() === "1";

    // ---------- Expand Mode (Cache-based expansion) ----------
    if (urlMode === "expand") {
      const modelExpand = pickModelFromFields(req);
      const cacheKey = String(req.query.cache || "").trim();
      const c = getCache(cacheKey);

      if (!c) {
        return res
          .status(400)
          .json({ ok: false, reason: "Expand failed: cache expired or not found." });
      }

      const dateStr = new Date().toISOString().slice(0, 10);
      const provHint = {
        headlines_present: !!c.headlinesText,
        calendar_status: c.calendar ? "image-ocr" : "unavailable",
      };

      const messages = messagesFull({
        instrument: c.instrument,
        dateStr,
        m15: c.m15,
        h1: c.h1,
        h4: c.h4,
        m5: c.m5 || null,
        m1: null,
        currentPrice: null,
        calendarDataUrl: c.calendar || undefined,
        headlinesText: c.headlinesText || undefined,
        sentimentText: c.sentimentText || undefined,
        calendarAdvisory: {
          warningMinutes: null,
          biasNote: null,
          advisoryText: null,
          evidence: [],
        },
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
      return res.status(200).json({
        ok: true,
        text,
        meta: { instrument: c.instrument, cacheKey, model: modelExpand, vp_version: VP_VERSION },
      });
    }

    // ---------- Multipart Check ----------
    if (!isMultipart(req)) {
      return res.status(400).json({
        ok: false,
        reason:
          "Use multipart/form-data with files: m15, h1, h4 and optional 'calendar'/'m5'/'m1'. Or pass m15Url/h1Url/h4Url and optional 'calendarUrl'/'m5Url'/'m1Url'. Include 'instrument'.",
      });
    }

    const { fields, files } = await parseMultipart(req);

    const MODEL = pickModelFromFields(req, fields);
    const rawInstr = String(fields.instrument || fields.code || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");

    if (!rawInstr) {
      return res.status(400).json({
        ok: false,
        reason: "Missing 'instrument'. Provide instrument code (e.g., EURUSD).",
      });
    }
    const instrument = rawInstr;

    // Scalping mode detection
    const scalpingRaw = String(pickFirst(fields.scalping) || "").trim().toLowerCase();
    const scalpingHardRaw = String(pickFirst(fields.scalping_hard) || "").trim().toLowerCase();

    const scalpingMode =
      scalpingHardRaw === "1" || scalpingHardRaw === "true" || scalpingHardRaw === "on"
        ? "hard"
        : scalpingRaw === "1" || scalpingRaw === "true" || scalpingRaw === "on"
          ? "soft"
          : "off";

    // Debug toggle
    const debugField = String(pickFirst(fields.debug) || "").trim() === "1";
    const debugOCR = debugQuery || debugField;

    // ---------- File and URL Processing ----------
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

    // Process files and URLs in parallel
    const [m1FromFile, m5FromFile, m15FromFile, h1FromFile, h4FromFile, calFromFile] =
      await Promise.all([
        m1f ? fileToDataUrl(m1f) : Promise.resolve(null),
        m5f ? fileToDataUrl(m5f) : Promise.resolve(null),
        fileToDataUrl(m15f),
        fileToDataUrl(h1f),
        fileToDataUrl(h4f),
        calF ? fileToDataUrl(calF) : Promise.resolve(null),
      ]);

    const [m1FromUrl, m5FromUrl, m15FromUrl, h1FromUrl, h4FromUrl, calFromUrl] =
      await Promise.all([
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

    // Chart requirements validation
    if (scalpingMode === "hard") {
      if (!m15 || !m5) {
        return res.status(400).json({
          ok: false,
          reason:
            "Hard scalping requires: 15M + 5M minimum. 1M highly recommended. 1H/4H optional for bias.",
        });
      }
    } else {
      if (!m15 || !h1 || !h4) {
        return res.status(400).json({
          ok: false,
          reason:
            "Provide all three charts: m15, h1, h4 — either files or TV/Gyazo image links. (5m/1m optional)",
        });
      }
    }

    // ---------- Headlines Processing ----------
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

    // ---------- Calendar Processing ----------
    let calendarStatus: "image-ocr" | "api" | "unavailable" = "unavailable";
    let calendarProvider: string | null = null;
    let calendarText: string | null = null;
    let calendarEvidence: string[] = [];
    let warningMinutes: number | null = null;
    let biasNote: string | null = null;
    let advisoryText: string | null = null;
    let debugRows: any[] | null = null;

    let calDataUrlForPrompt: string | null = calUrlOrig;

    if (calUrlOrig) {
      console.log("[CALENDAR] Processing image via OCR");
      const ocr = await ocrCalendarFromImage(MODEL, calUrlOrig).catch((err) => {
        console.error("[vision-plan] Calendar OCR error:", err?.message || err);
        return null;
      });

      if (ocr && Array.isArray(ocr.items) && ocr.items.length > 0) {
        console.log(`[vision-plan] OCR extracted ${ocr.items.length} calendar rows`);
        const analysis = analyzeCalendarProfessional(ocr.items, instrument);
        calendarProvider = "image-ocr";
        calendarStatus = "image-ocr";
        calendarText = analysis.reasoning[0];
        calendarEvidence = analysis.evidence;
        biasNote = analysis.reasoning.join("; ");
        advisoryText = analysis.details;
        calDataUrlForPrompt = calUrlOrig;

        // High-impact event warning
        const nowMs = Date.now();
        for (const it of ocr.items) {
          if (it?.impact === "High" && it?.timeISO) {
            const t = Date.parse(it.timeISO);
            if (isFinite(t) && t >= nowMs) {
              const mins = Math.floor((t - nowMs) / 60000);
              if (mins <= 60)
                warningMinutes = warningMinutes == null ? mins : Math.min(warningMinutes, mins);
            }
          }
        }

        if (debugOCR || debugQuery || debugField) {
          debugRows = ocr.items.slice(0, 5).map((r) => ({
            timeISO: r.timeISO || null,
            title: r.title || null,
            currency: r.currency || null,
            impact: r.impact || null,
            actual: r.actual ?? null,
            forecast: r.forecast ?? null,
            previous: r.previous ?? null,
          }));
        }
      } else {
        console.warn("[vision-plan] Calendar OCR failed or returned no data");
        calendarProvider = "image-ocr-failed";
        calendarStatus = "unavailable";
        calendarText =
          "Calendar: Unable to extract data from image. Please ensure calendar image is clear and contains economic events.";
        calendarEvidence = [`Calendar image processing failed for ${instrument}`];
        biasNote = null;
        advisoryText =
          "📊 Technical Analysis Focus: Calendar data unavailable. Analysis based on price action and sentiment only.";
        warningMinutes = null;
        calDataUrlForPrompt = calUrlOrig;
      }
    } else {
      console.log("[vision-plan] No calendar image provided");
      calendarProvider = null;
      calendarStatus = "unavailable";
      calendarText = "Calendar: No calendar image provided";
      calendarEvidence = [`No calendar data for ${instrument} analysis`];
      biasNote = null;
      advisoryText = "📊 Upload calendar image for fundamental analysis enhancement";
      warningMinutes = null;
      calDataUrlForPrompt = null;
    }

    // ---------- Sentiment & CSM ----------
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
    const { text: sentimentText } = sentimentSummary(csm, cotCue, hBias);

    // ---------- Live Price with Quality Metrics ----------
    const livePrice = await fetchLivePrice(instrument);
    const livePriceDetails = await fetchLivePriceConsensus(instrument);

    // Warn if price is stale
    if (livePriceDetails) {
      if (livePriceDetails.maxAge > 5000) {
        console.warn(
          `[PRICE WARNING] ${instrument} price is ${livePriceDetails.maxAge}ms old - may be stale for live trading`
        );
      }
      if (livePriceDetails.confidence < 70) {
        console.warn(
          `[PRICE WARNING] ${instrument} price consensus confidence only ${livePriceDetails.confidence}% - sources disagree`
        );
      }
    }

    const dateStr = new Date().toISOString().slice(0, 10);

    // ---------- Fundamental Bias Synthesis ----------
    const calendarSign = parseInstrumentBiasFromNote(biasNote);
    const csmData = computeCSMInstrumentSign(csm, instrument);

    const fundamentalBias = synthesizeFundamentalBias(calendarSign, hBias, csmData, cotCue);

    // For backwards compatibility
    const headlinesSign = computeHeadlinesSign(hBias);

    // Log fundamental analysis
    if (process.env.NODE_ENV !== "production") {
      console.log(`[FUNDAMENTAL] ${instrument}:`, fundamentalBias.reasoning.join(" | "));
    }

    const provForModel = {
      headlines_present: !!headlinesText,
      calendar_status: calendarStatus,
      fundamental_bias: fundamentalBias,
      fundamentals_hint: {
        calendar_sign: calendarSign,
        headlines_label: hBias.label,
        csm_diff: csmData.zdiff,
        cot_cue_present: !!cotCue,
        synthesized_score: fundamentalBias.score,
        synthesized_label: fundamentalBias.label,
      },
      proximity_flag: warningMinutes != null ? 1 : 0,
      scalping_mode: !!scalpingMode,
    };

    // ---------- Full Analysis ----------
    const messages = messagesFull({
      instrument,
      dateStr,
      m15: m15!,
      h1: h1 || "",
      h4: h4 || "",
      m5,
      m1,
      currentPrice: livePrice || undefined,
      calendarDataUrl: calDataUrlForPrompt || undefined,
      calendarText: !calDataUrlForPrompt && calendarText ? calendarText : undefined,
      headlinesText: headlinesText || undefined,
      sentimentText,
      calendarAdvisory: {
        warningMinutes,
        biasNote,
        advisoryText,
        evidence: calendarEvidence || [],
        debugRows: debugOCR ? debugRows || [] : [],
      },
      provenance: provForModel,
      scalpingMode,
    });

    // Add live price hint
    if (livePrice && scalpingMode === "hard") {
      (messages[0] as any).content =
        (messages[0] as any).content +
        `\n\n**HARD SCALPING PRICE LOCK**: ${instrument} is EXACTLY at ${livePrice} RIGHT NOW. For market orders, entry = ${livePrice} (no rounding). For limit orders, max 5 pips away. Entry MUST reference visible structure. SL must be 5-8 pips behind structure. TP1 = 8-12 pips at structure, TP2 = 12-18 pips at structure.`;
    } else if (livePrice) {
      (messages[0] as any).content =
        (messages[0] as any).content +
        `\n\n**CRITICAL PRICE CHECK**: Current ${instrument} price is EXACTLY ${livePrice}. You MUST report this exact price in ai_meta.currentPrice. Entry suggestions must reference visible structure levels from charts.`;
    }

  // ---------- STAGE 1: Analysis (Tournament + Context + Chart Reading) ----------
    const stage1Messages = [
      { 
        role: "system", 
        content: `Professional FX trader analyzing charts. Output ONLY these sections:

**Strategy Tournament Results:**
[Score all 5 strategies with detection checklists]

**Market Context Assessment:**
- Move Maturity: [pips from swing]
- Structural Position: [quality]
- Market Regime: [trending/ranging]
- CONTEXT GRADE: [A/B/C/D]

**Chart Analysis:**
- 4H: [5-step protocol results]
- 1H: [5-step protocol results]  
- 15M: [5-step protocol results]

**Fundamental Summary:**
- Calendar: ${fundamentalBias.breakdown.calendar}/100
- Headlines: ${fundamentalBias.breakdown.headlines}/100
- CSM: ${fundamentalBias.breakdown.csm}/100
- Overall: ${fundamentalBias.label} (${fundamentalBias.score})

NO trade options yet. Analysis only.`
      },
      {
        role: "user",
        content: buildUserPartsBase({
          instrument, dateStr, m15: m15!, h1: h1 || "", h4: h4 || "",
          m5, m1, currentPrice: livePrice || null,
          calendarDataUrl: calDataUrlForPrompt, calendarText, headlinesText, sentimentText,
          calendarAdvisoryText: advisoryText, calendarEvidence, debugOCRRows: debugOCR ? debugRows || [] : []
        })
      }
    ];
    
    const stage1Text = await callOpenAI(MODEL, stage1Messages);
    
    // Validate Stage 1
    if (!/Market\s+Context.*Grade\s*:\s*[ABCD]/i.test(stage1Text)) {
      console.error("[STAGE1] Missing Market Context Grade");
      return res.status(500).json({
        ok: false,
        reason: "Analysis failed: Could not determine market context grade. Please regenerate."
      });
    }
    
    // ---------- STAGE 2: Trade Options (Using Stage 1 Analysis) ----------
    const stage2Messages = [
      {
        role: "system",
        content: `Generate trade options based on analysis provided.

Output format:

**Option 1 (Primary)**
- Direction: [Long/Short]
- Order Type: [Limit/Stop/Market]
- Entry: [price range with structure reference]
- Stop Loss: [price (buffer pips direction TF swing at price)]
- TP1: [price (structure)], TP2: [price (structure)]
- Conviction: [%]

**Option 2 (Alternative)**
[Same format, 10-25% lower conviction]

**Full Breakdown**
- Technical: [Summary from analysis]
- Fundamental: ${fundamentalBias.label} (${fundamentalBias.score})
- Tech vs Fundy: [Match/Mismatch]

\`\`\`json
ai_meta
{
  "currentPrice": ${livePrice || 'UNREADABLE'},
  "trade_id": "${uuid()}",
  "strategy_used": "[from tournament]",
  "risk_grade": "[from context]"
}
\`\`\``
      },
      {
        role: "user",
        content: `Based on this analysis, generate trade options:

${stage1Text}

Current Price: ${livePrice}
Fundamental Bias: ${fundamentalBias.label}

Generate Option 1 and Option 2.`
      }
    ];
    
    const stage2Text = await callOpenAI(MODEL, stage2Messages);
    
    // Combine stages
    let textFull = `${stage1Text}\n\n${stage2Text}`;
    let aiMetaFull = extractAiMeta(textFull) || {};
    
    // CRITICAL: Validate response has all required sections
    let validation = validateMandatorySections(textFull);
    let retryCount = 0;
    
    while (!validation.isValid && retryCount < 2) {
      retryCount++;
      console.error(`[VALIDATION] Attempt ${retryCount} missing:`, validation.missing.join(", "));
      
    const fixMessages = [
        { 
          role: "system", 
          content: `You are fixing an incomplete trading analysis. You MUST include these exact section headers:

**Market Context Assessment:**
- Move Maturity: [state it]
- CONTEXT GRADE: [A/B/C/D]

**Strategy Tournament Results:**
[List all 5 strategies with scores]

**Option 1 (Primary)**
- Direction:
- Entry:
- Stop Loss:
- Conviction:

**Full Breakdown**
- Fundamental: [Use CSM data provided - never say unavailable]

NO OTHER FORMAT ACCEPTED. Start response with "**Market Context Assessment:**"`
        },
        { 
          role: "user", 
          content: `Missing sections: ${validation.missing.join(", ")}

Here is the data you need to complete this:
- Instrument: ${instrument}
- Current Price: ${livePrice || 'check charts'}
- Fundamental Bias: ${fundamentalBias.label} (score: ${fundamentalBias.score})
- CSM: ${csm.ranks.slice(0,3).join('>')}

Previous incomplete attempt had these charts already analyzed. Build the COMPLETE response with ALL required sections.

Start with: **Market Context Assessment:**` 
        }
      ];
      
      textFull = await callOpenAI(MODEL, fixMessages);
      aiMetaFull = extractAiMeta(textFull) || {};
      validation = validateMandatorySections(textFull);
    }
    
    if (!validation.isValid) {
      console.error(`[VALIDATION] Failed after retries. Missing:`, validation.missing);
      return res.status(500).json({
        ok: false,
        reason: `Analysis incomplete. Missing: ${validation.missing.join(", ")}. Regenerate required.`
      });
    }

    // ---------- Price Validation ----------
    if (livePrice) {
      const modelPrice = Number(aiMetaFull?.currentPrice);

      if (!isFinite(modelPrice) || modelPrice <= 0) {
        console.warn(
          `[VISION-PLAN] Model failed to report currentPrice, injecting live price ${livePrice}`
        );
        aiMetaFull.currentPrice = livePrice;
      } else {
        const config = getInstrumentConfig(instrument);

        // Instrument-specific validation
        if (config.type === "crypto") {
          const percentDiff = Math.abs((modelPrice - livePrice) / livePrice);
          if (percentDiff > 0.05) {
            console.error(
              `[VISION-PLAN] Crypto price mismatch: Reported=${modelPrice}, Actual=${livePrice}, Diff=${(percentDiff * 100).toFixed(1)}%`
            );
            return res.status(400).json({
              ok: false,
              reason: `Price reading error: Model read ${modelPrice} but actual is ${livePrice} (${(percentDiff * 100).toFixed(1)}% difference).`,
            });
          }
        } else if (config.type === "commodity") {
          const dollarDiff = Math.abs(modelPrice - livePrice);
          if (dollarDiff > 10) {
            console.error(
              `[VISION-PLAN] Commodity price mismatch: Reported=${modelPrice}, Actual=${livePrice}, Diff=$${dollarDiff.toFixed(2)}`
            );
            return res.status(400).json({
              ok: false,
              reason: `Price reading error: Model read ${modelPrice} but actual is ${livePrice} ($${dollarDiff.toFixed(2)} difference).`,
            });
          }
        } else if (config.type === "index") {
          const pointDiff = Math.abs(modelPrice - livePrice);
          if (pointDiff > 50) {
            console.error(
              `[VISION-PLAN] Index price mismatch: Reported=${modelPrice}, Actual=${livePrice}, Diff=${pointDiff.toFixed(1)} points`
            );
            return res.status(400).json({
              ok: false,
              reason: `Price reading error: Model read ${modelPrice} but actual is ${livePrice} (${pointDiff.toFixed(1)} points difference).`,
            });
          }
        } else {
          // FX pairs (pip-based)
          const pipDiff = calculatePipDistance(modelPrice, livePrice, instrument);
          const maxPipDiff = 5;

          if (pipDiff > maxPipDiff) {
            console.error(
              `[VISION-PLAN] FX price mismatch: Reported=${modelPrice}, Actual=${livePrice}, Diff=${pipDiff.toFixed(1)} pips`
            );
            return res.status(400).json({
              ok: false,
              reason: `Price reading error: Model read ${modelPrice} but actual is ${livePrice} (${pipDiff.toFixed(1)} pips difference).`,
            });
          }
        }
      }
    }

    if (
      livePrice &&
      (aiMetaFull.currentPrice == null || !isFinite(Number(aiMetaFull.currentPrice)))
    ) {
      aiMetaFull.currentPrice = livePrice;
    }

    // ---------- Enforcement ----------
    textFull = await enforceOption1(MODEL, instrument, textFull);
    textFull = await enforceOption2(MODEL, instrument, textFull);
    textFull = await enforceStrategyTournament(MODEL, instrument, textFull);

    // Validate order logic and entry format
    if (livePrice) {
      textFull = await validateOrderTypeLogic(MODEL, instrument, textFull, livePrice);
    }
    textFull = await enforceEntryFormat(MODEL, instrument, textFull);

    // ---------- Directional Consistency Check ----------
    const dirMatches = textFull.matchAll(/Direction:\s*(Long|Short)/gi);
    const directions = Array.from(dirMatches).map((m) => m[1].toLowerCase());
    if (directions.length >= 2) {
      const allLong = directions.every((d) => d === "long");
      const allShort = directions.every((d) => d === "short");
      if (!allLong && !allShort) {
        console.error(`[VISION-PLAN] Directional conflict: ${directions.join(", ")}`);
        return res.status(400).json({
          ok: false,
          reason: `Analysis quality error: Conflicting trade directions detected (${directions.join(" vs ")}). System generated inconsistent recommendations. Please regenerate.`,
        });
      }
    }

    // ---------- Entry and R:R Validation ----------
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

        // Entry reasonableness check
        for (const entry of entries) {
          if (isFinite(entry) && entry > 0) {
            const pctDiff = Math.abs((entry - livePrice) / livePrice);
            const maxDiff = scalpingMode === "hard" ? 0.08 : 0.2;

            if (pctDiff > 0.5) {
              return res.status(400).json({
                ok: false,
                reason: `Entry too far from current price: ${entry} vs live ${livePrice} (${(pctDiff * 100).toFixed(1)}% away). Charts may be stale.`,
              });
            }

            if (pctDiff > maxDiff) {
              console.warn(
                `[VISION-PLAN] Entry distant from current: Live=${livePrice}, Entry=${entry}, Diff=${(pctDiff * 100).toFixed(1)}%`
              );
            }
          }
        }

        // Limit order direction validation
        if (orderType === "limit") {
          if (direction === "long" && avgEntry >= livePrice) {
            console.error(
              `[VISION-PLAN] IMPOSSIBLE Long Limit: ${avgEntry} at/above current ${livePrice}`
            );
            return res.status(400).json({
              ok: false,
              reason: `IMPOSSIBLE ORDER: Long Limit at ${avgEntry} must be BELOW current price ${livePrice}. Use Market order OR Limit BELOW at visible support/OB.`,
            });
          }

          if (direction === "short" && avgEntry <= livePrice) {
            console.error(
              `[VISION-PLAN] IMPOSSIBLE Short Limit: ${avgEntry} at/below current ${livePrice}`
            );
            return res.status(400).json({
              ok: false,
              reason: `IMPOSSIBLE ORDER: Short Limit at ${avgEntry} must be ABOVE current price ${livePrice}. Use Market order OR Limit ABOVE at visible resistance/OB.`,
            });
          }

          // Warn if too close
          const minDistance = scalpingMode === "hard" ? 0.0005 : 0.0015;
          const priceDistance = Math.abs(avgEntry - livePrice) / livePrice;
          if (priceDistance < minDistance) {
            console.warn(
              `[VISION-PLAN] Limit order close to market: ${avgEntry} vs ${livePrice} (${(priceDistance * 10000).toFixed(1)} pips)`
            );
          }
        }
      }
    }

    // R:R validation
    const entryMatches = textFull.matchAll(/Entry[^:]*:\s*(\d+\.\d+)/gi);
    const slMatches = textFull.matchAll(/Stop Loss[^:]*:\s*(\d+\.\d+)/gi);
    const tpMatches = textFull.matchAll(/TP1[^:]*(\d+\.\d+)/gi);

    if (entryMatches && slMatches && tpMatches) {
      const entries = Array.from(entryMatches).map((m) => Number(m[1]));
      const stops = Array.from(slMatches).map((m) => Number(m[1]));
      const tps = Array.from(tpMatches).map((m) => Number(m[1]));

      for (let i = 0; i < Math.min(entries.length, stops.length, tps.length); i++) {
        const risk = Math.abs(entries[i] - stops[i]);
        const reward = Math.abs(tps[i] - entries[i]);
        const ratio = reward / risk;

        if (ratio < 1.5) {
          console.error(`[VISION-PLAN] Trade ${i + 1} R:R too low: ${ratio.toFixed(2)}:1`);
          return res.status(400).json({
            ok: false,
            reason: `Trade option ${i + 1} has poor risk-reward ratio: ${ratio.toFixed(2)}:1 (minimum 1.5:1 required). Entry: ${entries[i]}, SL: ${stops[i]}, TP1: ${tps[i]}`,
          });
        }
      }
    }

    // ---------- Stamping and Consistency ----------
    const usedM5Full = !!m5 && /(\b5m\b|\b5\-?min|\b5\s*minute)/i.test(textFull);
    textFull = stampM5Used(textFull, usedM5Full);
    const usedM1Full = !!m1 && /(\b1m\b|\b1\-?min|\b1\s*minute)/i.test(textFull);
    textFull = stampM1Used(textFull, usedM1Full);

    textFull = applyConsistencyGuards(textFull, {
      instrument,
      headlinesSign: headlinesSign,
      csmSign: csmData.sign,
      calendarSign: calendarSign,
    });

    // ---------- Footer and Response ----------
    const footer = buildServerProvenanceFooter({
      headlines_provider: headlinesProvider || "unknown",
      calendar_status: calendarStatus,
      calendar_provider: calendarProvider,
      csm_time: csm.tsISO,
      extras: {
        vp_version: VP_VERSION,
        model: MODEL,
        debug_ocr: !!debugOCR,
        scalping_mode: scalpingMode,
        fundamental_synthesis: fundamentalBias.label,
        price_sources: livePriceDetails?.sources.length || 0,
        price_confidence: livePriceDetails?.confidence || 0,
      },
    });
    textFull = `${textFull}\n${footer}`;

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text: textFull,
      meta: {
        instrument,
        vp_version: VP_VERSION,
        model: MODEL,
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
        fundamentalBias: {
          score: fundamentalBias.score,
          label: fundamentalBias.label,
          confidence: fundamentalBias.confidence,
          breakdown: fundamentalBias.breakdown,
        },
        priceQuality: livePriceDetails
          ? {
              consensus: livePriceDetails.consensus,
              confidence: livePriceDetails.confidence,
              maxAge: livePriceDetails.maxAge,
              sources: livePriceDetails.sources.length,
            }
          : null,
      },
    });
  } catch (err: any) {
    console.error("[VISION-PLAN] Handler error:", err);
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}
