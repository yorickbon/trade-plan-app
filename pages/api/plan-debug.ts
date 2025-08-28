import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle } from "../../lib/prices";

/**
 * PLAN-DEBUG
 * - GET only
 * - Accepts instrument= OR symbol= OR code=
 * - Polls for 15m/1h/4h candles using PLAN_CANDLES_TIMEOUT_MS + PLAN_CANDLES_POLL_MS
 * - Tries slash-alias once (EURUSD -> EUR/USD) if early polls fail
 *
 * Returns:
 * { ok, instrument, codeTried, counts: {m15,h1,h4}, missing:[], samples:{...}, timings:{...} }
 */

type DebugResponse =
  | {
      ok: true;
      instrument: string;
      codeTried: string;
      counts: { m15: number; h1: number; h4: number };
      missing: string[];
      samples: {
        m15?: Candle;
        h1?: Candle;
        h4?: Candle;
      };
      timings: { totalMs: number; pollMs: number; attempts: number; usedAlt: boolean };
    }
  | { ok: false; instrument: string; codeTried: string; missing: string[]; reason: string; timings: { totalMs: number; pollMs: number; attempts: number; usedAlt: boolean } };

const LIMIT_15M = 300;
const LIMIT_H1 = 360;
const LIMIT_H4 = 360;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function altSlash(s: string) {
  if (s.includes("/") || s.length !== 6) return null;
  return `${s.slice(0, 3)}/${s.slice(3)}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<DebugResponse>) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, instrument: "", codeTried: "", missing: ["15m", "1h", "4h"], reason: "Method not allowed", timings: { totalMs: 0, pollMs: 0, attempts: 0, usedAlt: false } });

  const raw = (req.query as any).instrument ?? req.query.symbol ?? req.query.code ?? "EURUSD";
  const instrument = String(raw).toUpperCase();

  const totalMs = Math.max(1000, Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 120000));
  const pollMs = Math.max(50, Number(process.env.PLAN_CANDLES_POLL_MS ?? 200));
  const maxTries = Math.max(1, Math.floor(totalMs / pollMs));

  let code = instrument;
  let usedAlt = false;
  let m15: Candle[] = [];
  let h1: Candle[] = [];
  let h4: Candle[] = [];

  for (let i = 1; i <= maxTries; i++) {
    if (!m15.length) m15 = await getCandles(code, "15m", LIMIT_15M);
    if (!h1.length) h1 = await getCandles(code, "1h", LIMIT_H1);
    if (!h4.length) h4 = await getCandles(code, "4h", LIMIT_H4);
    if (m15.length && h1.length && h4.length) break;

    // try a single slash alias early (3rd attempt) to salvage forex normalization
    if (i === 3 && !usedAlt) {
      const alt = altSlash(code);
      if (alt) {
        code = alt;
        usedAlt = true;
      }
    }
    if (i < maxTries) await sleep(pollMs);
  }

  const missing = [
    !m15.length && "15m",
    !h1.length && "1h",
    !h4.length && "4h",
  ].filter(Boolean) as string[];

  if (missing.length) {
    return res.status(200).json({
      ok: false,
      instrument,
      codeTried: code,
      missing,
      reason: `Missing candles for ${missing.join(", ")}`,
      timings: { totalMs, pollMs, attempts: maxTries, usedAlt },
    });
  }

  return res.status(200).json({
    ok: true,
    instrument,
    codeTried: code,
    counts: { m15: m15.length, h1: h1.length, h4: h4.length },
    missing: [],
    samples: { m15: m15[0], h1: h1[0], h4: h4[0] },
    timings: { totalMs, pollMs, attempts: maxTries, usedAlt },
  });
}
