// pages/api/candles.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles } from "../../lib/prices";

// Lightweight in-process cache (per region)
type CandlesBundle = { symbol: string; h4: any[]; h1: any[]; m15: any[] };
const CACHE_MS = 1000 * 60; // 60s
const g = global as unknown as { __CANDLE_CACHE?: Map<string, { t: number; v: CandlesBundle }> };
if (!g.__CANDLE_CACHE) g.__CANDLE_CACHE = new Map();

function cacheKey(symbol: string, h4n: number, h1n: number, m15n: number) {
  return JSON.stringify({ symbol, h4n, h1n, m15n });
}
function get(key: string) {
  const hit = g.__CANDLE_CACHE!.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_MS) { g.__CANDLE_CACHE!.delete(key); return null; }
  return hit.v;
}
function set(key: string, v: CandlesBundle) {
  g.__CANDLE_CACHE!.set(key, { t: Date.now(), v });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const symbol = (req.query.symbol as string) || "";
    if (!symbol) return res.status(400).json({ error: "symbol is required, e.g. EURUSD, XAUUSD, NAS100" });

    const h4n = parseInt(((req.query.h4 as string) ?? "200"), 10);
    const h1n = parseInt(((req.query.h1 as string) ?? "200"), 10);
    const m15n = parseInt(((req.query.m15 as string) ?? "200"), 10);

    const key = cacheKey(symbol, h4n, h1n, m15n);
    const cached = get(key);
    if (cached) {
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=60");
      return res.status(200).json(cached);
    }

    const [h4, h1, m15] = await Promise.all([
      getCandles(symbol, "4h", h4n),
      getCandles(symbol, "1h", h1n),
      getCandles(symbol, "15m", m15n),
    ]);

    const payload: CandlesBundle = { symbol, h4, h1, m15 };
    set(key, payload);

    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=60");
    return res.status(200).json(payload);
  } catch (err: any) {
    console.error("candles error", err);
    return res.status(500).json({ error: err?.message || "candles failed" });
  }
}
