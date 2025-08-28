// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type TF, type Candle } from "../../lib/prices";

type TradeType = "Breakout (BOS)" | "Pullback (Limit)" | "Range Fade" | "No Trade";
type Direction = "BUY" | "SELL" | "NONE";

type PlanPayload = {
  instrument: string | { code: string };
  date?: string;
  headlines?: Array<{ title?: string; url?: string; source?: string; seen?: string }>;
  calendar?: Array<{
    impact?: string; // "High" | "Medium" | ...
    title?: string;
    country?: string;
    currency?: string;
    datetime?: string; // ISO
  }>;
};

type PlanResponse = {
  ok: boolean;
  reason?: string;
  counts?: Record<TF, number>;
  missing?: TF[];
  used?: { instrument: string; price: number; provider?: string };
  plan?: {
    type: TradeType;
    direction: Direction;
    entry: number | null;
    stop: number | null;
    tp1: number | null;
    tp2: number | null;
    conviction: number; // 0..100
    note: string;       // short rationale
    card: string;       // multiline human-readable
  };
  // optional echoes for UI
  usedHeadlines?: PlanPayload["headlines"];
  usedCalendar?: PlanPayload["calendar"];
};

// ---------- helpers ----------
const TF_LIST: TF[] = ["15m", "1h", "4h"];
const LIMIT_15M = 240; // fetch depth
const FIBS = [0.382, 0.5, 0.618, 0.705];

function latest(c: Candle[] | undefined): Candle | undefined {
  return c && c.length ? c[0] : undefined; // newest->oldest per lib/prices.ts
}

function mid(a: number, b: number) {
  return (a + b) / 2;
}

// find recent swing highs/lows over window N (on newest->oldest arrays)
function recentSwingHigh(arr: Candle[], lookback = 20): number | null {
  if (!arr.length) return null;
  let hi = -Infinity;
  for (let i = 0; i < Math.min(lookback, arr.length); i++) hi = Math.max(hi, arr[i].h);
  return Number.isFinite(hi) ? hi : null;
}
function recentSwingLow(arr: Candle[], lookback = 20): number | null {
  if (!arr.length) return null;
  let lo = Infinity;
  for (let i = 0; i < Math.min(lookback, arr.length); i++) lo = Math.min(lo, arr[i].l);
  return Number.isFinite(lo) ? lo : null;
}

// very light BOS detector: compares last closes against closes N bars back
function biasFromCloses(arr: Candle[], step: number): number {
  if (arr.length <= step) return 0;
  return arr[0].c > arr[step].c ? 1 : arr[0].c < arr[step].c ? -1 : 0;
}

// compute “recent volatility” (average true range over N) for sensible stops/targets
function atrLike(arr: Candle[], n = 14): number {
  if (arr.length < 2) return 0;
  const m = Math.min(n, arr.length - 1);
  let sum = 0;
  for (let i = 0; i < m; i++) {
    const hi = arr[i].h;
    const lo = arr[i].l;
    const pc = arr[i + 1].c; // previous close (since newest->oldest)
    const tr = Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
    sum += tr;
  }
  return sum / m;
}

// simple headline sentiment (very lightweight)
function headlineBias(headlines: PlanPayload["headlines"]): number {
  if (!Array.isArray(headlines) || !headlines.length) return 0;
  const pos = /(cooling inflation|soft landing|rate cut|dovish|risk-on|beats|surprise.*lower)/i;
  const neg = /(hot inflation|hawkish|rate hike|risk-off|misses|surprise.*higher|geopolitical|sanction|conflict)/i;
  let score = 0;
  for (const h of headlines) {
    const t = (h?.title || "").toString();
    if (!t) continue;
    if (pos.test(t)) score += 1;
    if (neg.test(t)) score -= 1;
  }
  // clamp to [-2, 2]
  return Math.max(-2, Math.min(2, score));
}

// warn if a High impact calendar is within X minutes
function highImpactSoon(calendar: PlanPayload["calendar"], minutesAhead = 90): boolean {
  if (!Array.isArray(calendar)) return false;
  const now = Date.now();
  for (const e of calendar) {
    if (!e?.datetime) continue;
    if (!/high/i.test(e?.impact || "")) continue;
    const t = Date.parse(e.datetime);
    if (!Number.isFinite(t)) continue;
    const diffMin = (t - now) / 60000;
    if (diffMin >= -10 && diffMin <= minutesAhead) return true; // within window or just released
  }
  return false;
}

// ensure SL/TP ordering is correct vs entry/direction
function enforceOrdering(direction: Direction, entry: number, stop: number, tp1: number, tp2: number) {
  if (direction === "BUY") {
    // SL must be < entry, TPs > entry
    if (stop >= entry) stop = entry - Math.abs(entry - stop) - (Math.abs(entry) * 0.0001);
    if (tp1 <= entry) tp1 = entry + Math.abs(tp1 - entry) + (Math.abs(entry) * 0.0001);
    if (tp2 <= tp1) tp2 = tp1 + Math.abs(tp2 - tp1) + (Math.abs(entry) * 0.0001);
  } else if (direction === "SELL") {
    if (stop <= entry) stop = entry + Math.abs(entry - stop) + (Math.abs(entry) * 0.0001);
    if (tp1 >= entry) tp1 = entry - Math.abs(tp1 - entry) - (Math.abs(entry) * 0.0001);
    if (tp2 >= tp1) tp2 = tp1 - Math.abs(tp2 - tp1) - (Math.abs(entry) * 0.0001);
  }
  return { stop, tp1, tp2 };
}

// build the final trade card text
function buildCardText(
  instrument: string,
  type: TradeType,
  direction: Direction,
  entry: number | null,
  stop: number | null,
  tp1: number | null,
  tp2: number | null,
  conviction: number,
  rationale: string,
  notes: string[],
  counts: Record<TF, number>,
  missing: TF[],
): string {
  const lines: string[] = [];
  lines.push(`Instrument: ${instrument}`);
  lines.push(`TF data available → 15m:${counts["15m"]}  1h:${counts["1h"]}  4h:${counts["4h"]}${missing.length ? `  (missing: ${missing.join(", ")})` : ""}`);
  lines.push(`Type: ${type}    Direction: ${direction}`);
  lines.push(`Entry: ${entry ?? "-"}    SL: ${stop ?? "-"}    TP1: ${tp1 ?? "-"}    TP2: ${tp2 ?? "-"}`);
  lines.push(`Conviction: ${Math.round(conviction)}%`);
  lines.push(`Why: ${rationale}`);
  if (notes.length) {
    lines.push(`Notes: ${notes.join(" | ")}`);
  }
  return lines.join("\n");
}

// ---------- main handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<PlanResponse>) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, reason: "Method not allowed" });
  }

  // parse input
  const body = (req.body || {}) as PlanPayload;
  const instrument = (typeof body.instrument === "string" ? body.instrument : body.instrument?.code || "EURUSD").toUpperCase();
  const headlines = Array.isArray(body.headlines) ? body.headlines : [];
  const calendar = Array.isArray(body.calendar) ? body.calendar : [];

  // fetch candles in parallel (lib/prices.ts already handles provider failover)
  const [m15, h1, h4] = await Promise.all<TF[]>(TF_LIST.map(async (tf) => tf) // types trick
    .then(async () => [
      await getCandles(instrument, "15m", LIMIT_15M),
      await getCandles(instrument, "1h", LIMIT_15M),
      await getCandles(instrument, "4h", LIMIT_15M),
    ]));

  const counts: Record<TF, number> = {
    "15m": m15.length,
    "1h": h1.length,
    "4h": h4.length,
  };
  const missing = TF_LIST.filter((tf) => counts[tf] === 0);

  // Absolute last resort: if even 15m is missing, we cannot trade
  if (counts["15m"] === 0) {
    return res.status(200).json({
      ok: false,
      reason: `No 15m candles available for ${instrument}.`,
      counts,
      missing,
      used: { instrument, price: NaN },
      usedHeadlines: headlines,
      usedCalendar: calendar,
    });
  }

  // Current price = latest 15m close
  const last15 = latest(m15)!;
  const current = last15.c;

  // ---- BASIC STRUCTURE READ ----
  // Bias (HTF + 15m)
  const b4h = counts["4h"] ? biasFromCloses(h4, 8) * 2 : 0;  // weight more
  const b1h = counts["1h"] ? biasFromCloses(h1, 12) * 1.2 : 0;
  const b15 = biasFromCloses(m15, 20) * 0.8;

  let techBias = b4h + b1h + b15; // positive → bullish, negative → bearish

  // Swings on 15m to propose concrete levels
  const swingHi = recentSwingHigh(m15, 30);
  const swingLo = recentSwingLow(m15, 30);

  // ATR-like for sizing SL/TP bands
  const vol = Math.max(1e-9, atrLike(m15, 14)); // avoid zero

  // ---- HEADLINE / CALENDAR ADJUSTMENTS ----
  const hb = headlineBias(headlines); // -2..+2
  techBias += hb * 0.6; // blend a bit; not overpowering

  const highSoon = highImpactSoon(calendar, 90);
  const notes: string[] = [];
  if (highSoon) notes.push("High-impact calendar within ~90m → cut size / widen SL");

  // ---- TRADE CANDIDATE SELECTION ----
  let type: TradeType = "No Trade";
  let dir: Direction = "NONE";
  let entry: number | null = null;
  let stop: number | null = null;
  let tp1: number | null = null;
  let tp2: number | null = null;
  let rationale = "";

  // 1) Breakout (BOS) if strong single-side bias and clear nearby swing
  if (techBias >= 2 && swingHi && current < swingHi) {
    type = "Breakout (BOS)";
    dir = "BUY";
    entry = swingHi + vol * 0.1;          // stop-entry just above liquidity
    stop  = Math.min(current, swingLo ?? current - vol) - vol * 0.6; // below recent structure
    tp1   = entry + vol * 1.2;
    tp2   = entry + vol * 2.0;
    rationale = "Bullish bias (HTF+15m) with nearby swing-high liquidity. Break-and-go setup.";
  } else if (techBias <= -2 && swingLo && current > swingLo) {
    type = "Breakout (BOS)";
    dir = "SELL";
    entry = swingLo - vol * 0.1;
    stop  = Math.max(current, swingHi ?? current + vol) + vol * 0.6;
    tp1   = entry - vol * 1.2;
    tp2   = entry - vol * 2.0;
    rationale = "Bearish bias (HTF+15m) with nearby swing-low liquidity. Break-and-go setup.";
  }

  // 2) Pullback (Limit) with Fib confluence inside last 15m impulse (if no BOS chosen)
  if (dir === "NONE" && swingHi && swingLo) {
    // define the most recent leg (approx: from last pivot to current)
    const bullLeg = current > mid(swingHi, swingLo);
    const legHigh = bullLeg ? swingHi : current;
    const legLow  = bullLeg ? current : swingLo;

    // Fib levels from that leg
    const fibs = FIBS.map(f => legLow + (legHigh - legLow) * (bullLeg ? (1 - f) : f));
    // choose the cluster closest to current but not crossed yet
    const candidate = fibs.sort((a,b)=>Math.abs(a-current)-Math.abs(b-current))[0];

    if (techBias >= 0.5 && bullLeg) {
      type = "Pullback (Limit)";
      dir = "BUY";
      entry = candidate;                       // buy limit at the fib zone
      stop  = entry - Math.max(vol * 0.8, (entry - (swingLo ?? entry - vol))*0.6);
      tp1   = entry + vol * 1.2;
      tp2   = entry + vol * 2.2;
      rationale = "Pullback buy into fib/structure confluence with bullish composite bias.";
    } else if (techBias <= -0.5 && !bullLeg) {
      type = "Pullback (Limit)";
      dir = "SELL";
      entry = candidate;
      stop  = entry + Math.max(vol * 0.8, ((swingHi ?? entry + vol) - entry)*0.6);
      tp1   = entry - vol * 1.2;
      tp2   = entry - vol * 2.2;
      rationale = "Pullback sell into fib/structure confluence with bearish composite bias.";
    }
  }

  // 3) Range fade (if bias is weak and we have clear range)
  if (dir === "NONE" && swingHi && swingLo && Math.abs(techBias) < 0.8) {
    type = "Range Fade";
    // pick side by micro momentum (last few closes)
    const shortTerm = biasFromCloses(m15, 6);
    if (shortTerm >= 0) {
      dir = "SELL";
      entry = swingHi - vol * 0.2;
      stop  = swingHi + vol * 0.6;
      tp1   = mid(current, swingLo);
      tp2   = swingLo - vol * 0.3;
    } else {
      dir = "BUY";
      entry = swingLo + vol * 0.2;
      stop  = swingLo - vol * 0.6;
      tp1   = mid(current, swingHi);
      tp2   = swingHi + vol * 0.3;
    }
    rationale = "Balanced bias with defined 15m range — fading the edges back to the mean/liquidity.";
  }

  // If still NONE → no trade, but we’ll return a clear card (not empty)
  if (dir === "NONE") {
    const card = buildCardText(
      instrument,
      "No Trade",
      "NONE",
      null, null, null, null,
      0,
      "No clean structure with acceptable R:R based on current volatility.",
      notes.concat(missing.length ? [`Missing TFs: ${missing.join(", ")}`] : []),
      counts,
      missing,
    );
    return res.status(200).json({
      ok: true,
      counts, missing,
      used: { instrument, price: current },
      plan: {
        type: "No Trade",
        direction: "NONE",
        entry: null, stop: null, tp1: null, tp2: null,
        conviction: 0,
        note: "Stand aside until structure clarifies or HTF confirms.",
        card,
      },
      usedHeadlines: headlines,
      usedCalendar: calendar,
    });
  }

  // Enforce correct ordering for SL/TP vs entry/direction
  const ord = enforceOrdering(dir, entry!, stop!, tp1!, tp2!);
  stop = ord.stop; tp1 = ord.tp1; tp2 = ord.tp2;

  // Conviction: start from TF coverage + bias strength, adjust for headlines/calendar
  const tfCoverage = ( (counts["15m"]>0?1:0) + (counts["1h"]>0?1:0) + (counts["4h"]>0?1:0) ) / 3;
  let conviction = 50 * tfCoverage + Math.min(40, Math.abs(techBias) * 15);
  conviction += hb * 5; // headlines nudge
  if (highSoon) conviction = Math.max(5, conviction - 15);
  conviction = Math.max(1, Math.min(95, conviction));

  // Notes
  if (hb > 0) notes.push("Headlines lean risk-on/dovish");
  if (hb < 0) notes.push("Headlines lean risk-off/hawkish");
  if (missing.length) notes.push(`Generated without: ${missing.join(", ")}`);

  // Build card
  const card = buildCardText(
    instrument, type, dir, entry!, stop!, tp1!, tp2!, conviction,
    rationale, notes, counts, missing
  );

  return res.status(200).json({
    ok: true,
    counts, missing,
    used: { instrument, price: current },
    plan: {
      type,
      direction: dir,
      entry,
      stop,
      tp1,
      tp2,
      conviction: Math.round(conviction),
      note: rationale,
      card,
    },
    usedHeadlines: headlines,
    usedCalendar: calendar,
  });
}
