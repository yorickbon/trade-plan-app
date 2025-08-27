// pages/api/trade-state.ts
import type { NextApiRequest, NextApiResponse } from "next";

type Instrument = { code: string; currencies?: string[] };
type Levels = { entry?: number; sl?: number; tp1?: number; tp2?: number };

type TradeState = {
  active: boolean;
  instrument?: Instrument | null;
  levels?: Levels | null;
  startedAt?: string | null;
  updatedAt?: string | null;
};

const G = global as any;
G.__TRADE_STATE__ ||= { active: false } as TradeState;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json(G.__TRADE_STATE__);
  }

  if (req.method === "POST") {
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const { active, instrument, entry, sl, tp1, tp2, levels } = body;

      if (typeof active !== "boolean") {
        return res.status(400).json({ ok: false, error: "active must be boolean" });
      }

      if (active && (!instrument || (typeof instrument === "object" && !instrument.code))) {
        return res.status(400).json({ ok: false, error: "instrument is required when starting monitor" });
      }

      const lvl: Levels =
        levels && typeof levels === "object"
          ? { entry: toNum(levels.entry), sl: toNum(levels.sl), tp1: toNum(levels.tp1), tp2: toNum(levels.tp2) }
          : { entry: toNum(entry), sl: toNum(sl), tp1: toNum(tp1), tp2: toNum(tp2) };

      if (active) {
        G.__TRADE_STATE__ = {
          active: true,
          instrument: normInstrument(instrument),
          levels: lvl,
          startedAt: G.__TRADE_STATE__?.startedAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      } else {
        G.__TRADE_STATE__ = {
          active: false,
          instrument: null,
          levels: null,
          startedAt: null,
          updatedAt: new Date().toISOString(),
        };
      }

      return res.status(200).json({ ok: true, ...G.__TRADE_STATE__ });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || "server error" });
    }
  }

  if (req.method === "DELETE") {
    G.__TRADE_STATE__ = {
      active: false,
      instrument: null,
      levels: null,
      startedAt: null,
      updatedAt: new Date().toISOString(),
    };
    return res.status(200).json({ ok: true, ...G.__TRADE_STATE__ });
  }

  res.setHeader("Allow", "GET,POST,DELETE");
  return res.status(405).json({ ok: false, error: "Method not allowed" });
}

function toNum(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}
function normInstrument(instr: any): Instrument {
  if (!instr) return { code: "" };
  if (typeof instr === "string") return { code: instr };
  const code = String(instr.code || "").trim();
  const currencies: string[] | undefined = Array.isArray(instr.currencies)
    ? instr.currencies.map((s: any) => String(s))
    : undefined;
  return { code, currencies };
}
