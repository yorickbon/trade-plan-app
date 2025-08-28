// /pages/api/candles.ts  (DIAGNOSTIC)
import type { NextApiRequest, NextApiResponse } from "next";
import { TF } from "../../lib/prices";

// Minimal re-implementation that probes each provider directly with the same mapping as lib/prices.ts
type Candle = { t:number;o:number;h:number;l:number;c:number };
type DebugLine = { provider:string; tried:boolean; keyPresent:boolean; url?:string; status?:number; note?:string; count?:number };

const ok = (c:Candle)=>[c.t,c.o,c.h,c.l,c.c].every(Number.isFinite);
const normalize = (s:string)=>{ s=s.trim().toUpperCase(); if(s.includes("/")) return s; if(/^[A-Z]{6}$/.test(s)) return `${s.slice(0,3)}/${s.slice(3)}`; return s; };
const mapTf = (tf:TF, p:"td"|"polygon"|"finnhub") => (p==="td"? (tf==="15m"?"15min":tf) : (tf==="15m"?"15":tf==="1h"?"60":"240"));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const symbolIn = String(req.query.symbol ?? req.query.code ?? "EURUSD");
  const tf = String(req.query.interval ?? "15m") as TF;
  const n = Math.max(50, Math.min(2000, Number(req.query.limit ?? 200)));
  const debug = String(req.query.debug ?? "") === "1";
  const symbol = normalize(symbolIn);

  const debugLog: DebugLine[] = [];
  const perCall = Math.max(2000, Number(process.env.PLAN_PER_CALL_TIMEOUT_MS ?? 8000));

  async function withTimeout<T>(p:Promise<T>,ms:number){ return await Promise.race([p,new Promise<T>((_,r)=>setTimeout(()=>r(new Error("timeout") as any),ms))]); }

  // ── TwelveData
  const tdKey = !!process.env.TWELVEDATA_API_KEY;
  let result: Candle[] = [];
  if (tdKey) {
    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", mapTf(tf,"td"));
    url.searchParams.set("outputsize", String(n));
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("apikey", String(process.env.TWELVEDATA_API_KEY));
    try {
      const r = await withTimeout(fetch(url.toString(), { cache:"no-store" }), perCall);
      const j: any = r.ok ? await r.json() : null;
      const values:any[] = Array.isArray(j?.values) ? j.values : [];
      result = values.map(v=>({ t: Math.floor(Date.parse(v?.datetime??"")/1000), o:Number(v?.open), h:Number(v?.high), l:Number(v?.low), c:Number(v?.close) })).filter(ok);
      debugLog.push({ provider:"twelvedata", tried:true, keyPresent:true, url:url.toString(), status:r.status, count:result.length });
    } catch (e:any) {
      debugLog.push({ provider:"twelvedata", tried:true, keyPresent:true, note:e?.message });
    }
  } else {
    debugLog.push({ provider:"twelvedata", tried:false, keyPresent:false, note:"no key" });
  }

  // ── Polygon (forex only)
  if (!result.length) {
    const pgKey = !!process.env.POLYGON_API_KEY;
    if (pgKey) {
      const pgSym = "C:" + symbol.replace("/","");
      const mult = mapTf(tf,"polygon");
      const url = new URL(`https://api.polygon.io/v2/aggs/ticker/${pgSym}/range/${mult}/minute/now-14d/now`);
      url.searchParams.set("limit", String(n));
      url.searchParams.set("adjusted", "true");
      url.searchParams.set("sort", "desc");
      url.searchParams.set("apiKey", String(process.env.POLYGON_API_KEY));
      try {
        const r = await withTimeout(fetch(url.toString(), { cache:"no-store" }), perCall);
        const j: any = r.ok ? await r.json() : null;
        const arr:any[] = Array.isArray(j?.results) ? j.results : [];
        result = arr.map(r=>({ t:Math.floor(Number(r?.t)/1000), o:Number(r?.o), h:Number(r?.h), l:Number(r?.l), c:Number(r?.c) })).filter(ok);
        debugLog.push({ provider:"polygon", tried:true, keyPresent:true, url:url.toString(), status:r.status, count:result.length });
      } catch (e:any) {
        debugLog.push({ provider:"polygon", tried:true, keyPresent:true, note:e?.message });
      }
    } else {
      debugLog.push({ provider:"polygon", tried:false, keyPresent:false, note:"no key" });
    }
  }

  // ── Finnhub (forex only)
  if (!result.length) {
    const fhKey = !!process.env.FINNHUB_API_KEY;
    if (fhKey) {
      const finSym = `OANDA:${symbol.replace("/","_")}`;
      const minutes = Number(mapTf(tf,"finnhub"));
      const to = Math.floor(Date.now()/1000);
      const from = to - 14*24*3600;
      const url = new URL("https://finnhub.io/api/v1/forex/candle");
      url.searchParams.set("symbol", finSym);
      url.searchParams.set("resolution", String(minutes));
      url.searchParams.set("from", String(from));
      url.searchParams.set("to", String(to));
      url.searchParams.set("token", String(process.env.FINNHUB_API_KEY));
      try {
        const r = await withTimeout(fetch(url.toString(), { cache:"no-store" }), perCall);
        const j: any = r.ok ? await r.json() : null;
        const out: Candle[] = (j?.s==="ok" && Array.isArray(j?.t))
          ? j.t.map((t:number,i:number)=>({ t, o:Number(j.o[i]), h:Number(j.h[i]), l:Number(j.l[i]), c:Number(j.c[i]) }))
          : [];
        result = out.reverse().slice(0,n).filter(ok);
        debugLog.push({ provider:"finnhub", tried:true, keyPresent:true, url:url.toString(), status:r.status, count:result.length, note: j?.s });
      } catch (e:any) {
        debugLog.push({ provider:"finnhub", tried:true, keyPresent:true, note:e?.message });
      }
    } else {
      debugLog.push({ provider:"finnhub", tried:false, keyPresent:false, note:"no key" });
    }
  }

  if (debug) {
    return res.status(200).json({ symbol: symbolIn, norm: symbol, tf, n, count: result.length, candles: result, debug: debugLog });
  }
  return res.status(200).json({ symbol: symbolIn, tf, candles: result });
}
