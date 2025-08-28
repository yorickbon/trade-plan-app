// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle } from "../../lib/prices";

type TF = "15m" | "1h" | "4h";

type ScanResult = {
  ok: boolean;
  direction?: "bull" | "bear";
  confidence?: number; // 0..100
  note?: string;
};

type Card = {
  status: "OK" | "STAND_DOWN";
  reason?: string;
  usedSymbol: string;
  htf: { h1Trend: "up"|"down"|"flat"; h4Trend: "up"|"down"|"flat" };
  idea?: string;
  detail?: string[];
};

const TF_LIST: TF[] = ["15m", "1h", "4h"];
const LIMIT_15M = 350; // enough for swings + ATR
const LIMIT_H1  = 400;
const LIMIT_H4  = 400;

const clamp = (v:number, a:number, b:number) => Math.max(a, Math.min(b, v));

// ───────────────────────────── technical utils

function ema(values: number[], period: number): number[] {
  if (!values.length || period <= 1) return values.slice();
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    const val = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(val);
    prev = val;
  }
  return out;
}

function trendFromEMA(closes: number[], period=50): "up"|"down"|"flat" {
  if (closes.length < period + 5) return "flat";
  const e = ema(closes, period);
  const a = e[e.length - 1];
  const b = e[e.length - 6];
  if (a > b * 1.0005) return "up";
  if (a < b * 0.9995) return "down";
  return "flat";
}

// Expect newest→oldest candles
function asCloses(arr: Candle[]): number[] { return arr.map(c => c.c); }
function asHighs(arr: Candle[]): number[] { return arr.map(c => c.h); }
function asLows(arr: Candle[]): number[] { return arr.map(c => c.l); }

function recentSwingHigh(highs: number[], lookback=30): number {
  return Math.max(...highs.slice(0, lookback));
}
function recentSwingLow(lows: number[], lookback=30): number {
  return Math.min(...lows.slice(0, lookback));
}

function detectBOS(m15: Candle[], bias: "up"|"down"|"flat"): ScanResult {
  if (m15.length < 120) return { ok:false, note:"insufficient bars" };
  const highs = asHighs(m15);
  const lows  = asLows(m15);
  const closes= asCloses(m15);
  const lastClose = closes[0];

  const rh = recentSwingHigh(highs, 60);
  const rl = recentSwingLow(lows, 60);

  if (lastClose > rh) {
    const conf = 70 + (bias === "up" ? 15 : bias === "down" ? -15 : 0);
    return { ok:true, direction:"bull", confidence: clamp(conf, 0, 100), note:"Close > 60-bar swing high" };
  }
  if (lastClose < rl) {
    const conf = 70 + (bias === "down" ? 15 : bias === "up" ? -15 : 0);
    return { ok:true, direction:"bear", confidence: clamp(conf, 0, 100), note:"Close < 60-bar swing low" };
  }
  return { ok:false, note:"No break of structure" };
}

function detectPullback(m15: Candle[], bias: "up"|"down"|"flat"): ScanResult {
  if (m15.length < 120) return { ok:false };
  const highs = asHighs(m15), lows = asLows(m15), closes = asCloses(m15);
  const last = closes[0];

  // impulse anchor = max/min of the last 120 bars
  const maxH = Math.max(...highs.slice(0, 120));
  const minL = Math.min(...lows.slice(0, 120));

  // 38.2–61.8 retracement back into impulse
  if (bias === "up" || bias === "flat") {
    const retr = (maxH - last) / (maxH - minL + 1e-9);
    if (retr > 0.382 && retr < 0.618) {
      return { ok:true, direction:"bull", confidence: 60, note:"Bullish pullback (38–62% retracement)" };
    }
  }
  if (bias === "down" || bias === "flat") {
    const retr = (last - minL) / (maxH - minL + 1e-9);
    if (retr > 0.382 && retr < 0.618) {
      return { ok:true, direction:"bear", confidence: 60, note:"Bearish pullback (38–62% retracement)" };
    }
  }
  return { ok:false };
}

function detectRange(m15: Candle[]): ScanResult {
  if (m15.length < 200) return { ok:false };
  const highs = asHighs(m15).slice(0, 120);
  const lows  = asLows(m15).slice(0, 120);
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  const width = (hi - lo) / ((hi + lo) / 2);
  if (width < 0.004) { // < ~0.4% width over 120 bars → range
    return { ok:true, direction: m15[0].c > (hi + lo) / 2 ? "bear" : "bull", confidence: 45, note:"Compression range" };
  }
  return { ok:false };
}

// ───────────────────────────── main

export default async function handler(req: NextApiRequest, res: NextApiResponse<Card | any>) {
  const input = String(req.query.symbol || req.query.code || "EURUSD").toUpperCase();

  // Candle fetch with polling budget (same behavior as plan-debug)
  const totalMs = Math.max(1000, Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 120000));
  const pollMs  = Math.max(100,  Number(process.env.PLAN_CANDLES_POLL_MS    ?? 200));
  const maxTries = Math.max(1, Math.floor(totalMs / pollMs));

  let code = input;
  let triedAlt: string | null = null;
  let m15: Candle[] = [], h1: Candle[] = [], h4: Candle[] = [];

  for (let i = 1; i <= maxTries; i++) {
    if (!m15.length) m15 = await getCandles(code, "15m", LIMIT_15M);
    if (!h1.length)  h1  = await getCandles(code, "1h" , LIMIT_H1);
    if (!h4.length)  h4  = await getCandles(code, "4h" , LIMIT_H4);

    if (m15.length && h1.length && h4.length) break;
    if (i === 3 && !triedAlt) {
      const alt = altSymbol(code);
      if (alt) { code = alt; triedAlt = alt; }
    }
    if (i < maxTries) await sleep(pollMs);
  }

  // Stand down if any TF missing
  const missing = [
    !h4.length && "4h",
    !h1.length && "1h",
    !m15.length && "15m",
  ].filter(Boolean) as string[];

  if (missing.length) {
    return res.status(200).json({
      status: "STAND_DOWN",
      reason: `Missing candles for ${missing.join(", ")}`,
      usedSymbol: input,
      htf: { h1Trend: "flat", h4Trend: "flat" },
    } satisfies Card);
  }

  // HTF bias
  const h1Trend = trendFromEMA(asCloses(h1), 50);
  const h4Trend = trendFromEMA(asCloses(h4), 50);
  const bias: "up"|"down"|"flat" =
    h1Trend === h4Trend ? h1Trend : (h1Trend === "flat" ? h4Trend : h1Trend);

  const bosRes = detectBOS(m15, bias);
  const pullRes = detectPullback(m15, bias);
  const rangeRes = detectRange(m15);

  // Score + choose best
  const scored: Array<[string, ScanResult]> = [
    ["BOS", bosRes],
    ["Pullback", pullRes],
    ["Range", rangeRes],
  ];

  const best = scored
    .map(([name, r]) => ({ name, r, score: (r.ok ? (r.confidence ?? 50) : 0) + (r.direction ? 5 : 0) }))
    .sort((a, b) => b.score - a.score)[0];

  if (!best || best.score < 40) {
    return res.status(200).json({
      status: "STAND_DOWN",
      reason: "No high-conviction setup on 15m with HTF context",
      usedSymbol: input,
      htf: { h1Trend, h4Trend },
    } satisfies Card);
  }

  const dirWord = best.r.direction === "bull" ? "LONG" : "SHORT";
  const idea = `${dirWord} ${input} — ${best.name} (${best.r.note || "signal"}) with ${best.r.confidence ?? 50}% confidence`;
  const detail: string[] = [
    `HTF bias: 1h=${h1Trend}, 4h=${h4Trend}`,
    `Signal: ${best.name} → ${best.r.note ?? "—"}`,
  ];

  return res.status(200).json({
    status: "OK",
    usedSymbol: input,
    htf: { h1Trend, h4Trend },
    idea,
    detail,
  } satisfies Card);
}

// ───────────────────────────── small helpers
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function altSymbol(code: string) {
  if (code.includes("/")) return null;
  if (code.length === 6) return `${code.slice(0,3)}/${code.slice(3)}`;
  return null;
}
