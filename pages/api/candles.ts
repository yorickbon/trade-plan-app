// /pages/api/candles.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle, type TF } from "../../lib/prices";
import { getLastSource } from "../../lib/prices";

// normalize like lib/prices does (uppercase; insert '/' for 6-char FX codes)
function normalizeSymbol(s: string): string {
  s = String(s || "EURUSD").trim().toUpperCase();
  if (s.includes("/")) return s;
  if (/^[A-Z]{6}$/.test(s)) return `${s.slice(0, 3)}/${s.slice(3)}`;
  return s;
}

type Ok = {
  ok: true;
  symbol: string;
  limit: number;
  m15: Candle[];
  h1: Candle[];
  h4: Candle[];
  counts: { m15: number; h1: number; h4: number };
  sources?: { m15?: string; h1?: string; h4?: string };
};

type Err = { ok: false; reason: string };
type Resp = Ok | Err;

const DEFAULT_LIMITS: Record<TF, number> = { "15m": 200, "1h": 360, "4h": 360 };

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, reason: "Method not allowed" });
    }

    // Inputs
    const raw =
      (req.query.instrument as string) ||
      (req.query.symbol as string) ||
      (req.query.code as string) ||
      "EURUSD";
    const symbol = normalizeSymbol(raw);

    // Optional limit override (applies to all TFs if provided)
    const lim = Number(req.query.limit || 0);
    const limit15 = lim > 0 ? Math.min(lim, 2000) : DEFAULT_LIMITS["15m"];
    const limit1h = lim > 0 ? Math.min(lim, 2000) : DEFAULT_LIMITS["1h"];
    const limit4h = lim > 0 ? Math.min(lim, 2000) : DEFAULT_LIMITS["4h"];

    // Fetch in parallel; all fallback logic lives inside lib/prices.ts
    const [m15, h1, h4] = await Promise.all([
      getCandles(symbol, "15m", limit15),
      getCandles(symbol, "1h", limit1h),
      getCandles(symbol, "4h", limit4h),
    ]);

    // Hard guarantee of shape; never return undefined
    const out15 = Array.isArray(m15) ? m15 : [];
    const out1h = Array.isArray(h1) ? h1 : [];
    const out4h = Array.isArray(h4) ? h4 : [];

    // If everything is empty, surface a friendly error (rare; means all providers + synthetic failed)
    if (!out15.length && !out1h.length && !out4h.length) {
      return res.status(200).json({
        ok: false,
        reason: `No candles available for ${symbol} (providers + synthetic fallback failed)`,
      });
    }

    const debugWanted = String(req.query.debug || "") === "1";
    const sources = debugWanted
      ? {
          m15: getLastSource(`${symbol}|15m`) || undefined,
          h1: getLastSource(`${symbol}|1h`) || undefined,
          h4: getLastSource(`${symbol}|4h`) || undefined,
        }
      : undefined;

    // Stable response
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      symbol,
      limit: lim > 0 ? lim : Math.max(limit15, limit1h, limit4h),
      m15: out15,
      h1: out1h,
      h4: out4h,
      counts: { m15: out15.length, h1: out1h.length, h4: out4h.length },
      sources,
    });
  } catch (e: any) {
    return res.status(200).json({ ok: false, reason: e?.message || "candles error" });
  }
}
