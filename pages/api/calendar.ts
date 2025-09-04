// /pages/api/calendar.ts
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Calendar API with:
 *  - Provider fallback: FairEconomy RSS -> TradingEconomics (guest)
 *  - ±90m blackout for High impact
 *  - Fundamental bias scoring from Actual vs Forecast/Previous
 *  - Optional instrument bias (base - quote)
 *
 * Query:
 *  - date=YYYY-MM-DD (default: today, API uses that day)
 *  - currencies=EUR,USD (optional if instrument given)
 *  - instrument=EURUSD (optional; auto derives currencies)
 *  - windowHours=48 (bias lookback window around date; default 48)
 *
 * Response:
 *  { ok, provider, date, count, items: CalItem[], bias: { perCurrency, instrument? } }
 */

type Impact = "High" | "Medium" | "Low" | "None";

type CalItem = {
  title: string;
  country: string;
  currency?: string;
  impact: Impact;
  time: string;                   // ISO
  actual?: number | null;
  forecast?: number | null;
  previous?: number | null;
  unit?: string | null;
  isBlackout?: boolean;
  provider?: "fair" | "te";
};

type BiasSummary = {
  score: number;      // -5..+5
  count: number;      // events counted
  label: "strongly bearish" | "bearish" | "slightly bearish" | "neutral" | "slightly bullish" | "bullish" | "strongly bullish";
  evidence: Array<{ title: string; time: string; delta: number; weight: number }>;
};

type Ok = {
  ok: true;
  provider: string;
  date: string;
  count: number;
  items: CalItem[];
  bias: {
    windowHours: number;
    perCurrency: Record<string, BiasSummary>;
    instrument?: { pair: string; score: number; label: BiasSummary["label"] };
  };
};

type Err = { ok: false; reason: string };
type Resp = Ok | Err;

const FEED = process.env.CALENDAR_RSS_URL || "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";
const TE_USER = process.env.TE_API_USER || "guest";
const TE_PASS = process.env.TE_API_PASS || "guest";

// ----------------- utils -----------------
const toISODate = (d: Date) => d.toISOString().slice(0, 10);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function parseNum(x: any): number | null {
  if (x === null || x === undefined) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  const s = String(x).replace(/[^\d.+-]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function withinWindow(iso: string, d1: Date, d2: Date): boolean {
  const t = new Date(iso).getTime();
  return t >= d1.getTime() && t <= d2.getTime();
}

function blackout(iso: string, minutes = 90) {
  const t = new Date(iso).getTime();
  return { from: new Date(t - minutes * 60000).toISOString(), to: new Date(t + minutes * 60000).toISOString() };
}

function biasLabel(score: number): BiasSummary["label"] {
  if (score <= -4) return "strongly bearish";
  if (score <= -2) return "bearish";
  if (score < 0) return "slightly bearish";
  if (score === 0) return "neutral";
  if (score < 2) return "slightly bullish";
  if (score < 4) return "bullish";
  return "strongly bullish";
}

// Direction of "goodness" (true = higher is bullish)
function goodIfHigher(title: string): boolean | null {
  const t = title.toLowerCase();

  // Inflation / pricing: higher tends to be hawkish -> bullish (FX)
  if (/(cpi|core cpi|ppi|inflation)/.test(t)) return true;

  // Growth & demand: higher bullish
  if (/(gdp|retail sales|industrial production|manufacturing production|consumer credit|housing starts|building permits|durable goods)/.test(t)) return true;

  // PMI/ISM/Confidence: higher bullish (esp. above 50 for PMI)
  if (/(pmi|ism|confidence|sentiment)/.test(t)) return true;

  // Employment: unemployment lower bullish; jobless claims lower bullish; payrolls higher bullish
  if (/unemployment|jobless|jobless claims|initial claims|continuing claims/.test(t)) return false;   // lower is bullish
  if (/(nonfarm|nfp|employment change|payrolls|jobs)/.test(t)) return true;

  // Trade balance: less negative (higher) can be bullish, but noisy -> treat higher as bullish
  if (/trade balance|current account/.test(t)) return true;

  // Rates: higher rate is bullish; cuts bearish
  if (/interest rate|rate decision|refi rate|deposit facility|bank rate|cash rate|ocr/.test(t)) return true;

  // If we don't know, return null -> neutral handling
  return null;
}

function impactWeight(impact: Impact): number {
  if (impact === "High") return 1.0;
  if (impact === "Medium") return 0.6;
  if (impact === "Low") return 0.3;
  return 0.2;
}

// score delta from actual vs forecast/previous
function scoreDelta(title: string, actual: number | null, forecast: number | null, previous: number | null): number {
  const dir = goodIfHigher(title);
  if (dir === null || actual === null) return 0;

  const ref = forecast ?? previous;
  if (ref === null) return 0;

  const rawDelta = (actual - ref) / (Math.abs(ref) || 1); // relative surprise
  const signed = dir ? rawDelta : -rawDelta;              // invert if lower-is-bullish
  // squash to -1..+1
  return clamp(signed * 4, -1, 1);
}

// ----------------- providers -----------------
async function fetchFairEconomy(dateISO: string, windowHours: number): Promise<CalItem[]> {
  try {
    const rsp = await fetch(FEED, { cache: "no-store" });
    if (!rsp.ok) return [];
    const xml = await rsp.text();

    const out: CalItem[] = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;

    const start = new Date(`${dateISO}T00:00:00Z`);
    const end = new Date(`${dateISO}T23:59:59Z`);
    const lo = new Date(start.getTime() - windowHours * 3600 * 1000);
    const hi = new Date(end.getTime() + windowHours * 3600 * 1000);

    while ((m = re.exec(xml))) {
      const block = m[1];
      const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "");
      const pub = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "").trim();
      const iso = pub ? new Date(pub).toISOString() : new Date().toISOString();
      if (!withinWindow(iso, lo, hi)) continue;

      // crude impact + currency extraction from title/category
      const cat = (block.match(/<category>([\s\S]*?)<\/category>/)?.[1] || "").trim();
      const impact: Impact =
        /High/i.test(title + " " + cat) ? "High" :
        /Medium/i.test(title + " " + cat) ? "Medium" :
        /Low/i.test(title + " " + cat) ? "Low" : "None";
      const currency = (title.match(/(USD|EUR|GBP|JPY|AUD|NZD|CAD|CHF|CNY|XAU)/i)?.[1] || "").toUpperCase() || undefined;

      out.push({
        title,
        country: currency || "Global",
        currency,
        impact,
        time: iso,
        provider: "fair",
        actual: null, forecast: null, previous: null, unit: null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchTradingEconomics(dateISO: string, windowHours: number): Promise<CalItem[]> {
  try {
    const base = "https://api.tradingeconomics.com/calendar";
    // Pull +/- windowHours around the day (TE filters by d1..d2 UTC)
    const d1 = new Date(`${dateISO}T00:00:00Z`);
    const d2 = new Date(`${dateISO}T23:59:59Z`);
    const lo = new Date(d1.getTime() - windowHours * 3600 * 1000);
    const hi = new Date(d2.getTime() + windowHours * 3600 * 1000);

    const url = new URL(base);
    url.searchParams.set("d1", lo.toISOString().slice(0, 10));
    url.searchParams.set("d2", hi.toISOString().slice(0, 10));
    url.searchParams.set("c", "All");
    url.searchParams.set("format", "json");

    const auth = Buffer.from(`${TE_USER}:${TE_PASS}`).toString("base64");
    const rsp = await fetch(url.toString(), {
      headers: { Authorization: `Basic ${auth}` },
      cache: "no-store",
    });
    if (!rsp.ok) return [];

    const arr: any[] = await rsp.json();
    const out: CalItem[] = [];

    for (const e of arr) {
      const title: string = e?.Event || e?.Category || "Event";
      const iso = e?.Date ? new Date(e.Date).toISOString() : new Date().toISOString();
      if (!withinWindow(iso, lo, hi)) continue;

      const currency: string | undefined = e?.Currency || undefined;
      const imp: Impact =
        /high/i.test(String(e?.Importance || "")) ? "High" :
        /medium/i.test(String(e?.Importance || "")) ? "Medium" :
        /low/i.test(String(e?.Importance || "")) ? "Low" : "None";

      out.push({
        title,
        country: e?.Country || currency || "Global",
        currency,
        impact: imp,
        time: iso,
        provider: "te",
        actual: parseNum(e?.Actual),
        forecast: parseNum(e?.Forecast),
        previous: parseNum(e?.Previous),
        unit: e?.Unit || null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ----------------- bias engine -----------------
function computeBias(items: CalItem[], windowHours: number, currencies: string[]) {
  const end = new Date();
  const start = new Date(end.getTime() - windowHours * 3600 * 1000);

  const per: Record<string, BiasSummary> = {};

  function add(cur: string, title: string, time: string, delta: number, weight: number) {
    if (!per[cur]) per[cur] = { score: 0, count: 0, label: "neutral", evidence: [] };
    per[cur].score += delta * weight;
    per[cur].count += 1;
    per[cur].evidence.push({ title, time, delta, weight });
  }

  for (const it of items) {
    if (!it.currency) continue;
    if (currencies.length && !currencies.includes(it.currency)) continue;
    if (!withinWindow(it.time, start, end)) continue;

    const delta = scoreDelta(it.title, it.actual ?? null, it.forecast ?? null, it.previous ?? null);
    if (delta === 0) continue;

    const weight = impactWeight(it.impact);
    add(it.currency, it.title, it.time, delta, weight);
  }

  // normalize to -5..+5 and label
  for (const cur of Object.keys(per)) {
    per[cur].score = clamp(per[cur].score * 5, -5, 5);
    per[cur].label = biasLabel(Math.round(per[cur].score));
  }

  return { perCurrency: per };
}

// ----------------- handler -----------------
export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  try {
    const date = String(req.query.date || toISODate(new Date()));
    const windowHours = Math.max(6, Math.min(168, Number(req.query.windowHours || 48))); // 6h..7d

    let currencies: string[] = [];
    const instrument = String(req.query.instrument || "").toUpperCase().replace(/[^A-Z]/g, "");
    if (instrument && instrument.length >= 6) {
      currencies = [instrument.slice(0, 3), instrument.slice(-3)];
    } else if (req.query.currencies) {
      currencies = String(req.query.currencies).split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    }

    // 1) FairEconomy
    let items = await fetchFairEconomy(date, windowHours);
    let provider = "fair";

    // 2) TradingEconomics fallback or merge
    const teItems = await fetchTradingEconomics(date, windowHours);
    if (!items.length && teItems.length) { items = teItems; provider = "te"; }
    else if (teItems.length) { items = [...items, ...teItems]; provider = "mixed"; }

    if (!items.length) {
      return res.status(200).json({ ok: false, reason: "No calendar items from providers" });
    }

    // apply blackout (±90m) for High impact
    const now = new Date().toISOString();
    const withBlackout = items.map(i => {
      if (i.impact === "High") {
        const w = blackout(i.time, 90);
        const inWindow = now >= w.from && now <= w.to;
        return { ...i, isBlackout: inWindow };
      }
      return i;
    });

    // compute bias
    const { perCurrency } = computeBias(withBlackout, windowHours, currencies);

    // optional instrument bias
    let instrumentBias: Ok["bias"]["instrument"] | undefined;
    if (currencies.length === 2) {
      const [base, quote] = currencies;
      const b = perCurrency[base]?.score || 0;
      const q = perCurrency[quote]?.score || 0;
      const score = clamp(Math.round((b - q) * 10) / 10, -5, 5);
      instrumentBias = { pair: `${base}${quote}`, score, label: biasLabel(Math.round(score)) };
    }

    // final
    return res.status(200).json({
      ok: true,
      provider,
      date,
      count: withBlackout.length,
      items: withBlackout.sort((a, b) => b.time.localeCompare(a.time)),
      bias: {
        windowHours,
        perCurrency,
        instrument: instrumentBias,
      },
    });
  } catch (e: any) {
    return res.status(200).json({ ok: false, reason: e?.message || "calendar error" });
  }
}
