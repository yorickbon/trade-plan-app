/**
 * CHANGE MANIFEST — /pages/api/news.ts (TS fix)
 *
 * What changed now (and why):
 * - Fixed TypeScript error for meta["cost"] by introducing a Meta interface with an optional `cost`
 *   property and assigning via `meta.cost = ...`. Reason: avoid index-signature errors under strict TS.
 *
 * Everything else remains as in the previous approved update:
 * 1) Fixed fallback chain: Newsdata → NewsAPI → Google RSS → Yahoo RSS → ContextualWeb (optional).
 * 2) Provenance in meta.sources: headlines_provider, headlines_used (<=6), headlines_instrument,
 *    headlines_error on failure.
 * 3) Bias-aware scoring hooks exposed only when debug=1.
 * 4) Instrument synonyms for relevance, dedup/clustering, freshness & source weighting.
 * 5) Resilience: timeouts, single retry with jitter; soft-fail continuation; telemetry.
 * 6) Optional cost fields when SHOW_COST=true (placeholders).
 */

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

type Ok = {
  ok: true;
  provider: string;
  count: number;
  items: NewsItem[];
  query: any;
  debug?: any;
  meta?: Meta;
};
type Err = {
  ok: false;
  reason: string;
  provider?: string;
  query?: any;
  debug?: any;
  meta?: Meta;
};
type Resp = Ok | Err;

type CostMeta = {
  prompt_tokens: number;
  completion_tokens: number;
  total_usd: number;
};

type Meta = {
  sources: {
    headlines_provider: string;
    headlines_used: number;
    headlines_instrument: string[];
    headlines_error?: string;
  };
  telemetry?: any;
  debug_scores?: any;
  cost?: CostMeta;
};

// ────────────────────────────────────────────────────────────────────────────
// Config & constants

const POS = ["beats", "surge", "soar", "rally", "growth", "optimism", "strong", "bull", "gain"];
const NEG = ["miss", "fall", "drop", "slump", "recession", "fear", "weak", "bear", "loss"];

const DEFAULT_LANG = process.env.HEADLINES_LANG || "en";
const DEFAULT_HOURS = Number(process.env.HEADLINES_SINCE_HOURS || 48);
const DEFAULT_MAX = Number(process.env.HEADLINES_MAX || 12);
const MAX_UI = 12;
const MAX_EMBED = 6;
const PROVIDER_TIMEOUT_MS = Math.max(1000, Number(process.env.HEADLINES_TIMEOUT_MS || 4000));
const SHOW_COST = String(process.env.SHOW_COST || "") === "true";

const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY || "";
const NEWS_API_KEY = process.env.NEWS_API_KEY || process.env.NEWSAPI_API_KEY || "";
const CONTEXTUALWEB_KEY = process.env.CONTEXTUALWEB_RAPIDAPI_KEY || process.env.RAPIDAPI_KEY || "";

// Domain/source weighting (lightweight)
const SOURCE_TIERS: Record<string, number> = {
  "bloomberg.com": 1.0,
  "ft.com": 1.0,
  "reuters.com": 0.95,
  "wsj.com": 0.95,
  "nytimes.com": 0.9,
  "cnbc.com": 0.9,
  "theguardian.com": 0.85,
  "apnews.com": 0.85,
};

// Instrument synonyms
const SYNONYMS: Record<string, string[]> = {
  XAU: ["xau", "gold", "bullion", "precious metal"],
  XAUUSD: ["xauusd", "gold", "bullion", "precious metal"],
  GOLD: ["gold", "xau", "bullion"],
  WTI: ["wti", "crude", "oil", "west texas", "nymex"],
  BRENT: ["brent", "crude", "oil", "ice brent"],
  DXY: ["dxy", "dollar index", "us dollar index"],
  USD: ["usd", "dollar", "greenback"],
  EURUSD: ["eurusd", "euro dollar", "euro-dollar", "euro vs dollar", "eur/usd"],
  GBPJPY: ["gbpjpy", "pound yen", "sterling yen", "gbp/jpy"],
  NAS100: ["nas100", "nasdaq 100", "nasdaq-100", "ndx", "us tech index"],
  US30: ["us30", "dow jones", "djia", "dow"],
  SPX: ["spx", "s&p 500", "sp500", "s&p500", "standard & poor"],
  XAG: ["xag", "silver"],
  BTCUSD: ["btcusd", "bitcoin", "btc", "crypto"],
};

// ────────────────────────────────────────────────────────────────────────────
// Utilities

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

function buildQuery(tokens: string[]) {
  const base = ["forex", "currency", "rates", "inflation", "cpi", "gdp", "central bank", "market"];
  const bag = [...tokens, ...base]
    .map((s) => s.replace(/[^\w/+.-]/g, " ").trim())
    .filter(Boolean);
  const dedup = Array.from(new Set(bag)).slice(0, 12);
  return dedup.join(" OR ");
}

async function fetchRetry(url: string, opts: any, timeoutMs: number, maxRetries = 1): Promise<Response> {
  const jitter = () => Math.floor(150 + Math.random() * 250);
  let lastErr: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const ac = new AbortController();
      const id = setTimeout(() => ac.abort(), timeoutMs);
      const r = await fetch(url, { ...opts, signal: ac.signal });
      clearTimeout(id);
      if (!r.ok && i < maxRetries) {
        await new Promise((res) => setTimeout(res, jitter()));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (i < maxRetries) {
        await new Promise((res) => setTimeout(res, jitter()));
        continue;
      }
      throw lastErr;
    }
  }
  // @ts-ignore
  throw lastErr || new Error("fetch failed");
}

function hostnameWeight(u: string): number {
  try {
    const h = new URL(u).hostname.replace(/^www\./, "").toLowerCase();
    return SOURCE_TIERS[h] ?? 0.8;
  } catch {
    return 0.75;
  }
}

function freshnessWeight(iso: string): number {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const hours = Math.max(0, (now - t) / 3_600_000);
  // Simple decay: <=6h → ~1.0, 24h → ~0.8, 48h → ~0.6, 72h → ~0.5
  const w = Math.max(0.4, Math.min(1, 1 - Math.log10(1 + hours) * 0.25));
  return Number.isFinite(w) ? w : 0.6;
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  const A = new Set(normalizeTitle(a).split(" "));
  const B = new Set(normalizeTitle(b).split(" "));
  const inter = [...A].filter((t) => B.has(t)).length;
  const denom = Math.max(1, Math.min(A.size, B.size));
  return inter / denom; // 0..1
}

function canonicalKey(u: string): string {
  try {
    const url = new URL(u);
    return `${url.hostname.replace(/^www\./, "").toLowerCase()}${url.pathname}`;
  } catch {
    return u.toLowerCase();
  }
}

function buildSynonymBag(list: string[]): string[] {
  const bag = new Set<string>();
  const add = (s: string) => bag.add(s.toLowerCase());
  for (const raw of list) {
    const k = raw.toUpperCase();
    add(raw);
    add(k);
    if (SYNONYMS[k]) for (const syn of SYNONYMS[k]) add(syn);
  }
  return [...bag];
}

function instrumentRelevance(title: string, synonyms: string[]): number {
  const t = title.toLowerCase();
  let hits = 0;
  for (const k of synonyms) if (t.includes(k)) hits++;
  if (!hits) return 0;
  return Math.min(1, hits / Math.max(3, synonyms.length));
}

function computeScores(item: NewsItem, synonyms: string[]) {
  const sSource = hostnameWeight(item.url);
  const sFresh = freshnessWeight(item.published_at);
  const sInstr = instrumentRelevance(item.title, synonyms);
  const sSent = (item.sentiment?.score ?? 0) === 0 ? 0.5 : item.sentiment!.score > 0 ? 0.7 : 0.7;
  const total = sInstr * 0.45 + sFresh * 0.3 + sSource * 0.2 + sSent * 0.05;
  return { instrument: sInstr, freshness: sFresh, source: sSource, sentiment: sSent, total };
}

function capForUI(items: NewsItem[], maxUI = MAX_UI): NewsItem[] {
  return items.slice(0, maxUI);
}

// ────────────────────────────────────────────────────────────────────────────
// Providers

async function tryNewsdata(q: string, lang: string, sinceISO: string, max: number, timeoutMs: number) {
  const start = Date.now();
  const telemetry: any = { provider: "newsdata", attempted: Boolean(NEWSDATA_API_KEY) };
  if (!NEWSDATA_API_KEY) {
    telemetry.last_error = "missing NEWSDATA_API_KEY";
    telemetry.latency_ms = Date.now() - start;
    return { items: [] as NewsItem[], telemetry };
  }

  const url = new URL("https://newsdata.io/api/1/news");
  url.searchParams.set("apikey", NEWSDATA_API_KEY);
  url.searchParams.set("q", q);
  url.searchParams.set("language", lang);
  url.searchParams.set("from_date", sinceISO.slice(0, 10));
  url.searchParams.set("page", "1");

  try {
    const r = await fetchRetry(url.toString(), { cache: "no-store" }, timeoutMs, 1);
    telemetry.status = r.status;
    if (!r.ok) {
      telemetry.last_error = `http ${r.status}`;
      telemetry.latency_ms = Date.now() - start;
      return { items: [], telemetry };
    }
    const j: any = await r.json();
    if (j?.status === "error") {
      telemetry.last_error = String(j?.message || "newsdata error");
      telemetry.latency_ms = Date.now() - start;
      return { items: [], telemetry };
    }
    const results: any[] = Array.isArray(j?.results) ? j.results : [];
    const items: NewsItem[] = results.slice(0, max).map((r: any) => {
      const title: string = r?.title || r?.description || "";
      const published = r?.pubDate ? new Date(r.pubDate).toISOString() : new Date().toISOString();
      const url = r?.link || r?.source_url || "";
      return {
        title,
        url,
        published_at: published,
        source: r?.source_id || r?.creator || r?.source || undefined,
        country: r?.country,
        language: r?.language || lang,
        symbols: undefined,
        sentiment: simpleSentiment(title),
      };
    });
    telemetry.hits = results.length;
    telemetry.latency_ms = Date.now() - start;
    return { items, telemetry };
  } catch (e: any) {
    telemetry.last_error = e?.message || "fetch error";
    telemetry.latency_ms = Date.now() - start;
    return { items: [], telemetry };
  }
}

async function tryNewsAPI(q: string, lang: string, sinceISO: string, max: number, timeoutMs: number) {
  const start = Date.now();
  const telemetry: any = { provider: "newsapi", attempted: Boolean(NEWS_API_KEY) };
  if (!NEWS_API_KEY) {
    telemetry.last_error = "missing NEWS_API_KEY";
    telemetry.latency_ms = Date.now() - start;
    return { items: [] as NewsItem[], telemetry };
  }

  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("apiKey", NEWS_API_KEY);
  url.searchParams.set("q", q);
  url.searchParams.set("language", lang);
  url.searchParams.set("from", sinceISO);
  url.searchParams.set("pageSize", String(MAX_UI));
  url.searchParams.set("sortBy", "publishedAt");

  try {
    const r = await fetchRetry(url.toString(), { cache: "no-store" }, timeoutMs, 1);
    telemetry.status = r.status;
    if (!r.ok) {
      telemetry.last_error = `http ${r.status}`;
      telemetry.latency_ms = Date.now() - start;
      return { items: [], telemetry };
    }
    const j: any = await r.json();
    if (j?.status !== "ok") {
      telemetry.last_error = String(j?.message || "newsapi error");
      telemetry.latency_ms = Date.now() - start;
      return { items: [], telemetry };
    }
    const arr: any[] = Array.isArray(j?.articles) ? j.articles : [];
    const items: NewsItem[] = arr.slice(0, MAX_UI).map((a: any) => {
      const title: string = a?.title || a?.description || "";
      const published = a?.publishedAt ? new Date(a.publishedAt).toISOString() : new Date().toISOString();
      const url = a?.url || "";
      return {
        title,
        url,
        published_at: published,
        source: a?.source?.name || undefined,
        language: lang,
        symbols: undefined,
        sentiment: simpleSentiment(title),
      };
    });
    telemetry.hits = arr.length;
    telemetry.latency_ms = Date.now() - start;
    return { items, telemetry };
  } catch (e: any) {
    telemetry.last_error = e?.message || "fetch error";
    telemetry.latency_ms = Date.now() - start;
    return { items: [], telemetry };
  }
}

// Google News RSS
async function tryGoogleRSS(tokens: string[], lang: string, max: number, timeoutMs: number) {
  const start = Date.now();
  const telemetry: any = { provider: "google-rss", attempted: true };
  const qRSS = encodeURIComponent(tokens.concat(["forex"]).join(" "));
  const url = `https://news.google.com/rss/search?q=${qRSS}&hl=${encodeURIComponent(lang)}&gl=US&ceid=US:${encodeURIComponent(lang)}`;
  try {
    const r = await fetchRetry(url, { cache: "no-store" }, timeoutMs, 1);
    telemetry.status = r.status;
    if (!r.ok) {
      telemetry.last_error = `http ${r.status}`;
      telemetry.latency_ms = Date.now() - start;
      return { items: [] as NewsItem[], telemetry };
    }
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
        items.push({
          title,
          url: link,
          published_at: pub ? new Date(pub).toISOString() : new Date().toISOString(),
          source: "Google News",
          language: lang,
          symbols: undefined,
          sentiment: simpleSentiment(title),
        });
        count++;
      }
    }
    telemetry.hits = items.length;
    telemetry.latency_ms = Date.now() - start;
    return { items, telemetry };
  } catch (e: any) {
    telemetry.last_error = e?.message || "fetch error";
    telemetry.latency_ms = Date.now() - start;
    return { items: [], telemetry };
  }
}

// Yahoo News RSS
async function tryYahooRSS(q: string, lang: string, max: number, timeoutMs: number) {
  const start = Date.now();
  const telemetry: any = { provider: "yahoo-rss", attempted: true };
  const url = `https://news.search.yahoo.com/rss?p=${encodeURIComponent(q)}&hl=${encodeURIComponent(lang)}`;
  try {
    const r = await fetchRetry(url, { cache: "no-store" }, timeoutMs, 1);
    telemetry.status = r.status;
    if (!r.ok) {
      telemetry.last_error = `http ${r.status}`;
      telemetry.latency_ms = Date.now() - start;
      return { items: [] as NewsItem[], telemetry };
    }
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
        items.push({
          title,
          url: link,
          published_at: pub ? new Date(pub).toISOString() : new Date().toISOString(),
          source: "Yahoo News",
          language: lang,
          symbols: undefined,
          sentiment: simpleSentiment(title),
        });
        count++;
      }
    }
    telemetry.hits = items.length;
    telemetry.latency_ms = Date.now() - start;
    return { items, telemetry };
  } catch (e: any) {
    telemetry.last_error = e?.message || "fetch error";
    telemetry.latency_ms = Date.now() - start;
    return { items: [], telemetry };
  }
}

// ContextualWeb (RapidAPI) — optional last fallback
async function tryContextualWeb(q: string, lang: string, max: number, timeoutMs: number) {
  const start = Date.now();
  const telemetry: any = {
    provider: "contextualweb",
    attempted: Boolean(CONTEXTUALWEB_KEY),
    note: "skips gracefully if no key",
  };
  if (!CONTEXTUALWEB_KEY) {
    telemetry.last_error = "missing CONTEXTUALWEB_RAPIDAPI_KEY";
    telemetry.latency_ms = Date.now() - start;
    return { items: [] as NewsItem[], telemetry };
  }

  const url = new URL("https://contextualwebsearch-websearch-v1.p.rapidapi.com/api/Search/NewsSearchAPI");
  url.searchParams.set("q", q);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", String(max));
  url.searchParams.set("autoCorrect", "true");
  url.searchParams.set("safeSearch", "false");
  url.searchParams.set("withThumbnails", "false");
  url.searchParams.set("fromPublishedDate", "");

  const headers = {
    "X-RapidAPI-Key": CONTEXTUALWEB_KEY,
    "X-RapidAPI-Host": "contextualwebsearch-websearch-v1.p.rapidapi.com",
  };

  try {
    const r = await fetchRetry(url.toString(), { headers, cache: "no-store" }, timeoutMs, 1);
    telemetry.status = r.status;
    if (!r.ok) {
      telemetry.last_error = `http ${r.status}`;
      telemetry.latency_ms = Date.now() - start;
      return { items: [], telemetry };
    }
    const j: any = await r.json();
    const arr: any[] = Array.isArray(j?.value) ? j.value : [];
    const items: NewsItem[] = arr.slice(0, max).map((a: any) => {
      const title: string = a?.title || a?.description || "";
      const url: string = a?.url || "";
      const published = a?.datePublished ? new Date(a.datePublished).toISOString() : new Date().toISOString();
      return {
        title,
        url,
        published_at: published,
        source: a?.provider?.name || undefined,
        language: lang,
        symbols: undefined,
        sentiment: simpleSentiment(title),
      };
    });
    telemetry.hits = arr.length;
    telemetry.latency_ms = Date.now() - start;
    return { items, telemetry };
  } catch (e: any) {
    telemetry.last_error = e?.message || "fetch error";
    telemetry.latency_ms = Date.now() - start;
    return { items: [], telemetry };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main handler

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  if (req.method !== "GET")
    return res.status(405).json({ ok: false, reason: "Method not allowed" });

  const list = parseList((req.query as any).currencies ?? (req.query as any).symbols);
  const lang = String(req.query.lang || DEFAULT_LANG);
  const hours = Math.max(1, Number(req.query.hours || DEFAULT_HOURS));
  const max = Math.min(MAX_UI, Math.max(1, Number(req.query.max || DEFAULT_MAX)));
  const debugWanted = String(req.query.debug || "") === "1";
  const queryMeta = { list, lang, hours, max };

  const tokens = list.length ? list : ["USD"];
  const q = buildQuery(tokens);
  const sinceISO = hoursAgoISO(hours);
  const synonyms = buildSynonymBag(tokens);

  const chainTelemetry: any[] = [];

  try {
    // Fixed fallback order: Newsdata → NewsAPI → Google RSS → Yahoo RSS → ContextualWeb
    let best: { items: NewsItem[]; telemetry: any } = await tryNewsdata(q, lang, sinceISO, max, PROVIDER_TIMEOUT_MS);
    chainTelemetry.push(best.telemetry);
    let providerUsed = "newsdata";

    if (!best.items.length) {
      const r2 = await tryNewsAPI(q, lang, sinceISO, max, PROVIDER_TIMEOUT_MS);
      chainTelemetry.push(r2.telemetry);
      if (r2.items.length) {
        providerUsed = "newsapi";
        best = r2;
      }
    }

    if (!best.items.length) {
      const r3 = await tryGoogleRSS(tokens, lang, max, PROVIDER_TIMEOUT_MS);
      chainTelemetry.push(r3.telemetry);
      if (r3.items.length) {
        providerUsed = "google-rss";
        best = r3;
      }
    }

    if (!best.items.length) {
      const r4 = await tryYahooRSS(q, lang, max, PROVIDER_TIMEOUT_MS);
      chainTelemetry.push(r4.telemetry);
      if (r4.items.length) {
        providerUsed = "yahoo-rss";
        best = r4;
      }
    }

    if (!best.items.length) {
      const r5 = await tryContextualWeb(q, lang, max, PROVIDER_TIMEOUT_MS);
      chainTelemetry.push(r5.telemetry);
      if (r5.items.length) {
        providerUsed = "contextualweb";
        best = r5;
      } else {
        providerUsed = "none";
      }
    }

    // If nothing available — soft failure with provenance
    if (!best.items.length) {
      const meta: Meta = {
        sources: {
          headlines_provider: providerUsed,
          headlines_used: 0,
          headlines_instrument: list,
          headlines_error:
            chainTelemetry.find((t) => t.last_error)?.last_error || "no headlines from providers",
        },
        telemetry: chainTelemetry,
      };
      if (SHOW_COST) {
        meta.cost = { prompt_tokens: 0, completion_tokens: 0, total_usd: 0 };
      }
      return res.status(200).json({
        ok: false,
        reason: meta.sources.headlines_error!,
        provider: providerUsed,
        query: queryMeta,
        debug: debugWanted ? { chainTelemetry } : undefined,
        meta,
      });
    }

    // Dedup / clustering
    const clusters: NewsItem[] = [];
    const clusterScores: number[] = [];
    const debugScores: any[] = [];

    for (const item of best.items) {
      const s = computeScores(item, synonyms);
      if (debugWanted) {
        debugScores.push({ url: item.url, title: item.title, scores: s });
      }
      let merged = false;
      for (let i = 0; i < clusters.length; i++) {
        const other = clusters[i];
        const sim = titleSimilarity(item.title, other.title);
        const sameCanonical = canonicalKey(item.url) === canonicalKey(other.url);
        if (sim >= 0.85 || sameCanonical) {
          if (s.total > clusterScores[i]) {
            clusters[i] = item;
            clusterScores[i] = s.total;
          }
          merged = true;
          break;
        }
      }
      if (!merged) {
        clusters.push(item);
        clusterScores.push(s.total);
      }
    }

    const sorted = clusters
      .map((it, i) => ({ item: it, score: clusterScores[i] }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          new Date(b.item.published_at).getTime() - new Date(a.item.published_at).getTime()
      )
      .map((x) => x.item);

    const itemsCapped = capForUI(sorted, max);
    const headlinesUsed = Math.min(MAX_EMBED, itemsCapped.length);

    const meta: Meta = {
      sources: {
        headlines_provider: providerUsed,
        headlines_used: headlinesUsed,
        headlines_instrument: list,
      },
      telemetry: chainTelemetry,
    };
    if (SHOW_COST) {
      meta.cost = { prompt_tokens: 0, completion_tokens: 0, total_usd: 0 };
    }
    if (debugWanted) {
      meta.debug_scores = debugScores;
    }

    return res.status(200).json({
      ok: true,
      provider: providerUsed,
      count: itemsCapped.length,
      items: itemsCapped,
      query: queryMeta,
      debug: debugWanted ? { chainTelemetry } : undefined,
      meta,
    });
  } catch (err: any) {
    const meta: Meta = {
      sources: {
        headlines_provider: "error",
        headlines_used: 0,
        headlines_instrument: list,
        headlines_error: err?.message || "Unknown error",
      },
      telemetry: { fatal: true },
    };
    if (SHOW_COST) {
      meta.cost = { prompt_tokens: 0, completion_tokens: 0, total_usd: 0 };
    }
    return res.status(200).json({
      ok: false,
      reason: err?.message || "Unknown error",
      provider: "error",
      query: { list, lang, hours, max },
      debug: debugWanted ? { error: err?.stack || String(err) } : undefined,
      meta,
    });
  }
}
