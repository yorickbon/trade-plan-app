// pages/api/news.ts
import type { NextApiRequest, NextApiResponse } from "next";

// Simple cache
type CacheEntry<T> = { expires: number; data: T };
const NEWS_CACHE = (globalThis as any).__NEWS_CACHE__ ?? new Map<string, CacheEntry<any>>();
(globalThis as any).__NEWS_CACHE__ = NEWS_CACHE;

function getCache<T>(key: string): T | null {
  const hit = NEWS_CACHE.get(key) as CacheEntry<T> | undefined;
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    NEWS_CACHE.delete(key);
    return null;
  }
  return hit.data;
}
function setCache<T>(key: string, data: T, ttlMs = 120_000) {
  NEWS_CACHE.set(key, { data, expires: Date.now() + ttlMs });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const { q = "" } = req.query as { q?: string };
    const sinceHours = 24; // last 24h
    const cacheKey = JSON.stringify({ q, sinceHours });
    const cached = getCache<any>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, max-age=120");
      return res.status(200).json(cached);
    }

    // GDELT Doc API – filter to CBs & leaders; include optional extra query terms
    const base =
      '(ECB OR "European Central Bank" OR Fed OR "Federal Reserve" OR "Bank of England" OR BoE OR Lagarde OR Powell OR "Andrew Bailey" OR "US Treasury" OR "European Commission")';
    const query = encodeURIComponent(q ? `(${base}) AND (${q})` : base);
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&maxrecords=20&format=json&sort=DateDesc`;

    const rsp = await fetch(url, { cache: "no-store" });
    if (!rsp.ok) throw new Error(`GDELT ${rsp.status}`);
    const json = await rsp.json();

    const items =
      (json?.articles || []).map((a: any) => ({
        title: a.title,
        url: a.url,
        source: a.sourceCommonName,
        seen: a.seendate, // yyyymmddhhmmss
      })) || [];

    const payload = { count: items.length, items };
    setCache(cacheKey, payload, 120_000); // 2 min
    res.setHeader("Cache-Control", "public, max-age=120");
    return res.status(200).json(payload);
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
