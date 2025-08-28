// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle } from "../../lib/prices";

type TF = "15m" | "1h" | "4h";
type PlanOk = { ok: true; plan: { text: string; conviction: number } };
type PlanErr = { ok: false; reason: string };
type PlanResp = PlanOk | PlanErr;

const LIMIT_15M = 300, LIMIT_H1 = 360, LIMIT_H4 = 360;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const getCloses = (a: Candle[]) => a.map(c => c.c);
const getHighs  = (a: Candle[]) => a.map(c => c.h);
const getLows   = (a: Candle[]) => a.map(c => c.l);

function ema(vals:number[], p:number){ if(!vals.length||p<=1) return vals.slice(); const out:number[]=[]; const k=2/(p+1); let prev=vals[0]; for(let i=0;i<vals.length;i++){ const v=i===0?vals[0]:vals[i]*k+prev*(1-k); out.push(v); prev=v; } return out; }
function trendFromEMA(closes:number[], p=50):"up"|"down"|"flat"{ if(closes.length<p+5) return "flat"; const e=ema(closes,p); const a=e[e.length-1], b=e[e.length-6]; if(a>b*1.0008) return "up"; if(a<b*0.9992) return "down"; return "flat"; }

function lastSwingHigh(lows:number[], highs:number[]):number{
  // find most recent pivot high (simple lookback)
  for(let i=2;i<highs.length-2;i++){
    const idx = i;
    if(highs[idx] > highs[idx+1] && highs[idx] > highs[idx-1]) return highs[idx];
  }
  return Math.max(...highs.slice(0,30));
}
function lastSwingLow(lows:number[], highs:number[]):number{
  for(let i=2;i<lows.length-2;i++){
    const idx = i;
    if(lows[idx] < lows[idx+1] && lows[idx] < lows[idx-1]) return lows[idx];
  }
  return Math.min(...lows.slice(0,30));
}
function avgTrueRangeLike(bars:Candle[], n=14){
  if(bars.length<n+1) return 0;
  let sum=0;
  for(let i=0;i<n;i++){
    const c=bars[i], p=bars[i+1];
    const tr=Math.max(c.h-c.l, Math.abs(c.h-p.c), Math.abs(c.l-p.c));
    sum+=tr;
  }
  return sum/n;
}

function buildQuickPlan(symbol:string, dir:"LONG"|"SHORT", entry:number, sl:number, tp1:number, tp2:number, conviction:number, shortReason:string){
  return [
    "Quick Plan (Actionable)",
    `• Direction: ${dir}`,
    `• Entry: ${entry.toFixed(5)}`,
    `• Stop Loss: ${sl.toFixed(5)}`,
    `• Take Profit(s): TP1 ${tp1.toFixed(5)} / TP2 ${tp2.toFixed(5)}`,
    `• Conviction: ${conviction}%`,
    `• Short Reasoning: ${shortReason}`,
    "",
  ].join("\n");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<PlanResp>) {
  // Read POST JSON (instrument, headlines, calendar) – UI already sends it
  let code = "EURUSD";
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    if (body?.instrument?.code) code = String(body.instrument.code).toUpperCase();
  } catch {}
  // Headlines + Calendar (optional)
  const headlines: any[] = (typeof req.body === "object" && req.body && (req.body as any).headlines) || [];
  const calendar: any[]  = (typeof req.body === "object" && req.body && (req.body as any).calendar) || [];

  // Fetch all TFs in parallel (Yahoo fallback is inside getCandles)
  const [m15, h1, h4] = await Promise.all([
    getCandles(code, "15m", LIMIT_15M),
    getCandles(code, "1h",  LIMIT_H1),
    getCandles(code, "4h",  LIMIT_H4),
  ]);

  if (!m15.length) {
    return res.status(200).json({ ok:false, reason:"Missing 15m candles; cannot build execution plan" });
  }

  // HTF context (if missing, we’ll still build a low-conviction plan)
  const h1Trend = h1.length ? trendFromEMA(getCloses(h1), 50) : "flat";
  const h4Trend = h4.length ? trendFromEMA(getCloses(h4), 50) : "flat";
  const bias: "up"|"down"|"flat" =
    h1Trend === h4Trend ? h1Trend : (h1Trend === "flat" ? h4Trend : h1Trend);

  // Intraday logic
  const closes = getCloses(m15), highs = getHighs(m15), lows = getLows(m15);
  const last = closes[0];
  const hi20 = Math.max(...highs.slice(0,80)), lo20 = Math.min(...lows.slice(0,80));
  const width = (hi20 - lo20) / ((hi20+lo20)/2);

  // Simple signal set (always pick something)
  let note = "";
  let direction: "LONG" | "SHORT" = "LONG";
  let baseConv = 45;

  if (last > hi20) { note = "Breakout above recent swing high"; direction = "LONG"; baseConv = 62; }
  else if (last < lo20) { note = "Breakdown below recent swing low"; direction = "SHORT"; baseConv = 62; }
  else if (width < 0.004) { note = "Compression range"; direction = last > (hi20+lo20)/2 ? "SHORT" : "LONG"; baseConv = 45; }
  else { note = "Range trading conditions"; baseConv = 40; }

  // HTF tie-breaker bumps/penalizes conviction
  if (bias === "up" && direction === "LONG") baseConv += 10;
  if (bias === "down" && direction === "SHORT") baseConv += 10;
  if ((bias === "up" && direction === "SHORT") || (bias === "down" && direction === "LONG")) baseConv -= 8;

  // Fundamental tilt from headlines/calendar
  const hdCount = Array.isArray(headlines) ? headlines.length : 0;
  const blackout = Array.isArray(calendar) && calendar.some((e:any)=>e?.impact==="High" && e?.isBlackout);
  if (hdCount >= 6) baseConv += 3;                     // more context → slightly higher
  if (blackout) baseConv -= 10;                        // blackout window → caution

  baseConv = clamp(Math.round(baseConv), 20, 85);

  // Entry/SL/TP from structure
  const atr = avgTrueRangeLike(m15, 14) || (Math.abs(hi20 - lo20)/8);
  const sh = lastSwingHigh(lows, highs), slw = lastSwingLow(lows, highs);
  let entry = last, sl = last, tp1 = last, tp2 = last;

  if (direction === "LONG") {
    entry = last; sl = Math.min(slw, last - 1.2*atr);
    tp1 = last + 1.5*atr; tp2 = last + 3*atr;
  } else {
    entry = last; sl = Math.max(sh, last + 1.2*atr);
    tp1 = last - 1.5*atr; tp2 = last - 3*atr;
  }

  const quick = buildQuickPlan(code, direction, entry, sl, tp1, tp2, baseConv, note);
  const full = [
    "Full Breakdown",
    `• Technical View (HTF + Intraday): 1h=${h1Trend}, 4h=${h4Trend}; 15m=${note}`,
    `• Fundamental View (last ${hdCount} headlines): ${blackout ? "BLACKOUT in effect (±90m) — conviction reduced" : "no blackout"}`,
    `• Tech vs Fundy Alignment: ${bias==="flat" ? "Neutral" : ( (bias==="up" && direction==="LONG") || (bias==="down" && direction==="SHORT") ? "Match" : "Mixed" )}`,
    `• Conditional Scenarios: If price invalidates SL, stand down; otherwise manage at TP1 → BE.`,
    `• Surprise Risk: unscheduled CB comments; political soundbites.`,
    `• Invalidation: clear close beyond SL level.`,
    "",
    "Notes",
    `Symbol: ${code}`,
  ].join("\n");

  const text = [quick, full].join("\n");
  return res.status(200).json({ ok:true, plan:{ text, conviction: baseConv } });
}
