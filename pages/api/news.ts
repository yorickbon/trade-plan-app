// pages/api/news.ts
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Trade Plan App — Headlines API (instrument-scoped, finance-focused)
 * Flow:
 *   1) Primary: Newsdata (keyword OR-query built from instrument tokens + finance terms)
 *   2) Fallback: Yahoo Finance RSS search (instrument tokens + finance terms)
 *   3) Fallback: Google News RSS search (instrument tokens + finance terms)
 *
 * Notes:
 * - Accepts GET or POST. Reads symbol|symbols|instrument|currencies from query OR body.
 * - Enforces no-store caching to prevent stale headlines on instrument switch.
 * - Returns { ok, provider, count, items, query, debug? } — contract unchanged.
 * - Lightweight RSS parser (no extra deps).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
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
type Ok = { ok: true; provider: string; count: number; items: NewsItem[]; query: any; debug?: any };
type Err = { ok: false; reason: string; provider?: string; query?: any; debug?: any };
type Resp = Ok | Err;

// ─────────────────────────────────────────────────────────────────────────────
// Cheap heuristic sentiment (non-blocking)
const POS = ["beats","surge","soar","rally","growth","optimism","strong","bull","gain","record","expand"];
const NEG = ["miss","fall","drop","slump","recession","fear","weak","bear","loss","shrink","cut"];
function simpleSentiment(s: string): { score: number; label: SentimentLabel } {
  const t = (s || "").toLowerCase();
  let score = 0;
  for (const w of POS) if (t.includes(w)) score += 1;
  for (const w of NEG) if (t.includes(w)) score -= 1;
  return { score, label: score > 0 ? "positive" : score < 0 ? "negative" : "neutral" };
}

function parseList(q: string | string[] | undefined): string[] {
  if (!q) return [];
  const raw = Array.isArray(q) ? q.join(",") : String(q);
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function hoursAgoISO(h: number) {
  return new Date(Date.now() - h * 3600 * 1000).toISOString();
}

// ── Instrument → token bag (instrument + synonyms + finance terms)
function instrumentTokens(sym: string): string[] {
  if (!sym) return [];
  const s = sym.toUpperCase().trim();

  // FX pairs like EURUSD, GBPJPY
  const fx = s.match(/^([A-Z]{3})([A-Z]{3})$/);
  if (fx) {
    const b1 = fx[1], b2 = fx[2];
    const map: Record<string, string> = {
      EUR: "euro", USD: "US dollar", GBP: "British pound", JPY: "Japanese yen",
      CHF: "Swiss franc", AUD: "Australian dollar", NZD: "New Zealand dollar",
      CAD: "Canadian dollar", CNH: "offshore yuan", CNY: "Chinese yuan",
    };
    const t1 = map[b1] || b1, t2 = map[b2] || b2;
    // Finance-scoped extras relevant to FX
    const fxFinance = ["forex","FX","currency","exchange rate","yields","central bank","inflation","CPI","PMI","jobs","GDP","FOMC","BOJ","ECB","BOE"];
    return [s, b1, b2, t1, t2, ...fxFinance];
  }

  // Metals
  if (s === "XAUUSD" || s === "GOLD" || s === "XAU") {
    return [s, "gold", "XAU", "COMEX gold", "gold price", "bullion", "precious metals", "real yields", "Treasury yields", "inflation", "CPI", "Fed", "FOMC"];
  }
  if (s === "XAGUSD" || s === "SILVER" || s === "XAG") {
    return [s, "silver", "XAG", "COMEX silver", "silver price", "precious metals", "industrial metals", "yields", "inflation", "Fed"];
  }

  // Indices
  if (s === "NAS100" || s === "NDX" || s === "US100") {
    return [s, "Nasdaq 100", "Nasdaq", "NQ", "US tech stocks", "equities", "earnings", "Treasury yields", "risk appetite", "Fed", "FOMC"];
  }
  if (s === "US30" || s === "DJI" || s === "DOW") {
    return [s, "Dow Jones", "DJIA", "YM", "US equities", "industrial stocks", "earnings", "Treasury yields", "Fed"];
  }
  if (s === "SPX" || s === "US500" || s === "SP500" || s === "SPX500") {
    return [s, "S&P 500", "SPX", "ES", "US equities", "earnings", "Treasury yields", "Fed", "FOMC", "risk appetite"];
  }
  if (s === "DAX" || s === "DE40" || s === "GER40") {
    return [s, "DAX", "German equities", "EU equities", "ECB", "Bund yields", "eurozone inflation"];
  }

  // Crypto
  if (s === "BTCUSD" || s === "BTCUSDT" || s === "BTC") {
    return [s, "Bitcoin", "BTC", "crypto", "ETF", "risk appetite", "liquidity"];
  }
  if (s === "ETHUSD" || s === "ETHUSDT" || s === "ETH") {
    return [s, "Ethereum", "ETH", "crypto", "DeFi", "staking", "ETF"];
  }

  // Fallback
  return [s, "market", "finance"];
}

// Build Newsdata query string (simple OR list, trimmed)
function buildProviderQuery(tokens: string[], maxTerms = 12) {
  const bag = tokens
    .map((s) => s.replace(/[^\w/+.-]/g, " ").trim())
    .filter(Boolean);
  const dedup = Array.from(new Set(bag)).slice(0, maxTerms);
  return dedup.join(" OR ");
}

// Minimal RSS parser (no external deps)
function parseRss(xml: string, language?: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const b of blocks) {
    const get = (tag: string) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
    };
    const title = get("title");
    const link = get("link") || get("guid");
    const pub = get("pubDate") || get("published") || get("updated") || "";
    const src = get("source") || get("dc:creator") || "";
    if (!title || !link) continue;
    items.push({
      title,
      url: link,
      published_at: pub,
      source: src || undefined,
      language,
      sentiment: simpleSentiment(title),
    });
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, reason: "Method not allowed" });
  }

  // Prevent caching to avoid stale carryover on instrument switch
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  // Inputs
  const qQuery = req.query as any;
  const qBody = (req.method === "POST" ? (req.body as any) : {}) || {};

  // Accept: symbol, symbols, instrument, currencies
  const list =
    parseList(qQuery.symbol) ||
    parseList(qQuery.symbols) ||
    parseList(qQuery.instrument) ||
    parseList(qQuery.currencies) ||
    parseList(qBody.symbol) ||
    parseList(qBody.symbols) ||
    parseList(qBody.instrument) ||
    parseList(qBody.currencies);

  const lang = String(qQuery.lang || qBody.lang || process.env.HEADLINES_LANG || "en");
  const hours = Math.max(1, Number(qQuery.hours || qBody.hours || process.env.HEADLINES_SINCE_HOURS || 48));
  const max = Math.min(25, Math.max(1, Number(qQuery.max || qBody.max || process.env.HEADLINES_MAX || 12)));
  const debugWanted = String(qQuery.debug || qBody.debug || "") === "1";

  const tokens = list.length ? list.flatMap(instrumentTokens) : instrumentTokens("USD");
  const providerQuery = buildProviderQuery(tokens);
  const sinceISO = hoursAgoISO(hours);

  const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY || "";

  // ── Primary: Newsdata
  async function tryNewsdata() {
    if (!NEWSDATA_API_KEY) {
      return { items: [] as NewsItem[], debug: { note: "missing NEWSDATA_API_KEY" }, provider: "newsdata" as const };
    }
    const url = new URL("https://newsdata.io/api/1/news");
    url.searchParams.set("apikey", NEWSDATA_API_KEY);
    url.searchParams.set("q", providerQuery);
    url.searchParams.set("language", lang);
    url.searchParams.set("from_date", sinceISO.slice(0, 10)); // yyyy-mm-dd
    url.searchParams.set("page", "1");

    try {
      const r = await fetch(url.toString(), { cache: "no-store" });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || j?.status === "error") {
        return { items: [], debug: { providerUrl: url.toString(), status: r.status, message: j?.message }, provider: "newsdata" as const };
      }
      const results: any[] = Array.isArray(j?.results) ? j.results : [];
      const items: NewsItem[] = results.slice(0, max).map((row: any) => ({
        title: row?.title || row?.description || "",
        url: row?.link || row?.url || "",
        published_at: row?.pubDate || row?.published_at || row?.date || "",
        source: row?.source_id || row?.source || "",
        country: row?.country,
        language: row?.language || lang,
        symbols: list.length ? list : undefined,
        sentiment: simpleSentiment(row?.title || ""),
      }));
      return { items, debug: { providerUrl: url.toString(), providerHits: results.length }, provider: "newsdata" as const };
    } catch (e: any) {
      return { items: [], debug: { providerUrl: "newsdata", message: e?.message }, provider: "newsdata" as const };
    }
  }

  // ── Fallback 1: Yahoo Finance RSS Search (finance-scoped keywords)
  async function tryYahooFinanceRSS() {
    // Use instrument tokens + finance words; Yahoo News search feeds Yahoo Finance when finance terms are included
    const financeScoped = [...tokens, "finance", "markets", "forex", "FX", "exchange rate"].join(" ");
    const url = `https://news.yahoo.com/rss/search?p=${encodeURIComponent(financeScoped)}`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      const xml = await r.text();
      const parsed = parseRss(xml, lang);
      // Filter to finance-looking domains or finance-related headlines (lightweight guard)
      const allow = (u: string, title: string) => {
        const L = (title || "").toLowerCase();
        return /finance|market|forex|currency|yen|dollar|nasdaq|reuters|bloomberg|invest|econom/i.test(L) ||
               /finance|money|markets|business|reuters|bloomberg|invest|wsj|ft\.com/i.test(u);
      };
      const items = parsed
        .filter((it) => allow(it.url, it.title))
        .slice(0, max)
        .map((it) => ({ ...it, symbols: list.length ? list : undefined }));
      return { items, debug: { providerUrl: url, providerHits: parsed.length }, provider: "yahoo-finance" as const };
    } catch (e: any) {
      return { items: [], debug: { providerUrl: url, message: e?.message }, provider: "yahoo-finance" as const };
    }
  }

  // ── Fallback 2: Google News RSS (finance-oriented query)
  async function tryGoogleNewsRSS() {
    // Add finance words to bias results to business/markets
    const financeScoped = [...tokens, "finance", "markets", "forex", "FX", "exchange rate"].join(" ");
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(financeScoped)}&hl=${encodeURIComponent(lang)}`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      const xml = await r.text();
      const parsed = parseRss(xml, lang);
      const allow = (u: string, title: string) => {
        const L = (title || "").toLowerCase();
        return /finance|market|forex|currency|yen|dollar|nasdaq|reuters|bloomberg|invest|econom/i.test(L) ||
               /finance|money|markets|business|reuters|bloomberg|invest|wsj|ft\.com/i.test(u);
      };
      const items = parsed
        .filter((it) => allow(it.url, it.title))
        .slice(0, max)
        .map((it) => ({ ...it, symbols: list.length ? list : undefined }));
      return { items, debug: { providerUrl: url, providerHits: parsed.length }, provider: "google-news" as const };
    } catch (e: any) {
      return { items: [], debug: { providerUrl: url, message: e?.message }, provider: "google-news" as const };
    }
  }

  // ── Orchestrate: Newsdata → Yahoo Finance RSS → Google News RSS
  const debug: any = {};
  let usedProvider: "newsdata" | "yahoo-finance" | "google-news" = "newsdata";
  let items: NewsItem[] = [];

  const p1 = await tryNewsdata();
  debug.newsdata = p1.debug;
  if (p1.items.length) {
    items = p1.items;
  } else {
    const p2 = await tryYahooFinanceRSS();
    debug.yahoo = p2.debug;
    if (p2.items.length) {
      items = p2.items;
      usedProvider = "yahoo-finance";
    } else {
      const p3 = await tryGoogleNewsRSS();
      debug.google = p3.debug;
      items = p3.items;
      usedProvider = "google-news";
    }
  }

  return res.status(200).json({
    ok: true,
    provider: usedProvider,
    count: items.length,
    items,
    query: { list, lang, hours, max, providerQuery },
    debug: debugWanted ? debug : undefined,
  });
}
