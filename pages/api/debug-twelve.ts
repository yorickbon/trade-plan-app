// pages/api/debug-twelve.ts
import type { NextApiRequest, NextApiResponse } from "next";
import getCandles from "../../lib/prices"; // <-- RELATIVE PATH

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const instrument = (req.query.instrument as string) || "EURUSD";
    const tf = (req.query.tf as string) || "15min";
    const limit = Number(req.query.limit ?? 5);

    const candles = await getCandles(instrument, tf as any, limit);
    return res.status(200).json({ ok: true, instrument, tf, limit, candles });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "debug error" });
  }
}
