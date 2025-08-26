// pages/api/debug-twelve.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles } from '@/lib/prices';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const instrument = (req.query.instrument as string) || "EURUSD";
    const tf = (req.query.tf as "15m" | "1h" | "4h") || "15m";
    const limit = Number(req.query.limit || 5);

    const candles = await getCandles(instrument, tf, limit);
    return res.status(200).json({
      ok: true,
      instrument, tf, limit,
      count: candles.length,
      last: candles.at(-1) || null,
      first: candles[0] || null,
    });
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      stack: e?.stack || null,
    });
  }
}
