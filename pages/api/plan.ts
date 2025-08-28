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

type PlanResponse = {
  ok: boolean;
  plan?: { text: string; conviction?: number | null };
  reason?: string;
  usedHeadlines?: any[];
  usedCalendar?: any[];
};

const LIMIT_15M = 350;
const LIMIT_H1 = 400;
const LIMIT_H4 = 400;

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
const asCloses = (arr: Candle[]) => arr.map(c => c.c);
const asHighs  = (arr: Candle[]) => arr.map(c => c.h);
const asLows   = (arr: Candle[]) => arr.map(c => c.l);

function recentSwingHigh(highs: number[], lookback=60): number {
  return Math.max(...highs.slice(0, lookback));
}
function recentSwingLow(lows: number[], lookback=60): number {
  return Math.min(...lows.slice(0, lookback));
}

function detectBOS(m15: Candle[], bias: "up"|"down"|"flat"): ScanResult {
  if (m15.length < 120) return { ok:false, note:"insufficient bars" };
  const highs = asHighs(m15), lows = asLows(m15), closes = asCloses(m15);
  const last = closes[0], rh = recentSwingHigh(highs), rl = recentSwingLow(lows);
  if (last > rh) {
    const conf = 70 + (bias === "up" ? 15 : bias === "down" ? -15 : 0);
    return { ok:true, direction:"bull", confidence: clamp(conf, 0, 100), note:"Close > 60-bar swing high" };
  }
  if (last < rl) {
    const conf = 70 + (bias === "down" ? 15 : bias === "up" ? -15 : 0);
    return { ok:true, direction:"bear", confidence: clamp(conf, 0, 100), note:"Close < 60-bar swing low" };
  }
  return { ok:false, note:"No break of structure" };
}

function detectPullback(m15: Candle[], bias: "up"|"down"|"flat"): ScanResult {
  if (m15.length < 120) return { ok:false };
  const highs = asHighs(m15), lows = asLows(m15), closes = asCloses(m15);
  const last = closes[0];
  const maxH = Math.max(...highs.slice(0, 120));
  const minL = Math.min(...lows.slice(0, 120));
  if (bias === "up" || bias === "flat") {
    const retr = (maxH - last) / (maxH - minL + 1e-9);
    if (retr > 0.382 && retr < 0.618) return { ok:true, direction:"bull", confidence: 60, note:"Bullish pullback (38–62% retracement)" };
  }
  if (bias === "down" || bias === "flat") {
    const retr = (last - minL) / (maxH - minL + 1e-9);
    if (retr > 0.382 && retr < 0.618) return { ok:true, direction:"bear", confidence: 60, note:"Bearish pullback (38–62% retracement)" };
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
  if (width < 0.004) {
    return { ok:true, direction: m15[0].c > (hi + lo) / 2 ? "bear" : "bull", confidence: 45, note:"Compression range" };
  }
  return { ok:false };
}

// ───────────────────────────── handler
export default async function handler(req: NextApiRequest, res: NextApiResponse<PlanResponse>) {
  // Read instrument from POST body first (UI sends it), then fall back to query.
  let input = "EURUSD";
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    if (body?.instrument?.code) input = String(body.instrument.code).toUpperCase();
  } catch {}
  if (!input && (req.query.symbol || req.query.code)) {
    input = String(req.query.symbol || req.query.code).toUpperCase();
  }

  const usedCalendar = Array.isArray((req.body as any)?.calendar) ? (req.body as any).calendar : [];
  const usedHeadlines = Array.isArray((req.body as any)?.headlines) ? (req.body as any).headlines : [];

  // Candle fetch with polling budget (matches plan-debug semantics)
  const totalMs = Math.max(1000, Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 120000));
  const pollMs  = Math.max(100,  Number(process.env.PLAN_CANDLES_POLL_MS    ?? 200));
  const maxTries = Math.max(1, Math.floor(totalMs / pollMs));

  let code = input;
  let triedAlt: string | null = null;
  let m15: Candle[] = [], h1: Candle[] = [], h4: Candle[] = [];

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const altSymbol = (s: string) => (s.includes("/") || s.length !== 6) ? null : `${s.slice(0,3)}/${s.slice(3)}`;

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

  const missing = [
    !h4.length && "4h",
    !h1.length && "1h",
    !m15.length && "15m",
  ].filter(Boolean) as string[];

  if (missing.length) {
    return res.status(200).json({
      ok: false,
      reason: `Missing candles for ${missing.join(", ")}`,
      usedHeadlines,
      usedCalendar,
    });
  }

  // HTF bias → pick agreement between 1h & 4h (ties -> 1h)
  const h1Trend = trendFromEMA(asCloses(h1), 50);
  const h4Trend = trendFromEMA(asCloses(h4), 50);
  const bias: "up"|"down"|"flat" =
    h1Trend === h4Trend ? h1Trend : (h1Trend === "flat" ? h4Trend : h1Trend);

  const bosRes = detectBOS(m15, bias);
  const pullRes = detectPullback(m15, bias);
  const rangeRes = detectRange(m15);

  const scored = [
    ["BOS", bosRes],
    ["Pullback", pullRes],
    ["Range", rangeRes],
  ] as const;

  const best = scored
    .map(([name, r]) => ({ name, r, score: (r.ok ? (r.confidence ?? 50) : 0) + (r.direction ? 5 : 0) }))
    .sort((a, b) => b.score - a.score)[0];

  if (!best || best.score < 40) {
    return res.status(200).json({
      ok: false,
      reason: "No high-conviction setup on 15m with HTF context",
      usedHeadlines,
      usedCalendar,
    });
  }

  const dirWord = best.r.direction === "bull" ? "LONG" : "SHORT";
  const lines = [
    `Setup: ${best.name} — ${best.r.note ?? "signal"} (${best.r.confidence ?? 50}% conf)`,
    `HTF bias → 1h: ${h1Trend}, 4h: ${h4Trend}`,
    `Direction: ${dirWord}`,
    `Symbol: ${input}`,
  ];
  const text = lines.join("\n");

  return res.status(200).json({
    ok: true,
    plan: { text, conviction: best.r.confidence ?? 50 },
    usedHeadlines,
    usedCalendar,
  });
}
