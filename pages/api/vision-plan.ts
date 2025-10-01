// /pages/api/vision-plan.ts
/**
 * Professional FX Trading Analysis - Production v3.0
 * Full fundamental analysis + Institutional chart reading
 */

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";

export const config = { api: { bodyParser: false, sizeLimit: "25mb" } };

type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

const VP_VERSION = "2025-10-01-production-v3.0-full";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const MODEL = "gpt-4o";

const TD_KEY = process.env.TWELVEDATA_API_KEY || "";
const FH_KEY = process.env.FINNHUB_API_KEY || "";
const POLY_KEY = process.env.POLYGON_API_KEY || "";

function uuid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

async function callOpenAI(model: string, messages: any[]) {
  const body = { model, messages, temperature: 0 };
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  const json = await rsp.json().catch(() => ({}));
  if (!rsp.ok) throw new Error(`OpenAI failed: ${rsp.status}`);
  return String(json?.choices?.[0]?.message?.content || "");
}

function tryParseJson(s: string): any | null {
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const raw = fence ? fence[1] : s;
  try { return JSON.parse(raw); } catch { return null; }
}

function parseNumLoose(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  let s = String(v).trim().toLowerCase().replace(/,/g, "").replace(/\s+/g, "").replace(/\u2212/g, "-");
  if (!s || s === "n/a" || s === "na" || s === "-" || s === "—") return null;
  let mult = 1;
  if (s.endsWith("%")) s = s.slice(0, -1);
  if (s.endsWith("k")) { mult = 1_000; s = s.slice(0, -1); }
  else if (s.endsWith("m")) { mult = 1_000_000; s = s.slice(0, -1); }
  else if (s.endsWith("b")) { mult = 1_000_000_000; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n * mult : null;
}

async function processImageToDataUrl(buf: Buffer): Promise<string> {
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

async function getFormidable() { 
  const mod: any = await import("formidable"); 
  return mod.default || mod; 
}

function isMultipart(req: NextApiRequest) { 
  return String(req.headers["content-type"] || "").includes("multipart/form-data"); 
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

async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p = file.filepath || file.path || file._writeStream?.path;
  if (!p) return null;
  const raw = await fs.readFile(p);
  return processImageToDataUrl(raw);
}

async function linkToDataUrl(url: string): Promise<string | null> {
  if (!url) return null;
  try {
    const r1 = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "follow" });
    if (!r1.ok) return null;
    
    const contentType = String(r1.headers.get("content-type") || "").toLowerCase();
    const buf1 = Buffer.from(await r1.arrayBuffer());
    
    if (contentType.includes("image/")) {
      return `data:image/jpeg;base64,${buf1.toString("base64")}`;
    }
    
    const html = buf1.toString("utf8");
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (!ogMatch) return null;
    
    const imageUrl = ogMatch[1];
    const r2 = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) });
    if (!r2.ok) return null;
    
    const buf2 = Buffer.from(await r2.arrayBuffer());
    return `data:image/jpeg;base64,${buf2.toString("base64")}`;
  } catch {
    return null;
  }
}

// ---------- STAGE 1: PROFESSIONAL CHART READING ----------
interface ChartData {
  h4: { left: number; right: number; recent_high: number; recent_low: number; bias: string };
  h1: { left: number; right: number; recent_high: number; recent_low: number; bias: string; vs_h4: string };
  m15: { left: number; right: number; recent_high: number; recent_low: number; context: string };
  primary_direction: "LONG" | "SHORT";
  current_price: number;
  move_pips: number;
}

async function stage1_extractCharts(
  m15: string,
  h1: string,
  h4: string,
  instrument: string,
  livePrice: number | null
): Promise<ChartData> {
  const systemPrompt = `Professional chart analyst. Read charts EXACTLY like an institutional trader.

STEP-BY-STEP READING PROTOCOL:

1. LOCATE PRICE SCALE (right edge)
2. READ LEFT EDGE PRICE (where chart begins)
3. READ RIGHT EDGE PRICE (current price)
4. CALCULATE NET MOVEMENT (right - left in pips)

5. IDENTIFY TREND STRUCTURE:
   - Find last 3 swing HIGHS (rightmost peaks, ignore old highs from left 50% of chart)
   - Find last 3 swing LOWS (rightmost troughs, ignore old lows from left 50% of chart)
   - Recent = within last 20-30 candles on RIGHT side
   
6. DETERMINE BIAS:
   - If highs ascending AND lows ascending = BULLISH
   - If highs descending AND lows descending = BEARISH
   - If right edge significantly higher than left (>100 pips) = BULLISH
   - If right edge significantly lower than left (>100 pips) = BEARISH
   
7. VISUAL CONFIRMATION:
   - Look at overall left-to-right slope
   - Upward slope = BULLISH
   - Downward slope = BEARISH

8. FORCE DECISION - NO NEUTRAL ALLOWED

OUTPUT JSON:
{
  "h4": {
    "left": <price at leftmost candle>,
    "right": <price at rightmost candle>,
    "recent_high": <highest peak in last 20-30 candles>,
    "recent_low": <lowest trough in last 20-30 candles>,
    "bias": "BULLISH|BEARISH"
  },
  "h1": {
    "left": <price>,
    "right": <price>,
    "recent_high": <peak>,
    "recent_low": <trough>,
    "bias": "BULLISH|BEARISH",
    "vs_h4": "CONFIRMS|CONFLICTS"
  },
  "m15": {
    "left": <price>,
    "right": <price>,
    "recent_high": <peak in last 15-20 candles>,
    "recent_low": <trough in last 15-20 candles>,
    "context": "UPTREND|DOWNTREND|RANGING"
  },
  "primary_direction": "LONG|SHORT",
  "current_price": <rightmost price>,
  "move_pips": <distance from swing low/high to current>
}

${instrument} | Live: ${livePrice || "read from chart"}

CRITICAL: Focus on RECENT structure (right 30% of chart). Old highs/lows from weeks ago are irrelevant. Choose BULLISH or BEARISH, never neutral.`;

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: "Read these charts like a professional trader. Focus on RECENT price action." },
        { type: "text", text: "4H:" },
        { type: "image_url", image_url: { url: h4 } },
        { type: "text", text: "1H:" },
        { type: "image_url", image_url: { url: h1 } },
        { type: "text", text: "15M:" },
        { type: "image_url", image_url: { url: m15 } },
        { type: "text", text: "JSON only. BULLISH or BEARISH - force a decision." },
      ],
    },
  ];

  const response = await callOpenAI(MODEL, messages);
  const parsed = tryParseJson(response);

  if (!parsed?.h4?.left || !parsed?.current_price) {
    throw new Error("Stage 1 failed: Invalid chart reading");
  }

  if (parsed.h4.recent_high < parsed.h4.recent_low) {
    console.warn("[STAGE 1] Chart misread: high < low");
  }

  if (livePrice) {
    const diff = Math.abs(parsed.current_price - livePrice);
    const pipValue = instrument.includes("JPY") ? 0.01 : 0.0001;
    const pipDiff = diff / pipValue;
    
    if (pipDiff > 10) {
      console.log(`[STAGE 1] Using live ${livePrice} instead of chart ${parsed.current_price} (${pipDiff.toFixed(0)} pips off)`);
      parsed.current_price = livePrice;
    }
  }

  return parsed as ChartData;
}

// ---------- REAL MARKET DATA ----------
async function fetchLivePrice(pair: string): Promise<number | null> {
  if (TD_KEY) {
    try {
      const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
      const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&dp=5`, 
        { cache: "no-store", signal: AbortSignal.timeout(2000) });
      const j: any = await r.json();
      const p = Number(j?.price);
      if (isFinite(p) && p > 0) return p;
    } catch {}
  }
  
  if (FH_KEY) {
    try {
      const sym = `OANDA:${pair.slice(0, 3)}_${pair.slice(3)}`;
      const to = Math.floor(Date.now() / 1000);
      const r = await fetch(`https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(sym)}&resolution=15&from=${to-3600}&to=${to}&token=${FH_KEY}`,
        { cache: "no-store", signal: AbortSignal.timeout(2000) });
      const j: any = await r.json();
      if (j?.s === "ok" && Array.isArray(j?.c) && j.c.length > 0) {
        const last = Number(j.c[j.c.length - 1]);
        if (isFinite(last) && last > 0) return last;
      }
    } catch {}
  }
  
  return null;
}

type Series = { t: number[]; c: number[] };
const G8 = ["USD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD"];
const USD_PAIRS = ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDJPY", "USDCHF", "USDCAD"];

async function tdSeries15(pair: string): Promise<Series | null> {
  if (!TD_KEY) return null;
  try {
    const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=15min&outputsize=30&apikey=${TD_KEY}`,
      { cache: "no-store", signal: AbortSignal.timeout(2500) });
    const j: any = await r.json();
    if (!Array.isArray(j?.values)) return null;
    const vals = [...j.values].reverse();
    return {
      t: vals.map((v: any) => new Date(v.datetime).getTime() / 1000),
      c: vals.map((v: any) => Number(v.close))
    };
  } catch { return null; }
}

async function fhSeries15(pair: string): Promise<Series | null> {
  if (!FH_KEY) return null;
  try {
    const sym = `OANDA:${pair.slice(0, 3)}_${pair.slice(3)}`;
    const to = Math.floor(Date.now() / 1000);
    const r = await fetch(`https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(sym)}&resolution=15&from=${to-21600}&to=${to}&token=${FH_KEY}`,
      { cache: "no-store", signal: AbortSignal.timeout(2500) });
    const j: any = await r.json();
    if (j?.s === "ok") return { t: j.t, c: j.c.map(Number) };
  } catch {}
  return null;
}

async function fetchSeries15(pair: string): Promise<Series | null> {
  const td = await tdSeries15(pair);
  if (td) return td;
  return await fhSeries15(pair);
}

function kbarReturn(closes: number[], k: number): number | null {
  if (!closes || closes.length <= k) return null;
  const a = closes[closes.length - 1];
  const b = closes[closes.length - 1 - k];
  if (!(a > 0) || !(b > 0)) return null;
  return Math.log(a / b);
}

async function getCSM(): Promise<{ ranks: string[]; scores: Record<string, number> }> {
  const seriesMap: Record<string, Series | null> = {};
  await Promise.all(USD_PAIRS.map(async (p) => { seriesMap[p] = await fetchSeries15(p); }));
  
  const curScore: Record<string, number> = Object.fromEntries(G8.map((c) => [c, 0]));
  for (const pair of USD_PAIRS) {
    const S = seriesMap[pair];
    if (!S || S.c.length < 17) continue;
    const r1h = kbarReturn(S.c, 4) ?? 0;
    const r4h = kbarReturn(S.c, 16) ?? 0;
    const r = r1h * 0.6 + r4h * 0.4;
    curScore[pair.slice(0, 3)] += r;
    curScore[pair.slice(3)] -= r;
  }
  
  const vals = G8.map((c) => curScore[c]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
  const z: Record<string, number> = {};
  for (const c of G8) z[c] = (curScore[c] - mean) / sd;
  
  return {
    ranks: [...G8].sort((a, b) => z[b] - z[a]),
    scores: z
  };
}

async function fetchHeadlines(instrument: string): Promise<{ items: any[]; bias: string }> {
  try {
    const r = await fetch(`/api/news?instrument=${encodeURIComponent(instrument)}&hours=48&max=12`, { cache: "no-store" });
    const j = await r.json();
    const items = Array.isArray(j?.items) ? j.items : [];
    
   const scores = items
      .map((h: any) => typeof h?.sentiment?.score === "number" ? Number(h.sentiment.score) : null)
      .filter((s: any) => s !== null) as number[];
    
    if (scores.length === 0) return { items: [], bias: "unavailable" };
    
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const bias = avg > 0.015 ? "bullish" : avg < -0.015 ? "bearish" : "neutral";
    
    return { items, bias };
  } catch {
    return { items: [], bias: "unavailable" };
  }
}

// ---------- CALENDAR OCR & INSTITUTIONAL ANALYSIS ----------
type OcrCalendarRow = {
  timeISO: string | null;
  title: string | null;
  currency: string | null;
  impact: string | null;
  actual: any;
  forecast: any;
  previous: any;
};

async function ocrCalendar(calendarDataUrl: string): Promise<{ items: OcrCalendarRow[] } | null> {
  const sys = `Economic calendar OCR. Extract ALL data including grey/muted text.

JSON output:
{
  "items": [
    {
      "timeISO": "ISO8601 or null",
      "title": "event name",
      "currency": "USD|EUR|GBP|JPY|etc",
      "impact": "Low|Medium|High",
      "actual": <number or percentage or null>,
      "forecast": <number or percentage or null>,
      "previous": <number or percentage or null>
    }
  ]
}

Extract percentages (0.5%), decimals (<0.50%), and regular numbers. Grey text is valid data. Empty cells = null.`;

  const msg = [
    { role: "system", content: sys },
    { role: "user", content: [
      { type: "text", text: "Extract all calendar rows. JSON only." },
      { type: "image_url", image_url: { url: calendarDataUrl } }
    ]}
  ];

  const text = await callOpenAI(MODEL, msg);
  const parsed = tryParseJson(text);
  
  if (!parsed?.items || !Array.isArray(parsed.items)) return null;
  
  return {
    items: parsed.items.map((r: any) => ({
      timeISO: r?.timeISO || null,
      title: r?.title || null,
      currency: String(r?.currency || "").toUpperCase().slice(0, 3) || null,
      impact: r?.impact || null,
      actual: r?.actual ?? null,
      forecast: r?.forecast ?? null,
      previous: r?.previous ?? null
    }))
  };
}

function goodIfHigher(title: string): boolean | null {
  const t = title.toLowerCase();
  if (/(cpi|core cpi|ppi|inflation)/.test(t)) return true;
  if (/(gdp|retail sales|industrial production|consumer credit|housing starts|durable goods)/.test(t)) return true;
  if (/(pmi|ism|confidence|sentiment)/.test(t)) return true;
  if (/unemployment|jobless|initial claims|continuing claims/.test(t)) return false;
  if (/(nonfarm|nfp|employment change|payrolls|jobs)/.test(t)) return true;
  if (/trade balance|current account/.test(t)) return true;
  if (/interest rate|rate decision/.test(t)) return true;
  return null;
}

function applyInstitutionalCorrelations(
  scores: Record<string, number>,
  reasoning: string[],
  base: string,
  quote: string
) {
  // Risk-on/risk-off USD flows
  if (quote === "USD") {
    const riskCurrencies = ["AUD", "NZD", "CAD"];
    const riskOnScore = riskCurrencies.reduce((sum, curr) => sum + (scores[curr] || 0), 0);
    if (Math.abs(riskOnScore) > 2) {
      const usdAdjustment = riskOnScore * -0.4;
      scores["USD"] = (scores["USD"] || 0) + usdAdjustment;
      const sentiment = riskOnScore > 0 ? "risk-on" : "risk-off";
      reasoning.push(`${sentiment.toUpperCase()} → ${usdAdjustment > 0 ? "bullish" : "bearish"} USD (${usdAdjustment.toFixed(1)} pts)`);
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
          reasoning.push(`${curr1} ${scores[curr1] > 0 ? "strength" : "weakness"} → ${curr2} correlation (+${adjustment.toFixed(1)} pts)`);
        }
      }
    }
  }
  
  // EUR-GBP correlation
  if ((base === "EUR" || quote === "EUR") && scores["GBP"]) {
    const correlation = 0.25;
    const adjustment = scores["GBP"] * correlation;
    scores["EUR"] = (scores["EUR"] || 0) + adjustment;
    reasoning.push(`GBP-EUR correlation: ${adjustment > 0 ? "+" : ""}${adjustment.toFixed(1)} pts to EUR`);
  }
  
  // JPY safe-haven flows
  if (base === "JPY" || quote === "JPY") {
    const riskCurrencies = ["AUD", "NZD", "CAD"];
    const totalRisk = riskCurrencies.reduce((sum, curr) => sum + (scores[curr] || 0), 0);
    if (Math.abs(totalRisk) > 1.5) {
      const jpyAdjustment = totalRisk * -0.35;
      scores["JPY"] = (scores["JPY"] || 0) + jpyAdjustment;
      reasoning.push(`Risk sentiment → JPY safe-haven (${jpyAdjustment > 0 ? "+" : ""}${jpyAdjustment.toFixed(1)} pts)`);
    }
  }
}

function analyzeCalendar(
  items: OcrCalendarRow[],
  instrument: string
): { summary: string; bias: string; evidence: string[] } {
  const base = instrument.slice(0, 3);
  const quote = instrument.slice(3, 6);
  const nowMs = Date.now();
  const h72ago = nowMs - 72 * 3600 * 1000;
  
  const validEvents = items.filter(r => {
    if (!r?.currency) return false;
    const a = parseNumLoose(r.actual);
    if (a == null) return false;
    const f = parseNumLoose(r.forecast);
    const p = parseNumLoose(r.previous);
    if (f == null && p == null) return false;
    if (r.timeISO) {
      const t = Date.parse(r.timeISO);
      if (isFinite(t) && (t < h72ago || t > nowMs)) return false;
    }
    return true;
  });

  if (validEvents.length === 0) {
    return {
      summary: `Calendar: No valid data in last 72h for ${instrument}`,
      bias: "neutral",
      evidence: []
    };
  }

  const currencyScores: Record<string, number> = {};
  const reasoning: string[] = [];
  const evidence: string[] = [];

  for (const event of validEvents) {
    const currency = String(event.currency).toUpperCase();
    const title = String(event.title || "Event");
    const impact = event.impact || "Medium";
    
    const actual = parseNumLoose(event.actual)!;
    const forecast = parseNumLoose(event.forecast);
    const previous = parseNumLoose(event.previous);
    
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
    reasoning.push(`${currency} ${title}: ${actual} ${comparison} = ${sentiment} (${finalScore.toFixed(1)} pts)`);
    evidence.push(`${currency} ${title}: A:${actual} F:${forecast ?? "n/a"} P:${previous ?? "n/a"}`);
  }
  
  applyInstitutionalCorrelations(currencyScores, reasoning, base, quote);
  
  const baseScore = currencyScores[base] || 0;
  const quoteScore = currencyScores[quote] || 0;
  const netScore = baseScore - quoteScore;

  const moderateThreshold = 1.0;
  let finalBias: string;

  if (Math.abs(netScore) < moderateThreshold && Math.abs(baseScore) < moderateThreshold && Math.abs(quoteScore) < moderateThreshold) {
    finalBias = "neutral";
  } else if (netScore > moderateThreshold) {
    finalBias = "bullish";
  } else if (netScore < -moderateThreshold) {
    finalBias = "bearish";
  } else {
    finalBias = "neutral";
  }
  
  const summary = `${base} ${baseScore.toFixed(1)} vs ${quote} ${quoteScore.toFixed(1)} = ${finalBias} ${instrument} (net ${netScore > 0 ? "+" : ""}${netScore.toFixed(1)})`;
  
  return { summary, bias: finalBias, evidence };
}

// ---------- STAGE 2: STRATEGY ENGINE ----------
interface StrategyOutput {
  scores: { structure_break: number; order_block: number; reversal_extreme: number; liquidity_grab: number; fvg_fill: number };
  winner: string;
  runner_up: string;
  option1: { strategy: string; direction: string; order_type: string; entry_min: number; entry_max: number; stop_loss: number; tp1: number; tp2: number; conviction: number };
  option2: { strategy: string; direction: string; order_type: string; entry_min: number; entry_max: number; stop_loss: number; tp1: number; tp2: number; conviction: number };
  context_grade: string;
  fundamentals: { calendar_bias: string; headlines_bias: string; csm_bias: string; alignment: string };
}

async function stage2_strategyEngine(
  chartData: ChartData,
  instrument: string,
  csm: { ranks: string[]; scores: Record<string, number> },
  headlines: { items: any[]; bias: string },
  calendarText: string | null,
  calendarBias: string
): Promise<StrategyOutput> {
  const base = instrument.slice(0, 3);
  const quote = instrument.slice(3, 6);
  const csmDiff = (csm.scores[base] || 0) - (csm.scores[quote] || 0);
  const csmBias = csmDiff > 0.5 ? "bullish" : csmDiff < -0.5 ? "bearish" : "neutral";
  
  const systemPrompt = `Strategy scoring engine. JSON output only.

SCORE 5 STRATEGIES (0-100):
1. structure_break: Recent BOS + retest
2. order_block: Fresh demand/supply zone
3. reversal_extreme: Price at range extreme + rejection
4. liquidity_grab: Swept level + reversal
5. fvg_fill: Unfilled gap

CONTEXT GRADE:
Move: ${chartData.move_pips} pips
A: <150 fresh | B: 150-250 | C: 250-400 | D: >400

FUNDAMENTALS:
Calendar: ${calendarBias} (${calendarText || "unavailable"})
Headlines: ${headlines.bias}
CSM: ${csmBias} (${base}=${csm.scores[base]?.toFixed(2)}, ${quote}=${csm.scores[quote]?.toFixed(2)})

OUTPUT:
{
  "scores": {numbers},
  "winner": "<strategy>",
  "runner_up": "<strategy>",
  "option1": {"strategy": "<winner>", "direction": "${chartData.primary_direction}", "order_type": "LIMIT|MARKET|STOP", "entry_min": <num>, "entry_max": <num>, "stop_loss": <num>, "tp1": <num>, "tp2": <num>, "conviction": <0-100>},
  "option2": {"strategy": "<runner_up>", "direction": "${chartData.primary_direction}", "order_type": "LIMIT|MARKET|STOP", "entry_min": <num>, "entry_max": <num>, "stop_loss": <num>, "tp1": <num>, "tp2": <num>, "conviction": <0-100>},
  "context_grade": "A|B|C|D",
  "fundamentals": {"calendar_bias": "${calendarBias}", "headlines_bias": "${headlines.bias}", "csm_bias": "${csmBias}", "alignment": "MATCH|MISMATCH|NEUTRAL"}
}

Current: ${chartData.current_price}
H4 levels: high ${chartData.h4.recent_high}, low ${chartData.h4.recent_low}
Min R:R: 1.5:1`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${instrument} ${chartData.primary_direction}. JSON.` },
  ];

  const response = await callOpenAI(MODEL, messages);
  const parsed = tryParseJson(response);
  
  if (!parsed?.scores || !parsed?.option1) throw new Error("Stage 2 failed");
  
  return parsed as StrategyOutput;
}

// ---------- STAGE 3: FORMATTER ----------
async function stage3_formatCard(
  chartData: ChartData,
  strategyData: StrategyOutput,
  instrument: string
): Promise<string> {
  const systemPrompt = `Format trade analysis. Markdown output.

SECTIONS:
1. CHART ANALYSIS
2. STRATEGY TOURNAMENT RESULTS
3. Option 1 (Primary)
4. Option 2 (Alternative)
5. Market Context Assessment
6. Fundamentals
7. Tech vs Fundy Alignment
8. Trade Validation
9. Trader's Honest Assessment
10. ai_meta JSON`;

  const userPrompt = `${instrument}

CHARTS:
4H: ${chartData.h4.bias} (${chartData.h4.left}→${chartData.h4.right}, H:${chartData.h4.recent_high}, L:${chartData.h4.recent_low})
1H: ${chartData.h1.bias} ${chartData.h1.vs_h4} 4H
15M: ${chartData.m15.context}
Current: ${chartData.current_price} | Direction: ${chartData.primary_direction} | Move: ${chartData.move_pips} pips

STRATEGIES: ${Object.entries(strategyData.scores).map(([k,v])=>`${k}:${v}`).join(", ")}
Winner: ${strategyData.winner} | Runner-up: ${strategyData.runner_up}

OPTION 1: ${strategyData.option1.strategy} ${strategyData.option1.direction} ${strategyData.option1.order_type} ${strategyData.option1.entry_min}-${strategyData.option1.entry_max} SL:${strategyData.option1.stop_loss} TP1:${strategyData.option1.tp1} TP2:${strategyData.option1.tp2} Conv:${strategyData.option1.conviction}%

OPTION 2: ${strategyData.option2.strategy} ${strategyData.option2.direction} ${strategyData.option2.order_type} ${strategyData.option2.entry_min}-${strategyData.option2.entry_max} SL:${strategyData.option2.stop_loss} TP1:${strategyData.option2.tp1} TP2:${strategyData.option2.tp2} Conv:${strategyData.option2.conviction}%

CONTEXT: ${strategyData.context_grade}

FUNDAMENTALS:
Calendar: ${strategyData.fundamentals.calendar_bias}
Headlines: ${strategyData.fundamentals.headlines_bias}
CSM: ${strategyData.fundamentals.csm_bias}
Alignment: ${strategyData.fundamentals.alignment}

Format complete professional trade card.`;

  return await callOpenAI(MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);
}

// ---------- HANDLER ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "POST only" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "No API key" });
    if (!isMultipart(req)) return res.status(400).json({ ok: false, reason: "Use multipart" });

    const { fields, files } = await parseMultipart(req);
    const instrument = String(fields.instrument || "").trim().toUpperCase();
    if (!instrument) return res.status(400).json({ ok: false, reason: "Missing instrument" });

    const m15f = pickFirst(files.m15);
    const h1f = pickFirst(files.h1);
    const h4f = pickFirst(files.h4);
    const calF = pickFirst(files.calendar);
    
    const m15Url = String(pickFirst(fields.m15Url) || "").trim();
    const h1Url = String(pickFirst(fields.h1Url) || "").trim();
    const h4Url = String(pickFirst(fields.h4Url) || "").trim();
    const calUrl = String(pickFirst(fields.calendarUrl) || "").trim();

    const [m15Data, h1Data, h4Data, calData] = await Promise.all([
      m15f ? fileToDataUrl(m15f) : linkToDataUrl(m15Url),
      h1f ? fileToDataUrl(h1f) : linkToDataUrl(h1Url),
      h4f ? fileToDataUrl(h4f) : linkToDataUrl(h4Url),
      calF ? fileToDataUrl(calF) : linkToDataUrl(calUrl),
    ]);

    if (!m15Data || !h1Data || !h4Data) {
      return res.status(400).json({ ok: false, reason: "Missing charts" });
    }

    console.log(`[${instrument}] Starting...`);
    
    const livePrice = await fetchLivePrice(instrument);
    const [csm, headlines] = await Promise.all([getCSM(), fetchHeadlines(instrument)]);
    
    let calendarText: string | null = null;
    let calendarBias: string = "unavailable";
    if (calData) {
      try {
        const ocr = await ocrCalendar(calData);
        if (ocr && ocr.items.length > 0) {
          const analysis = analyzeCalendar(ocr.items, instrument);
          calendarText = analysis.summary;
          calendarBias = analysis.bias;
          console.log(`[CALENDAR] ${calendarBias}: ${analysis.evidence.length} events`);
        } else {
          calendarText = "Calendar OCR returned no data";
        }
      } catch (err: any) {
        console.error("[CALENDAR] Error:", err.message);
        calendarText = "Calendar processing error";
      }
    }

    console.log("[STAGE 1] Reading charts...");
    const chartData = await stage1_extractCharts(m15Data, h1Data, h4Data, instrument, livePrice);
    console.log(`[STAGE 1] ${chartData.primary_direction} @ ${chartData.current_price}, ${chartData.h4.bias} 4H`);
    
    console.log("[STAGE 2] Strategy engine...");
    const strategyData = await stage2_strategyEngine(chartData, instrument, csm, headlines, calendarText, calendarBias);
    console.log(`[STAGE 2] ${strategyData.winner} wins, grade ${strategyData.context_grade}`);
    
    console.log("[STAGE 3] Formatting...");
    let tradeCard = await stage3_formatCard(chartData, strategyData, instrument);
    
    tradeCard += `\n\n---\nProvenance: ${MODEL} | ${VP_VERSION}\nFundamentals: Calendar ${calendarBias}, Headlines ${headlines.bias}, CSM calculated\n---`;

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text: tradeCard,
      meta: {
        instrument,
        version: VP_VERSION,
        model: MODEL,
        chart_data: chartData,
        strategy_data: strategyData,
        fundamentals: {
          calendar: calendarBias,
          headlines: headlines.bias,
          csm_ranks: csm.ranks
        }
      },
    });

  } catch (err: any) {
    console.error("[ERROR]", err);
    return res.status(500).json({ ok: false, reason: err?.message || "Failed" });
  }
}
