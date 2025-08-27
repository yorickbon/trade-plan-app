// pages/api/candles.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle } from "../../lib/prices";

type Data =
  | { error: string }
  | {
      symbol: string;
      frames: Record<string, Candle[]>;
    };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const symbol = (req.query.symbol as string) || "";
    if (!symbol) {
      res.status(400).json({ error: "Missing ?symbol=" });
      return;
    }

    // e.g. "4h,1h,15m"
    const intervalsRaw =
      (req.query.intervals as string) || "4h,1h,15m";
    const intervals = intervalsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as Array<"4h" | "1h" | "15m" | "5m">;

    const limit = Math.min(
      500,
      Math.max(50, Number(req.query.limit ?? 200))
    );

    const frames: Record<string, Candle[]> = {};
    await Promise.all(
      intervals.map(async (iv) => {
        frames[iv] = await getCandles(symbol, iv, limit);
      })
    );

    res.status(200).json({ symbol, frames });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Server error" });
  }
}
