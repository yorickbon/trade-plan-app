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
  ago?: string;
};

type Ok = { ok: true; provider: string; count: number; items: NewsItem[]; query: any; debug?: any };
type Err = { ok: false; reason: string; provider?: string; query?: any; debug?: any };
type Resp = Ok | Err;

const POS = ["beats", "surge", "soar", "rally", "growth", "optimism", "strong", "bull", "gain"];
const NEG = ["miss", "fall", "drop", "slump", "recession", "fear", "weak", "bear", "loss"];

function simpleSentiment(s: string): { score: number; label: SentimentLabel } {
  const t = s.toLowerCase();
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

function fmtAgo(iso: string) {
  try {
    const dt = new Date(iso).getTime();
    const diffMs = Date.now() - dt;
    const h = Math.floor(diffMs / 3600000);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  } catch { return ""; }
}

// ---------------- instrument → tokens ----------------
function tokenizeInstrument(raw: string): string[] {
  if (!raw) return [];
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Common 6-letter FX pairs (e.g., EURUSD)
  if (/^[A-Z]{6}$/.test(s)) return [s.slice(0, 3), s.slice(3, 6)];
  // Metals / indices / crypto variants (XAUUSD, XAGUSD, BTCUSD, ETHUSD, DXY)
  if (s.length >= 6 && /^[A-Z0-9]+USD$/.test(s)) return [s.replace(/USD$/, ""), "USD"];
  if (s === "DXY") return ["USD", "DXY"];
  return [];
}

// Build a conservative, provider-friendly query (no parentheses/AND)
function buildQuery(tokens: string[]) {
  const base = ["forex", "currency", "rates", "inflation", "cpi", "gdp", "central bank", "market"];
  const bag = [...tokens, ...base]
    .map((x) => x.replace(/[^\w/+.-]/g, " ").trim())
    .filter(Boolean);
  const dedup = Array.from(new Set(bag)).slice(0, 12);
  return dedup.join(" OR ");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, reason: "Method not allowed" });

  res.setHeader("Cache-Control", "no-store");

  const prefer = String(process.env.NEWS_API_PROVIDER || "newsdata");
  const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY || "";
  const NEWS_API_KEY = process.env.NEWS_API_KEY || process.env.NEWSAPI_API_KEY || "";

  // ---- derive tokens (instrument first, then currencies/symbols) ----
  const instrument = String((req.query as any).instrument || "").trim();
  let tokens: string[] = tokenizeInstrument(instrument);

  const list = parseList((req.query as any).currencies ?? (req.query as any).symbols);
  if (!tokens.length && list.length) tokens = list.map((s) => s.toUpperCase());

  // minimal default to avoid empty query
  if (!tokens.length) tokens = ["USD"];

  const lang = String(req.query.lang || process.env.HEADLINES_LANG || "en");
  const hours = Math.max(1, Number(req.query.hours || process.env.HEADLINES_SINCE_HOURS || 48));
  const max = Math.min(25, Math.max(1, Number(req.query.max || process.env.HEADLINES_MAX || 12)));
  const debugWanted = String(req.query.debug || "") === "1";
  const queryMeta = { instrument, list, tokens, lang, hours, max };

  const q = buildQuery(tokens);
  const sinceISO = hoursAgoISO(hours);

  async function tryNewsdata() {
    if (!NEWSDATA_API_KEY) return { items: [] as NewsItem[], debug: { note: "missing NEWSDATA_API_KEY" }, error: "no-key" as string | undefined };
    const url = new URL("https://newsdata.io/api/1/news");
    url.searchParams.set("apikey", NEWSDATA_API_KEY);
    url.searchParams.set("q", q);
    url.searchParams.set("language", lang);
    url.searchParams.set("from_date", sinceISO.slice(0, 10)); // yyyy-mm-dd
    url.searchParams.set("page", "1");
    try {
      const r = await fetch(url.toString(), { cache: "no-store" });
      if (!r.ok) return { items: [], debug: { providerUrl: url.toString(), status: r.status }, error: `http ${r.status}` };
      const j: any = await r.json();
      if (j?.status === "error") return { items: [], debug: { providerUrl: url.toString(), status: "error", message: j?.message }, error: String(j?.message || "newsdata error") };
      const results: any[] = Array.isArray(j?.results) ? j.results : [];
      const items: NewsItem[] = results.slice(0, max).map((r: any) => {
        const title: string = r?.title || r?.description || "";
        const published = r?.pubDate ? new Date(r.pubDate).toISOString() : new Date().toISOString();
        return {
          title,
          url: r?.link || r?.source_url || "",
          published_at: published,
          source: r?.source_id || r?.creator || r?.source || undefined,
          country: r?.country,
          language: r?.language || lang,
          symbols: tokens,
          sentiment: simpleSentiment(title),
          ago: fmtAgo(published),
        };
      });
      return { items, debug: { providerUrl: url.toString(), providerHits: results.length } };
    } catch (e: any) {
      return { items: [], debug: { providerUrl: "newsdata", message: e?.message }, error: e?.message || "fetch error" };
    }
  }

  async function tryNewsAPI() {
    if (!NEWS_API_KEY) return { items: [] as NewsItem[], debug: { note: "missing NEWS_API_KEY" }, error: "no-key" as string | undefined };
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("apiKey", NEWS_API_KEY);
    url.searchParams.set("q", q);
    url.searchParams.set("language", lang);
    url.searchParams.set("from", sinceISO);
    url.searchParams.set("pageSize", String(max));
    url.searchParams.set("sortBy", "publishedAt");
    try {
      const r = await fetch(url.toString(), { cache: "no-store" });
      if (!r.ok) return { items: [], debug: { providerUrl: url.toString(), status: r.status }, error: `http ${r.status}` };
      const j: any = await r.json();
      if (j?.status !== "ok") return { items: [], debug: { providerUrl: url.toString(), status: j?.status, code: j?.code, message: j?.message }, error: String(j?.message || "newsapi error") };
      const arr: any[] = Array.isArray(j?.articles) ? j.articles : [];
      const items: NewsItem[] = arr.slice(0, max).map((a: any) => {
        const title: string = a?.title || a?.description || "";
        const published = a?.publishedAt ? new Date(a.publishedAt).toISOString() : new Date().toISOString();
        return {
          title,
          url: a?.url || "",
          published_at: published,
          source: a?.source?.name || undefined,
          language: lang,
          symbols: tokens,
          sentiment: simpleSentiment(title),
          ago: fmtAgo(published),
        };
      });
      return { items, debug: { providerUrl: url.toString(), providerHits: arr.length } };
    } catch (e: any) {
      return { items: [], debug: { providerUrl: "newsapi", message: e?.message }, error: e?.message || "fetch error" };
    }
  }

  // Very robust last-resort: Google News RSS (free)
  async function tryGoogleRSS() {
    const qRSS = encodeURIComponent(tokens.concat(["forex"]).join(" "));
    const url = `https://news.google.com/rss/search?q=${qRSS}&hl=${encodeURIComponent(lang)}&gl=US&ceid=US:${encodeURIComponent(lang)}`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return { items: [] as NewsItem[], debug: { providerUrl: url, status: r.status }, error: `http ${r.status}` };
      const xml = await r.text();
      const items: NewsItem[] = [];
      const re = /<item>([\s\S]*?)<\/item>/g;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = re.exec(xml)) && count < max) {
        const block = m[1];
        const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "");
        const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "").trim();
        const pub = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "").trim();
        if (title && link) {
          const published = pub ? new Date(pub).toISOString() : new Date().toISOString();
          items.push({
            title,
            url: link,
            published_at: published,
            source: "Google News",
            language: lang,
            symbols: tokens,
            sentiment: simpleSentiment(title),
            ago: fmtAgo(published),
          });
          count++;
        }
      }
      return { items, debug: { providerUrl: url, providerHits: items.length } };
    } catch (e: any) {
      return { items: [] as NewsItem[], debug: { providerUrl: "google-rss", message: e?.message }, error: e?.message || "fetch error" };
    }
  }

  try {
    const order = prefer === "newsapi" ? ["newsapi", "newsdata"] : ["newsdata", "newsapi"];
    let first: any = order[0] === "newsapi" ? await tryNewsAPI() : await tryNewsdata();
    let providerUsed = order[0];

    if (!first.items.length) {
      const second: any = order[1] === "newsapi" ? await tryNewsAPI() : await tryNewsdata();
      if (second.items.length) { providerUsed = order[1]; first = second; }
    }

    if (!first.items.length) {
      const rss = await tryGoogleRSS();
      if (rss.items.length) { providerUsed = "google-rss"; first = rss; }
    }

    if (!first.items.length) {
      return res.status(200).json({
        ok: false,
        reason: `No headlines from providers (last error: ${first.error || "none"})`,
        provider: providerUsed,
        query: queryMeta,
        debug: debugWanted ? first.debug : undefined,
      });
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
