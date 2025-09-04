// pages/api/news.ts
import type { NextApiRequest, NextApiResponse } from "next";

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
// Simple heuristic sentiment (cheap & fast, non-blocking)
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

// ── Instrument → token bag (used for provider queries / RSS keywords)
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
    return [s, b1, b2, t1, t2, "forex", "FX", "currency", "exchange rate"];
  }

  // Metals
  if (s === "XAUUSD" || s === "GOLD" || s === "XAU") {
    return [s, "gold", "XAU", "COMEX gold", "gold price", "bullion", "precious metals"];
  }
  if (s === "XAGUSD" || s === "SILVER" || s === "XAG") {
    return [s, "silver", "XAG", "COMEX silver", "silver price", "precious metals"];
  }

  // Indices
  if (s === "NAS100" || s === "NDX" || s === "US100") {
    return [s, "Nasdaq 100", "Nasdaq", "NQ", "US tech stocks", "equities"];
  }
  if (s === "US30" || s === "DJI" || s === "DOW") {
    return [s, "Dow Jones", "DJIA", "YM", "US equities"];
  }
  if (s === "SPX" || s === "US500" || s === "SP500" || s === "SPX500") {
    return [s, "S&P 500", "SPX", "ES", "US equities"];
  }
  if (s === "DAX" || s === "DE40" || s === "GER40") {
    return [s, "DAX", "German equities", "EU equities"];
  }

  // Crypto
  if (s === "BTCUSD" || s === "BTCUSDT" || s === "BTC") {
    return [s, "Bitcoin", "BTC", "crypto"];
  }
  if (s === "ETHUSD" || s === "ETHUSDT" || s === "ETH") {
    return [s, "Ethereum", "ETH", "crypto"];
  }

  // Fallback
  return [s];
}

// Build Newsdata/NewsAPI query string (simple OR list)
const MACRO_BASE = ["forex","currency","rates","inflation","cpi","gdp","central bank","market","economy","yields","PMI","jobs"];
function buildQuery(tokens: string[]) {
  const bag = [...tokens, ...MACRO_BASE]
    .map((s) => s.replace(/[^\w/+.-]/g, " ").trim())
    .filter(Boolean);
  const dedup = Array.from(new Set(bag)).slice(0, 12);
  return dedup.join(" OR ");
}

// Minimal RSS parser (no external deps). Extracts a few fields safely.
function parseRss(xml: string, language?: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1); // skip header before first <item>
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

  // Prevent caching to avoid stale carryover between instruments
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
  const q = buildQuery(tokens);
  const sinceISO = hoursAgoISO(hours);

  const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY || "";

  // ── Primary: Newsdata
  async function tryNewsdata() {
    if (!NEWSDATA_API_KEY) {
      return { items: [] as NewsItem[], debug: { note: "missing NEWSDATA_API_KEY" }, provider: "newsdata" as const };
    }
    const url = new URL("https://newsdata.io/api/1/news");
    url.searchParams.set("apikey", NEWSDATA_API_KEY);
    url.searchParams.set("q", q);
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
      const items: NewsItem[] = results.slice(0, max).map((r: any) => {
        const title: string = r?.title || r?.description || "";
        const url: string = r?.link || r?.url || "";
        const published_at: string = r?.pubDate || r?.published_at || r?.date || "";
        const src: string = r?.source_id || r?.source || "";
        return {
          title,
          url,
          published_at,
          source: src || undefined,
          country: r?.country,
          language: r?.language || lang,
          symbols: list.length ? list : undefined,
          sentiment: simpleSentiment(title),
        };
      });
      return { items, debug: { providerUrl: url.toString(), providerHits: results.length }, provider: "newsdata" as const };
    } catch (e: any) {
      return { items: [], debug: { providerUrl: "newsdata", message: e?.message }, provider: "newsdata" as const };
    }
  }

  // ── Fallback 1: Yahoo News RSS
  async function tryYahooRSS() {
    // Yahoo news search RSS endpoint
    // Example: https://news.yahoo.com/rss/search?p=EURUSD
    const query = encodeURIComponent(tokens.join(" "));
    const url = `https://news.yahoo.com/rss/search?p=${query}`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      const xml = await r.text();
      const items = parseRss(xml, lang).slice(0, max).map((it) => ({
        ...it,
        symbols: list.length ? list : undefined,
      }));
      return { items, debug: { providerUrl: url, providerHits: items.length }, provider: "yahoo" as const };
    } catch (e: any) {
      return { items: [], debug: { providerUrl: url, message: e?.message }, provider: "yahoo" as const };
    }
  }

  // ── Fallback 2: Google News RSS
  async function tryGoogleNewsRSS() {
    // Google News RSS search endpoint
    // Example: https://news.google.com/rss/search?q=EURUSD&hl=en
    const qAll = encodeURIComponent(tokens.join(" "));
    const url = `https://news.google.com/rss/search?q=${qAll}&hl=${encodeURIComponent(lang)}`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      const xml = await r.text();
      const items = parseRss(xml, lang).slice(0, max).map((it) => ({
        ...it,
        symbols: list.length ? list : undefined,
      }));
      return { items, debug: { providerUrl: url, providerHits: items.length }, provider: "google-news" as const };
    } catch (e: any) {
      return { items: [], debug: { providerUrl: url, message: e?.message }, provider: "google-news" as const };
    }
  }

  // ── Orchestration: Newsdata → Yahoo → Google
  const debug: any = {};
  let usedProvider: "newsdata" | "yahoo" | "google-news" = "newsdata";
  let items: NewsItem[] = [];

  const p1 = await tryNewsdata();
  debug.newsdata = p1.debug;
  if (p1.items.length) {
    items = p1.items;
  } else {
    const p2 = await tryYahooRSS();
    debug.yahoo = p2.debug;
    if (p2.items.length) {
      items = p2.items;
      usedProvider = "yahoo";
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
    query: { list, lang, hours, max, q },
    debug: debugWanted ? debug : undefined,
  });
}
