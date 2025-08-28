// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles } from "../../lib/prices"; // uses your base you pasted

// --- Types (kept local for safety with any older bases)
type Candle = { t: number; o: number; h: number; l: number; c: number };
type ScanResult = { ok: boolean; score: number; note?: string };
type Bias = "bull" | "bear" | "neutral";

const LIMIT_15M = 200;
const LIMIT_1H  = 200;
const LIMIT_4H  = 200;

const TF_LIST = ["15m", "1h", "4h"] as const;

// ---------------------------------------------------------------------------
// small utilities

const last = <T,>(a: T[]) => (a.length ? a[a.length - 1] : undefined);

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const slice = values.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

function atrProxy(cs: Candle[], lookback = 20): number {
  if (cs.length < lookback + 1) return 0;
  const seg = cs.slice(-lookback - 1);
  const trs = seg.slice(1).map((c, i) => {
    const p = seg[i];
    return Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  });
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function overallBias(h1: Candle[], h4: Candle[]): Bias {
  let vote = 0;

  // 1h vote
  if (h1.length > 50) {
    const c = last(h1)!.c;
    const ma = sma(h1.map(x => x.c), 50);
    if (ma != null) vote += c > ma ? 1 : -1;
  }

  // 4h vote
  if (h4.length > 50) {
    const c = last(h4)!.c;
    const ma = sma(h4.map(x => x.c), 50);
    if (ma != null) vote += c > ma ? 1 : -1;
  }

  if (vote > 0) return "bull";
  if (vote < 0) return "bear";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Step-4 setup scans (lightweight, deterministic)

// BOS: recent break of structure in direction of bias
function detectBOS(exec: Candle[], bias: Bias): ScanResult {
  if (exec.length < 60) return { ok: false, score: 0 };
  const seg = exec.slice(-60);
  const left = seg.slice(0, 45);
  const right = seg.slice(45);

  if (bias === "bull" || bias === "neutral") {
    const lh = Math.max(...left.map(c => c.h));
    const brk = right.some(c => c.h > lh);
    if (brk) return { ok: true, score: 70, note: "BOS up" };
  }
  if (bias === "bear" || bias === "neutral") {
    const ll = Math.min(...left.map(c => c.l));
    const brk = right.some(c => c.l < ll);
    if (brk) return { ok: true, score: 70, note: "BOS down" };
  }
  return { ok: false, score: 0 };
}

// Pullback: 38–62% retrace of last impulse in direction of bias
function detectPullback(exec: Candle[], bias: Bias): ScanResult {
  if (exec.length < 80) return { ok: false, score: 0 };
  const seg = exec.slice(-80);
  const atr = atrProxy(seg, 20) || 1e-6;

  // build a simple swing (highest high/lowest low) in last 60 bars
  const recent = seg.slice(-60);
  const hi = Math.max(...recent.map(c => c.h));
  const lo = Math.min(...recent.map(c => c.l));
  const rng = hi - lo;

  if (rng < 2 * atr) return { ok: false, score: 0 }; // not enough displacement

  const now = last(seg)!;

  if (bias === "bull" || bias === "neutral") {
    const pull = (hi - now.c) / Math.max(1e-6, rng);
    if (pull >= 0.38 && pull <= 0.62) {
      return { ok: true, score: 65, note: "Pullback in buy zone" };
    }
  }
  if (bias === "bear" || bias === "neutral") {
    const pull = (now.c - lo) / Math.max(1e-6, rng);
    if (pull >= 0.38 && pull <= 0.62) {
      return { ok: true, score: 65, note: "Pullback in sell zone" };
    }
  }
  return { ok: false, score: 0 };
}

// Range: compressed volatility (low ATR / range) – trade edges only
function detectRange(exec: Candle[]): ScanResult {
  if (exec.length < 80) return { ok: false, score: 0 };
  const seg = exec.slice(-60);
  const atr = atrProxy(seg, 20);
  const hi = Math.max(...seg.map(c => c.h));
  const lo = Math.min(...seg.map(c => c.l));
  const width = hi - lo;
  if (atr === 0) return { ok: false, score: 0 };
  // range if width is < ~5 ATR
  if (width / atr < 5) return { ok: true, score: 55, note: "Range conditions" };
  return { ok: false, score: 0 };
}

// Order-Block Retest (see discussion)
function detectOrderBlockRetest(exec: Candle[], bias: Bias): ScanResult {
  if (exec.length < 60) return { ok: false, score: 0 };
  const recent = exec.slice(-60);
  const highs = recent.map(c => c.h);
  const lows = recent.map(c => c.l);
  const localHigh = Math.max(...highs.slice(0, -5));
  const localLow  = Math.min(...lows.slice(0, -5));
  const last5     = recent.slice(-5);

  if (bias === "bull" || bias === "neutral") {
    const bosUp = last5.some(c => c.h > localHigh);
    if (!bosUp) return { ok: false, score: 0 };
    // last bearish body before BOS
    const pre = recent.slice(0, -5).reverse().find(c => c.o > c.c);
    if (!pre) return { ok: false, score: 0 };
    const obLow  = Math.min(pre.o, pre.c);
    const obHigh = Math.max(pre.o, pre.c);
    const retest = last5.some(c => c.l <= obHigh && c.h >= obLow);
    return retest
      ? { ok: true, score: 68, note: `OB retest (bull) ${obLow.toFixed(5)}–${obHigh.toFixed(5)}` }
      : { ok: false, score: 0 };
  }

  if (bias === "bear" || bias === "neutral") {
    const bosDown = last5.some(c => c.l < localLow);
    if (!bosDown) return { ok: false, score: 0 };
    const pre = recent.slice(0, -5).reverse().find(c => c.c > c.o); // last bullish body
    if (!pre) return { ok: false, score: 0 };
    const obLow  = Math.min(pre.o, pre.c);
    const obHigh = Math.max(pre.o, pre.c);
    const retest = last5.some(c => c.l <= obHigh && c.h >= obLow);
    return retest
      ? { ok: true, score: 68, note: `OB retest (bear) ${obLow.toFixed(5)}–${obHigh.toFixed(5)}` }
      : { ok: false, score: 0 };
  }

  return { ok: false, score: 0 };
}

// FVG fill (3-bar displacement gap, wicked but not fully closed)
function detectFVGFill(exec: Candle[], bias: Bias): ScanResult {
  if (exec.length < 60) return { ok: false, score: 0 };
  const cs = exec.slice(-60);
  const atr = atrProxy(cs, 20) || 1e-6;

  for (let i = cs.length - 1; i >= 2 && i >= cs.length - 25; i--) {
    const a = cs[i - 2], b = cs[i - 1], c = cs[i];
    const dispUp   = (c.c - a.c) > 2 * atr;
    const dispDown = (a.c - c.c) > 2 * atr;

    if ((bias === "bull" || bias === "neutral") && dispUp && c.l > a.h) {
      const gapLow = a.h, gapHigh = c.l;
      const after = exec.slice(-10);
      const wicked = after.some(k => k.l <= gapHigh && k.h >= gapLow);
      const closed = after.some(k => k.l <= gapLow);
      if (wicked && !closed) return { ok: true, score: 62, note: `FVG fill (bull) ${gapLow.toFixed(5)}–${gapHigh.toFixed(5)}` };
    }

    if ((bias === "bear" || bias === "neutral") && dispDown && c.h < a.l) {
      const gapLow = c.h, gapHigh = a.l;
      const after = exec.slice(-10);
      const wicked = after.some(k => k.l <= gapHigh && k.h >= gapLow);
      const closed = after.some(k => k.h >= gapHigh);
      if (wicked && !closed) return { ok: true, score: 62, note: `FVG fill (bear) ${gapLow.toFixed(5)}–${gapHigh.toFixed(5)}` };
    }
  }
  return { ok: false, score: 0 };
}

// ---------------------------------------------------------------------------
// Response helpers

function cardLine(s: string) { return `• ${s}`; }

function makeCard(opts: {
  symbol: string;
  bias: Bias;
  setup: string;
  notes: string[];
  conviction: number;
  missing: Record<"15m"|"1h"|"4h", boolean>;
}) {
  const rows: string[] = [];
  rows.push(`Instrument: ${opts.symbol}`);
  rows.push(cardLine(`Bias (HTF): ${opts.bias.toUpperCase()}`));
  rows.push(cardLine(`Setup: ${opts.setup}`));
  if (opts.notes.length) rows.push(cardLine(`Notes: ${opts.notes.join(" | ")}`));
  const missList = Object.entries(opts.missing).filter(([,v]) => v).map(([k]) => k);
  rows.push(cardLine(`Data: ${missList.length ? "partial (" + missList.join(", ") + " missing)" : "complete"}`));
  rows.push(cardLine(`Conviction: ${Math.max(0, Math.min(100, Math.round(opts.conviction)))}/100`));
  return rows.join("\n");
}

// ---------------------------------------------------------------------------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // allow GET for quick testing (also supports POST with JSON body { symbol })
  const symbol = (req.method === "GET" ? (req.query.symbol as string) : req.body?.symbol) || "EURUSD";
  const code = symbol.toUpperCase().replace("/", ""); // "EURUSD" or "XAUUSD" etc.

  try {
    // --- fetch candles in parallel (fixed: explicit array, no TS generic weirdness)
    const [m15, h1, h4] = await Promise.all([
      getCandles(code, "15m", LIMIT_15M),
      getCandles(code, "1h",  LIMIT_1H),
      getCandles(code, "4h",  LIMIT_4H),
    ]);

    const have15 = m15.length > 0;
    const have1  = h1.length  > 0;
    const have4  = h4.length  > 0;

    const missing = { "15m": !have15, "1h": !have1, "4h": !have4 };

    // If 15m is missing we cannot run setups; return graceful low-conviction card
    if (!have15) {
      const card = makeCard({
        symbol: symbol,
        bias: "neutral",
        setup: "No-Trade (execution TF unavailable)",
        notes: ["15m data missing – provider fallback exhausted"],
        conviction: 15,
        missing,
      });
      return res.status(200).json({
        ok: true,
        symbolUsed: symbol,
        card,
        conviction: 15,
        missing,
        notes: ["15m missing"],
        usedHeadlines: [],
        usedCalendar: [],
      });
    }

    // Bias from HTFs; with partial data we soften the effect
    let bias = overallBias(h1, h4);
    let conviction = 45;          // base
    const notes: string[] = [];

    if (bias !== "neutral") {
      const hVotes = (have1 ? 1 : 0) + (have4 ? 1 : 0);
      conviction += hVotes * 6;   // reward each HTF present
      if (!have1 || !have4) notes.push("HTF partial");
    } else {
      notes.push("HTF mixed/neutral");
      conviction -= 5;
    }

    // --- Step-4 scans on 15m
    const bosRes      = detectBOS(m15, bias);
    const pullRes     = detectPullback(m15, bias);
    const rangeRes    = detectRange(m15);
    const obRes       = detectOrderBlockRetest(m15, bias);
    const fvgRes      = detectFVGFill(m15, bias);

    const scored: Array<[string, ScanResult]> = [
      ["BOS", bosRes],
      ["Pullback", pullRes],
      ["Range", rangeRes],
      ["OB", obRes],
      ["FVG", fvgRes],
    ].sort((a, b) => b[1].score - a[1].score);

    const [bestName, best] = scored[0];

    let setup = "No-Trade";
    if (best.ok) {
      setup = bestName + (best.note ? ` – ${best.note}` : "");
      conviction += best.score;
    } else {
      notes.push("No qualifying 15m setup");
      conviction = Math.max(10, conviction - 20);
    }

    // Clamp conviction
    conviction = Math.max(0, Math.min(100, Math.round(conviction)));

    // Final card
    const card = makeCard({
      symbol,
      bias,
      setup,
      notes,
      conviction,
      missing,
    });

    return res.status(200).json({
      ok: true,
      symbolUsed: symbol,
      card,
      conviction,
      missing,
      notes,
      usedHeadlines: [],  // reserved for later blend
      usedCalendar: [],   // reserved for blackout logic
    });
  } catch (err: any) {
    return res.status(200).json({
      ok: false,
      reason: err?.message || "Unexpected error",
      usedHeadlines: [],
      usedCalendar: [],
    });
  }
}
