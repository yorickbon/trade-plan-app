// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle } from "../../lib/prices";

// -------------------- types --------------------
type PlanOk = { ok: true; text: string; conviction: number };
type PlanFail = { ok: false; reason: string };
type PlanResp = PlanOk | PlanFail;

const LIMIT_15M = 200;
const LIMIT_1H  = 360;
const LIMIT_4H  = 360;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const getCloses = (a: Candle[]) => a.map(c => c.c);
const getHighs  = (a: Candle[]) => a.map(c => c.h);
const getLows   = (a: Candle[]) => a.map(c => c.l);

// -------------------- helpers --------------------
function ema(vals: number[], period: number): number {
  if (vals.length < period) return vals[vals.length - 1] ?? 0;
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev = vals[0];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    prev = (v - prev) * k + prev;
    out.push(prev);
  }
  return out[out.length - 1];
}

function lastSwingHigh(lows: number[], highs: number[]): number {
  // find most recent pivot high (simple lookback)
  for (let i = highs.length - 1; i >= 2; i--) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2]) return highs[i];
  }
  // fallback
  return Math.max(...highs.slice(-30));
}

function lastSwingLow(lows: number[], highs: number[]): number {
  for (let i = lows.length - 1; i >= 2; i--) {
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2]) return lows[i];
  }
  return Math.min(...lows.slice(-30));
}

function trendFromEMAs(closes: number[], n = 14): "UP" | "DOWN" | "FLAT" {
  if (closes.length < n) return "FLAT";
  const last = closes[closes.length - 1];
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  if (Math.abs(e21 - e50) < last * 0.0001) return "FLAT";
  return e21 > e50 ? "UP" : "DOWN";
}

function buildQuickPlan(
  symbol: string,
  dir: "LONG" | "SHORT",
  entry: number,
  sl: number,
  tp1: number,
  tp2: number,
  conviction: number,
  shortReason: string,
  notes: string[],
): string {
  return [
    "Quick Plan (Actionable)",
    `• Direction: ${dir}`,
    `• Entry: ${entry}`,
    `• Stop Loss: ${sl}`,
    `• Take Profit(s): TP1 ${tp1} / TP2 ${tp2}`,
    `• Conviction: ${conviction}`,
    `• Short Reasoning: ${shortReason}`,
    "",
    "Full Breakdown",
    notes.join("\n"),
    "",
    `Symbol: ${symbol}`,
  ].join("\n");
}

// -------------------- api handler --------------------
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PlanResp>
) {
  // ---- INPUTS (body first, then query, then fallback) ----
  // This is the only *behavior* change: we now trust POST body > query > fallback.
  let instrument = "EURUSD";
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const fromBody = (body?.instrument ?? body?.code ?? "").toString();
    const fromQuery = (req.query.instrument ?? req.query.code ?? "").toString();
    instrument = (fromBody || fromQuery || "EURUSD").toUpperCase().replace(/\s+/g, "");
  } catch {
    const fromQuery = (req.query.instrument ?? req.query.code ?? "").toString();
    instrument = (fromQuery || "EURUSD").toUpperCase().replace(/\s+/g, "");
  }

  // Optional inputs already sent by UI (do not change your working flow)
  let headlines: any[] = [];
  let calendar: any[] = [];
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    headlines = Array.isArray(body?.headlines) ? body.headlines : [];
    calendar  = Array.isArray(body?.calendar)  ? body.calendar  : [];
  } catch { /* no-op */ }

  // ---- Fetch candles in parallel (fallbacks live inside getCandles) ----
  const [m15, h1, h4] = await Promise.all([
    getCandles(instrument, "15m", LIMIT_15M),
    getCandles(instrument, "1h",  LIMIT_1H),
    getCandles(instrument, "4h",  LIMIT_4H),
  ]);

  // Require execution TF
  if (!m15.length) {
    return res.status(200).json({ ok: false, reason: "Missing 15m candles; cannot build execution plan" });
  }

  // -------------------- Data prep --------------------
  const closes15 = getCloses(m15), highs15 = getHighs(m15), lows15 = getLows(m15);
  const closes1  = getCloses(h1),  highs1  = getHighs(h1),  lows1  = getLows(h1);
  const closes4  = getCloses(h4),  highs4  = getHighs(h4),  lows4  = getLows(h4);

  // HTF context
  const tf15 = trendFromEMAs(closes15);
  const tf1  = trendFromEMAs(closes1);
  const tf4  = trendFromEMAs(closes4);

  // Pick a base direction (keep your simple “always pick something” rule)
  let direction: "LONG" | "SHORT" = "LONG";
  let baseConv = 60; // base conviction

  // Weight trends
  const score = (tf15 === "UP" ? 1 : tf15 === "DOWN" ? -1 : 0)
              + (tf1  === "UP" ? 1 : tf1  === "DOWN" ? -1 : 0)
              + (tf4  === "UP" ? 1 : tf4  === "DOWN" ? -1 : 0);

  if (score > 0) { direction = "LONG";  baseConv += 5; }
  if (score < 0) { direction = "SHORT"; baseConv += 5; }

  // Simple BOS / compression hint (kept from your base approach)
  const lastH = lastSwingHigh(lows15, highs15);
  const lastL = lastSwingLow(lows15, highs15);
  let shortReason = "Compression range";
  if (closes15[closes15.length - 1] > lastH) shortReason = "Breakout above recent swing high";
  else if (closes15[closes15.length - 1] < lastL) shortReason = "Breakdown below recent swing low";

  // Fundamental bump: headlines & blackout
  const biasFromNews = (() => {
    // naive score: title contains positive/negative words (already done upstream, we just count)
    const scores = headlines.map((h: any) => (h?.sentiment?.score ?? 0));
    const sum = scores.reduce((a: number, b: number) => a + b, 0);
    return sum > 0 ? 1 : sum < 0 ? -1 : 0;
  })();

  baseConv += biasFromNews * 5;

  const blackout = calendar.some((e: any) =>
    (e?.impact ?? "").toString().toUpperCase().includes("HIGH") &&
    e?.isBlackout === true
  );

  if (blackout) baseConv = Math.min(baseConv, 45);

  // -------------------- Entry/SL/TP (structure) --------------------
  const last = closes15[closes15.length - 1];
  const sh   = lastSwingHigh(lows15, highs15);
  const slw  = lastSwingLow(lows15, highs15);

  let entry = last;
  let sl    = direction === "LONG" ? slw : sh;
  // protect against ultra-tight SL (logical > 0.1% of price)
  const minGap = last * 0.001;
  if (direction === "LONG" && entry - sl < minGap) sl = entry - minGap;
  if (direction === "SHORT" && sl - entry < minGap) sl = entry + minGap;

  const risk = Math.abs(entry - sl);
  const tp1  = direction === "LONG" ? entry + risk : entry - risk;
  const tp2  = direction === "LONG" ? entry + risk * 1.6 : entry - risk * 1.6;

  // Conviction number (0–100)
  const conviction = clamp(Math.round(baseConv), 20, 85);

  // -------------------- Notes --------------------
  const notes: string[] = [];
  notes.push(`• Technical View (HTF + Intraday): 1h=${tf1.toLowerCase()}, 4h=${tf4.toLowerCase()}, 15m=${tf15.toLowerCase()}`);
  notes.push(`• Fundamental View (last 12 headlines): ${blackout ? "blackout window — caution" : "no blackout"}`);
  notes.push(`• Tech vs Fundy Alignment: ${(biasFromNews > 0 && direction === "LONG") || (biasFromNews < 0 && direction === "SHORT") ? "Match" : "Mixed"}`);
  notes.push("• Conditional Scenarios: If price invalidates SL, stand down; otherwise manage at TP1 → BE.");
  notes.push("• Surprise Risk: unscheduled CB comments; political soundbites.");
  notes.push("• Invalidation: clear close beyond SL level.");

  const text = buildQuickPlan(
    instrument,
    direction,
    entry,
    sl,
    tp1,
    tp2,
    conviction,
    shortReason,
    notes
  );

  return res.status(200).json({ ok: true, text, conviction });
}
