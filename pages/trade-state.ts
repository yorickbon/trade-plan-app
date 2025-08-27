// pages/api/trade-state.ts
import type { NextApiRequest, NextApiResponse } from "next";

type TradeState = {
  active: boolean;
  instrument?: {
    code: string;
    currencies?: string[];
  };
  levels?: {
    entry: number;
    sl: number;
    tp1: number;
    tp2?: number;
  };
};

let TRADE_STATE: TradeState = { active: false };

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    return res.status(200).json(TRADE_STATE);
  }

  if (req.method === "POST") {
    try {
      const body = JSON.parse(req.body as any);

      if (body.active === false) {
        TRADE_STATE = { active: false };
      } else {
        TRADE_STATE = {
          active: true,
          instrument: body.instrument,
          levels: body.levels,
        };
      }

      return res.status(200).json(TRADE_STATE);
    } catch (err: any) {
      return res.status(400).json({ error: "Invalid JSON body", details: err.message });
    }
  }

  return res.status(405).json({ error: "Method Not Allowed" });
}
