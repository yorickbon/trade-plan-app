// /lib/prices.ts
export type Candle = { t:number; o:number; h:number; l:number; c:number };
export type TF = "15m"|"1h"|"4h";

// ── simple in-memory TTL cache to avoid provider rate limits across quick successive calls
const CANDLE_CACHE = new Map<string, { expires:number; data:Candle[] }>();
const TTL_MS = 20_000; // 20s — enough to shield plan+debug+UI bursts without getting stale

export async function getCandles(
  instrument: string | { code: string },
  tf: TF,
  n: number
): Promise<Candle[]> {
  const raw = (typeof instrument==="string"?instrument:instrument.code)||"EURUSD";
  const symbol = normalize(raw);
  const cacheKey = `${symbol}|${tf}`;
  const now = Date.now();

  const hit = CANDLE_CACHE.get(cacheKey);
  if (hit && hit.expires > now && hit.data?.length) {
    return hit.data.slice(0, n);
  }

  const perCall = Math.max(2000, Number(process.env.PLAN_PER_CALL_TIMEOUT_MS ?? 8000));

  // 1) TwelveData (+aliases)
  const td = await tdTryAliases(symbol, tf, n, perCall);
  if(td.length) { CANDLE_CACHE.set(cacheKey, { expires: now + TTL_MS, data: td }); return td; }

  // 2) Polygon (forex only)
  if(isForex(symbol)){ const p = await polygonFetch(symbol, tf, n, perCall); if(p.length){ CANDLE_CACHE.set(cacheKey, { expires: now + TTL_MS, data: p }); return p; } }

  // 3) Finnhub (forex only)
  if(isForex(symbol)){ const f = await finnhubFetch(symbol, tf, n, perCall); if(f.length){ CANDLE_CACHE.set(cacheKey, { expires: now + TTL_MS, data: f }); return f; } }

  // 4) Synthetic from nearest TF (best-effort)
  const synth = await syntheticFromNearest(symbol, tf, n, perCall);
  if (synth.length) { CANDLE_CACHE.set(cacheKey, { expires: now + TTL_MS, data: synth }); }
  return synth;
}

// ── helpers (unchanged from your latest file) …
const ok=(c:Candle)=>[c.t,c.o,c.h,c.l,c.c].every(Number.isFinite);
const withTimeout=<T,>(p:Promise<T>,ms:number)=>Promise.race([p,new Promise<T>((_,r)=>setTimeout(()=>r(new Error("timeout") as any),ms))]) as Promise<T>;

function normalize(s:string){ s=s.trim().toUpperCase(); if(s.includes("/")) return s; if(/^[A-Z]{6}$/.test(s)) return `${s.slice(0,3)}/${s.slice(3)}`; return s; }
function isForex(s:string){ if(s.includes("/")){ const [a,b]=s.split("/"); return a?.length===3 && b?.length===3; } return /^[A-Z]{6}$/.test(s); }
function mapTf(tf:TF, p:"td"|"polygon"|"finnhub"){ if(p==="td") return tf==="15m"?"15min":tf; const m=tf==="15m"?"15":tf==="1h"?"60":"240"; return m; }

// TwelveData aliases …
const TD_ALIASES: Record<string,string[]> = {
  SPX500:["SPX","SP500","US500"], NAS100:["NDX","NASDAQ100","NAS100"], US30:["DJI","DOW","US30"], GER40:["DAX","DE40","GER40"],
  "XAU/USD":["XAU/USD","GOLD","XAUUSD"], "BTC/USD":["BTC/USD","BTCUSD"], "ETH/USD":["ETH/USD","ETHUSD"],
};
const tdAliasesFor=(sym:string)=>{ const base=sym.replace("/",""); const withSlash = sym.includes("/")?sym:normalize(sym); const s=new Set<string>([withSlash,base,sym]); (TD_ALIASES[base]||TD_ALIASES[withSlash]||TD_ALIASES[sym]||[]).forEach(a=>s.add(a)); return [...s]; };

async function tdTryAliases(symbol:string, tf:TF, n:number, ms:number){
  for(const s of tdAliasesFor(symbol)){ const out = await tdFetch(s, tf, n, ms); if(out.length) return out; }
  return [];
}
async function tdFetch(symbol:string, tf:TF, n:number, ms:number){
  const key=process.env.TWELVEDATA_API_KEY||""; if(!key) return [];
  const url=new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol",symbol); url.searchParams.set("interval",mapTf(tf,"td"));
  url.searchParams.set("outputsize",String(n)); url.searchParams.set("timezone","UTC"); url.searchParams.set("apikey",key);
  try{
    const rsp=await withTimeout(fetch(url.toString(),{cache:"no-store"}),ms); if(!rsp.ok) return [];
    const j:any=await rsp.json(); const values:any[]=Array.isArray(j?.values)?j.values:[];
    const out = values.map((v:any):Candle=>({ t:Math.floor(Date.parse(v?.datetime??"")/1000), o:Number(v?.open), h:Number(v?.high), l:Number(v?.low), c:Number(v?.close) })).filter(ok);
    return out; // TD returns newest→oldest already
  }catch{ return []; }
}

async function polygonFetch(symbol:string, tf:TF, n:number, ms:number){
  const key=process.env.POLYGON_API_KEY||""; if(!key) return [];
  const pSym="C:"+symbol.replace("/",""); const mult=mapTf(tf,"polygon");
  const url=new URL(`https://api.polygon.io/v2/aggs/ticker/${pSym}/range/${mult}/minute/now-14d/now`);
  url.searchParams.set("limit",String(n)); url.searchParams.set("adjusted","true"); url.searchParams.set("sort","desc"); url.searchParams.set("apiKey",key);
  try{
    const rsp=await withTimeout(fetch(url.toString(),{cache:"no-store"}),ms); if(!rsp.ok) return [];
    const j:any=await rsp.json(); const r:any[]=Array.isArray(j?.results)?j.results:[];
    return r.map((x:any):Candle=>({ t:Math.floor(Number(x?.t)/1000), o:Number(x?.o), h:Number(x?.h), l:Number(x?.l), c:Number(x?.c) })).filter(ok);
  }catch{ return []; }
}

async function finnhubFetch(symbol:string, tf:TF, n:number, ms:number){
  const key=process.env.FINNHUB_API_KEY||""; if(!key) return [];
  const finSym=`OANDA:${symbol.replace("/","_")}`; const minutes=Number(mapTf(tf,"finnhub"));
  const to=Math.floor(Date.now()/1000), from=to-14*24*3600;
  const url=new URL("https://finnhub.io/api/v1/forex/candle");
  url.searchParams.set("symbol",finSym); url.searchParams.set("resolution",String(minutes)); url.searchParams.set("from",String(from)); url.searchParams.set("to",String(to)); url.searchParams.set("token",key);
  try{
    const rsp=await withTimeout(fetch(url.toString(),{cache:"no-store"}),ms); if(!rsp.ok) return [];
    const j:any=await rsp.json(); if(j?.s!=="ok"||!Array.isArray(j?.t)) return [];
    const out:Candle[] = j.t.map((t:number,i:number)=>({ t, o:Number(j.o[i]), h:Number(j.h[i]), l:Number(j.l[i]), c:Number(j.c[i]) })).filter(ok).reverse();
    return out.slice(0,n);
  }catch{ return []; }
}

// ── synthetic fallbacks (explode/aggregate)
function explode(bars:Candle[], ratio:number, stepSec:number){ const out:Candle[]=[]; for(const b of bars){ for(let i=0;i<ratio;i++){ out.push({ t:b.t - i*stepSec, o:b.o, h:b.h, l:b.l, c:b.c }); } } return out; }
function aggregate(bars:Candle[], ratio:number){ const out:Candle[]=[]; for(let i=0;i<bars.length;i+=ratio){ const g=bars.slice(i,i+ratio); if(!g.length) continue; const o=g[g.length-1].o, c=g[0].c, h=Math.max(...g.map(x=>x.h)), l=Math.min(...g.map(x=>x.l)); const t=g[0].t; out.push({t,o,h,l,c}); } return out; }

async function syntheticFromNearest(symbol:string, tf:TF, n:number, ms:number){
  if(tf==="15m"){ const h1=await tdTryAliases(symbol,"1h",Math.ceil(n/4),ms); if(h1.length) return explode(h1,4,15*60).slice(0,n);
                  const h4=await tdTryAliases(symbol,"4h",Math.ceil(n/16),ms); if(h4.length) return explode(h4,16,15*60).slice(0,n); }
  if(tf==="1h"){ const h4=await tdTryAliases(symbol,"4h",Math.ceil(n/4),ms); if(h4.length) return explode(h4,4,60*60).slice(0,n);
                 const m15=await tdTryAliases(symbol,"15m",n*4,ms); if(m15.length) return aggregate(m15,4).slice(0,n); }
  if(tf==="4h"){ const h1=await tdTryAliases(symbol,"1h",n*4,ms); if(h1.length) return aggregate(h1,4).slice(0,n); }
  return [];
}
