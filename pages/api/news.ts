// /pages/api/news.ts
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * NEWS API (Newsdata.io)
 * - Accepts BOTH ?currencies= and ?symbols= (comma-separated)
 * - Optional: ?hours= (default HEADLINES_SINCE_HOURS or 48)
 * - Optional: ?max= (default HEADLINES_MAX or 12; hard cap 25)
 * - Optional: ?lang= (default HEADLINES_LANG or "en")
 * - Optional: ?debug=1 (returns provider URL and hit counts)
 *
 * ENV:
 *   NEWS_API_PROVIDER = "newsdata"
 *   NEWSDATA_API_KEY
 *   HEADLINES_MAX
 *   HEADLINES_LANG
 *   HEADLINES_SINCE_HOURS
 */

type SentimentLabel = "positive" | "negative" | "neutral";

type NewsItem = {
  title: string;
  url: string;
  published_at: string; // ISO
  source?: string;
  country?: string | string[];
  language?: string;
  symbols?: string[];
  sentiment?: { score: number; label: SentimentLabel };
};

type OkResponse = {
  ok: true;
  provider: string;
  count: number;
  items: NewsItem[];
  query: any;
  debug?: any;
};
type ErrResponse = {
  ok: false;
  reason: string;
  provider?: string;
  query?: any;
  debug?: any;
};

type NewsResponse = OkResponse | ErrResponse;

const positiveWords = ["beats", "surge", "soar", "rally", "growth", "optimism", "strong", "bull", "gain"];
const negativeWords = ["miss", "fall", "drop", "slump", "recession", "fear", "weak", "bear", "loss"];

function simpleSentiment(text: string): { score: number; label: SentimentLabel } {
  const t = text.toLowerCase();
  let score = 0;
  for (const w of positiveWords) if (t.includes(w)) score += 1;
  for (const w of negativeWords) if (t.includes(w)) score -= 1;
  const label: SentimentLabel = score > 0 ? "positive" : score < 0 ? "negative" : "neutral";
  return { score, label };
}

function parseList(q: string | string[] | undefined): string[] {
  if (!q) return [];
  const raw = Array.isArray(q) ? q.join(",") : String(q);
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function hoursAgoISO(hours: number) {
  const d = new Date(Date.now() - hours * 3600 * 1000);
  return d.toISOString();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<NewsResponse>) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, reason: "Method not allowed" });

  const provider = String(process.env.NEWS_API_PROVIDER || "newsdata");

  // Accept both ?currencies= and ?symbols=
  const list = parseList((req.query as any).currencies ?? (req.query as any).symbols);
  const lang = String(req.query.lang || process.env.HEADLINES_LANG || "en");
  const hours = Math.max(1, Number(req.query.hours || process.env.HEADLINES_SINCE_HOURS || 48));
  const max = Math.min(25, Math.max(1, Number(req.query.max || process.env.HEADLINES_MAX || 12)));
  const debugWanted = String(req.query.debug || "") === "1";

  const queryMeta = { list, lang, hours, max };

  try {
    if (provider !== "newsdata") {
      return res.status(200).json({ ok: false, reason: "Unsupported NEWS_API_PROVIDER", provider, query: queryMeta });
    }

    const apiKey = process.env.NEWSDATA_API_KEY;
    if (!apiKey) {
      return res.status(200).json({ ok: false, reason: "NEWSDATA_API_KEY missing", provider, query: queryMeta });
    }

    // Build a loose OR query like: (EUR OR USD) with finance keywords to reduce noise
    const tokens = list.length ? list : ["USD"];
    const q =
      "(" +
      tokens.map((s) => s.replace(/[^\w/+-]/g, "")).join(" OR ") +
      ") AND (forex OR currency OR index OR stocks OR gold OR oil OR crypto OR market)";

    const fromIso = hoursAgoISO(hours);

    // First attempt (scoped)
    const url = new URL("https://newsdata.io/api/1/news");
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("q", q);
    url.searchParams.set("language", lang);
    url.searchParams.set("from_date", fromIso.slice(0, 10)); // yyyy-mm-dd
    url.searchParams.set("page", "1");

    const providerUrl = url.toString();

    const resp = await fetch(providerUrl, { cache: "no-store" });
    if (!resp.ok) {
      return res.status(200).json({
        ok: false,
        reason: `newsdata http ${resp.status}`,
        provider,
        query: queryMeta,
        debug: debugWanted ? { providerUrl } : undefined,
      });
    }

    const data: any = await resp.json();

    // Explicit error payloads (rate limit, etc.)
    if (data?.status === "error") {
      return res.status(200).json({
        ok: false,
        reason: `newsdata error: ${data?.message ?? "unknown"}`,
        provider,
        query: queryMeta,
        debug: debugWanted ? { providerUrl } : undefined,
      });
    }

    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    let providerHits = results.length;

    const items: NewsItem[] = results.slice(0, max).map((r) => {
      const title: string = r?.title || r?.description || "";
      const sentiment = simpleSentiment(title);
      return {
        title,
        url: r?.link || r?.source_url || "",
        published_at: r?.pubDate ? new Date(r.pubDate).toISOString() : new Date().toISOString(),
        source: r?.source_id || r?.creator || r?.source || undefined,
        country: r?.country,
        language: r?.language || lang,
        symbols: tokens,
        sentiment,
      };
    });

    // Broaden-on-empty: retry once without finance keywords & from_date
    if (items.length === 0) {
      const url2 = new URL("https://newsdata.io/api/1/news");
      url2.searchParams.set("apikey", apiKey);
      url2.searchParams.set("q", "(" + tokens.map((s) => s.replace(/[^\w/+-]/g, "")).join(" OR ") + ")");
      url2.searchParams.set("language", lang);
      url2.searchParams.set("page", "1");

      const resp2 = await fetch(url2.toString(), { cache: "no-store" });
      if (resp2.ok) {
        const d2: any = await resp2.json();
        if (d2?.status === "error") {
          // keep items empty, but report reason
          return res.status(200).json({
            ok: false,
            reason: `newsdata error: ${d2?.message ?? "unknown"}`,
            provider,
            query: queryMeta,
            debug: debugWanted ? { providerUrl: url2.toString() } : undefined,
          });
        }
        const r2: any[] = Array.isArray(d2?.results) ? d2.results : [];
        providerHits = r2.length;
        for (const r of r2.slice(0, max)) {
          const title: string = r?.title || r?.description || "";
          items.push({
            title,
            url: r?.link || r?.source_url || "",
            published_at: r?.pubDate ? new Date(r.pubDate).toISOString() : new Date().toISOString(),
            source: r?.source_id || r?.creator || r?.source || undefined,
            country: r?.country,
            language: r?.language || lang,
            symbols: tokens,
            sentiment: simpleSentiment(title),
          });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      provider,
      count: items.length,
      items,
      query: queryMeta,
      debug: debugWanted ? { providerUrl, providerHits } : undefined,
    });
  } catch (err: any) {
    return res.status(200).json({
      ok: false,
      reason: err?.message || "Unknown error",
      provider,
      query: queryMeta,
    });
  }
}
