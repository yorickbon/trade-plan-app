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

type Ok = { ok: true; provider: string; count: number; items: NewsItem[]; query: any; debug?: any };
type Err = { ok: false; reason: string; provider?: string; query?: any; debug?: any };
type Resp = Ok | Err;

// ─────────────────────────────────────────────────────────────────────────────
// Simple heuristic sentiment for headline text (cheap/informal)
const POS = ["beats", "surge", "soar", "rally", "growth", "optimism", "strong", "bull", "gain"];
const NEG = ["miss", "fall", "drop", "slump", "recession", "fear", "weak", "bear", "loss"];
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

// Expand a single symbol/instrument into a richer token bag for “q”
function instrumentTokens(sym: string): string[] {
  if (!sym) return [];
  const s = sym.toUpperCase().trim();

  // Currency pairs (EURUSD, GBPJPY, USDJPY, etc.)
  const fx = s.match(/^([A-Z]{3})([A-Z]{3})$/);
  if (fx) {
    const b1 = fx[1], b2 = fx[2];
    const map: Record<string, string> = {
      EUR: "euro",
      USD: "US dollar",
      GBP: "British pound",
      JPY: "Japanese yen",
      CHF: "Swiss franc",
      AUD: "Australian dollar",
      NZD: "New Zealand dollar",
      CAD: "Canadian dollar",
      CNH: "offshore yuan",
      CNY: "Chinese yuan",
    };
    const t1 = map[b1] || b1, t2 = map[b2] || b2;
    return [s, b1, b2, t1, t2, "forex", "FX", "currency"];
  }

  // Metals/commodities
  if (s === "XAUUSD" || s === "GOLD" || s === "XAU") {
    return [s, "gold", "XAU", "COMEX gold", "bullion", "precious metals"];
  }
  if (s === "XAGUSD" || s === "SILVER" || s === "XAG") {
    return [s, "silver", "XAG", "COMEX silver", "precious metals"];
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

  // Crypto (basic)
  if (s === "BTCUSD" || s === "BTCUSDT" || s === "BTC") {
    return [s, "Bitcoin", "BTC", "crypto"];
  }
  if (s === "ETHUSD" || s === "ETHUSDT" || s === "ETH") {
    return [s, "Ethereum", "ETH", "crypto"];
  }

  // Fallback: use the raw symbol
  return [s];
}

// Build a conservative, provider-friendly query (no parentheses/AND)
function buildQuery(tokens: string[]) {
  const base = ["forex", "currency", "rates", "inflation", "cpi", "gdp", "central bank", "market"];
  const bag = [...tokens, ...base]
    .map((s) => s.replace(/[^\w/+.-]/g, " ").trim())
    .filter(Boolean);
  // limit length to avoid 414/422
  const dedup = Array.from(new Set(bag)).slice(0, 12);
  return dedup.join(" OR ");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  // Accept GET or POST
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, reason: "Method not allowed" });
  }

  // Always prevent caching (avoid stale instrument carryover)
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  const prefer = String(process.env.NEWS_API_PROVIDER || "newsdata");
  const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY || "";
  const NEWS_API_KEY = process.env.NEWS_API_KEY || process.env.NEWSAPI_API_KEY || "";

  // Read params from query and/or body
  const qQuery = req.query as any;
  const qBody = (req.method === "POST" ? (req.body as any) : {}) || {};

  // Accept: symbol, symbols, instrument, currencies (any)
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
  const queryMeta = { list, lang, hours, max };

  // Token bag
  const tokens =
    list.length > 0
      ? list.flatMap(instrumentTokens)
      : instrumentTokens("USD"); // safe default

  const q = buildQuery(tokens);
  const sinceISO = hoursAgoISO(hours);

  // ───────────────────────────────────────────────────────────────────────────
  async function tryNewsdata() {
    if (!NEWSDATA_API_KEY) return { items: [] as NewsItem[], debug: { note: "missing NEWSDATA_API_KEY" }, error: "no-key" as string | undefined };
    const url = new URL("https://newsdata.io/api/1/news");
    url.searchParams.set("apikey", NEWSDATA_API_KEY);
    url.searchParams.set("q", q);                 // simple OR query
    url.searchParams.set("language", lang);
    url.searchParams.set("from_date", sinceISO.slice(0, 10)); // yyyy-mm-dd
    url.searchParams.set("page", "1");
    try {
      const r = await fetch(url.toString(), { cache: "no-store" });
      if (!r.ok) return { items: [], debug: { providerUrl: url.toString(), status: r.status }, error: `http ${r.status}` };
      const j: any = await r.json();
      if (j?.status === "error") return { items: [], debug: { providerUrl: url.toString(), message: j?.message }, error: String(j?.message || "newsdata error") };
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
          source: src,
          country: r?.country,
          language: r?.language || lang,
          symbols: list.length ? list : undefined,
          sentiment: simpleSentiment(title),
        };
      });
      return { items, debug: { providerUrl: url.toString(), providerHits: results.length } };
    } catch (e: any) {
      return { items: [], debug: { providerUrl: "newsdata", message: e?.message }, error: e?.message || "fetch error" };
    }
  }

  async function tryNewsAPI() {
    if (!NEWS_API_KEY) return { items: [] as NewsItem[], debug: { note: "missing NEWS_API_KEY" }, error: "no-key" as string | undefined };
    // 'everything' endpoint for keyword query
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("apiKey", NEWS_API_KEY);
    url.searchParams.set("q", q);
    url.searchParams.set("language", lang);
    url.searchParams.set("from", sinceISO);
    url.searchParams.set("sortBy", "publishedAt");
    url.searchParams.set("pageSize", String(Math.min(50, Math.max(10, max * 2))));
    try {
      const r = await fetch(url.toString(), { cache: "no-store" });
      if (!r.ok) return { items: [], debug: { providerUrl: url.toString(), status: r.status }, error: `http ${r.status}` };
      const j: any = await r.json();
      const results: any[] = Array.isArray(j?.articles) ? j.articles : [];
      const items: NewsItem[] = results.slice(0, max).map((a: any) => {
        const title: string = a?.title || a?.description || "";
        const url: string = a?.url || "";
        const published_at: string = a?.publishedAt || "";
        const src: string = a?.source?.name || "";
        return {
          title,
          url,
          published_at,
          source: src,
          language: lang,
          symbols: list.length ? list : undefined,
          sentiment: simpleSentiment(title),
        };
      });
      return { items, debug: { providerUrl: url.toString(), providerHits: results.length } };
    } catch (e: any) {
      return { items: [], debug: { providerUrl: "newsapi", message: e?.message }, error: e?.message || "fetch error" };
    }
  }

  // Try preferred provider first, then fallback
  const providerOrder = (prefer === "newsapi" ? ["newsapi", "newsdata"] : ["newsdata", "newsapi"]) as const;
  let first: { items: NewsItem[]; debug?: any; error?: string } = { items: [] };
  let providerUsed = providerOrder[0];

  try {
    first = providerOrder[0] === "newsdata" ? await tryNewsdata() : await tryNewsAPI();
    if (!first.items.length) {
      const second = providerOrder[1] === "newsdata" ? await tryNewsdata() : await tryNewsAPI();
      if (second.items.length) {
        first = second;
        providerUsed = providerOrder[1];
      }
    }

    return res.status(200).json({
      ok: true,
      provider: providerUsed,
      count: first.items.length,
      items: first.items,
      query: queryMeta,
      debug: debugWanted ? first.debug : undefined,
    });
  } catch (err: any) {
    return res.status(200).json({ ok: false, reason: err?.message || "Unknown error", provider: prefer, query: queryMeta });
  }
}
