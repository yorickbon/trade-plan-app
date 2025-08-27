// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles } from "../../lib/prices";

type Candle = { t: string; o: number; h: number; l: number; c: number };

const PLAN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const G = global as any;
G.__PLAN_CACHE__ ??= new Map<string, { t: number; data: any }>();

function cacheGet(k: string) {
  const v = G.__PLAN_CACHE__.get(k);
  if (!v) return null;
  if (Date.now() - v.t > PLAN_CACHE_TTL) {
    G.__PLAN_CACHE__.delete(k);
    return null;
  }
  return v.data;
}
function cacheSet(k: string, data: any) {
  G.__PLAN_CACHE__.set(k, { t: Date.now(), data });
}

function trend(c: Candle[]): "up" | "down" | "flat" {
  if (c.length < 5) return "flat";
  const first = c[0].c,
    last = c[c.length - 1].c;
  const up = last > first * 1.002;
  const down = last < first * 0.998;
  return up ? "up" : down ? "down" : "flat";
}
function swingHL(c: Candle[]) {
  let hi = -Infinity,
    lo = Infinity;
  c.forEach((x) => {
    if (x.h > hi) hi = x.h;
    if (x.l < lo) lo = x.l;
  });
  return { hi, lo };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).end();

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const instrument = body?.instrument?.code || body?.instrument || "";
    const date = body?.date;
    const calendar = body?.calendar || { items: [] };
    const headlines = body?.headlines || { items: [] };

    if (!instrument) return res.status(400).json({ error: "instrument required" });

    const cacheKey = JSON.stringify({ instrument, date });
    const hit = cacheGet(cacheKey);
    if (hit) return res.status(200).json(hit);

    const [h4, h1, m15] = await Promise.all([
      getCandles(instrument, "4h", 200),
      getCandles(instrument, "1h", 200),
      getCandles(instrument, "15m", 200),
    ]);

    const bias15 = trend(m15);
    const biasH1 = trend(h1);
    const biasH4 = trend(h4);

    // use last ~60 bars on 15m
    const window15 = m15.slice(-60);
    const { hi, lo } = swingHL(window15);
    const impulseUp = bias15 === "up";
    const range = hi - lo;
    const fib62 = impulseUp ? hi - 0.62 * range : lo + 0.62 * range;

    const entry = Number(fib62.toFixed(5));
    const stop = Number((impulseUp ? lo : hi).toFixed(5));
    const tp1 = Number((impulseUp ? entry + range * 0.5 : entry - range * 0.5).toFixed(5));
    const tp2 = Number((impulseUp ? entry + range * 0.9 : entry - range * 0.9).toFixed(5));

    // News blackout guard
    const windowMin = parseInt(process.env.MONITOR_WINDOW_MIN || "90", 10);
    const hiEvents = (calendar?.items || []).filter((x: any) =>
      /high/i.test(x.impact || "")
    );
    const now = Date.now();
    let blackout = false;
    for (const e of hiEvents) {
      const ts = e?.date ? Date.parse(`${e.date}T${e.time || "00:00"}Z`) : NaN;
      if (!Number.isFinite(ts)) continue;
      const mins = Math.abs(ts - now) / 60000;
      if (mins <= windowMin) {
        blackout = true;
        break;
      }
    }

    const alignScore =
      (bias15 === "up" && biasH1 === "up" ? 1 : 0) +
      (bias15 === "down" && biasH1 === "down" ? 1 : 0) +
      (bias15 === "up" && biasH4 === "up" ? 1 : 0) +
      (bias15 === "down" && biasH4 === "down" ? 1 : 0);

    let conviction = 60 + alignScore * 10;
    if (blackout) conviction -= 25;
    if ((headlines?.items || []).some((h: any) =>
      /Fed|ECB|BOE|CPI|jobs|NFP|inflation/i.test(h.title || "")
    )) {
      conviction -= 10;
    }
    conviction = Math.max(5, Math.min(95, conviction));

    const planText = `**Trade Card: ${instrument}**

**Setup Type:** ${impulseUp ? "Pullback-to-62% (Bullish)" : "Pullback-to-62% (Bearish)"}
**Direction:** ${impulseUp ? "Long" : "Short"}
**Entry:** ${entry}
**Stop:** ${stop}
**TP1:** ${tp1}
**TP2:** ${tp2}
**Conviction %:** ${conviction}

**Reasoning:** 15m bias is *${bias15}* with HTF alignment H1=${biasH1}, H4=${biasH4}. Using recent swing ${
      impulseUp ? "low→high" : "high→low"
    }, targeting a ${impulseUp ? "dip" : "rally"} to 62% retracement for entry.
${blackout ? "**Caution:** High-impact event within the next news window — consider waiting for the release." : ""}`;

    const payload = { plan: { text: planText, conviction }, m15, h1, h4 };
    cacheSet(cacheKey, payload);
    return res.status(200).json(payload);
  } catch (e: any) {
    console.error("plan error:", e?.message || e);
    return res.status(500).json({ error: e?.message || "plan failed" });
  }
}
