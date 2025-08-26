// pages/api/debug-twelve.ts
import type { NextApiRequest, NextApiResponse } from "next";
import getCandles from "../../lib/prices";  // ✅ fixed relative import

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { instrument, interval = "15m", bars = 5 } = req.query as {
      instrument: string;
      interval?: string;
      bars?: string;
    };

    const candles = await getCandles(instrument, interval, parseInt(bars, 10));
    res.status(200).json(candles);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}
