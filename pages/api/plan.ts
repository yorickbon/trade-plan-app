// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle } from "../../lib/prices";

type TF = "15m" | "1h" | "4h";
type ScanResult = { ok: boolean; direction?: "bull" | "bear"; confidence?: number; note?: string };

type PlanResponse =
  | { ok: true; plan: { text: string; conviction?: number | null }; usedHeadlines?: any[]; usedCalendar?: any[] }
  | { ok: false; reason: string; usedHeadlines?: any[]; usedCalendar?: any[] };

const LIMIT_15M = 300, LIMIT_H1 = 360, LIMIT_H4 = 360;
const clamp = (v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));

// ── tiny TA helpers (newest→oldest arrays)
const asCloses = (a:Candle[])=>a.map(c=>c.c), asHighs=(a:Candle[])=>a.map(c=>c.h), asLows=(a:Candle[])=>a.map(c=>c.l);
function ema(vals:number[], p:number){ if(!vals.length||p<=1) return vals.slice(); const out:number[]=[]; const k=2/(p+1); let prev=vals[0]; for(let i=0;i<vals.length;i++){ const v=i===0?vals[0]:vals[i]*k+prev*(1-k); out.push(v); prev=v; } return out; }
function trendFromEMA(closes:number[], p=50):"up"|"down"|"flat"{ if(closes.length<p+5) return "flat"; const e=ema(closes,p); const a=e[e.length-1], b=e[e.length-6]; if(a>b*1.0005) return "up"; if(a<b*0.9995) return "down"; return "flat"; }

function detectBOS(m15:Candle[], bias:"up"|"down"|"flat"):ScanResult{
  if(m15.length<120) return {ok:false};
  const highs=asHighs(m15), lows=asLows(m15), closes=asCloses(m15);
  const last=closes[0], rh=Math.max(...highs.slice(0,60)), rl=Math.min(...lows.slice(0,60));
  if(last>rh) return {ok:true, direction:"bull", confidence: clamp(70+(bias==="up"?15:bias==="down"?-15:0),0,100), note:"Close > swing high"};
  if(last<rl) return {ok:true, direction:"bear", confidence: clamp(70+(bias==="down"?15:bias==="up"?-15:0),0,100), note:"Close < swing low"};
  return {ok:false};
}
function detectPullback(m15:Candle[], bias:"up"|"down"|"flat"):ScanResult{
  if(m15.length<120) return {ok:false};
  const highs=asHighs(m15), lows=asLows(m15), last=asCloses(m15)[0];
  const maxH=Math.max(...highs.slice(0,120)), minL=Math.min(...lows.slice(0,120));
  if(bias!=="down"){ const retr=(maxH-last)/(maxH-minL+1e-9); if(retr>0.382&&retr<0.618) return {ok:true,direction:"bull",confidence:60,note:"38–62% pullback"}; }
  if(bias!=="up"){ const retr=(last-minL)/(maxH-minL+1e-9); if(retr>0.382&&retr<0.618) return {ok:true,direction:"bear",confidence:60,note:"38–62% pullback"}; }
  return {ok:false};
}
function detectRange(m15:Candle[]):ScanResult{
  if(m15.length<200) return {ok:false};
  const highs=asHighs(m15).slice(0,120), lows=asLows(m15).slice(0,120);
  const hi=Math.max(...highs), lo=Math.min(...lows), width=(hi-lo)/((hi+lo)/2);
  if(width<0.004) return {ok:true, direction: m15[0].c>((hi+lo)/2)?"bear":"bull", confidence:45, note:"Compression range"};
  return {ok:false};
}
const altSlash=(s:string)=>(!s.includes("/")&&s.length===6)?`${s.slice(0,3)}/${s.slice(3)}`:null;

async function fetchAllTF(code:string){
  // single parallel attempt
  const [m15,h1,h4] = await Promise.all([
    getCandles(code,"15m",LIMIT_15M),
    getCandles(code,"1h" ,LIMIT_H1),
    getCandles(code,"4h" ,LIMIT_H4),
  ]);
  return { m15, h1, h4 };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<PlanResponse>) {
  // Read POST body first (your UI sends it). :contentReference[oaicite:1]{index=1}
  let input="EURUSD";
  try { const body = typeof req.body==="string"?JSON.parse(req.body):req.body||{}; if(body?.instrument?.code) input=String(body.instrument.code).toUpperCase(); } catch {}
  if(!input && (req.query.symbol||req.query.code)) input=String(req.query.symbol||req.query.code).toUpperCase();

  const usedCalendar = Array.isArray((req.body as any)?.calendar) ? (req.body as any).calendar : [];
  const usedHeadlines = Array.isArray((req.body as any)?.headlines) ? (req.body as any).headlines : [];

  // hard cap to stay within serverless limits
  const totalBudgetMs = Math.min(15000, Math.max(3000, Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 15000)));
  const t0 = Date.now();

  // attempt 1: exact code
  let { m15, h1, h4 } = await fetchAllTF(input);
  // attempt 2: slash alias once if missing anything
  if (!(m15.length && h1.length && h4.length) && Date.now()-t0 < totalBudgetMs) {
    const alt = altSlash(input);
    if (alt) {
      const r2 = await fetchAllTF(alt);
      // prefer r2 if fills gaps
      m15 = r2.m15.length ? r2.m15 : m15;
      h1  = r2.h1.length  ? r2.h1  : h1;
      h4  = r2.h4.length  ? r2.h4  : h4;
    }
  }

  const missing = [!m15.length&&"15m", !h1.length&&"1h", !h4.length&&"4h"].filter(Boolean) as string[];
  if(missing.length){
    // salvage: if we have 15m + either HTF, still return a low-conviction plan
    if(m15.length && (h1.length || h4.length)){
      const htfTrend = h1.length ? trendFromEMA(asCloses(h1),50) : trendFromEMA(asCloses(h4),50);
      const bos = detectBOS(m15, htfTrend);
      const pull = detectPullback(m15, htfTrend);
      const best = [bos,pull].find(r=>r.ok);
      if(best){
        const text = [
          `Setup: ${best.note ?? "signal"} (${best.confidence ?? 45}% conf)`,
          `Direction: ${best.direction==="bull"?"LONG":"SHORT"}`,
          `Symbol: ${input}`,
          `Warning: Missing TFs: ${missing.join(", ")} (partial/synthetic data)`,
        ].join("\n");
        return res.status(200).json({ ok:true, plan:{ text, conviction: Math.max(35, best.confidence ?? 45) }, usedHeadlines, usedCalendar });
      }
    }
    return res.status(200).json({ ok:false, reason:`Missing candles for ${missing.join(", ")}`, usedHeadlines, usedCalendar });
  }

  const h1Trend = trendFromEMA(asCloses(h1),50);
  const h4Trend = trendFromEMA(asCloses(h4),50);
  const bias: "up"|"down"|"flat" = h1Trend===h4Trend ? h1Trend : (h1Trend==="flat"?h4Trend:h1Trend);

  const bos = detectBOS(m15,bias);
  const pull = detectPullback(m15,bias);
  const range = detectRange(m15);

  const candidates = [bos,pull,range].filter(r=>r.ok) as Required<ScanResult>[];
  if(!candidates.length) return res.status(200).json({ ok:false, reason:"No high-conviction setup on 15m with HTF context", usedHeadlines, usedCalendar });

  candidates.sort((a,b)=>(b.confidence??0)-(a.confidence??0));
  const best = candidates[0];
  const text = [
    `Setup: ${best.note ?? "signal"} (${best.confidence ?? 50}% conf)`,
    `HTF bias → 1h: ${h1Trend}, 4h: ${h4Trend}`,
    `Direction: ${best.direction==="bull"?"LONG":"SHORT"}`,
    `Symbol: ${input}`,
  ].join("\n");

  return res.status(200).json({ ok:true, plan:{ text, conviction: best.confidence ?? 50 }, usedHeadlines, usedCalendar });
}
