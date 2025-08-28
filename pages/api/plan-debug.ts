// /pages/api/plan-debug.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles } from "../../lib/prices";

type Candle = { t: number; o: number; h: number; l: number; c: number };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchTF(code: string, tf: "15m"|"1h"|"4h", limit=200): Promise<Candle[]> {
  try { return await getCandles(code, tf, limit); } catch { return []; }
}
function altSymbol(code: string) {
  if (code.includes("/")) return null;
  if (code.length === 6) return `${code.slice(0,3)}/${code.slice(3)}`;
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, reason:"Method not allowed" });

  const input = String(req.query.symbol || req.query.code || "EURUSD").toUpperCase();
  const totalMs = Math.max(1000, Number(process.env.PLAN_CANDLES_TIMEOUT_MS ?? 8000));
  const pollMs  = Math.max(100,  Number(process.env.PLAN_CANDLES_POLL_MS    ?? 1000));
  const maxTries = Math.max(1, Math.floor(totalMs / pollMs));

  let code = input;
  let triedAlt: string | null = null;
  let m15: Candle[] = [], h1: Candle[] = [], h4: Candle[] = [];

  for (let i=1; i<=maxTries; i++) {
    if (!m15.length) m15 = await fetchTF(code, "15m");
    if (!h1.length)  h1  = await fetchTF(code, "1h");
    if (!h4.length)  h4  = await fetchTF(code, "4h");

    if (m15.length && h1.length && h4.length) {
      return res.status(200).json({
        ok: true,
        symbolUsed: input,
        triedAlt,
        tries: i,
        pollMs, totalMs,
        counts: { m15: m15.length, h1: h1.length, h4: h4.length },
      });
    }

    if (i === 3 && !triedAlt) {
      const alt = altSymbol(code);
      if (alt) { code = alt; triedAlt = alt; }
    }
    if (i < maxTries) await sleep(pollMs);
  }

  return res.status(200).json({
    ok: false,
    symbolUsed: input,
    triedAlt,
    tries: maxTries,
    pollMs, totalMs,
    counts: { m15: m15.length, h1: h1.length, h4: h4.length },
    missing: [
      !h4.length && "4h",
      !h1.length && "1h",
      !m15.length && "15m",
    ].filter(Boolean),
  });
}
