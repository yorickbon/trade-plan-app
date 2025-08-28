// /pages/api/news.ts
import type { NextApiRequest, NextApiResponse } from "next";

type SentimentLabel = "positive" | "negative" | "neutral";
type NewsItem = {
  title: string;
  url: string;
  published_at: string;
  source?: string;
  country?: string | string[];
  language?: string;
  symbols?: string[];
  sentiment?: { score: number; label: SentimentLabel };
};
type Ok = { ok:true; provider:string; count:number; items:NewsItem[]; query:any; debug?:any };
type Err = { ok:false; reason:string; provider?:string; query?:any; debug?:any };
type Resp = Ok|Err;

const positive = ["beats","surge","soar","rally","growth","optimism","strong","bull","gain"];
const negative = ["miss","fall","drop","slump","recession","fear","weak","bear","loss"];

function sentiment(s:string): {score:number; label:SentimentLabel} {
  const t=s.toLowerCase(); let sc=0; for(const w of positive) if(t.includes(w)) sc+=1; for(const w of negative) if(t.includes(w)) sc-=1;
  return { score: sc, label: sc>0?"positive":sc<0?"negative":"neutral" };
}
function parseList(q: string | string[] | undefined): string[] {
  if (!q) return []; const raw = Array.isArray(q) ? q.join(",") : String(q);
  return raw.split(",").map(s=>s.trim()).filter(Boolean);
}
function hoursAgoISO(h:number){ return new Date(Date.now()-h*3600*1000).toISOString(); }

export default async function handler(req:NextApiRequest,res:NextApiResponse<Resp>){
  if (req.method!=="GET") return res.status(405).json({ok:false,reason:"Method not allowed"});

  const prefer = String(process.env.NEWS_API_PROVIDER||"newsdata");
  const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY || "";
  const NEWS_API_KEY = process.env.NEWS_API_KEY || process.env.NEWSAPI_API_KEY || ""; // allow either name

  const list = parseList((req.query as any).currencies ?? (req.query as any).symbols);
  const lang = String(req.query.lang || process.env.HEADLINES_LANG || "en");
  const hours = Math.max(1, Number(req.query.hours || process.env.HEADLINES_SINCE_HOURS || 48));
  const max = Math.min(25, Math.max(1, Number(req.query.max || process.env.HEADLINES_MAX || 12)));
  const debugWanted = String(req.query.debug || "") === "1";
  const queryMeta = { list, lang, hours, max };

  // unified tokens for context tagging
  const tokens = list.length ? list : ["USD"];
  const financeQ = "(" + tokens.map(s => s.replace(/[^\w/+-]/g,"")).join(" OR ") + ") AND (forex OR currency OR index OR stocks OR gold OR oil OR crypto OR market)";
  const sinceISO = hoursAgoISO(hours);

  async function tryNewsdata(): Promise<{items:NewsItem[]; debug:any; error?:string}> {
    if (!NEWSDATA_API_KEY) return { items:[], debug:{note:"missing NEWSDATA_API_KEY"} };
    const url = new URL("https://newsdata.io/api/1/news");
    url.searchParams.set("apikey", NEWSDATA_API_KEY);
    url.searchParams.set("q", financeQ);
    url.searchParams.set("language", lang);
    url.searchParams.set("from_date", sinceISO.slice(0,10));
    url.searchParams.set("page", "1");
    try{
      const r = await fetch(url.toString(), { cache:"no-store" });
      if (!r.ok) return { items:[], debug:{providerUrl:url.toString(), status:r.status}, error:`http ${r.status}` };
      const j:any = await r.json();
      if (j?.status === "error") return { items:[], debug:{providerUrl:url.toString(), status:"error", message:j?.message}, error:String(j?.message||"newsdata error") };
      const results:any[] = Array.isArray(j?.results) ? j.results : [];
      const items:NewsItem[] = results.slice(0,max).map((r:any)=>{
        const title:String = r?.title || r?.description || "";
        return {
          title: String(title),
          url: r?.link || r?.source_url || "",
          published_at: r?.pubDate ? new Date(r.pubDate).toISOString() : new Date().toISOString(),
          source: r?.source_id || r?.creator || r?.source || undefined,
          country: r?.country,
          language: r?.language || lang,
          symbols: tokens,
          sentiment: sentiment(String(title)),
        };
      });
      return { items, debug:{ providerUrl:url.toString(), providerHits:results.length } };
    }catch(e:any){ return { items:[], debug:{providerUrl:"newsdata"}, error:e?.message||"fetch error" }; }
  }

  async function tryNewsAPI(): Promise<{items:NewsItem[]; debug:any; error?:string}> {
    if (!NEWS_API_KEY) return { items:[], debug:{note:"missing NEWS_API_KEY"} };
    // Use /v2/everything with from= and language=
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("apiKey", NEWS_API_KEY);
    url.searchParams.set("q", financeQ); // NewsAPI supports boolean text search
    url.searchParams.set("language", lang);
    url.searchParams.set("from", sinceISO);
    url.searchParams.set("pageSize", String(max));
    url.searchParams.set("sortBy", "publishedAt");
    try{
      const r = await fetch(url.toString(), { cache:"no-store" });
      if (!r.ok) return { items:[], debug:{providerUrl:url.toString(), status:r.status}, error:`http ${r.status}` };
      const j:any = await r.json();
      if (j?.status !== "ok") return { items:[], debug:{providerUrl:url.toString(), status:j?.status, code:j?.code, message:j?.message}, error:String(j?.message||"newsapi error") };
      const articles:any[] = Array.isArray(j?.articles) ? j.articles : [];
      const items:NewsItem[] = articles.slice(0,max).map((a:any)=>{
        const title:String = a?.title || a?.description || "";
        return {
          title: String(title),
          url: a?.url || "",
          published_at: a?.publishedAt ? new Date(a.publishedAt).toISOString() : new Date().toISOString(),
          source: a?.source?.name || undefined,
          country: undefined,
          language: lang,
          symbols: tokens,
          sentiment: sentiment(String(title)),
        };
      });
      return { items, debug:{ providerUrl:url.toString(), providerHits:articles.length } };
    }catch(e:any){ return { items:[], debug:{providerUrl:"newsapi"}, error:e?.message||"fetch error" }; }
  }

  try {
    let primary = prefer === "newsapi" ? await tryNewsAPI() : await tryNewsdata();
    let providerUsed = prefer === "newsapi" ? "newsapi" : "newsdata";

    if (primary.items.length === 0) {
      const secondary = prefer === "newsapi" ? await tryNewsdata() : await tryNewsAPI();
      if (secondary.items.length) {
        providerUsed = prefer === "newsapi" ? "newsdata" : "newsapi";
        primary = secondary;
      }
    }

    if (primary.items.length === 0) {
      return res.status(200).json({
        ok:false,
        reason:`No headlines from ${providerUsed}${primary.error?`: ${primary.error}`:""}`,
        provider: providerUsed,
        query: queryMeta,
        debug: debugWanted ? primary.debug : undefined,
      });
    }

    return res.status(200).json({
      ok:true,
      provider: providerUsed,
      count: primary.items.length,
      items: primary.items,
      query: queryMeta,
      debug: debugWanted ? primary.debug : undefined,
    });
  } catch (err:any) {
    return res.status(200).json({ ok:false, reason: err?.message || "Unknown error", provider: prefer, query: queryMeta });
  }
}
