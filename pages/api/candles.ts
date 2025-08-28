// /pages/api/candles.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, getLastSource, TF } from "../../lib/prices";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const symbolIn = String(req.query.symbol ?? req.query.code ?? "EURUSD");
  const tf = String(req.query.interval ?? "15m") as TF;
  const n = Math.max(50, Math.min(2000, Number(req.query.limit ?? 200)));
  const debug = String(req.query.debug ?? "") === "1";

  try {
    const candles = await getCandles(symbolIn, tf, n);
    const norm = (typeof symbolIn === "string" ? symbolIn : String(symbolIn)).toUpperCase().includes("/")
      ? String(symbolIn).toUpperCase()
      : `${String(symbolIn).slice(0,3).toUpperCase()}/${String(symbolIn).slice(3).toUpperCase()}`;
    const key = `${norm}|${tf}`;
    const provider = getLastSource(key);

    if (debug) {
      return res.status(200).json({ symbol: symbolIn, norm, tf, n, count: candles.length, provider, candles });
    }
    return res.status(200).json({ symbol: symbolIn, tf, candles });
  } catch (e: any) {
    return res.status(200).json({ symbol: symbolIn, tf, candles: [], error: e?.message || "unknown" });
  }
}
