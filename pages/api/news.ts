// pages/api/news.ts
import type { NextApiRequest, NextApiResponse } from "next";

// --- simple in-memory cache across hot reloads / lambdas ---
type CacheEntry<T> = { data: T; expires: number };
const NEWS_CACHE: Map<string, CacheEntry<any>> =
  (globalThis as any).__NEWS_CACHE__ || new Map();
(globalThis as any).__NEWS_CACHE__ = NEWS_CACHE;

function getCache<T>(key: string): T | null {
  const hit = NEWS_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    NEWS_CACHE.delete(key);
    return null;
  }
  return hit.data as T;
}

function setCache<T>(key: string, data: T, ms = 5 * 60 * 1000) {
  NEWS_CACHE.set(key, { data, expires: Date.now() + ms });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    // query to bias the headlines (instrument code, currency, etc.)
    const q = (req.query.q as string) || "";
    const sinceHours = Number(req.query.sinceHours ?? 24);

    // cache key
    const cacheKey = JSON.stringify({ q, sinceHours });
    const cached = getCache<any>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "private, max-age=120");
      return res.status(200).json(cached);
    }

    // --- GDELT doc API (free) ---
    // You can swap this to any headline provider later.
    const base = "https://api.gdeltproject.org/api/v2/doc/doc";
    // bias query: prefer macro topics + your string
    const query =
      (q ? `("${encodeURIComponent(q)}") AND ` : "") +
      '(macro OR "central bank" OR inflation OR GDP OR unemployment OR recession OR PMI OR jobs OR CPI OR rates OR yield)';

    const url = new URL(base);
    url.searchParams.set("format", "json");
    url.searchParams.set("maxrecords", "25");
    url.searchParams.set("sort", "datedesc");
    url.searchParams.set("query", query);

    // --- AbortController for timeout (20s) ---
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);

    const r = await fetch(url.toString(), {
      // no "timeout" field in RequestInit; use AbortController
      signal: controller.signal,
      headers: { "User-Agent": "trade-plan-app" },
    }).catch((err) => {
      // normalize abort into a tidy error
      if ((err as any).name === "AbortError") {
        throw new Error("Headline request timed out");
      }
      throw err;
    }) as Response;

    clearTimeout(timeoutId);

    if (!r.ok) throw new Error(`NewsData ${r.status}`);

    const data = await r.json();

    // normalize
    const items =
      (data?.articles || data?.articles?.article || data?.documents || data?.matches || data?.results || data?.articles_v2 || data?.articles_v1 || data?.articles_list || data?.articles_array || data?.articlesSet || data?.articlesFeed || data?.articlesData || data?.articlesResponse || data?.articlesOut || data?.articlesResult || data?.articlesItems || data?.articlesDocs || data?.articlesStories || data?.articlesEntries || data?.articlesItemsList || data?.articlesListItems || data?.articlesCollection || data?.articlesStream || data?.articlesObj || data?.articlesArr || data?.articlesGrouped || data?.articlesAll || data?.articlesJSON || data?.articlesRecords || data?.articlesNode || data?.articlesRecord || data?.articlesMap || data?.articlesPack || data?.articlesAnything) ??
      data?.articles ??
      data?.artList ??
      [];

    // GDELT v2 doc format typically uses `articles`
    const normalized = (data?.articles || []).map((a: any) => ({
      title: a.title,
      url: a.url,
      source: a.sourceCommonName || a.domain || a.source || "Unknown",
      seen: a.seendate || a.date || a.publishDate || "",
    }));

    const payload = { items: normalized };

    setCache(cacheKey, payload, 5 * 60 * 1000); // 5 min cache
    res.setHeader("Cache-Control", "private, max-age=120");
    return res.status(200).json(payload);
  } catch (err: any) {
    console.error("NEWS API error:", err?.message || err);
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}
