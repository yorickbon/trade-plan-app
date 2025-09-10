/**
 * Vision Plan API
 * - Fast and Full share the same decision kernel (temperature 0) for identical trade ideas.
 * - Calendar OCR: pre-release rows are usable for awareness, but DO NOT bias bullish/bearish.
 * - Optional 5M chart (file: m5, url: m5Url). If used for the setup, the plan must say so.
 * - Stage-1 caches ai_meta; Expand and Full use that anchor to expand without changing the trade.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";
import sharp from "sharp";

/* ---------------- basic cfg ---------------- */
export const config = { api: { bodyParser: false, sizeLimit: "25mb" } };
type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

const VP_VERSION = "2025-09-11-ocr-no-prebias-m5-parity";

/* ---------------- model pick ---------------- */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const DEFAULT_MODEL = process.env.OPENAI_MODEL_ALT || "gpt-4o";
const ALT_MODEL     = process.env.OPENAI_MODEL     || "gpt-5";

function pickModelFromFields(req: NextApiRequest, fields?: Record<string, any>) {
  const raw = String((fields?.model as string) || (req.query.model as string) || "").trim().toLowerCase();
  if (raw.startsWith("gpt-5"))  return ALT_MODEL || "gpt-5";
  if (raw.startsWith("gpt-4o")) return DEFAULT_MODEL || "gpt-4o";
  return DEFAULT_MODEL || "gpt-4o";
}

/* ---------------- market data keys ---------------- */
const TD_KEY = process.env.TWELVEDATA_API_KEY || "";
const FH_KEY = process.env.FINNHUB_API_KEY || process.env.FINNHUB_APT_KEY || "";
const POLY_KEY = process.env.POLYGON_API_KEY || "";

/* ---------------- utils ---------------- */
const IMG_MAX_BYTES = 12 * 1024 * 1024;
const BASE_W = 1280; const MAX_W = 1500;
const TARGET_MIN = 420 * 1024; const TARGET_MAX = 1200 * 1024;

function uuid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function dataUrlSizeBytes(s: string | null | undefined): number {
  if (!s) return 0; const i = s.indexOf(","); if (i < 0) return 0;
  const b64 = s.slice(i + 1); const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}
function parseNumberLoose(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  let s = String(v).trim().toLowerCase();
  if (!s || s === "n/a" || s === "na" || s === "-" || s === "—") return null;
  s = s.replace(/,/g,"").replace(/\s+/g,"").replace(/\u2212/g,"-");
  let mult = 1;
  if (s.endsWith("%")) s = s.slice(0,-1);
  if (s.endsWith("k")) { mult=1_000; s=s.slice(0,-1); }
  else if (s.endsWith("m")) { mult=1_000_000; s=s.slice(0,-1); }
  else if (s.endsWith("b")) { mult=1_000_000_000; s=s.slice(0,-1); }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n*mult : null;
}

/* ---------------- in-memory cache ---------------- */
type CacheEntry = {
  exp: number;
  instrument: string;
  m5?: string | null;
  m15: string; h1: string; h4: string;
  calendar?: string | null;
  headlinesText?: string | null;
  sentimentText?: string | null;
  ai_meta?: any | null;
};
const CACHE = new Map<string, CacheEntry>();
function setCache(entry: Omit<CacheEntry,"exp">): string {
  const key = uuid();
  CACHE.set(key, { ...entry, exp: Date.now() + 3*60*1000 });
  return key;
}
function getCache(key?: string | null): CacheEntry | null {
  if (!key) return null; const e = CACHE.get(key); if (!e) return null;
  if (Date.now() > e.exp) { CACHE.delete(key); return null; }
  return e;
}

/* ---------------- CSM (15m) ---------------- */
type CsmSnapshot = { tsISO: string; ranks: string[]; scores: Record<string, number>; ttl: number; };
let CSM_CACHE: CsmSnapshot | null = null;

const G8 = ["USD","EUR","JPY","GBP","CHF","CAD","AUD","NZD"];
const USD_PAIRS = ["EURUSD","GBPUSD","AUDUSD","NZDUSD","USDJPY","USDCHF","USDCAD"];
type Series = { t:number[]; c:number[] };

function kbarReturn(closes:number[], k:number){ if(!closes||closes.length<=k) return null; const a=closes.at(-1)!; const b=closes.at(-(k+1))!; if(!(a>0)||!(b>0)) return null; return Math.log(a/b); }
async function tdSeries15(pair:string):Promise<Series|null>{
  if(!TD_KEY) return null; try{
    const sym = `${pair.slice(0,3)}/${pair.slice(3)}`;
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=15min&outputsize=30&apikey=${TD_KEY}&dp=6`;
    const r = await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(2500)}); if(!r.ok) return null;
    const j:any = await r.json(); if(!Array.isArray(j?.values)) return null;
    const vals=[...j.values].reverse(); const t=vals.map((v:any)=>new Date(v.datetime).getTime()/1000); const c=vals.map((v:any)=>Number(v.close));
    if (!c.every((x:number)=>isFinite(x))) return null; return {t,c};
  }catch{ return null;}
}
async function fhSeries15(pair:string):Promise<Series|null>{
  if(!FH_KEY) return null; try{
    const sym=`OANDA:${pair.slice(0,3)}_${pair.slice(3)}`; const to=Math.floor(Date.now()/1000); const from=to-60*60*6;
    const url=`https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(sym)}&resolution=15&from=${from}&to=${to}&token=${FH_KEY}`;
    const r=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(2500)}); if(!r.ok) return null; const j:any=await r.json();
    if(j?.s!=="ok"||!Array.isArray(j?.c)) return null; const t=j.t.map((x:number)=>x); const c=j.c.map((x:number)=>Number(x));
    if(!c.every((x:number)=>isFinite(x))) return null; return {t,c};
  }catch{ return null;}
}
async function polySeries15(pair:string):Promise<Series|null>{
  if(!POLY_KEY) return null; try{
    const ticker=`C:${pair}`; const to=new Date(); const from=new Date(to.getTime()-6*60*60*1000);
    const fmt=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const url=`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/15/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&apiKey=${POLY_KEY}`;
    const r=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(2500)}); if(!r.ok) return null; const j:any=await r.json();
    if(!Array.isArray(j?.results)) return null; const t=j.results.map((x:any)=>Math.floor(x.t/1000)); const c=j.results.map((x:any)=>Number(x.c));
    if(!c.every((x:number)=>isFinite(x))) return null; return {t,c};
  }catch{ return null;}
}
async function fetchSeries15(pair:string){ const td=await tdSeries15(pair); if(td) return td; const fh=await fhSeries15(pair); if(fh) return fh; const pg=await polySeries15(pair); if(pg) return pg; return null; }
function computeCSMFromPairs(seriesMap:Record<string,Series|null>):CsmSnapshot|null{
  const weights={r60:0.6,r240:0.4}; const curScore:Record<string,number>=Object.fromEntries(G8.map(c=>[c,0]));
  for(const pair of USD_PAIRS){ const S=seriesMap[pair]; if(!S||!Array.isArray(S.c)||S.c.length<17) continue;
    const r60=kbarReturn(S.c,4)??0; const r240=kbarReturn(S.c,16)??0; const r=r60*weights.r60+r240*weights.r240;
    const base=pair.slice(0,3); const quote=pair.slice(3); curScore[base]+=r; curScore[quote]-=r;
  }
  const vals=G8.map(c=>curScore[c]); const mean=vals.reduce((a,b)=>a+b,0)/vals.length; const sd=Math.sqrt(vals.reduce((a,b)=>a+(b-mean)**2,0)/vals.length)||1;
  const z:Record<string,number>={}; for(const c of G8) z[c]=(curScore[c]-mean)/sd; const ranks=[...G8].sort((a,b)=>z[b]-z[a]);
  return {tsISO:new Date().toISOString(),ranks,scores:z,ttl:Date.now()+15*60*1000};
}
async function getCSM():Promise<CsmSnapshot>{
  if(CSM_CACHE && Date.now()<CSM_CACHE.ttl) return CSM_CACHE;
  const seriesMap:Record<string,Series|null>={}; await Promise.all(USD_PAIRS.map(async p=>{seriesMap[p]=await fetchSeries15(p);})); const snap=computeCSMFromPairs(seriesMap);
  if(!snap){ if(CSM_CACHE) return CSM_CACHE; throw new Error("CSM unavailable"); } CSM_CACHE=snap; return snap;
}

/* ---------------- file helpers ---------------- */
async function toJpeg(buf:Buffer,width:number,quality:number){ return sharp(buf).rotate().resize({width,withoutEnlargement:true}).jpeg({quality,progressive:true,mozjpeg:true}).toBuffer(); }
async function processAdaptiveToDataUrl(buf:Buffer){
  let width=BASE_W, quality=74; let out=await toJpeg(buf,width,quality); let guard=0;
  while(out.byteLength<TARGET_MIN && guard<4){ quality=Math.min(quality+6,88); if(quality>=82 && width<MAX_W) width=Math.min(width+100,MAX_W); out=await toJpeg(buf,width,quality); guard++; }
  if(out.byteLength<TARGET_MIN && (quality<88||width<MAX_W)){ quality=Math.min(quality+4,88); width=Math.min(width+100,MAX_W); out=await toJpeg(buf,width,quality); }
  if(out.byteLength>TARGET_MAX){ const q2=Math.max(72,quality-6); out=await toJpeg(buf,width,q2); }
  if(out.byteLength>IMG_MAX_BYTES) throw new Error("image too large after processing");
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}
async function fileToDataUrl(file:any):Promise<string|null>{
  if(!file) return null; const p=file.filepath||file.path||file._writeStream?.path||file.originalFilepath; if(!p) return null;
  const raw=await fs.readFile(p); const out=await processAdaptiveToDataUrl(raw);
  if(process.env.NODE_ENV!=="production") console.log(`[vision-plan] file processed size=${dataUrlSizeBytes(out)}B`);
  return out;
}

/* ---------------- link helpers ---------------- */
function originFromReq(req:NextApiRequest){ const proto=(req.headers["x-forwarded-proto"] as string)||"https"; const host=(req.headers.host as string)||process.env.VERCEL_URL||"localhost:3000"; return host.startsWith("http")?host:`${proto}://${host}`; }
function absoluteUrl(base:string,maybe:string){ try{ return new URL(maybe, base).toString(); }catch{ return maybe; } }
function htmlFindOgImage(html:string){ const re1=/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i; const m1=html.match(re1); if(m1?.[1]) return m1[1]; const re2=/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i; const m2=html.match(re2); if(m2?.[1]) return m2[1]; return null; }
function looksLikeImageUrl(u:string){ const s=String(u||"").split("?")[0]||""; return /\.(png|jpe?g|webp|gif)$/i.test(s); }
async function fetchWithTimeout(url:string,ms:number){ return fetch(url,{signal:AbortSignal.timeout(ms),redirect:"follow"}); }
async function downloadAndProcess(url:string):Promise<string|null>{
  const r=await fetchWithTimeout(url,8000); if(!r||!r.ok) return null; const ct=String(r.headers.get("content-type")||"").toLowerCase(); const mime=ct.split(";")[0].trim();
  const ab=await r.arrayBuffer(); const raw=Buffer.from(ab); if(raw.byteLength>IMG_MAX_BYTES) return null;
  if(mime.startsWith("image/")){ const out=await processAdaptiveToDataUrl(raw); if(process.env.NODE_ENV!=="production") console.log(`[vision-plan] link processed size=${dataUrlSizeBytes(out)}B from ${url}`); return out; }
  const html=raw.toString("utf8"); const og=htmlFindOgImage(html); if(!og) return null; const resolved=absoluteUrl(url,og);
  const r2=await fetchWithTimeout(resolved,8000); if(!r2||!r2.ok) return null; const ab2=await r2.arrayBuffer(); const raw2=Buffer.from(ab2); if(raw2.byteLength>IMG_MAX_BYTES) return null;
  const out2=await processAdaptiveToDataUrl(raw2); if(process.env.NODE_ENV!=="production") console.log(`[vision-plan] og:image processed size=${dataUrlSizeBytes(out2)}B from ${resolved}`); return out2;
}
async function linkToDataUrl(link:string){ if(!link) return null; try{ if(looksLikeImageUrl(link)) return await downloadAndProcess(link); return await downloadAndProcess(link); }catch{ return null; }}

/* ---------------- headlines / COT ---------------- */
type AnyHeadline = { title?:string; description?:string; source?:string; ago?:string; sentiment?:{score?:number}|null } & Record<string,any>;
type HeadlineBias = { label:"bullish"|"bearish"|"neutral"|"unavailable"; avg:number|null; count:number; };

function headlinesToPromptLines(items:AnyHeadline[], limit=6):string|null{
  const take=(items||[]).slice(0,limit); if(!take.length) return null;
  return take.map(it=>{
    const s=typeof it?.sentiment?.score==="number" ? Number(it.sentiment!.score) : null;
    const lab=s==null?"neu": s>0.05?"pos": s<-0.05?"neg":"neu";
    const t=String(it?.title||"").slice(0,200); const src=it?.source||""; const when=it?.ago||"";
    return `• ${t} — ${src}${when?`, ${when}`:""} — ${lab};`;
  }).join("\n");
}
function computeHeadlinesBias(items:AnyHeadline[]):HeadlineBias{
  if(!Array.isArray(items)||!items.length) return {label:"unavailable",avg:null,count:0};
  const scores=items.map(h=>typeof h?.sentiment?.score==="number"?Number(h.sentiment!.score):null).filter(v=>Number.isFinite(v)) as number[];
  if(!scores.length) return {label:"unavailable",avg:null,count:0};
  const avg=scores.reduce((a,b)=>a+b,0)/(scores.length||1);
  const label=avg>0.05?"bullish":avg<-0.05?"bearish":"neutral";
  return {label,avg,count:scores.length};
}
async function fetchedHeadlinesViaServer(req:NextApiRequest,instrument:string){
  try{ const base=originFromReq(req); const url=`${base}/api/news?instrument=${encodeURIComponent(instrument)}&hours=48&max=12&_t=${Date.now()}`;
    const r=await fetch(url,{cache:"no-store"}); const j=await r.json().catch(()=>({})); const items:Array<AnyHeadline>=Array.isArray(j?.items)?j.items:[];
    return { items, promptText: headlinesToPromptLines(items,6), provider: String(j?.provider||"unknown") };
  }catch{ return {items:[], promptText:null, provider:"unknown"} }
}
type CotCue = { method:"headline_fallback"; reportDate:null; summary:string; net:Record<string,number>; };
function detectCotCueFromHeadlines(headlines:AnyHeadline[]):CotCue|null{
  if(!Array.isArray(headlines)||!headlines.length) return null;
  const text=headlines.map(h=>[h?.title||"",h?.description||""].join(" ")).join(" • ").toLowerCase();
  const mentions=/(commitments?\s+of\s+traders|cot|cftc)\b/.test(text); if(!mentions) return null;
  const terms:Record<string,RegExp[]>={ USD:[/\b(us|u\.s\.|dollar|usd|greenback|dxy)\b/i], EUR:[/\b(euro|eur)\b/i], JPY:[/\b(yen|jpy)\b/i], GBP:[/\b(pound|sterling|gbp)\b/i], CAD:[/\b(canadian|loonie|cad)\b/i], AUD:[/\b(australian|aussie|aud)\b/i], CHF:[/\b(franc|chf)\b/i], NZD:[/\b(kiwi|new zealand|nzd)\b/i] };
  const net:Record<string,number>={}; let any=false;
  for(const [cur,regs] of Object.entries(terms)){ if(regs.some(re=>re.test(text))){ const neg=new RegExp(`${regs[0].source}[\\s\\S]{0,60}?net\\s+short`,"i"); const pos=new RegExp(`${regs[0].source}[\\s\\S]{0,60}?net\\s+long`,"i");
      if(neg.test(text)){ net[cur]=-1; any=true; continue; } if(pos.test(text)){ net[cur]=1; any=true; continue; }
    }
  }
  if(!any) return null; const parts=Object.entries(net).map(([c,v])=>`${c}:${v>0?"net long":"net short"}`); return {method:"headline_fallback",reportDate:null,summary:`COT cues (headlines): ${parts.join(", ")}`, net};
}

/* ---------------- AI core ---------------- */
async function callOpenAI(model:string, messages:any[], opts?:{expect_json?:boolean}){
  const body:any = { model, messages, temperature: 0, top_p: 1, n: 1 };
  if (opts?.expect_json) body.response_format = { type: "json_object" };
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method:"POST", headers:{ "content-type":"application/json", authorization:`Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify(body)
  });
  const json = await rsp.json().catch(()=>({} as any));
  if(!rsp.ok) throw new Error(`OpenAI request failed: ${rsp.status} ${JSON.stringify(json)}`);
  const out = json?.choices?.[0]?.message?.content ??
              (Array.isArray(json?.choices?.[0]?.message?.content)? json.choices[0].message.content.map((c:any)=>c?.text||"").join("\n") : "");
  return String(out||"");
}
function tryParseJsonBlock(s:string){ if(!s) return null; const fence=s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i); const raw=fence?fence[1]:s; try{ return JSON.parse(raw);}catch{return null;} }
function extractAiMeta(text:string){ if(!text) return null; const fences=[/\nai_meta\s*({[\s\S]*?})\s*\n/i, /\njson\s*({[\s\S]*?})\s*\n/i]; for(const re of fences){ const m=text.match(re); if(m?.[1]){ try{ return JSON.parse(m[1]); }catch{} } } return null; }
function invalidOrderRelativeToPrice(aiMeta:any){
  const o=String(aiMeta?.entryOrder||"").toLowerCase(); const dir=String(aiMeta?.direction||"").toLowerCase(); const z=aiMeta?.zone||{};
  const p=Number(aiMeta?.currentPrice); const zmin=Number(z?.min); const zmax=Number(z?.max);
  if(!isFinite(p)||!isFinite(zmin)||!isFinite(zmax)) return null;
  if(o==="sell limit"&&dir==="short"){ if(Math.max(zmin,zmax)<=p) return "sell-limit-below-price"; }
  if(o==="buy limit"&&dir==="long"){ if(Math.min(zmin,zmax)>=p) return "buy-limit-above-price"; }
  return null;
}

/* ---------------- Calendar OCR & analysis ---------------- */
type OcrCalendarRow = { timeISO:string|null; title:string|null; currency:string|null; impact:"Low"|"Medium"|"High"|null; actual:number|string|null; forecast:number|string|null; previous:number|string|null; };
type OcrCalendar = { items: OcrCalendarRow[] };

function goodIfHigher(title:string):boolean|null{
  const t=title.toLowerCase();
  if(/(cpi|core cpi|ppi|inflation)/.test(t)) return true;
  if(/(gdp|retail sales|industrial production|manufacturing production|consumer credit|housing starts|building permits|durable goods)/.test(t)) return true;
  if(/(pmi|ism|confidence|sentiment)/.test(t)) return true;
  if(/unemployment|jobless|initial claims|continuing claims/.test(t)) return false;
  if(/(nonfarm|nfp|employment change|payrolls|jobs)/.test(t)) return true;
  if(/trade balance|current account/.test(t)) return true;
  if(/interest rate|rate decision|refi rate|deposit facility|bank rate|cash rate|ocr/.test(t)) return true;
  return null;
}
function evidenceLine(it:any, cur:string):string|null{
  const a=parseNumberLoose(it.actual); const f=parseNumberLoose(it.forecast); const p=parseNumberLoose(it.previous);
  if(a==null || (f==null && p==null)) return null; const dir=goodIfHigher(String(it.title||"")); const comp:string[]=[];
  if(f!=null) comp.push(a<f?"< forecast": a>f?"> forecast":"= forecast");
  if(p!=null) comp.push(a<p?"< previous": a>p?"> previous":"= previous");
  let verdict="neutral";
  if(dir===true){ verdict=(a>(f??a) && a>(p??a))?"bullish": (a<(f??a) && a<(p??a))?"bearish":"mixed"; }
  else if(dir===false){ verdict=(a<(f??a) && a<(p??a))?"bullish": (a>(f??a) && a>(p??a))?"bearish":"mixed"; }
  const comps=comp.join(" and "); return `${cur} — ${it.title}: actual ${a}${(f!=null||p!=null)?` ${comps}`:""} → ${verdict} ${cur}`;
}
async function ocrCalendarFromImage(model:string, calendarDataUrl:string):Promise<OcrCalendar|null>{
  const sys = [
    "You are extracting ECONOMIC CALENDAR rows via image OCR.",
    "Return STRICT JSON only. If a field is unreadable or absent, use null.",
    "Fields: timeISO (ISO8601 if visible, else null), title, currency (e.g., USD), impact (Low|Medium|High), actual, forecast, previous."
  ].join("\n");
  const user = [{type:"text",text:"Extract rows. JSON only: { items: OcrCalendarRow[] }"},{type:"image_url",image_url:{url:calendarDataUrl}}];
  const msg=[{role:"system",content:sys},{role:"user",content:user}];
  let text=await callOpenAI(model,msg); let parsed=tryParseJsonBlock(text);
  if(!parsed||!Array.isArray(parsed?.items)){
    const msg2=[{role:"system",content:sys+"\nREPLY STRICT JSON, no prose."},{role:"user",content:user}];
    text=await callOpenAI(model,msg2); parsed=tryParseJsonBlock(text); if(!parsed||!Array.isArray(parsed?.items)) return null;
  }
  const items:OcrCalendarRow[]=(parsed.items as any[]).map(r=>({
    timeISO: typeof r?.timeISO==="string"? r.timeISO : null,
    title: typeof r?.title==="string"? r.title : null,
    currency: typeof r?.currency==="string"? r.currency.toUpperCase().slice(0,3) : null,
    impact: typeof r?.impact==="string"? (["low","medium","high"].includes(r.impact.toLowerCase()) ? (r.impact[0].toUpperCase()+r.impact.slice(1).toLowerCase()) as any : null) : null,
    actual: r?.actual ?? null, forecast: r?.forecast ?? null, previous: r?.previous ?? null,
  }));
  return { items };
}

const CURRENCIES = new Set(G8);
function relevantCurrenciesFromInstrument(instr:string):string[]{
  const U=(instr||"").toUpperCase();
  const found=[...CURRENCIES].filter(c=>U.includes(c));
  if(found.length) return found;
  if(U.endsWith("USD")||U.startsWith("USD")) return ["USD"];
  return ["USD"];
}
function hasUsableFields(r:OcrCalendarRow):boolean{
  // usable if either (a) post-result: actual + (forecast|previous), or (b) pre-release: forecast & previous (awareness only)
  const post = r!=null && r.actual!=null && (r.forecast!=null || r.previous!=null);
  const prerelease = r!=null && r.actual==null && r.forecast!=null && r.previous!=null;
  return !!(post || prerelease);
}
function analyzeCalendarOCR(ocr:OcrCalendar, pair:string){
  const base=pair.slice(0,3), quote=pair.slice(3);
  const nowMs=Date.now(); const lines:string[]=[]; const score:Record<string,number>={};
  function add(cur:string, s:number){ if(!cur) return; score[cur]=(score[cur]??0)+s; }

  let warn:number|null=null; let hasPostResult=false; let sawRelevant=false;

  for(const it of (ocr.items||[])){
    const cur=(it?.currency||"").toUpperCase(); if(!cur) continue;
    if (cur===base || cur===quote) sawRelevant = true;

    if(it?.impact==="High" && it?.timeISO){
      const t=Date.parse(it.timeISO); if(isFinite(t) && t>=nowMs){ const mins=Math.floor((t-nowMs)/60000); if(mins<=60) warn=warn==null?mins:Math.min(warn,mins); }
    }

    const a=parseNumberLoose(it.actual); const f=parseNumberLoose(it.forecast); const p=parseNumberLoose(it.previous);
    const dir=goodIfHigher(String(it?.title||""));

    // Post-result → evidence AND bias
    if(a!=null && (f!=null || p!=null)){
      hasPostResult=true;
      const ev=evidenceLine(it, cur); if(ev) lines.push(ev);
      if(dir!==null){
        const ref=f??p; const raw=(a-(ref as number))/(Math.abs(ref as number)||1); const signed=(dir?raw:-raw);
        const s=Math.max(-1,Math.min(1,signed*4)); add(cur, s*1.0);
      }
      continue;
    }

    // Pre-release → usable but NO bias contribution (awareness only)
  }

  const lab=(s:number)=> s>0.05?"bullish" : s<-0.05?"bearish" : "neutral";
  const b=score[base]??0, q=score[quote]??0; const bLab=lab(b), qLab=lab(q);
  let instr:string|null=null;
  if (hasPostResult) {
    if (bLab==="bullish" && qLab==="bearish") instr="bullish (base stronger than quote)";
    else if (bLab==="bearish" && qLab==="bullish") instr="bearish (quote stronger than base)";
  }

  const biasLine = hasPostResult
    ? `Calendar bias for ${pair}: ${instr ? `Instrument: ${instr}; ` : ""}Per-currency: ${base}:${bLab} / ${quote}:${qLab}`
    : (sawRelevant ? `Calendar: data not released yet (expectations only).` : `Calendar provided, but no relevant info for ${pair}.`);

  const biasNote = hasPostResult
    ? `Per-currency: ${base} ${bLab} vs ${quote} ${qLab}${instr?`; Instrument bias: ${instr}`:""}`
    : null;

  return { biasLine, biasNote, warningMinutes: warn, evidenceLines: lines, postResult: hasPostResult, sawRelevant };
}

/* ---------------- API calendar fallback (unchanged) ---------------- */
async function fetchCalendarRaw(req:NextApiRequest, instrument:string){ try{
  const base=originFromReq(req); const url=`${base}/api/calendar?instrument=${encodeURIComponent(instrument)}&windowHours=120&_t=${Date.now()}`;
  const r=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(5000)}); const j:any=await r.json().catch(()=>({})); return j?.ok?j:null;
}catch{ return null; } }
function calendarShortText(resp:any,pair:string){
  if(!resp?.ok) return null; const instrBias=resp?.bias?.instrument; const parts:string[]=[];
  if(instrBias && instrBias.pair===pair) parts.push(`Instrument bias: ${instrBias.label} (${instrBias.score})`);
  const per=resp?.bias?.perCurrency||{}; const base=pair.slice(0,3), quote=pair.slice(3);
  const b=per[base]?.label ? `${base}:${per[base].label}` : null; const q=per[quote]?.label ? `${quote}:${per[quote].label}` : null;
  if(b||q) parts.push(`Per-currency: ${[b,q].filter(Boolean).join(" / ")}`); if(!parts.length) parts.push("No strong calendar bias.");
  return `Calendar bias for ${pair}: ${parts.join("; ")}`;
}
function nearestHighImpactWithin(resp:any, minutes:number){ if(!resp?.ok||!Array.isArray(resp?.items)) return null; const nowMs=Date.now(); let best:number|null=null;
  for(const it of resp.items){ if(String(it?.impact||"")!=="High") continue; const t=new Date(it.time).getTime(); if(t>=nowMs){ const mins=Math.floor((t-nowMs)/60000); if(mins<=minutes) best=best==null?mins:Math.min(best,mins); } }
  return best;
}
function postResultBiasNote(resp:any,pair:string){ if(!resp?.ok) return null; const base=pair.slice(0,3), quote=pair.slice(3);
  const per=resp?.bias?.perCurrency||{}; const b=per[base]?.label||"neutral"; const q=per[quote]?.label||"neutral"; const instr=resp?.bias?.instrument?.label||null;
  const scores = resp?.bias?.instrument ? `(score ${resp.bias.instrument.score})` : ""; return `Per-currency: ${base} ${b} vs ${quote} ${q}${instr?`; Instrument bias: ${instr} ${scores}`:""}`;
}
function buildCalendarEvidence(resp:any,pair:string){ if(!resp?.ok||!Array.isArray(resp?.items)) return []; const base=pair.slice(0,3), quote=pair.slice(3); const nowMs=Date.now(), lo=nowMs-72*3600*1000;
  const done=resp.items.filter((it:any)=>{ const t=new Date(it.time).getTime(); return t<=nowMs && t>=lo && (it.actual!=null||it.forecast!=null||it.previous!=null) && (it.currency===base||it.currency===quote); }).slice(0,12);
  const lines:string[]=[]; for(const it of done){ const line=evidenceLine(it,it.currency||""); if(line) lines.push(line); } return lines;
}
async function fetchCalendarForAdvisory(req:NextApiRequest,instrument:string){
  try{
    const base=originFromReq(req); const url=`${base}/api/calendar?instrument=${encodeURIComponent(instrument)}&windowHours=48&_t=${Date.now()}`;
    const r=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(4000)}); const j:any=await r.json().catch(()=>({}));
    if(j?.ok){
      const t=calendarShortText(j,instrument) || `Calendar bias for ${instrument}: (no strong signal)`;
      const warn=nearestHighImpactWithin(j,60); const bias=postResultBiasNote(j,instrument);
      const advisory=[ warn!=null?`⚠️ High-impact event in ~${warn} min.`:null, bias?`Recent result alignment: ${bias}.`:null ].filter(Boolean).join("\n");
      const rawFull=await fetchCalendarRaw(req,instrument); const evidence = rawFull ? buildCalendarEvidence(rawFull,instrument) : buildCalendarEvidence(j,instrument);
      return { text:t, status:"api" as const, provider:String(j?.provider||"mixed"), warningMinutes:warn??null, advisoryText:advisory||null, biasNote:bias||null, raw:j, evidence };
    }
    return { text:"Calendar unavailable.", status:"unavailable" as const, provider:null, warningMinutes:null, advisoryText:null, biasNote:null, raw:null, evidence:[] };
  }catch{
    return { text:"Calendar unavailable.", status:"unavailable" as const, provider:null, warningMinutes:null, advisoryText:null, biasNote:null, raw:null, evidence:[] };
  }
}

/* ---------------- composite bias ---------------- */
function splitFXPair(instr:string){ const U=(instr||"").toUpperCase(); if(U.length>=6){ const base=U.slice(0,3), quote=U.slice(3,6); if(G8.includes(base)&&G8.includes(quote)) return {base,quote}; } return {base:null,quote:null}; }
function parseInstrumentBiasFromNote(biasNote:string|null|undefined){ if(!biasNote) return 0; const m=biasNote.match(/instrument[^:]*:\s*(bullish|bearish)/i); if(m?.[1]) return m[1].toLowerCase()==="bullish"?1:-1; return 0; }
function computeCSMInstrumentSign(csm:CsmSnapshot,instr:string){ const {base,quote}=splitFXPair(instr); if(!base||!quote) return {sign:0, zdiff:null}; const zb=csm.scores[base], zq=csm.scores[quote]; if(typeof zb!=="number"||typeof zq!=="number") return {sign:0,zdiff:null}; const diff=zb-zq; const sign=diff>0.4?1:diff<-0.4?-1:0; return {sign,zdiff:diff}; }
function computeHeadlinesSign(hb:HeadlineBias){ if(!hb) return 0; if(hb.label==="bullish") return 1; if(hb.label==="bearish") return -1; return 0; }
function computeCompositeBias(args:{instrument:string; calendarBiasNote:string|null; headlinesBias:HeadlineBias; csm:CsmSnapshot; warningMinutes:number|null; postResult:boolean;}){
  const calSign=args.postResult ? parseInstrumentBiasFromNote(args.calendarBiasNote) : 0; // no bias if only expectations
  const hSign=computeHeadlinesSign(args.headlinesBias);
  const {sign:csmSign, zdiff}=computeCSMInstrumentSign(args.csm,args.instrument);
  const parts=[calSign!==0?(calSign>0?1:-1):0, hSign, csmSign];
  const pos=parts.some(s=>s>0), neg=parts.some(s=>s<0);
  const align = (pos && !neg) || (neg && !pos);
  const conflict = pos && neg;
  let cap=70; if(conflict) cap=35; if(args.warningMinutes!=null) cap=Math.min(cap,35);
  return {calendarSign:calSign, headlinesSign:hSign, csmSign, csmZDiff:zdiff, align, conflict, cap};
}

/* ---------------- prompts ---------------- */
function systemCore(instrument:string, opts:{warningMinutes?:number|null; biasNote?:string|null; hasM5?:boolean}){
  const warn = (opts?.warningMinutes ?? null) != null ? opts!.warningMinutes : null;
  const bias = opts?.biasNote || null;
  const m5Line = opts?.hasM5 ? "\n5M present: If the primary/alternative is based on 5M execution, explicitly say so in Option blocks." : "";

  return [
    "You are a professional discretionary trader.",
    "STRICT NO-GUESS:",
    "- Mention **Calendar** only if calendar_status === 'api' or 'image-ocr'.",
    "- Mention **Headlines** only if provided.",
    "- Never invent figures; missing → 'unavailable'. Use provided Sentiment (CSM+Headlines, optional COT).",
    "",
    "Execution:",
    "- 4H HTF → 1H context → 15m execution. If 5m provided, evaluate as scalp execution too and state it when used.",
    "- Use Entry zones (min–max) for confluence. Use single price for tight breakouts. SL behind structure; TP1/TP2; BE rules.",
    "",
    "Tournament: evaluate common strategies; Option 2 must be a distinct viable alternative.",
    "Breakout discipline: if proof not confirmed, mark Pending with trigger sequence.",
    "",
    "Conviction governance (use provenance_hint.composite):",
    "- conflict === true → cap ≤35% and 'Tech vs Fundy: Mismatch'.",
    "- align === true → may reach composite.cap (≤70%) if technical clarity allows.",
    "",
    "Consistency: When Calendar/Headlines/CSM align, do not say 'contradicting'—use 'aligning'.",
    "Fundamental View must state 'Calendar: unavailable' if so.",
    `${m5Line}`,
    warn!==null ? `\nCALENDAR WARNING: High-impact event within ~${warn} min → avoid new Market entries right before; cap ≤35%.` : "",
    bias ? `\nPOST-RESULT ALIGNMENT: ${bias}.` : "",
    `\nKeep instrument alignment with ${instrument}.`,
  ].join("\n");
}

function buildUserPartsBase(args:{
  instrument:string; dateStr:string;
  m15:string; h1:string; h4:string; m5?:string|null;
  calendarDataUrl?:string|null; calendarText?:string|null;
  headlinesText?:string|null; sentimentText?:string|null;
  calendarAdvisoryText?:string|null; calendarEvidence?:string[]|null;
}){
  const parts:any[]=[
    {type:"text", text:`Instrument: ${args.instrument}\nDate: ${args.dateStr}`},
    {type:"text", text:"HTF 4H Chart:"}, {type:"image_url", image_url:{url:args.h4}},
    {type:"text", text:"Context 1H Chart:"}, {type:"image_url", image_url:{url:args.h1}},
    {type:"text", text:"Execution 15M Chart:"}, {type:"image_url", image_url:{url:args.m15}},
  ];
  if (args.m5) { parts.push({type:"text", text:"Scalp 5M Chart:"}); parts.push({type:"image_url", image_url:{url:args.m5}}); }
  if (args.calendarDataUrl) { parts.push({type:"text", text:"Economic Calendar Image:"}); parts.push({type:"image_url", image_url:{url:args.calendarDataUrl}}); }
  if (!args.calendarDataUrl && args.calendarText) { parts.push({type:"text", text:`Calendar snapshot:\n${args.calendarText}`}); }
  if (args.calendarAdvisoryText) { parts.push({type:"text", text:`Calendar advisory:\n${args.calendarAdvisoryText}`}); }
  if (args.calendarEvidence && args.calendarEvidence.length) { parts.push({type:"text", text:`Calendar fundamentals evidence:\n- ${args.calendarEvidence.join("\n- ")}`}); }
  if (args.headlinesText) { parts.push({type:"text", text:`Headlines snapshot:\n${args.headlinesText}`}); }
  if (args.sentimentText) { parts.push({type:"text", text:`Sentiment snapshot (server):\n${args.sentimentText}`}); }
  return parts;
}

/* ---- Decision kernel prompt (used by both Fast and Full) ---- */
function messagesDecisionKernel(args:{
  instrument:string; dateStr:string;
  m15:string; h1:string; h4:string; m5?:string|null;
  calendarDataUrl?:string|null; calendarText?:string|null;
  headlinesText?:string|null; sentimentText?:string|null;
  calendarAdvisory?:{ warningMinutes?:number|null; biasNote?:string|null; advisoryText?:string|null; evidence?:string[]|null; };
  provenance?:any;
}){
  const system = [
    systemCore(args.instrument,{ warningMinutes:args.calendarAdvisory?.warningMinutes, biasNote: args.calendarAdvisory?.biasNote, hasM5: !!args.m5 }),
    "",
    "OUTPUT ONLY Quick Plan + ai_meta JSON.",
    "Quick Plan (Actionable)",
    "• Direction: Long | Short | Stay Flat",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger:",
    "• Entry (zone or single):",
    "• Stop Loss:",
    "• Take Profit(s): TP1 / TP2",
    "• Conviction: <0–100>%",
    "• Setup: (state explicitly if based on 5M / 15M)",
    "• Short Reasoning:",
    "",
    "Append a fenced JSON block labelled ai_meta containing: { direction, entryOrder, zone:{min,max}, sl, tp1, tp2, conviction, usedChart:'5M'|'15M'|'1H'|'4H', currentPrice? }",
    "",
    "provenance_hint:",
    JSON.stringify(args.provenance||{},null,2),
  ].join("\n");

  return [
    { role:"system", content: system },
    { role:"user", content: buildUserPartsBase({
        instrument:args.instrument, dateStr:args.dateStr, m15:args.m15, h1:args.h1, h4:args.h4, m5:args.m5||undefined,
        calendarDataUrl:args.calendarDataUrl, calendarText:args.calendarText,
        headlinesText:args.headlinesText, sentimentText:args.sentimentText,
        calendarAdvisoryText:args.calendarAdvisory?.advisoryText||null, calendarEvidence:args.calendarAdvisory?.evidence||null,
    }) },
  ];
}

/* ---- Expansion prompt (locks ai_meta) ---- */
function messagesExpandFromMeta(args:{
  instrument:string; dateStr:string;
  m15:string; h1:string; h4:string; m5?:string|null;
  calendarDataUrl?:string|null; calendarText?:string|null;
  headlinesText?:string|null; sentimentText?:string|null;
  calendarAdvisory?:{ warningMinutes?:number|null; biasNote?:string|null; advisoryText?:string|null; evidence?:string[]|null; };
  provenance?:any;
  ai_meta:any;
}){
  const system = [
    systemCore(args.instrument,{ warningMinutes:args.calendarAdvisory?.warningMinutes, biasNote: args.calendarAdvisory?.biasNote, hasM5: !!args.m5 }),
    "",
    "You are given ai_meta (anchor). DO NOT change direction, order type, entry zone, SL, TP1/TP2, conviction, or usedChart.",
    "Produce the full card with sections:",
    "Quick Plan (Actionable)  → copy values from ai_meta",
    "",
    "Option 1 (Primary)  → same numbers as ai_meta; justify why; explicitly state usedChart (e.g., 'based on 5M execution').",
    "Option 2 (Alternative) → distinct viable alternative (different trigger/structure) but keep conviction governed by composite cap.",
    "",
    "Full Breakdown",
    "• Technical View (4H/1H/15M and 5M if used)",
    "• Fundamental View (Calendar + Sentiment + Headlines)",
    "• Tech vs Fundy Alignment",
    "• Conditional Scenarios; Surprise Risk; Invalidation; One-liner Summary",
    "",
    "Append fenced JSON ai_meta again at the end (unchanged).",
    "",
    "provenance_hint:",
    JSON.stringify(args.provenance||{},null,2),
    "",
    "ai_meta ANCHOR:",
    "```json",
    JSON.stringify(args.ai_meta||{},null,2),
    "```",
  ].join("\n");

  return [
    { role:"system", content: system },
    { role:"user", content: buildUserPartsBase({
        instrument:args.instrument, dateStr:args.dateStr, m15:args.m15, h1:args.h1, h4:args.h4, m5:args.m5||undefined,
        calendarDataUrl:args.calendarDataUrl, calendarText:args.calendarText,
        headlinesText:args.headlinesText, sentimentText:args.sentimentText,
        calendarAdvisoryText:args.calendarAdvisory?.advisoryText||null, calendarEvidence:args.calendarAdvisory?.evidence||null,
    }) },
  ];
}

/* ---------------- enforcement & guards ---------------- */
function hasCompliantOption2(text:string){ if(!/Option\s*2/i.test(text||"")) return false; const block=(text.match(/Option\s*2[\s\S]{0,800}/i)?.[0]||"").toLowerCase(); const must=["direction","order type","trigger","entry","stop","tp","conviction"]; return must.every(k=>block.includes(k)); }
async function enforceOption2(model:string,instrument:string,text:string){ if(hasCompliantOption2(text)) return text;
  const messages=[{role:"system",content:"Add a compliant 'Option 2 (Alternative)' below Option 1. Include Direction, Order Type, explicit Trigger, Entry, SL, TP1/TP2, Conviction %. Keep everything else unchanged."},{role:"user",content:`Instrument: ${instrument}\n\n${text}\n\nAdd Option 2 (Alternative).`}];
  return callOpenAI(model,messages);
}
function hasOption1(text:string){ return /Option\s*1\s*\(?(Primary)?\)?/i.test(text||""); }
async function enforceOption1(model:string,instrument:string,text:string){ if(hasOption1(text)) return text;
  const messages=[{role:"system",content:"Insert a labeled 'Option 1 (Primary)' block BEFORE 'Option 2'. Use the primary trade details already present. Include Direction, Order Type, Trigger, Entry, SL, TP1/TP2, Conviction %. Keep other content unchanged."},{role:"user",content:`Instrument: ${instrument}\n\n${text}\n\nNormalize/add 'Option 1 (Primary)'.`}];
  return callOpenAI(model,messages);
}
function hasQuickPlan(text:string){ return /Quick\s*Plan\s*\(Actionable\)/i.test(text||""); }
async function enforceQuickPlan(model:string,instrument:string,text:string){ if(hasQuickPlan(text)) return text;
  const messages=[{role:"system",content:"Add a 'Quick Plan (Actionable)' section at the very top, copying primary trade (ai_meta). Keep everything else unchanged."},{role:"user",content:`Instrument: ${instrument}\n\n${text}\n\nAdd Quick Plan at the top.`}];
  return callOpenAI(model,messages);
}
function applyConsistencyGuards(text:string,args:{instrument:string; headlinesSign:number; csmSign:number; calendarSign:number;}){
  let out=text||""; const signs=[args.headlinesSign,args.csmSign,args.calendarSign].filter(s=>s!==0);
  const hasPos=signs.some(s=>s>0), hasNeg=signs.some(s=>s<0); const aligned=signs.length>0 && ((hasPos&&!hasNeg)||(hasNeg&&!hasPos)); const mismatch=hasPos&&hasNeg;
  if(aligned) out=out.replace(/contradict(?:ion|ing|s)?/gi,"aligning");
  const reTF=/(Tech\s*vs\s*Fundy\s*Alignment:\s*)(Match|Mismatch)/i; if(reTF.test(out)){ out=out.replace(reTF,(_,p1)=>`${p1}${aligned?"Match":mismatch?"Mismatch":"Match"}`); }
  return out;
}

/* ---------------- live price ---------------- */
async function fetchLivePrice(pair:string):Promise<number|null>{
  if(TD_KEY){ try{ const sym=`${pair.slice(0,3)}/${pair.slice(3)}`; const url=`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&dp=5`; const r=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(1800)}); const j:any=await r.json().catch(()=>({})); const p=Number(j?.price); if(isFinite(p)&&p>0) return p; }catch{} }
  if(FH_KEY){ try{ const sym=`OANDA:${pair.slice(0,3)}_${pair.slice(3)}`; const to=Math.floor(Date.now()/1000); const from=to-60*60*3;
    const url=`https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(sym)}&resolution=15&from=${from}&to=${to}&token=${FH_KEY}`;
    const r=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(1800)}); const j:any=await r.json().catch(()=>({})); const c:Array<number>=Array.isArray(j?.c)?j.c:[]; const last=Number(c.at(-1)); if(isFinite(last)&&last>0) return last; }catch{} }
  if(POLY_KEY){ try{ const ticker=`C:${pair}`; const to=new Date(); const from=new Date(to.getTime()-60*60*1000);
    const fmt=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const url=`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=desc&limit=1&apiKey=${POLY_KEY}`;
    const r=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(1500)}); const j:any=await r.json().catch(()=>({})); const res=Array.isArray(j?.results)?j.results[0]:null; const last=Number(res?.c); if(isFinite(last)&&last>0) return last; }catch{} }
  try{ const S=await fetchSeries15(pair); const last=S?.c?.at(-1); if(isFinite(Number(last))&&Number(last)>0) return Number(last); }catch{}
  return null;
}

/* ---------------- provenance footer ---------------- */
function buildServerProvenanceFooter(args:{ headlines_provider:string|null; calendar_status:"api"|"image-ocr"|"unavailable"; calendar_provider:string|null; csm_time:string|null; extras?:Record<string,any>; }){
  const lines=[ "\n---","Data Provenance (server — authoritative):", `• Headlines: ${args.headlines_provider||"unknown"}`, `• Calendar: ${args.calendar_status}${args.calendar_provider?` (${args.calendar_provider})`:""}`, `• Sentiment CSM timestamp: ${args.csm_time||"n/a"}`, args.extras?`• Meta: ${JSON.stringify(args.extras)}`:undefined,"---\n" ].filter(Boolean);
  return lines.join("\n");
}

/* ---------------- multipart helpers ---------------- */
async function getFormidable(){ const mod:any = await import("formidable"); return mod.default || mod; }
function isMultipart(req:NextApiRequest){ const t=String(req.headers["content-type"]||""); return t.includes("multipart/form-data"); }
async function parseMultipart(req:NextApiRequest){
  const formidable=await getFormidable(); const form=formidable({multiples:false,maxFiles:25,maxFileSize:25*1024*1024});
  return new Promise<{fields:Record<string,any>; files:Record<string,any>}>((resolve,reject)=>{ form.parse(req as any,(err:any,fields:any,files:any)=>{ if(err) return reject(err); resolve({fields,files}); }); });
}
function pickFirst<T=any>(x:T|T[]|undefined|null):T|null{ if(!x) return null; return Array.isArray(x)?(x[0]??null):(x as any); }

/* ---------------- handler ---------------- */
export default async function handler(req:NextApiRequest, res:NextApiResponse<Ok|Err>){
  try{
    if(req.method!=="POST") return res.status(405).json({ok:false,reason:"Method not allowed"});
    if(!OPENAI_API_KEY) return res.status(400).json({ok:false,reason:"Missing OPENAI_API_KEY"});

    const urlMode=String((req.query.mode as string)||"").toLowerCase();
    let mode: "full"|"fast"|"expand" = urlMode==="fast"?"fast": urlMode==="expand"?"expand":"full";

    /* ----- expand (uses cached ai_meta) ----- */
    if(mode==="expand"){
      const modelExpand=pickModelFromFields(req);
      const cacheKey=String(req.query.cache||"").trim();
      const c=getCache(cacheKey);
      if(!c) return res.status(400).json({ok:false,reason:"Expand failed: cache expired or not found."});

      const dateStr=new Date().toISOString().slice(0,10);
      const calAdv=await fetchCalendarForAdvisory(req, c.instrument);
      const provHint={ headlines_present: !!c.headlinesText, calendar_status: c.calendar ? "image-ocr" : (calAdv.status||"unavailable"), composite:{} };

      const messages = messagesExpandFromMeta({
        instrument:c.instrument, dateStr,
        m15:c.m15, h1:c.h1, h4:c.h4, m5:c.m5||undefined,
        calendarDataUrl: c.calendar || undefined,
        headlinesText: c.headlinesText || undefined,
        sentimentText: c.sentimentText || undefined,
        calendarAdvisory: { warningMinutes: calAdv.warningMinutes, biasNote: calAdv.biasNote, advisoryText: calAdv.advisoryText, evidence: calAdv.evidence||[] },
        provenance: provHint,
        ai_meta: c.ai_meta || {},
      });

      let text = await callOpenAI(modelExpand, messages);
      text = await enforceQuickPlan(modelExpand, c.instrument, text);
      text = await enforceOption1(modelExpand, c.instrument, text);
      text = await enforceOption2(modelExpand, c.instrument, text);

      const footer = buildServerProvenanceFooter({
        headlines_provider:"expand-uses-stage1",
        calendar_status: c.calendar ? "image-ocr" : (calAdv?.status||"unavailable"),
        calendar_provider: c.calendar ? "image-ocr" : calAdv?.provider || null,
        csm_time: null,
        extras: { vp_version: VP_VERSION, model: modelExpand, mode:"expand" },
      });
      text = `${text}\n${footer}`;

      res.setHeader("Cache-Control","no-store");
      return res.status(200).json({ok:true, text, meta:{ instrument:c.instrument, cacheKey, model:modelExpand, vp_version:VP_VERSION }});
    }

    /* ----- multipart ----- */
    if(!isMultipart(req)) return res.status(400).json({ok:false,reason:"Use multipart/form-data with files: m15, h1, h4 (+optional m5, calendar). Or pass m15Url/h1Url/h4Url (and optional m5Url, calendarUrl). Include 'instrument'."});
    const {fields,files}=await parseMultipart(req);

    const MODEL=pickModelFromFields(req,fields);
    const instrument=String(fields.instrument||fields.code||"EURUSD").toUpperCase().replace(/\s+/g,"");
    const requestedMode=String(fields.mode||"").toLowerCase(); if(requestedMode==="fast") mode="fast";

    // files
    const m5f = pickFirst(files.m5);
    const m15f=pickFirst(files.m15); const h1f=pickFirst(files.h1); const h4f=pickFirst(files.h4); const calF=pickFirst(files.calendar);
    // urls
    const m5UrlField = String(pickFirst(fields.m5Url)||"").trim();
    const m15Url=String(pickFirst(fields.m15Url)||"").trim(); const h1Url=String(pickFirst(fields.h1Url)||"").trim(); const h4Url=String(pickFirst(fields.h4Url)||"").trim();
    const calendarUrlField=String(pickFirst(fields.calendarUrl)||"").trim();

    // process images
    const [m5FromFile, m15FromFile, h1FromFile, h4FromFile, calFromFile] = await Promise.all([
      m5f ? fileToDataUrl(m5f) : Promise.resolve(null),
      fileToDataUrl(m15f), fileToDataUrl(h1f), fileToDataUrl(h4f),
      calF ? fileToDataUrl(calF) : Promise.resolve(null),
    ]);
    const [m5FromUrl, m15FromUrl, h1FromUrl, h4FromUrl, calFromUrl] = await Promise.all([
      m5FromFile ? Promise.resolve(null) : linkToDataUrl(m5UrlField),
      m15FromFile ? Promise.resolve(null) : linkToDataUrl(m15Url),
      h1FromFile ? Promise.resolve(null) : linkToDataUrl(h1Url),
      h4FromFile ? Promise.resolve(null) : linkToDataUrl(h4Url),
      calFromFile ? Promise.resolve(null) : linkToDataUrl(calendarUrlField),
    ]);

    const m5 = m5FromFile || m5FromUrl || null;
    const m15=m15FromFile||m15FromUrl; const h1=h1FromFile||h1FromUrl; const h4=h4FromFile||h4FromUrl;
    const calUrlOrig = calFromFile || calFromUrl || null;

    if(!m15 || !h1 || !h4) return res.status(400).json({ok:false,reason:"Provide 15m + 1H + 4H charts (files or image links)."});

    /* ----- headlines ----- */
    let headlineItems:AnyHeadline[]=[]; let headlinesText:string|null=null; let headlinesProvider="unknown";
    const rawHeadlines=pickFirst(fields.headlinesJson) as string | null;
    if(rawHeadlines){ try{ const parsed=JSON.parse(String(rawHeadlines)); if(Array.isArray(parsed)){ headlineItems=parsed.slice(0,12); headlinesText=headlinesToPromptLines(headlineItems,6); headlinesProvider="client"; }}catch{} }
    if(!headlinesText){ const viaServer=await fetchedHeadlinesViaServer(req,instrument); headlineItems=viaServer.items; headlinesText=viaServer.promptText; headlinesProvider=viaServer.provider||"unknown"; }
    const hBias=computeHeadlinesBias(headlineItems);

    /* ----- calendar OCR-first (no pre-release bias) ----- */
    let calendarStatus:"image-ocr"|"api"|"unavailable"="unavailable";
    let calendarProvider:string|null=null;
    let calendarText:string|null=null;
    let calendarEvidence:string[]=[];
    let warningMinutes:number|null=null;
    let biasNote:string|null=null;
    let advisoryText:string|null=null;

    let calDataUrlForPrompt:string|null=calUrlOrig;

    if(calUrlOrig){
      const ocr = await ocrCalendarFromImage(MODEL, calUrlOrig).catch(()=>null);
      if(ocr && Array.isArray(ocr.items)){
        const rel=new Set(relevantCurrenciesFromInstrument(instrument));
        const usable=(ocr.items||[]).some(r=>rel.has(String(r?.currency||"")) && hasUsableFields(r));
        calendarStatus="image-ocr"; calendarProvider="image-ocr";
        if(usable){
          const analyzed=analyzeCalendarOCR(ocr,instrument);
          calendarText = analyzed.biasLine;
          calendarEvidence = analyzed.evidenceLines;
          warningMinutes = analyzed.warningMinutes;
          biasNote = analyzed.biasNote;
          calDataUrlForPrompt = calUrlOrig;
        }else{
          calendarText = `Calendar provided, but no relevant info for ${instrument}.`;
          calDataUrlForPrompt = null;
        }
      }else{
        const calAdv=await fetchCalendarForAdvisory(req,instrument);
        calendarStatus=calAdv.status; calendarProvider=calAdv.provider; calendarText=calAdv.text; advisoryText=calAdv.advisoryText||null; calendarEvidence=calAdv.evidence||[];
        warningMinutes=calAdv.warningMinutes; biasNote=calAdv.biasNote; calDataUrlForPrompt=null;
      }
    }else{
      const calAdv=await fetchCalendarForAdvisory(req,instrument);
      calendarStatus=calAdv.status; calendarProvider=calAdv.provider; calendarText=calAdv.text; calendarEvidence=calAdv.evidence||[];
      warningMinutes=calAdv.warningMinutes; biasNote=calAdv.biasNote; calDataUrlForPrompt=null;
    }

    /* ----- sentiment + price ----- */
    let csm:CsmSnapshot; try{ csm=await getCSM(); }catch(e:any){ return res.status(503).json({ok:false,reason:`CSM unavailable: ${e?.message||"fetch failed"}`}); }
    const cotCue=detectCotCueFromHeadlines(headlineItems);
    const ranksLine = `CSM (60–240m): ${csm.ranks.slice(0,4).join(" > ")} ... ${csm.ranks.slice(-3).join(" < ")}`;
    const hBiasLine = hBias.label==="unavailable" ? "Headlines bias (48h): unavailable" : `Headlines bias (48h): ${hBias.label}${hBias.avg!=null?` (${hBias.avg.toFixed(2)})`:""}`;
    const cotLine = cotCue ? `COT: ${cotCue.summary}` : "COT: no cues from headlines.";
    const sentimentText = `${ranksLine}\n${hBiasLine}\n${cotLine}`;
    const livePrice = await fetchLivePrice(instrument);
    const dateStr = new Date().toISOString().slice(0,10);

    /* ----- composite (no calendar bias if only expectations) ----- */
    // Determine if OCR had post-result (for image path) — used to zero calendar sign when only expectations
    let postResult=false;
    if (calendarStatus === "image-ocr" && calendarText) {
      // crude flag: if text starts with "Calendar bias for", we likely had post results
      postResult = /^Calendar bias for/i.test(calendarText);
    }
    const composite = computeCompositeBias({
      instrument, calendarBiasNote: biasNote, headlinesBias: hBias, csm, warningMinutes, postResult
    });
    const provForModel = { headlines_present: !!headlinesText, calendar_status: calendarStatus, composite, has_m5: !!m5 };

    /* ---------- Decision Kernel (ONE SOURCE OF TRUTH) ---------- */
    const kernelMsgs = messagesDecisionKernel({
      instrument, dateStr, m15, h1, h4, m5: m5||undefined,
      calendarDataUrl: calDataUrlForPrompt||undefined,
      calendarText: (!calDataUrlForPrompt && calendarText) ? calendarText : undefined,
      headlinesText: headlinesText||undefined,
      sentimentText,
      calendarAdvisory: { warningMinutes, biasNote, advisoryText, evidence: calendarEvidence||[] },
      provenance: provForModel,
    });
    if(livePrice){ (kernelMsgs[0] as any).content = (kernelMsgs[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice};`; }

    const kernelText = await callOpenAI(MODEL, kernelMsgs);
    let aiMeta = extractAiMeta(kernelText) || {};
    if (livePrice && (aiMeta.currentPrice==null || !isFinite(Number(aiMeta.currentPrice)))) aiMeta.currentPrice = livePrice;

    // sanity vs price
    const bad = invalidOrderRelativeToPrice(aiMeta);
    let quickOut = kernelText;
    if (bad){
      // repair by re-enforcing structure sections later; keep ai_meta as anchor
      quickOut = await enforceQuickPlan(MODEL, instrument, kernelText);
    }

    // Always normalise minimal sections in quick
    quickOut = await enforceQuickPlan(MODEL, instrument, quickOut);
    quickOut = await enforceOption1(MODEL, instrument, quickOut);
    quickOut = await enforceOption2(MODEL, instrument, quickOut);

    quickOut = applyConsistencyGuards(quickOut, {
      instrument,
      headlinesSign: computeHeadlinesSign(hBias),
      csmSign: computeCSMInstrumentSign(csm, instrument).sign,
      calendarSign: postResult ? parseInstrumentBiasFromNote(biasNote) : 0
    });

    const cacheKey = setCache({ instrument, m5: m5||null, m15, h1, h4, calendar: calDataUrlForPrompt||null, headlinesText: headlinesText||null, sentimentText, ai_meta: aiMeta });

    /* ---------- FAST path ---------- */
    if (mode==="fast"){
      const footer = buildServerProvenanceFooter({
        headlines_provider: headlinesProvider||"unknown",
        calendar_status: calendarStatus,
        calendar_provider: calendarProvider,
        csm_time: csm.tsISO,
        extras: { vp_version: VP_VERSION, model: MODEL, mode, composite_cap: composite.cap, composite_align: composite.align, composite_conflict: composite.conflict },
      });
      const text = `${quickOut}\n${footer}`;
      res.setHeader("Cache-Control","no-store");
      return res.status(200).json({
        ok:true,
        text,
        meta:{
          instrument, mode, cacheKey, vp_version:VP_VERSION, model:MODEL,
          sources:{ headlines_used: Math.min(6, Array.isArray(headlineItems)?headlineItems.length:0), headlines_instrument: instrument, headlines_provider: headlinesProvider||"unknown", calendar_used: calendarStatus!=="unavailable", calendar_status: calendarStatus, calendar_provider: calendarProvider, csm_used:true, csm_time:csm.tsISO },
          aiMeta
        }
      });
    }

    /* ---------- FULL path (expand around SAME ai_meta) ---------- */
    const expandMsgs = messagesExpandFromMeta({
      instrument, dateStr, m15, h1, h4, m5: m5||undefined,
      calendarDataUrl: calDataUrlForPrompt||undefined,
      calendarText: (!calDataUrlForPrompt && calendarText) ? calendarText : undefined,
      headlinesText: headlinesText||undefined, sentimentText,
      calendarAdvisory: { warningMinutes, biasNote, advisoryText, evidence: calendarEvidence||[] },
      provenance: provForModel,
      ai_meta: aiMeta,
    });
    if(livePrice){ (expandMsgs[0] as any).content = (expandMsgs[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice};`; }

    let textFull = await callOpenAI(MODEL, expandMsgs);
    // enforce presence/order (should already be OK)
    textFull = await enforceQuickPlan(MODEL, instrument, textFull);
    textFull = await enforceOption1(MODEL, instrument, textFull);
    textFull = await enforceOption2(MODEL, instrument, textFull);
    textFull = applyConsistencyGuards(textFull, {
      instrument,
      headlinesSign: computeHeadlinesSign(hBias),
      csmSign: computeCSMInstrumentSign(csm, instrument).sign,
      calendarSign: postResult ? parseInstrumentBiasFromNote(biasNote) : 0
    });

    const footer = buildServerProvenanceFooter({
      headlines_provider: headlinesProvider||"unknown",
      calendar_status: calendarStatus,
      calendar_provider: calendarProvider,
      csm_time: csm.tsISO,
      extras: { vp_version: VP_VERSION, model: MODEL, mode, composite_cap: composite.cap, composite_align: composite.align, composite_conflict: composite.conflict },
    });
    textFull = `${textFull}\n${footer}`;

    res.setHeader("Cache-Control","no-store");
    return res.status(200).json({
      ok:true,
      text: textFull,
      meta:{
        instrument, mode, vp_version:VP_VERSION, model:MODEL,
        sources:{ headlines_used: Math.min(6, Array.isArray(headlineItems)?headlineItems.length:0), headlines_instrument: instrument, headlines_provider: headlinesProvider||"unknown", calendar_used: calendarStatus!=="unavailable", calendar_status: calendarStatus, calendar_provider: calendarProvider, csm_used:true, csm_time:csm.tsISO },
        aiMeta
      }
    });

  }catch(err:any){
    return res.status(500).json({ok:false,reason: err?.message || "vision-plan failed"});
  }
}
