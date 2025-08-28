// /pages/api/candles.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles } from "../../lib/prices";

type Candle = { t:number;o:number;h:number;l:number;c:number };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const symbol = String(req.query.symbol ?? req.query.code ?? "EURUSD");
  const interval = String(req.query.interval ?? "15m") as "15m"|"1h"|"4h";
  const limit = Math.max(50, Math.min(2000, Number(req.query.limit ?? 200)));
  const debug = String(req.query.debug ?? "") === "1";

  try {
    const data: Candle[] = await getCandles(symbol, interval, limit);
    if (debug) {
      return res.status(200).json({ symbol, tf: interval, n: limit, count: data.length, candles: data });
    }
    return res.status(200).json({ symbol, tf: interval, candles: data });
  } catch (e: any) {
    if (debug) return res.status(200).json({ symbol, tf: interval, error: e?.message || "failed", candles: [] });
    return res.status(200).json({ symbol, tf: interval, candles: [] });
  }
}
