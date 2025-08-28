// /pages/api/plan-debug.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, TF } from "../../lib/prices";

type DebugOut = {
  ok: boolean;
  instrument: string;
  codeTried: string;
  counts: { m15: number; h1: number; h4: number };
  missing: string[];
  samples?: { m15?: any; h1?: any; h4?: any };
  timings?: { totalMs: number };
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<DebugOut>) {
  try {
    const code = String(req.query.instrument || req.query.symbol || "EURUSD").toUpperCase();
    const t0 = Date.now();

    const [m15, h1, h4] = await Promise.all([
      getCandles(code, "15m", 300),
      getCandles(code, "1h", 360),
      getCandles(code, "4h", 360),
    ]);

    const counts = { m15: m15.length, h1: h1.length, h4: h4.length };
    const missing = [
      !m15.length && "15m",
      !h1.length && "1h",
      !h4.length && "4h",
    ].filter(Boolean) as string[];

    return res.status(200).json({
      ok: !missing.length,
      instrument: code,
      codeTried: code,
      counts,
      missing,
      samples: {
        m15: m15[0],
        h1:  h1[0],
        h4:  h4[0],
      },
      timings: { totalMs: Date.now() - t0 },
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      instrument: String(req.query.instrument || ""),
      codeTried: "",
      counts: { m15: 0, h1: 0, h4: 0 },
      missing: ["15m", "1h", "4h"],
    });
  }
}
