// pages/api/candles.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles } from "../../lib/prices";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { code, tf = "15m", limit = "200" } = (req.method === "GET" ? req.query : req.body) as any;
    if (!code) return res.status(400).json({ error: "missing code" });

    const candles = await getCandles({ code: String(code) }, tf as any, Number(limit));
    return res.status(200).json({ code, tf, count: candles.length, candles });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "failed" });
  }
}
