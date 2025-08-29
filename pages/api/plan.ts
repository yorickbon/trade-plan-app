// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle } from "../../lib/prices";

/** Response types */
type PlanOk = { ok: true; text: string; conviction: number };
type PlanFail = { ok: false; reason: string };
type PlanResp = PlanOk | PlanFail;

/** Candle limits per TF */
const LIMIT_15M = 200;
const LIMIT_1H  = 360;
const LIMIT_4H  = 360;

/** Helpers */
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const getCloses = (a: Candle[]) => a.map((c) => c.c);
const getHighs  = (a: Candle[]) => a.map((c) => c.h);
const getLows   = (a: Candle[]) => a.map((c) => c.l);

/** EMA + simple trend from EMA21/EMA50 */
function ema(vals: number[], period: number): number {
  if (!vals.length) return 0;
  const k = 2 / (period + 1);
  let e = vals[0];
  for (let i = 1; i < vals.length; i++) e = (vals[i] - e) * k + e;
  return e;
}

function trendFromEMAs(closes: number[]): "UP" | "DOWN" | "FLAT" {
  if (closes.length < 55) return "FLAT";
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const last = closes[closes.length - 1] || 0;
  if (Math.abs(e21 - e50) < Math.max(1e-9, last * 0.0001)) return "FLAT";
  return e21 > e50 ? "UP" : "DOWN";
}

/** Last swing pivots (very light BOS/structure hint) */
function lastSwingHigh(lows: number[], highs: number[]): number {
  for (let i = highs.length - 1; i >= 2; i--) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2]) return highs[i];
  }
  return Math.max(...highs.slice(-30));
}

function lastSwingLow(lows: number[], highs: number[]): number {
  for (let i = lows.length - 1; i >= 2; i--) {
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2]) return lows[i];
  }
  return Math.min(...lows.slice(-30));
}

function fmtPct(v: number) {
  return `${clamp(Math.round(v), 0, 100)}%`;
}

function minutesUntil(iso: string): number {
  const now = Date.now();
  const t = new Date(iso).getTime();
  return Math.round((t - now) / 60000);
}

/** Macro keyword set to infer context from headlines when no calendar is present */
const MACRO_KEYWORDS = [
  "cpi","inflation","ppi","core","gdp","retail sales","industrial production",
  "durable goods","pmi","ism","confidence","sentiment","unemployment","jobless",
  "claims","payrolls","nfp","employment","rate decision","interest rate",
  "fomc","ecb","boe","boj","rba","boc","snb","trade balance","current account"
];

/** Render the final card */
function toCard({
  symbol, dir, entry, sl, tp1, tp2, conviction,
  tf15, tf1, tf4, shortReason, fundSummary, alignText, scenarios, invalidation, priorityBias,
  eventWatch,
}: {
  symbol: string;
  dir: "Long" | "Short";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  conviction: number;
  tf15: string;
  tf1: string;
  tf4: string;
  shortReason: string;
  fundSummary: string;
  alignText: string;
  scenarios: string[];
  invalidation: string;
  priorityBias: string;
  eventWatch: string[];
}) {
  return [
    "Quick Plan (Actionable)",
    "",
    `• Direction: ${dir}`,
    `• Entry: ${entry}`,
    `• Stop Loss: ${sl}`,
    `• Take Profit(s): TP1 ${tp1} / TP2 ${tp2}`,
    `• Conviction: ${fmtPct(conviction)}`,
    `• Short Reasoning: ${shortReason}`,
    "",
    "Full Breakdown",
    "",
    `• Technical View (HTF + Intraday): 4H=${tf4}, 1H=${tf1}, 15m=${tf15}`,
    `• Fundamental View (Calendar + Sentiment): ${fundSummary}`,
    `• Tech vs Fundy Alignment: ${alignText}`,
    "• Conditional Scenarios:",
    ...scenarios.map((s) => `  - ${s}`),
    "• Surprise Risk: unscheduled CB comments; geopolitical headlines.",
    `• Invalidation: ${invalidation}`,
    "",
    "Advanced Reasoning (Pro-Level Context)",
    "",
    `• Priority Bias (fundamentals): ${priorityBias}`,
    "• Structure Context: last swings used for SL/TP; EMA(21/50) slope for trend.",
    "• Confirmation Logic: prefer retest of broken swing / OB / FVG before continuation; avoid chasing wicks.",
    "• Fundamentals ↔ Technicals: sentiment + any calendar bias inform conviction (no blackout, warning only).",
    "• Scenario Planning: pre/post-news alternatives covered above.",
    "",
    "News / Event Watch",
    ...(eventWatch.length ? eventWatch.map((s) => `• ${s}`) : ["• No scheduled data available; using headlines only."]),
    "",
    "Notes",
    "",
    `• Symbol: ${symbol}`,
  ].join("\n");
}

/** API handler */
export default async function handler(req: NextApiRequest, res: NextApiResponse<PlanResp>) {
  // ---- INPUTS ----
  let instrument = "EURUSD";
  let headlines: any[] = [];
  let calendar: any = null;

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const fromBody = (body?.instrument ?? body?.code ?? "").toString();
    const fromQuery = (req.query.instrument ?? req.query.code ?? "").toString();
    instrument = (fromBody || fromQuery || "EURUSD").toUpperCase().replace(/\s+/g, "");
    headlines = Array.isArray(body?.headlines) ? body.headlines : [];
    calendar  = body?.calendar ?? null;
  } catch {
    const fromQuery = (req.query.instrument ?? req.query.code ?? "").toString();
    instrument = (fromQuery || "EURUSD").toUpperCase().replace(/\s+/g, "");
  }

  // ---- Candles (parallel) ----
  const [m15, h1, h4] = await Promise.all([
    getCandles(instrument, "15m", LIMIT_15M),
    getCandles(instrument, "1h",  LIMIT_1H),
    getCandles(instrument, "4h",  LIMIT_4H),
  ]);

  if (!Array.isArray(m15) || m15.length === 0) {
    return res.status(200).json({ ok: false, reason: "Missing 15m candles; cannot build execution plan" });
  }

  const closes15 = getCloses(m15), highs15 = getHighs(m15), lows15 = getLows(m15);
  const closes1  = getCloses(h1),  highs1  = getHighs(h1),  lows1  = getLows(h1);
  const closes4  = getCloses(h4),  highs4  = getHighs(h4),  lows4  = getLows(h4);

  // ---- Technical (multi-TF) ----
  const t15 = trendFromEMAs(closes15);
  const t1  = trendFromEMAs(closes1);
  const t4  = trendFromEMAs(closes4);
  const tf15 = t15.toLowerCase();
  const tf1  = t1.toLowerCase();
  const tf4  = t4.toLowerCase();

  let dir: "Long" | "Short" = "Long";
  let techScore = 50; // base
  const trendScore =
    (t15 === "UP" ? 1 : t15 === "DOWN" ? -1 : 0) +
    (t1  === "UP" ? 1 : t1  === "DOWN" ? -1 : 0) +
    (t4  === "UP" ? 1 : t4  === "DOWN" ? -1 : 0);

  if (trendScore > 0) { dir = "Long";  techScore += 10; }
  if (trendScore < 0) { dir = "Short"; techScore += 10; }

  // Light structure hint via swings
  const last = closes15[closes15.length - 1];
  const swingH = lastSwingHigh(lows15, highs15);
  const swingL = lastSwingLow(lows15, highs15);

  let shortReason = "Compression / range awaiting break";
  if (last > swingH) shortReason = "Breakout above recent swing high (momentum)";
  else if (last < swingL) shortReason = "Breakdown below recent swing low (momentum)";

  // Execution: Entry/SL/TP from 15m structure
  let entry = last;
  let stop  = dir === "Long" ? swingL : swingH;
  const minGap = last * 0.001; // ~0.1% logical gap
  if (dir === "Long" && entry - stop < minGap) stop = entry - minGap;
  if (dir === "Short" && stop - entry < minGap) stop = entry + minGap;
  const risk = Math.abs(entry - stop);
  const tp1  = dir === "Long" ? entry + risk : entry - risk;
  const tp2  = dir === "Long" ? entry + risk * 1.6 : entry - risk * 1.6;

  // ---- Fundamentals: Headlines (scores already attached by /api/news) ----
  const headlineScores: number[] = Array.isArray(headlines)
    ? headlines.map((h: any) => Number(h?.sentiment?.score ?? 0)).filter((n) => Number.isFinite(n))
    : [];
  const newsSum = headlineScores.reduce((a, b) => a + b, 0);
  const newsBias = newsSum > 0 ? 1 : newsSum < 0 ? -1 : 0;
  const newsText = newsBias > 0 ? "positive" : newsBias < 0 ? "negative" : "neutral";

  // Macro context from headlines when calendar missing
  const macroMentions: string[] = [];
  const now = Date.now();
  for (const h of Array.isArray(headlines) ? headlines : []) {
    const title = String(h?.title || "").toLowerCase();
    if (!title) continue;
    if (MACRO_KEYWORDS.some((k) => title.includes(k))) {
      const when = h?.published_at ? new Date(h.published_at).getTime() : now;
      const hoursAgo = Math.floor((now - when) / 3600000);
      macroMentions.push(`${h?.title || "(headline)"} — ${hoursAgo}h ago`);
      if (macroMentions.length >= 6) break;
    }
  }

  // ---- Calendar (optional): instrument bias + upcoming warnings (NO conviction cap)
  let instBiasScore = 0; // -5..+5 expected if provided by /api/calendar
  const eventWatch: string[] = [];

  if (calendar && calendar.ok) {
    const bias = (calendar as any)?.bias;
    instBiasScore = Number(bias?.instrument?.score || 0) || 0;

    const items: any[] = Array.isArray((calendar as any)?.items) ? (calendar as any).items : [];
    for (const e of items) {
      if (!e?.time) continue;
      if (e?.impact !== "High" && e?.impact !== "Medium") continue;
      const mins = minutesUntil(e.time);
      if (mins >= 0 && mins <= 90) {
        eventWatch.push(
          `⚠️ ${e.impact} impact: ${e.title} in ~${mins} min (${e?.currency || e?.country || ""})`
        );
      }
      if (eventWatch.length >= 4) break;
    }
  } else {
    // No calendar → show macro context derived from headlines
    if (macroMentions.length) {
      eventWatch.push("No calendar connected; macro context from recent headlines:");
      for (const m of macroMentions) eventWatch.push(`• ${m}`);
    }
  }

  // ---- Conviction model (NO blackout cap; warning only)
  let conviction = techScore;
  conviction += newsBias * 7;          // ±7 from headlines
  conviction += instBiasScore * 3;     // -5..+5 → ±15 swing
  conviction = clamp(Math.round(conviction), 20, 90);

  // Alignment sentence
  const dirForAlign = dir === "Long" ? 1 : -1;
  const fundComposite = newsBias * 0.5 + Math.sign(instBiasScore) * 0.5;
  const aligned = (dirForAlign > 0 && fundComposite >= 0) || (dirForAlign < 0 && fundComposite <= 0);
  const alignText = aligned ? "Match (fundamentals support technicals)" : "Mixed (partial or weak support)";

  // Priority bias & summary
  const priorityBias =
    instBiasScore !== 0
      ? `Calendar instrument bias ${instBiasScore > 0 ? "bullish" : "bearish"} (${instBiasScore.toFixed(1)}), headlines ${newsText}`
      : `Headlines ${newsText}, calendar bias unavailable`;

  const fundSummary =
    (calendar && calendar.ok)
      ? `Calendar bias ${instBiasScore > 0 ? "bullish" : instBiasScore < 0 ? "bearish" : "neutral"} (${instBiasScore.toFixed(1)}); headlines ${newsText}`
      : `Calendar unavailable; headlines ${newsText}`;

  // Scenarios
  const scenarios: string[] = [];
  scenarios.push(
    dir === "Long"
      ? "If price retests broken swing high / OB / FVG on 15m and holds, consider continuation long."
      : "If price retests broken swing low / OB / FVG on 15m and rejects, consider continuation short."
  );
  scenarios.push("Move to break-even at TP1; trail partials to structure after TP1.");
  if (eventWatch.length) scenarios.push("If a high-impact release is imminent, prefer confirmation after the print.");

  const invalidation =
    dir === "Long"
      ? "Clean 15m close below protective swing low or heavy acceptance below EMA50."
      : "Clean 15m close above protective swing high or heavy acceptance above EMA50.";

  const card = toCard({
    symbol: instrument,
    dir,
    entry: Number(entry.toFixed(5)),
    sl: Number(stop.toFixed(5)),
    tp1: Number(tp1.toFixed(5)),
    tp2: Number(tp2.toFixed(5)),
    conviction,
    tf15: t15.toLowerCase(),
    tf1: t1.toLowerCase(),
    tf4: t4.toLowerCase(),
    shortReason,
    fundSummary,
    alignText,
    scenarios,
    invalidation,
    priorityBias,
    eventWatch,
  });

  return res.status(200).json({ ok: true, text: card, conviction });

  // local closures use variables above
  function stopFrom(d: "Long" | "Short", price: number, sh: number, slw: number) {
    const gap = price * 0.001;
    let s = d === "Long" ? slw : sh;
    if (d === "Long" && price - s < gap) s = price - gap;
    if (d === "Short" && s - price < gap) s = price + gap;
    return s;
  }
}
