import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle } from "../../lib/prices";

type TF = "15m" | "1h" | "4h";
type PlanResp =
  | { ok: true; plan: { text: string; conviction: number }; usedHeadlines?: any[]; usedCalendar?: any[] }
  | { ok: false; reason: string; usedHeadlines?: any[]; usedCalendar?: any[] };

const LIMIT_15M = 300, LIMIT_H1 = 360, LIMIT_H4 = 360;
const clamp = (v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));

const asCloses=(a:Candle[])=>a.map(c=>c.c), asHighs=(a:Candle[])=>a.map(c=>c.h), asLows=(a:Candle[])=>a.map(c=>c.l);
function ema(vals:number[], p:number){ if(!vals.length||p<=1) return vals.slice(); const out:number[]=[]; const k=2/(p+1); let prev=vals[0]; for(let i=0;i<vals.length;i++){ const v=i===0?vals[0]:vals[i]*k+prev*(1-k); out.push(v); prev=v; } return out; }
function trendFromEMA(closes:number[], p=50):"up"|"down"|"flat"{ if(closes.length<p+5) return "flat"; const e=ema(closes,p); const a=e.at(-1)!, b=e.at(-6)!; if(a>b*1.0005) return "up"; if(a<b*0.9995) return "down"; return "flat"; }

function swingHigh(l: Candle[], look=20){ let idx=0, hi=-Infinity; for(let i=0;i<look && i<l.length;i++){ if(l[i].h>hi){hi=l[i].h; idx=i;} } return {p:hi, idx}; }
function swingLow (l: Candle[], look=20){ let idx=0, lo= Infinity; for(let i=0;i<look && i<l.length;i++){ if(l[i].l<lo){lo=l[i].l; idx=i;} } return {p:lo, idx}; }

function detectBOS(m15:Candle[], bias:"up"|"down"|"flat"){
  if(m15.length<120) return null;
  const highs=asHighs(m15), lows=asLows(m15), close=m15[0].c;
  const rh=Math.max(...highs.slice(0,60)), rl=Math.min(...lows.slice(0,60));
  if(close>rh) return {dir:"long" as const, note:"Break of structure (above recent swing high)", base:70+(bias==="up"?15:bias==="down"?-15:0)};
  if(close<rl) return {dir:"short" as const, note:"Break of structure (below recent swing low)", base:70+(bias==="down"?15:bias==="up"?-15:0)};
  return null;
}
function detectPullback(m15:Candle[], bias:"up"|"down"|"flat"){
  if(m15.length<120) return null;
  const highs=asHighs(m15), lows=asLows(m15), last=m15[0].c;
  const maxH=Math.max(...highs.slice(0,120)), minL=Math.min(...lows.slice(0,120));
  if(bias!=="down"){ const retr=(maxH-last)/(maxH-minL+1e-9); if(retr>0.382&&retr<0.618) return {dir:"long" as const, note:"Pullback into 38–62% zone", base:60}; }
  if(bias!=="up"){ const retr=(last-minL)/(maxH-minL+1e-9); if(retr>0.382&&retr<0.618) return {dir:"short" as const, note:"Pullback into 38–62% zone", base:60}; }
  return null;
}
function detectRange(m15:Candle[]){
  if(m15.length<200) return null;
  const highs=asHighs(m15).slice(0,120), lows=asLows(m15).slice(0,120);
  const hi=Math.max(...highs), lo=Math.min(...lows), width=(hi-lo)/((hi+lo)/2);
  if(width<0.004) return {dir:m15[0].c>((hi+lo)/2)?"short" as const:"long" as const, note:"Compression range", base:45};
  return null;
}

function scoreFromNews(headlines:any[]):number{
  if(!Array.isArray(headlines) || !headlines.length) return 0;
  let pos=0, neg=0;
  for(const h of headlines.slice(0,12)){
    const label=(h?.sentiment?.label||"neutral").toLowerCase();
    if(label==="positive") pos++; else if(label==="negative") neg++;
  }
  return clamp((pos-neg)*4, -10, 10); // ±10% max influence
}
function blackoutPenalty(calendar:any[]):number{
  if(!Array.isArray(calendar)) return 0;
  // if any high-impact item within ±90m → -10%
  const now=Date.now();
  for(const ev of calendar){
    const t = ev?.time ? new Date(ev.time).getTime() : null;
    const imp = (ev?.impact||"").toLowerCase();
    if(!t || !/high|3/.test(imp)) continue;
    if(Math.abs(t - now) <= 90*60*1000) return -10;
  }
  return 0;
}

const altSlash=(s:string)=>(!s.includes("/")&&s.length===6)?`${s.slice(0,3)}/${s.slice(3)}`:null;

async function fetchTF(code:string){
  const [m15,h1,h4] = await Promise.all([
    getCandles(code,"15m",LIMIT_15M),
    getCandles(code,"1h" ,LIMIT_H1),
    getCandles(code,"4h" ,LIMIT_H4),
  ]);
  return {m15,h1,h4};
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<PlanResp>) {
  const body = typeof req.body==="string" ? safeParse(req.body) : (req.body||{});
  let code = String(body?.instrument?.code || req.query.instrument || req.query.symbol || "EURUSD").toUpperCase();

  const usedCalendar = Array.isArray(body?.calendar) ? body.calendar : [];
  const usedHeadlines = Array.isArray(body?.headlines) ? body.headlines : [];

  // get data quickly (with one slash retry)
  let {m15,h1,h4} = await fetchTF(code);
  if(!(m15.length&&h1.length&&h4.length)){
    const alt = altSlash(code);
    if(alt){ const r2=await fetchTF(alt); m15=r2.m15.length?r2.m15:m15; h1=r2.h1.length?r2.h1:h1; h4=r2.h4.length?r2.h4:h4; }
  }

  const haveM15=!!m15.length, haveH1=!!h1.length, haveH4=!!h4.length;

  // HTF bias (fallback if missing)
  const h1Trend = haveH1?trendFromEMA(asCloses(h1),50):"flat";
  const h4Trend = haveH4?trendFromEMA(asCloses(h4),50):h1Trend;
  const bias: "up"|"down"|"flat" = (h1Trend===h4Trend?h1Trend:(h1Trend==="flat"?h4Trend:h1Trend));

  // Signals on 15m
  let candidates = [] as {dir:"long"|"short"; note:string; base:number}[];
  if(haveM15){
    const a=detectBOS(m15,bias), b=detectPullback(m15,bias), c=detectRange(m15);
    [a,b,c].forEach(x=>x&&candidates.push(x));
  }

  // If still empty, create a minimalist momentum idea so we ALWAYS return a plan
  if(!candidates.length && haveM15){
    const e21=ema(asCloses(m15),21), e50=ema(asCloses(m15),50);
    const dir = (e21.at(-1)!>=e50.at(-1)!) ? "long":"short";
    candidates.push({dir, note:"EMA21/50 momentum (weak)", base:40});
  }

  if(!haveM15){
    return res.status(200).json({ ok:false, reason:"Missing 15m data; try again in a minute.", usedHeadlines, usedCalendar });
  }

  // News & calendar weighting
  const newsW = scoreFromNews(usedHeadlines);
  const calW  = blackoutPenalty(usedCalendar);

  // Choose best and build entry/SL/TP from swings
  candidates.sort((a,b)=>b.base-a.base);
  const best = candidates[0];

  const lastClose = m15[0].c;
  const upSwing = swingLow(m15, 30).p;
  const dnSwing = swingHigh(m15, 30).p;

  const long = best.dir==="long";
  const entry = lastClose;
  const sl    = long ? upSwing : dnSwing;
  const risk  = Math.max(1e-6, Math.abs(entry - sl));
  const tp1   = long ? entry + risk : entry - risk;
  const tp2   = long ? entry + 2*risk : entry - 2*risk;

  // Final conviction
  let conviction = clamp(best.base + newsW + calW, 30, 85);
  if(!haveH1 || !haveH4) conviction = Math.min(conviction, 55); // partial HTF → cap
  const biasLine = `HTF bias → 1h: ${h1Trend}, 4h: ${h4Trend}`;

  const planText = [
    "Quick Plan (Actionable)",
    `• Direction: ${long?"LONG":"SHORT"}`,
    `• Entry: ${entry.toFixed(5)}  (market or limit)`,
    `• Stop Loss: ${sl.toFixed(5)}`,
    `• Take Profit(s): TP1 ${tp1.toFixed(5)} / TP2 ${tp2.toFixed(5)}`,
    `• Conviction: ${conviction}%`,
    `• Short Reasoning: ${best.note}. ${biasLine}${(newsW||calW)?` (news:+${newsW}% cal:${calW}%)`:""}`,

    "",
    "Full Breakdown",
    `• Technical View (HTF + Intraday): ${biasLine}. 15m: ${best.note}.`,
    `• Fundamental View: using last ${Math.min(12, usedHeadlines?.length||0)} headlines; calendar events considered in ±90m window.`,
    `• Tech vs Fundy Alignment: ${newsW>=0?"Match/Neutral":"Potential mismatch"} (news weight ${newsW}%).`,
    `• Conditional Scenarios: if price revisits ${sl.toFixed(5)} without invalidation, re-evaluate; if impulsive move pierces TP1 quickly, trail to BE.`,
    `• Surprise Risk: unscheduled central-bank remarks; sudden risk-on/off flows.`,
    `• Invalidation: close beyond ${long?dnSwing:upSwing} on 15m.`,
    `• One-liner: ${long?"Buy pullbacks in up-bias":"Sell rallies in down-bias"} with risk defined at swing ${long?"low":"high"}.`,
  ].join("\n");

  return res.status(200).json({ ok:true, plan: { text: planText, conviction }, usedHeadlines, usedCalendar });
}

function safeParse(s:string){ try{return JSON.parse(s)}catch{return{}} }
