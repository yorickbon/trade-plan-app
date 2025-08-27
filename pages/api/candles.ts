// pages/api/candles.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles } from "../../lib/prices";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { symbol, tf = "15m", limit = "200" } = req.query;
    if (!symbol || typeof symbol !== "string") {
      return res.status(400).json({ error: "symbol required" });
    }
    const data = await getCandles(symbol, tf as any, Number(limit));
    res.status(200).json({ items: data });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "candles failed" });
  }
}
