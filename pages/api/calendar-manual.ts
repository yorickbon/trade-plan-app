// /pages/api/calendar-manual.ts
import type { NextApiRequest, NextApiResponse } from "next";

type Impact = "High" | "Medium" | "Low" | "None";

type RawItem = {
  title: string;
  currency?: string;     // "USD","EUR",...
  impact?: Impact;
  time: string;          // ISO string
  actual?: number | null;
  forecast?: number | null;
  previous?: number | null;
  unit?: string | null;
};

type CalItem = RawItem & { impact: Impact; isBlackout?: boolean };

type BiasSummary = {
  score: number;  // -5..+5
  count: number;
  label: "strongly bearish" | "bearish" | "slightly bearish" | "neutral" |
         "slightly bullish" | "bullish" | "strongly bullish";
  evidence: Array<{ title: string; time: string; delta: number; weight: number }>;
};

type Ok = {
  ok: true;
  count: number;
  items: CalItem[];
  bias: {
    perCurrency: Record<string, BiasSummary>;
    instrument?: { pair: string; score: number; label: BiasSummary["label"] };
  };
};

type Err = { ok: false; reason: string };
type Resp = Ok | Err;

const clamp = (v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const isISO = (s:string)=>!isNaN(new Date(s).getTime());

function impactWeight(imp: Impact){ return imp==="High"?1:imp==="Medium"?0.6:imp==="Low"?0.3:0.2; }
function biasLabel(x:number){
  if (x<=-4) return "strongly bearish";
  if (x<=-2) return "bearish";
  if (x<0)  return "slightly bearish";
  if (x===0) return "neutral";
  if (x<2)  return "slightly bullish";
  if (x<4)  return "bullish";
  return "strongly bullish";
}
// true => higher is bullish; false => lower is bullish; null => unknown
function goodIfHigher(title:string): boolean | null {
  const t = title.toLowerCase();
  if (/(cpi|ppi|inflation)/.test(t)) return true;
  if (/(gdp|retail sales|industrial production|durable goods|housing starts|building permits)/.test(t)) return true;
  if (/(pmi|ism|confidence|sentiment)/.test(t)) return true;
  if (/unemployment|jobless|initial claims|continuing claims/.test(t)) return false;
  if (/(nonfarm|nfp|employment change|payrolls|jobs)/.test(t)) return true;
  if (/trade balance|current account/.test(t)) return true;
  if (/interest rate|rate decision|cash rate|bank rate|ocr|refi rate/.test(t)) return true;
  return null;
}
function scoreDelta(title:string, actual:number|null, forecast:number|null, previous:number|null){
  const dir = goodIfHigher(title);
  if (dir===null || actual===null) return 0;
  const ref = forecast ?? previous;
  if (ref===null) return 0;
  const raw = (actual - ref) / (Math.abs(ref) || 1);
  const signed = dir ? raw : -raw;
  return clamp(signed * 4, -1, 1);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  try {
    const { items, instrument } =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(200).json({ ok:false, reason:"No items provided" });
    }

    // Normalize + add blackout
    const out: CalItem[] = items
      .map((r: RawItem): CalItem | null => {
        if (!r || !r.title || !r.time || !isISO(r.time)) return null;
        const impact: Impact = (r.impact as Impact) || "Medium";
        const t = new Date(r.time).getTime();
        const inBlackout = Date.now() >= t-90*60000 && Date.now() <= t+90*60000;
        return {
          title: r.title,
          currency: r.currency?.toUpperCase(),
          impact,
          time: new Date(r.time).toISOString(),
          actual: r.actual ?? null,
          forecast: r.forecast ?? null,
          previous: r.previous ?? null,
          unit: r.unit ?? null,
          isBlackout: impact==="High" ? inBlackout : false,
        };
      })
      .filter(Boolean) as CalItem[];

    // Compute bias per currency
    const per: Record<string, BiasSummary> = {};
    const add = (cur:string, title:string, time:string, delta:number, weight:number)=>{
      if (!per[cur]) per[cur] = { score:0, count:0, label:"neutral", evidence:[] };
      per[cur].score += delta * weight;
      per[cur].count += 1;
      per[cur].evidence.push({ title, time, delta, weight });
    };
    for (const it of out) {
      if (!it.currency) continue;
      const delta = scoreDelta(it.title, it.actual ?? null, it.forecast ?? null, it.previous ?? null);
      if (delta === 0) continue;
      add(it.currency, it.title, it.time, delta, impactWeight(it.impact));
    }
    for (const cur of Object.keys(per)) {
      per[cur].score = clamp(per[cur].score * 5, -5, 5);
      per[cur].label = biasLabel(Math.round(per[cur].score));
    }

    let instrBias: Ok["bias"]["instrument"];
    if (instrument && instrument.length>=6) {
      const base = instrument.slice(0,3).toUpperCase();
      const quote = instrument.slice(-3).toUpperCase();
      const b = per[base]?.score || 0;
      const q = per[quote]?.score || 0;
      const score = clamp(Math.round((b-q)*10)/10, -5, 5);
      instrBias = { pair: `${base}${quote}`, score, label: biasLabel(Math.round(score)) };
    }

    return res.status(200).json({
      ok: true,
      count: out.length,
      items: out.sort((a,b)=>a.time.localeCompare(b.time)),
      bias: { perCurrency: per, instrument: instrBias },
    });
  } catch (e:any) {
    return res.status(200).json({ ok:false, reason: e?.message || "manual calendar error" });
  }
}
