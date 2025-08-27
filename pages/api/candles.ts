// /pages/api/candles.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles } from "../../lib/prices";

type TF = "15m" | "1h" | "4h";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const symbol = String(req.query.symbol || req.query.code || "");
    const tf = (String(req.query.tf || "15m") as TF);
    const n = Number(req.query.n || 200);

    if (!symbol) return res.status(400).json({ error: "Missing symbol" });

    const data = await getCandles(symbol, tf, n);
    return res.status(200).json({ symbol, tf, n, candles: data });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "server error" });
  }
}
