// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles } from "../../lib/prices";

type TF = "15m" | "1h" | "4h";
type Candle = { t: number; o: number; h: number; l: number; c: number };

type ScanDirection = "long" | "short" | "none";
type ScanResult = {
  dir: ScanDirection;
  score: number;          // 0..100
  note?: string;
};

type PlanResponse =
  | {
      ok: true;
      plan: { text: string };
      usedCalendar: any[];
      usedHeadlines: any[];
    }
  | {
      ok: false;
      reason: string;
      usedCalendar: any[];
      usedHeadlines: any[];
    };

// ---------- constants ----------
const TF_LIST: TF[] = ["15m", "1h", "4h"];
const LIMIT_15M = 200;
const LIMIT_1H = 200;
const LIMIT_4H = 200;
const PER_CALL_TIMEOUT_MS =
  Math.max(1000, Number(process.env.PLAN_PER_CALL_TIMEOUT_MS ?? 8000));

// ---------- utils ----------
function withTimeout<T>(p: Promise<T>, ms: number, tag = "task"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(
      () => reject(new Error(`${tag} timed out after ${ms}ms`)),
      ms
    );
    p.then((v) => {
      clearTimeout(id);
      resolve(v);
    }).catch((e) => {
      clearTimeout(id);
      reject(e);
    });
  });
}

// prices.ts returns newest->oldest; for some calcs we want oldest->newest
function asc(c: Candle[]): Candle[] {
  return [...c].reverse();
}

function high(arr: Candle[], from = 0, to?: number) {
  const s = to === undefined ? arr.slice(from) : arr.slice(from, to);
  return Math.max(...s.map((x) => x.h));
}
function low(arr: Candle[], from = 0, to?: number) {
  const s = to === undefined ? arr.slice(from) : arr.slice(from, to);
  return Math.min(...s.map((x) => x.l));
}
function sma(vals: number[], n: number) {
  if (vals.length < n) return null;
  let s = 0;
  for (let i = 0; i < n; i++) s += vals[i];
  return s / n;
}
function atrLike(c: Candle[], n = 14) {
  const series = asc(c);
  const trs: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i];
    const b = series[i - 1];
    const tr = Math.max(
      a.h - a.l,
      Math.abs(a.h - b.c),
      Math.abs(a.l - b.c)
    );
    trs.push(tr);
  }
  const m = sma(trs.slice(-n), Math.min(n, trs.length));
  return m ?? 0;
}

// ---------- scans (fast heuristics) ----------

// BOS on HTFs: did price close beyond prior swing extreme?
function scanBOS(h1: Candle[], h4: Candle[]): ScanResult {
  // use last 60 bars each, oldest->newest for readability
  const a1 = asc(h1).slice(-60);
  const a4 = asc(h4).slice(-60);
  if (a1.length < 30 || a4.length < 30) return { dir: "none", score: 0 };

  const last1 = a1[a1.length - 1].c;
  const last4 = a4[a4.length - 1].c;
  const hi1 = high(a1, 0, a1.length - 1);
  const lo1 = low(a1, 0, a1.length - 1);
  const hi4 = high(a4, 0, a4.length - 1);
  const lo4 = low(a4, 0, a4.length - 1);

  const up =
    last1 > hi1 * 0.999 && last4 > hi4 * 0.999 ? Math.min(
      ((last1 - hi1) / Math.max(1e-6, hi1)) * 10000,
      100
    ) : 0;
  const dn =
    last1 < lo1 * 1.001 && last4 < lo4 * 1.001 ? Math.min(
      ((lo1 - last1) / Math.max(1e-6, lo1)) * 10000,
      100
    ) : 0;

  if (up === 0 && dn === 0) return { dir: "none", score: 0 };
  if (up > dn) return { dir: "long", score: Math.min(100, Math.round(up)), note: "BOS ↑ on HTFs" };
  return { dir: "short", score: Math.min(100, Math.round(dn)), note: "BOS ↓ on HTFs" };
}

// Pullback on 15m into 1h context: simple fib-style check
function scanPullback(m15: Candle[], h1: Candle[]): ScanResult {
  const a15 = asc(m15);
  const a1 = asc(h1);
  if (a15.length < 60 || a1.length < 40) return { dir: "none", score: 0 };

  // 1h trend: compare last close vs 20-bar SMA
  const h1closes = a1.map((x) => x.c);
  const ma20 = sma(h1closes.slice(-20), Math.min(20, h1closes.length)) ?? a1[a1.length - 1].c;
  const h1Last = a1[a1.length - 1].c;
  const h1Trend: "up" | "down" =
    h1Last >= ma20 ? "up" : "down";

  // last impulsive leg on 15m (use last 30 bars)
  const seg = a15.slice(-30);
  const hi = high(seg);
  const lo = low(seg);
  const range = hi - lo || 1e-6;
  const last = seg[seg.length - 1].c;
  const pct = (last - lo) / range; // 0..1

  if (h1Trend === "up") {
    // pullback into 0.38..0.62 area from top
    const pull = 1 - pct;
    const inZone = pull >= 0.38 && pull <= 0.62;
    const score = inZone ? Math.round(70 + 30 * (1 - Math.abs(pull - 0.5) / 0.12)) : 0;
    return { dir: inZone ? "long" : "none", score, note: inZone ? "15m pullback in 1h uptrend" : undefined };
  } else {
    // downtrend: mirror logic
    const pull = pct;
    const inZone = pull >= 0.38 && pull <= 0.62;
    const score = inZone ? Math.round(70 + 30 * (1 - Math.abs(pull - 0.5) / 0.12)) : 0;
    return { dir: inZone ? "short" : "none", score, note: inZone ? "15m pullback in 1h downtrend" : undefined };
  }
}

// Range detection on 15m: compression vs ATR
function scanRange(m15: Candle[]): ScanResult {
  const a = asc(m15);
  if (a.length < 60) return { dir: "none", score: 0 };
  const last40 = a.slice(-40);
  const width = high(last40) - low(last40);
  const atr = atrLike(a, 14) || 1e-6;
  // If width is small relative to ATR -> ranging
  const ratio = width / (atr * 10); // normalize
  if (ratio < 1) {
    const score = Math.round(80 * (1 - ratio)); // tighter range -> higher score
    return { dir: "none", score, note: "15m compression/range" };
  }
  return { dir: "none", score: 0 };
}

// FVG-fill heuristic on 15m (imbalance quickly closed)
function scanFVGFill(m15: Candle[]): ScanResult {
  const a = asc(m15);
  if (a.length < 10) return { dir: "none", score: 0 };
  // lookback small window for a large candle followed by mean-reversion
  for (let i = a.length - 6; i < a.length - 1; i++) {
    if (i <= 1) continue;
    const c0 = a[i - 1], c1 = a[i], c2 = a[i + 1];
    const body = Math.abs(c1.c - c1.o);
    const span = c1.h - c1.l || 1e-6;
    const bodyRatio = body / span; // big body?
    if (bodyRatio > 0.7) {
      const reverted =
        (c1.c > c1.o && c2.l <= (c1.o + c1.c) / 2) ||
        (c1.c < c1.o && c2.h >= (c1.o + c1.c) / 2);
      if (reverted) {
        const dir: ScanDirection = c1.c > c1.o ? "short" : "long";
        const score = 60 + Math.min(40, Math.round(bodyRatio * 40));
        return { dir, score, note: "Recent FVG/impulse filled" };
      }
    }
  }
  return { dir: "none", score: 0 };
}

// Type guard used to build the scored list safely
function isScanResult(x: any): x is ScanResult {
  return !!x && typeof x.score === "number";
}

// ---------- main handler ----------
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PlanResponse>
) {
  try {
    const isGet = req.method === "GET";
    const q = isGet ? req.query : (req.body ?? {});
    const symbolRaw =
      (q.symbol ?? q.code ?? "EURUSD") as string;
    const symbol = String(symbolRaw).toUpperCase();

    // Fetch all TFs in parallel with an overall timeout
    const fetchAll = Promise.all([
      getCandles(symbol, "15m", LIMIT_15M),
      getCandles(symbol, "1h", LIMIT_1H),
      getCandles(symbol, "4h", LIMIT_4H),
    ]);

    const [m15, h1, h4] = await withTimeout(
      fetchAll,
      PER_CALL_TIMEOUT_MS,
      "candles"
    );

    // Identify any missing frames
    const missing: TF[] = [];
    if (!m15?.length) missing.push("15m");
    if (!h1?.length) missing.push("1h");
    if (!h4?.length) missing.push("4h");

    if (missing.length) {
      return res.status(200).json({
        ok: false,
        reason: `Standing down: Missing candles for ${missing.join(", ")} (symbol used: ${symbol}).`,
        usedCalendar: [],
        usedHeadlines: [],
      });
    }

    // --- Scans (Step 4)
    const bosRes = scanBOS(h1, h4);
    const pullRes = scanPullback(m15, h1);
    const rangeRes = scanRange(m15);
    const fvgRes = scanFVGFill(m15);

    // Build scored list with filtering + correct tuple type
    const rawPairs: (readonly [string, ScanResult] | null)[] = [
      isScanResult(bosRes) && bosRes.score > 0 ? ["BOS", bosRes] : null,
      isScanResult(pullRes) && pullRes.score > 0 ? ["Pullback", pullRes] : null,
      isScanResult(rangeRes) && rangeRes.score > 0 ? ["Range", rangeRes] : null,
      isScanResult(fvgRes) && fvgRes.score > 0 ? ["FVG-fill", fvgRes] : null,
    ];
    const scored: Array<[string, ScanResult]> = rawPairs.filter(
      (p): p is [string, ScanResult] => Array.isArray(p)
    );

    // Choose direction by max score (ignoring "Range" dir=none)
    const ranked = [...scored].sort((a, b) => b[1].score - a[1].score);
    let dir: ScanDirection = "none";
    for (const [, r] of ranked) {
      if (r.dir !== "none") {
        dir = r.dir;
        break;
      }
    }

    // Build human plan text
    const lines: string[] = [];
    if (dir === "none") {
      lines.push(
        "No high-conviction directional edge. Consider range tactics or stand by."
      );
    } else {
      lines.push(
        `Bias: **${dir === "long" ? "LONG" : "SHORT"}** (highest-score signal)`
      );
    }
    for (const [name, r] of ranked) {
      lines.push(
        `• ${name}: ${r.dir !== "none" ? r.dir.toUpperCase() : "neutral"} (score ${r.score})` +
          (r.note ? ` — ${r.note}` : "")
      );
    }
    // simple entry/SL/TP sketch (you can replace with your exact rules)
    const last = m15[0]; // newest
    const atr = atrLike(m15, 14) || (last.h - last.l) || 0.001;
    if (dir === "long") {
      lines.push(
        `Idea: Buy-stop above ${last.h.toFixed(5)}; SL ~${(last.h - 1.2 * atr).toFixed(5)}; TP1 ~${(last.h + 1.5 * atr).toFixed(5)}.`
      );
    } else if (dir === "short") {
      lines.push(
        `Idea: Sell-stop below ${last.l.toFixed(5)}; SL ~${(last.l + 1.2 * atr).toFixed(5)}; TP1 ~${(last.l - 1.5 * atr).toFixed(5)}.`
      );
    }

    return res.status(200).json({
      ok: true,
      plan: { text: lines.join("\n") },
      usedCalendar: [],
      usedHeadlines: [],
    });
  } catch (e: any) {
    return res.status(200).json({
      ok: false,
      reason:
        e?.message?.includes("timed out")
          ? `Server timeout while generating plan (limit ${PER_CALL_TIMEOUT_MS}ms).`
          : "Server error while generating plan.",
      usedCalendar: [],
      usedHeadlines: [],
    });
  }
}
