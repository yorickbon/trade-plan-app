// pages/api/calendar.ts
import type { NextApiRequest, NextApiResponse } from "next";

// Basic cache (2 min)
type CacheEntry<T> = { expires: number; data: T };
const CAL_CACHE = (globalThis as any).__CAL_CACHE__ ?? new Map<string, CacheEntry<any>>();
(globalThis as any).__CAL_CACHE__ = CAL_CACHE;

function getCache<T>(key: string): T | null {
  const hit = CAL_CACHE.get(key) as CacheEntry<T> | undefined;
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    CAL_CACHE.delete(key);
    return null;
  }
  return hit.data;
}
function setCache<T>(key: string, data: T, ttlMs = 120_000) {
  CAL_CACHE.set(key, { data, expires: Date.now() + ttlMs });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const { date, currencies = "EUR,USD,GBP" } = req.query as { date: string; currencies?: string };

    const countries = Array.from(
      new Set(
        currencies
          .split(",")
          .map((c) => c.trim().toUpperCase())
          .flatMap((c) =>
            c === "EUR"
              ? ["Euro Area", "Germany", "France", "Italy", "Spain"]
              : c === "USD"
              ? ["United States"]
              : c === "GBP"
              ? ["United Kingdom"]
              : []
          )
      )
    );

    const d1 = date || new Date().toISOString().slice(0, 10);
    const d2 = d1;

    const cacheKey = JSON.stringify({ d1, d2, countries });
    const cached = getCache<any>(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, max-age=120");
      return res.status(200).json(cached);
    }

    // TradingEconomics "guest:guest"
    const qs = new URLSearchParams({
      d1,
      d2,
      c: countries.join(","),
      format: "json",
    });
    const url = `https://api.tradingeconomics.com/calendar?${qs.toString()}`;

    const auth = Buffer.from("guest:guest").toString("base64");
    const rsp = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      cache: "no-store",
    });

    // Some regions may return 403 with guest: fallback to empty
    let items: any[] = [];
    if (rsp.ok) {
      const raw = await rsp.json();
      items =
        (raw || [])
          .filter((r: any) => !!r?.Country)
          .map((r: any) => ({
            date: r?.Date || r?.DateUtc || r?.DateOnly || d1,
            country: r?.Country,
            currency: r?.Currency || "",
            title: r?.Event || r?.Category || r?.Title || "",
            impact: r?.Importance || r?.Impact || "Medium",
            actual: r?.Actual ?? "",
            forecast: r?.Forecast ?? "",
            previous: r?.Previous ?? "",
          })) ?? [];
    }

    const payload = {
      date_from: d1,
      date_to: d2,
      countries,
      count: items.length,
      items,
    };

    setCache(cacheKey, payload, 120_000);
    res.setHeader("Cache-Control", "public, max-age=120");
    return res.status(200).json(payload);
  } catch (err: any) {
    console.error(err);
    return res.status(200).json({ date_from: "", date_to: "", countries: [], count: 0, items: [] });
  }
}
