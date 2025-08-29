// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle } from "../../lib/prices";

/** ===== Response types ===== */
type PlanOk = { ok: true; text: string; conviction: number; setup: string; signals: string[] };
type PlanFail = { ok: false; reason: string };
type PlanResp = PlanOk | PlanFail;

/** ===== Utility ===== */
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const getOpens  = (a: Candle[]) => a.map(c => c.o);
const getHighs  = (a: Candle[]) => a.map(c => c.h);
const getLows   = (a: Candle[]) => a.map(c => c.l);
const getCloses = (a: Candle[]) => a.map(c => c.c);

function ema(vals: number[], p: number): number {
  if (!vals.length) return 0;
  const k = 2 / (p + 1);
  let e = vals[0];
  for (let i = 1; i < vals.length; i++) e = e + k * (vals[i] - e);
  return e;
}

function atr(H: number[], L: number[], C: number[], period = 14): number {
  if (H.length < period + 1) return 0;
  const tr: number[] = [];
  for (let i = 1; i < H.length; i++) {
    const a = H[i] - L[i];
    const b = Math.abs(H[i] - C[i - 1]);
    const c = Math.abs(L[i] - C[i - 1]);
    tr.push(Math.max(a, b, c));
  }
  const last = tr.slice(-period);
  return last.reduce((s, x) => s + x, 0) / last.length;
}

/** ===== Ticks & rounding (no artificial minimums) ===== */
function tickSizeFor(sym: string): number {
  const s = sym.toUpperCase();
  if (s.endsWith("JPY")) return 0.01;
  if (s.includes("XAU")) return 0.1;
  if (s.includes("XAG")) return 0.01;
  if (s.includes("BTC") || s.includes("ETH")) return 1;
  if (/^(US30|DJI|US100|NAS100|NDX|US500|SPX|GER40|DE40|UK100|FTSE|DAX)/.test(s)) return 1;
  return 0.0001; // default FX
}
const roundTick = (v: number, t: number) => Math.round(v / t) * t;
const ceilTick  = (v: number, t: number) => Math.ceil(v / t) * t;
const floorTick = (v: number, t: number) => Math.floor(v / t) * t;

/** ===== Swings & structure ===== */
type Swing = { idx: number; price: number; type: "H" | "L" };

function detectSwings(H: number[], L: number[], lb = 2): Swing[] {
  const s: Swing[] = [];
  for (let i = lb; i < H.length - lb; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= lb; k++) {
      if (!(H[i] > H[i - k] && H[i] > H[i + k])) isH = false;
      if (!(L[i] < L[i - k] && L[i] < L[i + k])) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) s.push({ idx: i, price: H[i], type: "H" });
    if (isL) s.push({ idx: i, price: L[i], type: "L" });
  }
  return s.sort((a, b) => a.idx - b.idx);
}

function lastSwing(type: "H" | "L", swings: Swing[]): Swing | null {
  for (let i = swings.length - 1; i >= 0; i--) if (swings[i].type === type) return swings[i];
  return null;
}

type Struct = "UP" | "DOWN" | "TRANSITION" | "RANGE";
function structureFromSwings(sw: Swing[]): Struct {
  const s = sw.slice(-8);
  if (s.length < 4) return "TRANSITION";
  // require two legs confirming
  const highs = s.filter(x => x.type === "H");
  const lows  = s.filter(x => x.type === "L");
  let HH = 0, LH = 0, HL = 0, LL = 0;
  for (let i = 1; i < highs.length; i++) (highs[i].price > highs[i - 1].price) ? HH++ : LH++;
  for (let i = 1; i < lows.length;  i++) (lows[i].price  > lows[i - 1].price)  ? HL++ : LL++;
  if (HH >= 2 && HL >= 2) return "UP";
  if (LH >= 2 && LL >= 2) return "DOWN";
  // flat band?
  const hi = Math.max(...s.map(x => x.price));
  const lo = Math.min(...s.map(x => x.price));
  const midBand = (hi - lo) / (s[s.length - 1].idx - s[0].idx + 1);
  if (midBand < (hi - lo) * 0.002) return "RANGE";
  return "TRANSITION";
}

/** ===== BOS / SR-flip / Liquidity Sweep / FVG / OB / Fib ===== */
type BOS = { side: "up" | "down"; level: number; idx: number };
function detectBOS(C: number[], H: number[], L: number[], sw: Swing[]): BOS | null {
  const i = C.length - 1;
  const lastH = lastSwing("H", sw);
  const lastL = lastSwing("L", sw);
  if (lastH && C[i] > lastH.price) return { side: "up", level: lastH.price, idx: i };
  if (lastL && C[i] < lastL.price) return { side: "down", level: lastL.price, idx: i };
  return null;
}

function detectSRFlip(C: number[], H: number[], L: number[], sw: Swing[]): { level: number; side: "bull" | "bear" } | null {
  const lastH = lastSwing("H", sw);
  const lastL = lastSwing("L", sw);
  const n = C.length;
  if (lastH) {
    const broke = C.slice(lastH.idx + 1).some(c => c > lastH.price);
    const retest = L.slice(-30).some(x => x <= lastH.price);
    if (broke && retest) return { level: lastH.price, side: "bull" };
  }
  if (lastL) {
    const broke = C.slice(lastL.idx + 1).some(c => c < lastL.price);
    const retest = H.slice(-30).some(x => x >= lastL.price);
    if (broke && retest) return { level: lastL.price, side: "bear" };
  }
  return null;
}

function detectLiquiditySweep(O: number[], C: number[], H: number[], L: number[], sw: Swing[]): { side: "bull" | "bear"; wickLevel: number } | null {
  const lastH = lastSwing("H", sw);
  const lastL = lastSwing("L", sw);
  const n = C.length - 1;
  if (lastH && H[n] > lastH.price && Math.max(O[n], C[n]) < lastH.price) return { side: "bear", wickLevel: lastH.price };
  if (lastL && L[n] < lastL.price && Math.min(O[n], C[n]) > lastL.price) return { side: "bull", wickLevel: lastL.price };
  return null;
}

type FVG = { startIdx: number; endIdx: number; gapTop: number; gapBot: number; side: "bull" | "bear" };
function detectFVG(H: number[], L: number[]): FVG[] {
  const out: FVG[] = [];
  for (let i = 2; i < H.length; i++) {
    const bull = L[i] > H[i - 2];
    const bear = H[i] < L[i - 2];
    if (bull) out.push({ startIdx: i - 2, endIdx: i, gapTop: L[i], gapBot: H[i - 2], side: "bull" });
    if (bear) out.push({ startIdx: i - 2, endIdx: i, gapTop: L[i - 2], gapBot: H[i], side: "bear" });
  }
  return out.slice(-10);
}

type OB = { idx: number; hi: number; lo: number; side: "bull" | "bear" };
function detectOB(O: number[], H: number[], L: number[], C: number[], sw: Swing[]): OB[] {
  const out: OB[] = [];
  const swingH = sw.filter(s => s.type === "H").slice(-5);
  const swingL = sw.filter(s => s.type === "L").slice(-5);
  for (let i = 2; i < C.length; i++) {
    const brokeH = swingH.some(sh => C[i] > sh.price && i > sh.idx);
    if (brokeH) {
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        if (C[j] < O[j]) { out.push({ idx: j, hi: H[j], lo: L[j], side: "bull" }); break; }
      }
    }
    const brokeL = swingL.some(sl => C[i] < sl.price && i > sl.idx);
    if (brokeL) {
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        if (C[j] > O[j]) { out.push({ idx: j, hi: H[j], lo: L[j], side: "bear" }); break; }
      }
    }
  }
  return out.slice(-8);
}

type FibZone = { a: number; b: number; r382: number; r5: number; r618: number };
function fibZones(lastLow: Swing | null, lastHigh: Swing | null) {
  const z: { bull?: FibZone; bear?: FibZone } = {};
  if (lastLow && lastHigh && lastLow.idx < lastHigh.idx) {
    const a = lastLow.price, b = lastHigh.price;
    z.bull = { a, b, r382: a + (b - a) * 0.382, r5: a + (b - a) * 0.5, r618: a + (b - a) * 0.618 };
  }
  if (lastHigh && lastLow && lastHigh.idx < lastLow.idx) {
    const a = lastHigh.price, b = lastLow.price;
    z.bear = { a, b, r382: b + (a - b) * 0.618, r5: b + (a - b) * 0.5, r618: b + (a - b) * 0.382 };
  }
  return z;
}

/** ===== Trendline (simple) ===== */
function simpleTrendlineBreak(sw: Swing[], C: number[]): { side: "up" | "down" } | null {
  // take last two highs and two lows; if price closes through the opposite line, count it
  const highs = sw.filter(s => s.type === "H");
  const lows  = sw.filter(s => s.type === "L");
  const n = C.length - 1;
  if (highs.length >= 2) {
    const h1 = highs[highs.length - 2], h2 = highs[highs.length - 1];
    const slope = (h2.price - h1.price) / (h2.idx - h1.idx);
    const expected = h2.price + slope * (n - h2.idx);
    if (C[n] > expected) return { side: "up" };
  }
  if (lows.length >= 2) {
    const l1 = lows[lows.length - 2], l2 = lows[lows.length - 1];
    const slope = (l2.price - l1.price) / (l2.idx - l1.idx);
    const expected = l2.price + slope * (n - l2.idx);
    if (C[n] < expected) return { side: "down" };
  }
  return null;
}

/** ===== Headlines (calendar optional) ===== */
const MACRO_WORDS = [
  "cpi","inflation","ppi","core","gdp","retail sales","industrial production","durable goods",
  "pmi","ism","confidence","sentiment","unemployment","jobless","claims","payrolls","nfp",
  "rate decision","interest rate","fomc","ecb","boe","boj","rba","boc","snb","trade balance",
  "war","conflict","sanction","ceasefire","tariff","attack","strike","escalation"
];
const minsUntil = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / 60000);

/** ===== Card builder ===== */
function card({
  symbol, dir, orderType, trigger, entry, sl, tp1, tp2, conviction, setup, reasons,
  t15, t1, t4, fund, align, scenarios, invalid, watch, signals,
}: any) {
  return [
    "Quick Plan (Actionable)",
    "",
    `• Direction: ${dir}`,
    `• Order Type: ${orderType}`,
    `• Trigger: ${trigger}`,
    `• Entry: ${entry}`,
    `• Stop Loss: ${sl}`,
    `• Take Profit(s): TP1 ${tp1} / TP2 ${tp2}`,
    `• Conviction: ${conviction}%`,
    `• Setup: ${setup}`,
    `• Short Reasoning: ${reasons}`,
    "",
    "Full Breakdown",
    "",
    `• Technical View (HTF + Intraday): 4H=${t4}, 1H=${t1}, 15m=${t15}`,
    `• Signals Triggered: ${signals.join(" · ") || "—"}`,
    `• Fundamental View (Calendar + Sentiment): ${fund}`,
    `• Tech vs Fundy Alignment: ${align}`,
    "• Conditional Scenarios:",
    ...scenarios.map((s: string) => `  - ${s}`),
    "• Surprise Risk: unscheduled CB comments; geopolitical headlines.",
    `• Invalidation: ${invalid}`,
    "",
    "News / Event Watch",
    ...(watch.length ? watch.map((w: string) => `• ${w}`) : ["• No calendar connected; using headlines only."]),
    "",
    "Notes",
    "",
    `• Symbol: ${symbol}`,
  ].join("\n");
}

/** ===== API ===== */
export default async function handler(req: NextApiRequest, res: NextApiResponse<PlanResp>) {
  // ---- Input ----
  let instrument = "EURUSD";
  let headlines: any[] = [];
  let calendar: any = null;

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    instrument = String(body.instrument || body.code || req.query.instrument || req.query.code || "EURUSD").toUpperCase().replace(/\s+/g, "");
    headlines = Array.isArray(body.headlines) ? body.headlines : [];
    calendar  = body.calendar ?? null;
  } catch {
    instrument = String(req.query.instrument || "EURUSD").toUpperCase();
  }

  // ---- Candles (real) ----
  const [m15, h1, h4] = await Promise.all([
    getCandles(instrument, "15m", 400),
    getCandles(instrument, "1h",  600),
    getCandles(instrument, "4h",  800),
  ]);
  if (!Array.isArray(m15) || m15.length < 50) return res.status(200).json({ ok: false, reason: "Missing 15m candles" });

  const O15 = getOpens(m15), H15 = getHighs(m15), L15 = getLows(m15), C15 = getCloses(m15);
  const H1  = getHighs(h1||[]),  L1  = getLows(h1||[]),  C1  = getCloses(h1||[]);
  const H4  = getHighs(h4||[]),  L4  = getLows(h4||[]),  C4  = getCloses(h4||[]);

  const tick = tickSizeFor(instrument);
  const dec  = (tick.toString().split(".")[1]?.length || 0);
  const fmt  = (n: number) => Number(n.toFixed(dec));
  const last = C15[C15.length - 1];
  const A15  = atr(H15, L15, C15, 14);

  // ---- Structure (PA first) ----
  const sw15 = detectSwings(H15, L15, 2);
  const sw1  = detectSwings(H1,  L1,  2);
  const sw4  = detectSwings(H4,  L4,  2);

  const st15 = structureFromSwings(sw15);
  const st1  = structureFromSwings(sw1);
  const st4  = structureFromSwings(sw4);

  // EMAs only for description (not scoring)
  const ema21_15 = ema(C15, 21), ema50_15 = ema(C15, 50);
  const emaCtx = ema21_15 > ema50_15 ? "ema-supportive" : "ema-against";

  // ---- Strategy detections (PA) ----
  const bos15 = detectBOS(C15, H15, L15, sw15);
  const srFlip15 = detectSRFlip(C15, H15, L15, sw15);
  const sweep15 = detectLiquiditySweep(O15, C15, H15, L15, sw15);
  const fvg15 = detectFVG(H15, L15);
  const ob15  = detectOB(O15, H15, L15, C15, sw15);
  const tlBreak = simpleTrendlineBreak(sw15, C15);

  const lastH = lastSwing("H", sw15);
  const lastL = lastSwing("L", sw15);
  const fibZ  = fibZones(lastL, lastH);

  // ---- Score long vs short from PA (no EMA weight) ----
  let longPts = 0, shortPts = 0;
  const sigs: string[] = [];

  // HTF alignment
  if (st4 === "UP") longPts += 5; else if (st4 === "DOWN") shortPts += 5;
  if (st1 === "UP") longPts += 3; else if (st1 === "DOWN") shortPts += 3;
  if (st15 === "UP") longPts += 4; else if (st15 === "DOWN") shortPts += 4;

  if (bos15?.side === "up") { longPts += 4; sigs.push("BOS↑"); }
  if (bos15?.side === "down") { shortPts += 4; sigs.push("BOS↓"); }

  if (srFlip15?.side === "bull") { longPts += 3; sigs.push("SR-flip bull"); }
  if (srFlip15?.side === "bear") { shortPts += 3; sigs.push("SR-flip bear"); }

  if (sweep15?.side === "bull") { longPts += 2; sigs.push("Liquidity sweep (below L)"); }
  if (sweep15?.side === "bear") { shortPts += 2; sigs.push("Liquidity sweep (above H)"); }

  const nearBullFVG = fvg15.find(g => g.side === "bull" && Math.abs(last - g.gapTop) <= A15 * 0.6);
  const nearBearFVG = fvg15.find(g => g.side === "bear" && Math.abs(last - g.gapBot) <= A15 * 0.6);
  if (nearBullFVG) { longPts += 2; sigs.push("FVG bull"); }
  if (nearBearFVG) { shortPts += 2; sigs.push("FVG bear"); }

  const nearOBbull = ob15.find(o => o.side === "bull" && last >= o.lo && last <= o.hi);
  const nearOBbear = ob15.find(o => o.side === "bear" && last <= o.hi && last >= o.lo);
  if (nearOBbull) { longPts += 3; sigs.push("OB bull"); }
  if (nearOBbear) { shortPts += 3; sigs.push("OB bear"); }

  if (tlBreak?.side === "up") { longPts += 2; sigs.push("Trendline break ↑"); }
  if (tlBreak?.side === "down") { shortPts += 2; sigs.push("Trendline break ↓"); }

  const dir: "Long" | "Short" = longPts >= shortPts ? "Long" : "Short";
  const dirSign = dir === "Long" ? 1 : -1;

  // ---- Choose setup: Breakout vs Pullback (OB/FVG/Fib) ----
  let orderType: "Buy Stop" | "Sell Stop" | "Buy Limit" | "Sell Limit" | "Market" = "Market";
  let trigger = "";
  let entry = last, sl = last, tp1 = last, tp2 = last;
  let setupName = "";
  let reason = "";
  const buffer = Math.max(tick * 2, 0); // tiny buffer, **not** an artificial minimum

  const nextBullSwingTarget = () => {
    const h = sw15.filter(s => s.type === "H").map(s => s.price).filter(p => p > entry).sort((a,b)=>a-b)[0];
    return h ?? (entry + Math.abs(entry - sl));
  };
  const nextBearSwingTarget = () => {
    const l = sw15.filter(s => s.type === "L").map(s => s.price).filter(p => p < entry).sort((a,b)=>b-a)[0];
    return l ?? (entry - Math.abs(entry - sl));
  };

  if (dir === "Long") {
    // Prefer pullback if inside bull fib or OB/FVG
    const inBullFib = !!(fibZ.bull && last >= fibZ.bull.r382 && last <= fibZ.bull.r618);
    if (inBullFib || nearOBbull || nearBullFVG) {
      orderType = "Buy Limit";
      const zoneMid = fibZ.bull ? fibZ.bull.r5 : last;
      const prefer = nearOBbull ? Math.min(zoneMid, nearOBbull.hi) : zoneMid;
      entry = floorTick(prefer, tick);
      // SL: purely technical — below protective swing / zone
      const zoneFloor = Math.min(
        fibZ.bull ? fibZ.bull.a : entry,
        nearOBbull ? nearOBbull.lo : entry
      );
      sl = floorTick(zoneFloor - buffer, tick);
      setupName = "Pullback (OB/FVG + Fib 0.5) Long";
      reason = "Retrace into 15m confluence zone (OB/FVG/Fib) within HTF up-bias.";
      trigger = `Limit near 0.5 of last leg${nearOBbull ? ", OB confluence" : nearBullFVG ? ", FVG confluence" : ""}`;
    } else if (bos15?.side === "up" || srFlip15?.side === "bull") {
      orderType = "Buy Stop";
      const level = lastH ? lastH.price : last;
      entry = ceilTick(level + buffer, tick);
      // SL: last protective swing low
      const prot = lastL ? lastL.price : (entry - A15);
      sl = floorTick(prot - buffer, tick);
      setupName = "Breakout + SR-flip Long";
      reason = "BOS/SR-flip through 15m high with HTF support.";
      trigger = `Stop above swing H ${fmt(level)}`;
    } else {
      // fallback: market with protective swing SL
      orderType = "Buy Limit";
      entry = floorTick(last, tick);
      const prot = lastL ? lastL.price : (entry - A15);
      sl = floorTick(prot - buffer, tick);
      setupName = "Continuation Long (structure)";
      reason = "HTF up-bias with supportive structure; conservative protective SL.";
      trigger = "At market / minor pullback";
    }
    const risk = Math.abs(entry - sl);
    tp1 = fmt(nextBullSwingTarget());
    if (tp1 - entry < risk) tp1 = fmt(entry + risk);
    tp2 = fmt(Math.max(tp1, entry + risk * 1.8));
  } else {
    // Short
    const inBearFib = !!(fibZ.bear && last <= fibZ.bear.r382 && last >= fibZ.bear.r618);
    if (inBearFib || nearOBbear || nearBearFVG) {
      orderType = "Sell Limit";
      const zoneMid = fibZ.bear ? fibZ.bear.r5 : last;
      const prefer = nearOBbear ? Math.max(zoneMid, nearOBbear.lo) : zoneMid;
      entry = ceilTick(prefer, tick);
      const zoneCeil = Math.max(
        fibZ.bear ? fibZ.bear.a : entry,
        nearOBbear ? nearOBbear.hi : entry
      );
      sl = ceilTick(zoneCeil + buffer, tick);
      setupName = "Pullback (OB/FVG + Fib 0.5) Short";
      reason = "Retrace into 15m confluence zone (OB/FVG/Fib) within HTF down-bias.";
      trigger = `Limit near 0.5 of last leg${nearOBbear ? ", OB confluence" : nearBearFVG ? ", FVG confluence" : ""}`;
    } else if (bos15?.side === "down" || srFlip15?.side === "bear") {
      orderType = "Sell Stop";
      const level = lastL ? lastL.price : last;
      entry = floorTick(level - buffer, tick);
      const prot = lastH ? lastH.price : (entry + A15);
      sl = ceilTick(prot + buffer, tick);
      setupName = "Breakout + SR-flip Short";
      reason = "BOS/SR-flip through 15m low with HTF support.";
      trigger = `Stop below swing L ${fmt(level)}`;
    } else {
      orderType = "Sell Limit";
      entry = ceilTick(last, tick);
      const prot = lastH ? lastH.price : (entry + A15);
      sl = ceilTick(prot + buffer, tick);
      setupName = "Continuation Short (structure)";
      reason = "HTF down-bias with supportive structure; conservative protective SL.";
      trigger = "At market / minor pullback";
    }
    const risk = Math.abs(entry - sl);
    tp1 = fmt(nextBearSwingTarget());
    if (entry - tp1 < risk) tp1 = fmt(entry - risk);
    tp2 = fmt(Math.min(tp1, entry - risk * 1.8));
  }

  // Final safety: ensure SL != Entry (still technical — one tick beyond)
  if (dir === "Long" && sl >= entry) sl = floorTick(entry - tick, tick);
  if (dir === "Short" && sl <= entry) sl = ceilTick(entry + tick, tick);

  entry = fmt(entry); sl = fmt(sl); tp1 = fmt(tp1); tp2 = fmt(tp2);

  // ---- Fundamentals (headlines + optional calendar) ----
  const scores = Array.isArray(headlines) ? headlines
    .map(h => Number(h?.sentiment?.score ?? 0))
    .filter(n => Number.isFinite(n)) : [];
  const newsSum = scores.reduce((a, b) => a + b, 0);
  const newsBias = newsSum > 0 ? 1 : newsSum < 0 ? -1 : 0;
  const newsText = newsBias > 0 ? "positive" : newsBias < 0 ? "negative" : "neutral";

  const watch: string[] = [];
  const macroRefs: string[] = [];
  for (const h of headlines || []) {
    const title = String(h?.title || "").toLowerCase();
    if (!title) continue;
    if (MACRO_WORDS.some(w => title.includes(w))) {
      const t = h?.published_at ? new Date(h.published_at).getTime() : Date.now();
      const hours = Math.floor((Date.now() - t) / 3600000);
      macroRefs.push(`${h.title} — ${hours}h ago`);
      if (macroRefs.length >= 6) break;
    }
  }
  if (calendar?.ok) {
    const items: any[] = Array.isArray(calendar.items) ? calendar.items : [];
    for (const e of items) {
      if (!e?.time) continue;
      if (e.impact !== "High" && e.impact !== "Medium") continue;
      const m = minsUntil(e.time);
      if (m >= 0 && m <= 90) watch.push(`⚠️ ${e.impact} ${e.title} in ~${m} min (${e.currency || e.country || ""})`);
    }
  } else if (macroRefs.length) {
    watch.push("No calendar connected; macro items from headlines:");
    for (const r of macroRefs) watch.push(`• ${r}`);
  }

  // ---- Conviction (PA-led + fundamentals assist) ----
  const techDelta = Math.abs(longPts - shortPts);
  let baseConv = clamp(50 + techDelta * 4, 40, 85); // PA only
  baseConv += newsBias * 5;                          // small nudge from headlines
  const conviction = clamp(Math.round(baseConv), 25, 92);

  const t15 = `${st15.toLowerCase()} (${emaCtx})`;
  const t1  = `${st1.toLowerCase()}`;
  const t4  = `${st4.toLowerCase()}`;
  const fund = calendar?.ok
    ? `Calendar ${calendar?.bias?.instrument?.score > 0 ? "bullish" : calendar?.bias?.instrument?.score < 0 ? "bearish" : "neutral"}; headlines ${newsText}`
    : `Calendar unavailable; headlines ${newsText}`;
  const align = (dirSign > 0 && newsBias >= 0) || (dirSign < 0 && newsBias <= 0) ? "Match" : "Mixed";
  const scenarios: string[] = [];
  if (orderType.endsWith("Limit")) {
    scenarios.push(dir === "Long" ? "Execute on bullish rejection/BOS inside zone; else wait."
                                  : "Execute on bearish rejection/BOS inside zone; else wait.");
  } else {
    scenarios.push(dir === "Long" ? "If breakout fails back under swing H, stand down." :
                                    "If breakout fails back above swing L, stand down.");
  }
  scenarios.push("Move to BE at TP1; trail partials behind 15m structure.");
  const invalid = dir === "Long"
    ? "Clean 15m close below protective swing/zone."
    : "Clean 15m close above protective swing/zone.";

  const text = card({
    symbol: instrument,
    dir,
    orderType,
    trigger,
    entry,
    sl,
    tp1,
    tp2,
    conviction,
    setup: setupName,
    reasons: reason,
    t15, t1, t4,
    fund,
    align,
    scenarios,
    invalid,
    watch,
    signals: sigs,
  });

  return res.status(200).json({
    ok: true,
    text,
    conviction,
    setup: setupName,
    signals: sigs,
  });
}
