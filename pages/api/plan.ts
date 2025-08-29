// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle } from "../../lib/prices";

/** ===== Response types ===== */
type PlanOk = { ok: true; text: string; conviction: number; setup: string; signals: string[] };
type PlanFail = { ok: false; reason: string };
type PlanResp = PlanOk | PlanFail;

/** ===== Config ===== */
const LIMIT_15M = 300; // more bars helps structure detection
const LIMIT_1H  = 500;
const LIMIT_4H  = 600;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const getCloses = (a: Candle[]) => a.map((c) => c.c);
const getHighs  = (a: Candle[]) => a.map((c) => c.h);
const getLows   = (a: Candle[]) => a.map((c) => c.l);
const getOpens  = (a: Candle[]) => a.map((c) => c.o);
const getTimes  = (a: Candle[]) => a.map((c) => c.t);

/** ===== Basic indicators ===== */
function ema(vals: number[], period: number): number {
  if (vals.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = vals[0];
  for (let i = 1; i < vals.length; i++) e = (vals[i] - e) * k + e;
  return e;
}

function emaSeries(vals: number[], period: number): number[] {
  if (vals.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [vals[0]];
  for (let i = 1; i < vals.length; i++) out.push((vals[i] - out[i - 1]) * k + out[i - 1]);
  return out;
}

function atr(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (highs.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const subset = trs.slice(-period);
  return subset.reduce((a, b) => a + b, 0) / subset.length;
}

/** ===== Swings & structure ===== */
type Swing = { idx: number; price: number; type: "H" | "L" };

function detectSwings(highs: number[], lows: number[], lookback = 2): Swing[] {
  // Simple pivot: high[i] > high[i-1..i-lookback] and > high[i+1..i+lookback]
  const swings: Swing[] = [];
  const n = highs.length;
  for (let i = lookback; i < n - lookback; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= lookback; k++) {
      if (!(highs[i] > highs[i - k] && highs[i] > highs[i + k])) isH = false;
      if (!(lows[i]  < lows[i - k]  && lows[i]  < lows[i + k])) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) swings.push({ idx: i, price: highs[i], type: "H" });
    if (isL) swings.push({ idx: i, price: lows[i],  type: "L" });
  }
  return swings.sort((a, b) => a.idx - b.idx);
}

function structureBias(swings: Swing[]): "UP" | "DOWN" | "RANGE" {
  // last 6 swings: if HH+HL dominate → UP, if LH+LL dominate → DOWN
  const recent = swings.slice(-6);
  if (recent.length < 4) return "RANGE";
  let hh = 0, hl = 0, lh = 0, ll = 0;
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1], cur = recent[i];
    if (cur.type === "H" && prev.type === "H") {
      if (cur.price > prev.price) hh++;
      else lh++;
    }
    if (cur.type === "L" && prev.type === "L") {
      if (cur.price > prev.price) hl++; // higher low (note: higher low means price number is larger; but for "up", we actually want HL to be higher than prev L? In FX upward trend, lows rise → low price increases; so yes.)
      else ll++;
    }
  }
  const upScore = hh + hl;
  const dnScore = lh + ll;
  if (upScore > dnScore + 1) return "UP";
  if (dnScore > upScore + 1) return "DOWN";
  return "RANGE";
}

function lastSwingOf(type: "H" | "L", swings: Swing[]): Swing | null {
  for (let i = swings.length - 1; i >= 0; i--) {
    if (swings[i].type === type) return swings[i];
  }
  return null;
}

/** ===== Fair Value Gap (3-candle) =====
 * Bullish FVG if low[i] > high[i-2]; Bearish FVG if high[i] < low[i-2]
 */
type FVG = { startIdx: number; endIdx: number; gapTop: number; gapBot: number; side: "bull" | "bear" };

function detectFVG(highs: number[], lows: number[]): FVG[] {
  const out: FVG[] = [];
  for (let i = 2; i < highs.length; i++) {
    const bull = lows[i - 0] > highs[i - 2];
    const bear = highs[i - 0] < lows[i - 2];
    if (bull) out.push({ startIdx: i - 2, endIdx: i, gapTop: lows[i], gapBot: highs[i - 2], side: "bull" });
    if (bear) out.push({ startIdx: i - 2, endIdx: i, gapTop: lows[i - 2], gapBot: highs[i], side: "bear" });
  }
  return out.slice(-8);
}

/** ===== Order Block (simple) =====
 * Bullish OB: last down candle before an impulse that breaks a "H" swing
 * Bearish OB: last up candle before an impulse that breaks a "L" swing
 */
type OB = { idx: number; hi: number; lo: number; side: "bull" | "bear" };

function detectOB(opens: number[], highs: number[], lows: number[], closes: number[], swings: Swing[]): OB[] {
  const out: OB[] = [];
  const n = closes.length;
  const swingH = swings.filter(s => s.type === "H").slice(-4);
  const swingL = swings.filter(s => s.type === "L").slice(-4);

  // find breaks of structure and tag the prior opposite candle as OB
  for (let i = 2; i < n; i++) {
    // broke a recent swing high?
    const brokeH = swingH.some(s => closes[i] > s.price && i > s.idx);
    if (brokeH) {
      // walk back to find last down candle
      for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
        if (closes[j] < opens[j]) { // red candle
          out.push({ idx: j, hi: highs[j], lo: lows[j], side: "bull" });
          break;
        }
      }
    }
    // broke a recent swing low?
    const brokeL = swingL.some(s => closes[i] < s.price && i > s.idx);
    if (brokeL) {
      for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
        if (closes[j] > opens[j]) { // green candle
          out.push({ idx: j, hi: highs[j], lo: lows[j], side: "bear" });
          break;
        }
      }
    }
  }
  return out.slice(-6);
}

/** ===== SR Flip / Fakeout ===== */
function brokeAndRetested(level: number, closes: number[], highs: number[], lows: number[]): boolean {
  // break through 'level' then retest within last N bars
  const N = 40;
  const arrC = closes.slice(-N), arrH = highs.slice(-N), arrL = lows.slice(-N);
  const brokeUp = arrC.some(c => c > level) && arrL.some(l => l <= level);
  const brokeDn = arrC.some(c => c < level) && arrH.some(h => h >= level);
  return brokeUp || brokeDn;
}

function wickFakeoutThrough(level: number, opens: number[], closes: number[], highs: number[], lows: number[]): boolean {
  // long wick through level but close back within previous range
  const N = 30;
  const o = opens.slice(-N), c = closes.slice(-N), h = highs.slice(-N), l = lows.slice(-N);
  for (let i = 0; i < o.length; i++) {
    const upWick = h[i] > level && Math.max(o[i], c[i]) < level;
    const dnWick = l[i] < level && Math.min(o[i], c[i]) > level;
    if (upWick || dnWick) return true;
  }
  return false;
}

/** ===== Fib confluence ===== */
type FibZone = { a: number; b: number; r382: number; r5: number; r618: number };

function fibZoneFromSwings(lastUp: { a: number; b: number } | null, lastDn: { a: number; b: number } | null) {
  // For bullish pullback: from swing low (a) to swing high (b) → buy zone 0.382..0.618
  // For bearish pullback: from swing high (a) to swing low (b) → sell zone 0.382..0.618
  const zones: { bull?: FibZone; bear?: FibZone } = {};
  if (lastUp) {
    const { a, b } = lastUp; // a=low, b=high
    zones.bull = { a, b, r382: a + (b - a) * 0.382, r5: a + (b - a) * 0.5, r618: a + (b - a) * 0.618 };
  }
  if (lastDn) {
    const { a, b } = lastDn; // a=high, b=low
    zones.bear = { a, b, r382: b + (a - b) * 0.618, r5: b + (a - b) * 0.5, r618: b + (a - b) * 0.382 };
  }
  return zones;
}

/** ===== Sentiment keywords (for when calendar is missing) ===== */
const MACRO_KEYWORDS = [
  "cpi","inflation","ppi","core","gdp","retail sales","industrial production",
  "durable goods","pmi","ism","confidence","sentiment","unemployment","jobless",
  "claims","payrolls","nfp","employment","rate decision","interest rate",
  "fomc","ecb","boe","boj","rba","boc","snb","trade balance","current account","war","conflict","sanction"
];

function minutesUntil(iso: string): number {
  const now = Date.now();
  const t = new Date(iso).getTime();
  return Math.round((t - now) / 60000);
}

/** ===== Card renderer ===== */
function fmtPct(v: number) { return `${clamp(Math.round(v), 0, 100)}%`; }

function toCard({
  symbol, dir, entry, sl, tp1, tp2, conviction,
  tf15, tf1, tf4, shortReason, fundSummary, alignText, scenarios, invalidation, priorityBias,
  eventWatch, signals, setup,
}: {
  symbol: string;
  dir: "Long" | "Short";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  conviction: number;
  tf15: string;
  tf1: string;
  tf4: string;
  shortReason: string;
  fundSummary: string;
  alignText: string;
  scenarios: string[];
  invalidation: string;
  priorityBias: string;
  eventWatch: string[];
  signals: string[];
  setup: string;
}) {
  return [
    "Quick Plan (Actionable)",
    "",
    `• Direction: ${dir}`,
    `• Entry: ${entry}`,
    `• Stop Loss: ${sl}`,
    `• Take Profit(s): TP1 ${tp1} / TP2 ${tp2}`,
    `• Conviction: ${fmtPct(conviction)}`,
    `• Setup: ${setup}`,
    `• Short Reasoning: ${shortReason}`,
    "",
    "Full Breakdown",
    "",
    `• Technical View (HTF + Intraday): 4H=${tf4}, 1H=${tf1}, 15m=${tf15}`,
    `• Signals Triggered: ${signals.join(" · ") || "—"}`,
    `• Fundamental View (Calendar + Sentiment): ${fundSummary}`,
    `• Tech vs Fundy Alignment: ${alignText}`,
    "• Conditional Scenarios:",
    ...scenarios.map((s) => `  - ${s}`),
    "• Surprise Risk: unscheduled CB comments; geopolitical headlines.",
    `• Invalidation: ${invalidation}`,
    "",
    "News / Event Watch",
    ...(eventWatch.length ? eventWatch.map((s) => `• ${s}`) : ["• No scheduled data available; using headlines only."]),
    "",
    "Notes",
    "",
    `• Symbol: ${symbol}`,
  ].join("\n");
}

/** ===== API handler ===== */
export default async function handler(req: NextApiRequest, res: NextApiResponse<PlanResp>) {
  // ---- INPUTS ----
  let instrument = "EURUSD";
  let headlines: any[] = [];
  let calendar: any = null;

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const fromBody = (body?.instrument ?? body?.code ?? "").toString();
    const fromQuery = (req.query.instrument ?? req.query.code ?? "").toString();
    instrument = (fromBody || fromQuery || "EURUSD").toUpperCase().replace(/\s+/g, "");
    headlines = Array.isArray(body?.headlines) ? body.headlines : [];
    calendar  = body?.calendar ?? null;
  } catch {
    const fromQuery = (req.query.instrument ?? req.query.code ?? "").toString();
    instrument = (fromQuery || "EURUSD").toUpperCase().replace(/\s+/g, "");
  }

  // ---- Fetch candles (REAL data via your providers) ----
  const [m15, h1, h4] = await Promise.all([
    getCandles(instrument, "15m", LIMIT_15M),
    getCandles(instrument, "1h",  LIMIT_1H),
    getCandles(instrument, "4h",  LIMIT_4H),
  ]);

  if (!Array.isArray(m15) || m15.length === 0) {
    return res.status(200).json({ ok: false, reason: "Missing 15m candles; cannot build execution plan" });
  }

  const H15 = getHighs(m15), L15 = getLows(m15), C15 = getCloses(m15), O15 = getOpens(m15);
  const H1  = getHighs(h1),  L1  = getLows(h1),  C1  = getCloses(h1);
  const H4  = getHighs(h4),  L4  = getLows(h4),  C4  = getCloses(h4);

  const ATR15 = atr(H15, L15, C15, 14);

  // ---- Technical context ----
  const e21_15 = emaSeries(C15, 21), e50_15 = emaSeries(C15, 50);
  const e21_1  = ema(C1, 21), e50_1 = ema(C1, 50);
  const e21_4  = ema(C4, 21), e50_4 = ema(C4, 50);

  const trend15 = e21_15.length && e50_15.length
    ? (e21_15[e21_15.length - 1] > e50_15[e50_15.length - 1] ? "UP" : "DOWN")
    : "FLAT";
  const trend1  = e21_1 > e50_1 ? "UP" : "DOWN";
  const trend4  = e21_4 > e50_4 ? "UP" : "DOWN";

  const swings15 = detectSwings(H15, L15, 2);
  const swings1  = detectSwings(H1,  L1,  2);
  const swings4  = detectSwings(H4,  L4,  2);

  const struct15 = structureBias(swings15);
  const struct1  = structureBias(swings1);
  const struct4  = structureBias(swings4);

  const fvg15 = detectFVG(H15, L15);
  const ob15  = detectOB(O15, H15, L15, C15, swings15);

  // last swings for levels
  const lastH15 = lastSwingOf("H", swings15);
  const lastL15 = lastSwingOf("L", swings15);

  const last = C15[C15.length - 1];

  // ---- Technical signal scoring (deterministic) ----
  let longScore = 0, shortScore = 0;
  const fired: string[] = [];

  // EMA momentum alignment
  if (trend15 === "UP") { longScore += 6; fired.push("EMA(21>50) 15m ↑"); }
  else { shortScore += 6; fired.push("EMA(21<50) 15m ↓"); }
  if (trend1 === "UP") longScore += 4; else shortScore += 4;
  if (trend4 === "UP") longScore += 3; else shortScore += 3;

  // Structure BOS/Context
  if (struct15 === "UP") { longScore += 6; fired.push("Structure 15m HH/HL"); }
  if (struct15 === "DOWN") { shortScore += 6; fired.push("Structure 15m LH/LL"); }
  if (struct1 === "UP") longScore += 4; if (struct1 === "DOWN") shortScore += 4;
  if (struct4 === "UP") longScore += 3; if (struct4 === "DOWN") shortScore += 3;

  // FVG confluence near price (15m)
  const nearFVGup = fvg15.find(g => g.side === "bull" && Math.abs(last - g.gapTop) <= ATR15 * 0.6);
  const nearFVGdn = fvg15.find(g => g.side === "bear" && Math.abs(last - g.gapBot) <= ATR15 * 0.6);
  if (nearFVGup) { longScore += 4; fired.push("Bull FVG nearby"); }
  if (nearFVGdn) { shortScore += 4; fired.push("Bear FVG nearby"); }

  // OB tag proximity
  const nearOBbull = ob15.find(o => o.side === "bull" && last >= o.lo && last <= o.hi + ATR15 * 0.2);
  const nearOBbear = ob15.find(o => o.side === "bear" && last <= o.hi && last >= o.lo - ATR15 * 0.2);
  if (nearOBbull) { longScore += 5; fired.push("Bull OB in play"); }
  if (nearOBbear) { shortScore += 5; fired.push("Bear OB in play"); }

  // SR flip & fakeout using last swings
  if (lastH15 && brokeAndRetested(lastH15.price, C15, H15, L15)) { longScore += 3; fired.push("SR Flip (over H)"); }
  if (lastL15 && brokeAndRetested(lastL15.price, C15, H15, L15)) { shortScore += 3; fired.push("SR Flip (under L)"); }
  if (lastH15 && wickFakeoutThrough(lastH15.price, O15, C15, H15, L15)) { shortScore += 2; fired.push("Fakeout above H"); }
  if (lastL15 && wickFakeoutThrough(lastL15.price, O15, C15, H15, L15)) { longScore += 2; fired.push("Fakeout below L"); }

  // Fib zones from recent swings (15m)
  // Up leg: last L then later H; Down leg: last H then later L
  const lastLow = lastL15, lastHigh = lastH15;
  let upLeg: { a: number; b: number } | null = null;
  let dnLeg: { a: number; b: number } | null = null;
  if (lastLow && lastHigh) {
    if (lastLow.idx < lastHigh.idx) upLeg = { a: lastLow.price, b: lastHigh.price };
    if (lastHigh.idx < lastLow.idx) dnLeg = { a: lastHigh.price, b: lastLow.price };
  }
  const zones = fibZoneFromSwings(upLeg, dnLeg);
  if (zones.bull && last >= zones.bull.r382 && last <= zones.bull.r618) { longScore += 4; fired.push("Fib 0.382–0.618 (bull)"); }
  if (zones.bear && last <= zones.bear.r382 && last >= zones.bear.r618) { shortScore += 4; fired.push("Fib 0.382–0.618 (bear)"); }

  // ---- Pick direction by higher score
  let dir: "Long" | "Short" = longScore >= shortScore ? "Long" : "Short";
  const setupSignals: string[] = [];
  const tf15 = `${trend15.toLowerCase()}/${struct15.toLowerCase()}`;
  const tf1  = `${trend1.toLowerCase()}/${struct1.toLowerCase()}`;
  const tf4  = `${trend4.toLowerCase()}/${struct4.toLowerCase()}`;

  // Build entry/SL/TP based on structure and ATR
  let entry = last;
  let stop: number;
  if (dir === "Long") {
    const baseSL = lastL15 ? lastL15.price : Math.min(...L15.slice(-20));
    stop = Math.min(baseSL, last - ATR15 * 0.8);
  } else {
    const baseSL = lastH15 ? lastH15.price : Math.max(...H15.slice(-20));
    stop = Math.max(baseSL, last + ATR15 * 0.8);
  }
  const risk = Math.abs(entry - stop);
  const tp1  = dir === "Long" ? entry + risk : entry - risk;
  const tp2  = dir === "Long" ? entry + risk * 1.8 : entry - risk * 1.8;

  // Short reasoning and named setup
  let shortReason = "Multi-signal confluence around recent structure.";
  let setupName = dir === "Long" ? "Continuation Pullback Long" : "Continuation Pullback Short";
  if (nearFVGup && dir === "Long") setupName = "15m FVG + OB Long";
  if (nearFVGdn && dir === "Short") setupName = "15m FVG + OB Short";
  if (lastH15 && dir === "Long" && entry > lastH15.price) setupName = "Range Break & Retest Long";
  if (lastL15 && dir === "Short" && entry < lastL15.price) setupName = "Range Break & Retest Short";

  // collect surfaced signals (top 6 only)
  for (const s of fired) {
    if (setupSignals.length >= 6) break;
    setupSignals.push(s);
  }

  // ---- Fundamentals: Headlines (scores already attached by /api/news) ----
  const headlineScores: number[] = Array.isArray(headlines)
    ? headlines.map((h: any) => Number(h?.sentiment?.score ?? 0)).filter((n) => Number.isFinite(n))
    : [];
  const newsSum = headlineScores.reduce((a, b) => a + b, 0);
  const newsBias = newsSum > 0 ? 1 : newsSum < 0 ? -1 : 0;
  const newsText = newsBias > 0 ? "positive" : newsBias < 0 ? "negative" : "neutral";

  // Macro context from headlines when no calendar
  const eventWatch: string[] = [];
  const now = Date.now();
  const macroMentions: string[] = [];
  for (const h of Array.isArray(headlines) ? headlines : []) {
    const title = String(h?.title || "").toLowerCase();
    if (!title) continue;
    if (MACRO_KEYWORDS.some(k => title.includes(k))) {
      const when = h?.published_at ? new Date(h.published_at).getTime() : now;
      const hoursAgo = Math.floor((now - when) / 3600000);
      macroMentions.push(`${h?.title || "(headline)"} — ${hoursAgo}h ago`);
      if (macroMentions.length >= 6) break;
    }
  }

  // ---- Calendar bias & upcoming warnings (optional) — WARNING ONLY (no cap) ----
  let instBiasScore = 0; // -5..+5 expected if provided by /api/calendar
  if (calendar && calendar.ok) {
    const bias = (calendar as any)?.bias;
    instBiasScore = Number(bias?.instrument?.score || 0) || 0;

    const items: any[] = Array.isArray((calendar as any)?.items) ? (calendar as any).items : [];
    for (const e of items) {
      if (!e?.time) continue;
      if (e?.impact !== "High" && e?.impact !== "Medium") continue;
      const mins = minutesUntil(e.time);
      if (mins >= 0 && mins <= 90) {
        eventWatch.push(`⚠️ ${e.impact} impact: ${e.title} in ~${mins} min (${e?.currency || e?.country || ""})`);
        if (eventWatch.length >= 4) break;
      }
    }
  } else if (macroMentions.length) {
    eventWatch.push("No calendar connected; macro context from recent headlines:");
    for (const m of macroMentions) eventWatch.push(`• ${m}`);
  }

  // ---- Conviction: Technical base + headlines + calendar (no blackout cap) ----
  // Base from technical delta
  let techScore = 50 + (dir === "Long" ? (longScore - shortScore) : (shortScore - longScore)) * 2;
  // Normalize
  techScore = clamp(techScore, 30, 80);
  // Apply fundamentals
  let conviction = techScore + newsBias * 7 + instBiasScore * 3;
  conviction = clamp(Math.round(conviction), 25, 92);

  // Alignment sentence
  const dirSign = dir === "Long" ? 1 : -1;
  const fundComposite = newsBias * 0.5 + Math.sign(instBiasScore) * 0.5;
  const aligned = (dirSign > 0 && fundComposite >= 0) || (dirSign < 0 && fundComposite <= 0);
  const alignText = aligned ? "Match (fundamentals support technicals)" : "Mixed (partial or weak support)";

  const priorityBias =
    instBiasScore !== 0
      ? `Calendar instrument bias ${instBiasScore > 0 ? "bullish" : "bearish"} (${instBiasScore.toFixed(1)}), headlines ${newsText}`
      : `Headlines ${newsText}, calendar bias unavailable`;

  const fundSummary =
    (calendar && calendar.ok)
      ? `Calendar bias ${instBiasScore > 0 ? "bullish" : instBiasScore < 0 ? "bearish" : "neutral"} (${instBiasScore.toFixed(1)}); headlines ${newsText}`
      : `Calendar unavailable; headlines ${newsText}`;

  // Scenarios
  const scenarios: string[] = [];
  scenarios.push(
    dir === "Long"
      ? "If price retests 15m OB / FVG / 0.5 fib and holds, consider continuation long."
      : "If price retests 15m OB / FVG / 0.5 fib and rejects, consider continuation short."
  );
  scenarios.push("Move to break-even at TP1; trail partials behind structure.");
  if (eventWatch.length) scenarios.push("If a high-impact release is imminent, prefer confirmation after the print.");

  const invalidation =
    dir === "Long"
      ? "Clean 15m close below protective swing low or heavy acceptance below EMA50."
      : "Clean 15m close above protective swing high or heavy acceptance above EMA50.";

  const card = toCard({
    symbol: instrument,
    dir,
    entry: Number(entry.toFixed(5)),
    sl: Number(stop.toFixed(5)),
    tp1: Number(tp1.toFixed(5)),
    tp2: Number(tp2.toFixed(5)),
    conviction,
    tf15: `${trend15.toLowerCase()} / ${struct15.toLowerCase()}`,
    tf1:  `${trend1.toLowerCase()} / ${struct1.toLowerCase()}`,
    tf4:  `${trend4.toLowerCase()} / ${struct4.toLowerCase()}`,
    shortReason,
    fundSummary,
    alignText,
    scenarios,
    invalidation,
    priorityBias,
    eventWatch,
    signals: setupSignals,
    setup: setupName,
  });

  return res.status(200).json({ ok: true, text: card, conviction, setup: setupName, signals: setupSignals });
}
