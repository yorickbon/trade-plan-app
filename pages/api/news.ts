// pages/api/news.ts
import type { NextApiRequest, NextApiResponse } from "next";

type NewsItem = {
  title: string;
  source: string;
  url: string;
  published_at: string; // ISO
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const provider = (process.env.NEWS_API_PROVIDER || "").toLowerCase();
    const apiKey = process.env.NEWS_API_KEY || "";

    const q = (req.query.q as string) || "forex";
    const lang = (req.query.lang as string) || process.env.HEADLINES_LANG || "en";
    const hours = parseInt((req.query.hours as string) || process.env.HEADLINES_SINCE_HOURS || "48", 10);
    const limit = parseInt((req.query.limit as string) || process.env.HEADLINES_MAX || "8", 10);

    // If no provider/key, return empty gracefully (no explosions in prod)
    if (!provider || !apiKey) {
      return res.status(200).json({ provider, q, items: [] as NewsItem[] });
    }

    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    let items: NewsItem[] = [];

    if (provider === "newsdata") {
      // Docs: https://newsdata.io/documentation
      const url = new URL("https://newsdata.io/api/1/news");
      url.searchParams.set("apikey", apiKey);
      url.searchParams.set("q", q);
      url.searchParams.set("language", lang);
      url.searchParams.set("category", "business,politics,world");
      url.searchParams.set("page", "1");

      const r = await fetch(url.toString(), { timeout: 20_000 as any });
      if (!r.ok) throw new Error(`NewsData ${r.status}`);

      const data = await r.json();

      const raw = Array.isArray(data?.results) ? data.results : [];
      items = raw
        .map((it: any) => ({
          title: String(it?.title || "").trim(),
          source: String(it?.source_id || it?.source || "Unknown"),
          url: String(it?.link || it?.url || "#"),
          published_at: new Date(it?.pubDate || it?.pub_date || Date.now()).toISOString(),
        }))
        // filter by "since"
        .filter((it: NewsItem) => new Date(it.published_at).getTime() >= new Date(since).getTime())
        .slice(0, limit);
    } else {
      // Unknown provider -> empty
      items = [];
    }

    return res.status(200).json({ provider, q, since, items });
  } catch (err: any) {
    console.error(err);
    return res.status(200).json({ provider: process.env.NEWS_API_PROVIDER || "", q: req.query.q || "", items: [] as NewsItem[] });
  }
}
