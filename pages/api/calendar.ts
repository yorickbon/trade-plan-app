// /pages/api/calendar.ts
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Calendar API (Primary: ForexFactory XML → structured; Fallback: TradingEconomics guest JSON; Last: DailyFX RSS timing-only)
 * - 60-minute warning (no blackout) for High impact.
 * - Fundamental bias from Actual vs Forecast/Previous over a rolling window.
 * - Optional instrument bias (base - quote).
 * - Full transparency: if both structured providers fail, ok:false + notes prompts manual image upload.
 *
 * Query:
 *  - date=YYYY-MM-DD (default: today)
 *  - currencies=EUR,USD (optional if instrument given)
 *  - instrument=EURUSD (optional; derives currencies)
 *  - windowHours (override lookback window; default CALENDAR_LOOKBACK_DAYS*24 or 168)
 *  - debug=1 (optional; adds provider/debug info)
 *
 * Response (stable fields preserved; added fields are optional):
 *  {
 *    ok: boolean,
 *    provider: "forexfactory"|"tradingeconomics"|"dailyfx"|"mixed"|"none"|"error",
 *    date: string,
 *    count: number,
 *    items: CalItem[],
 *    bias: { windowHours, perCurrency, instrument? },
 *    warning: { title, currency?, impact, time } | null,
 *    notes?: string,
 *    calendar_status?: "ok" | "unavailable" | "timing-only",
 *    debug?: any
 *  }
 */

type Impact = "High" | "Medium" | "Low" | "None";

type CalItem = {
  title: string;
  country: string;
  currency?: string;
  impact: Impact;
  time: string;                   // ISO UTC
  actual?: number | null;
  forecast?: number | null;
  previous?: number | null;
  unit?: string | null;
  provider?: "forexfactory" | "tradingeconomics" | "dailyfx";
};

type BiasSummary = {
  score: number; // -5..+5
  count: number;
  label:
    | "strongly bearish"
    | "bearish"
    | "slightly bearish"
    | "neutral"
    | "slightly bullish"
    | "bullish"
    | "strongly bullish";
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
  warning: { title: string; currency?: string; impact: Impact; time: string } | null;
  notes?: string;
  calendar_status?: "ok" | "unavailable" | "timing-only";
  debug?: any;
};

type Err = { ok: false; reason: string; notes?: string; provider?: string; calendar_status?: "unavailable" | "timing-only"; debug?: any };
type Resp = Ok | Err;

// ──────────────────────────────────────────────────────────────────────────────
// ENV defaults
const LOOKBACK_HOURS_DEFAULT = (Number(process.env.CALENDAR_LOOKBACK_DAYS) || 7) * 24;
const WARN_MINS_DEFAULT = Number(process.env.CALENDAR_WARN_MINS) || 60;
const TIMEOUT_MS = Number(process.env.CALENDAR_TIMEOUT_MS) || 12000;

// Sources
const FF_XML_URL = process.env.CALENDAR_RSS_URL || "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";
const TE_USER = process.env.TE_API_USER || "guest";
const TE_PASS = process.env.TE_API_PASS || "guest";
const TE_BASE = "https://api.tradingeconomics.com/calendar";
const DAILYFX_RSS_URL = process.env.DAILYFX_RSS_URL || "https://www.dailyfx.com/feeds/market-news";

// ──────────────────────────────────────────────────────────────────────────────
// utils
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const toISODate = (d: Date) => d.toISOString().slice(0, 10);

function parseNum(x: any): number | null {
  if (x === null || x === undefined) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  const s = String(x).replace(/[^\d.+-]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function within(iso: string, d1: Date, d2: Date): boolean {
  const t = new Date(iso).getTime();
  return t >= d1.getTime() && t <= d2.getTime();
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

  if (/(cpi|core cpi|ppi|inflation)/.test(t)) return true;
  if (/(gdp|retail sales|industrial production|manufacturing production|consumer credit|housing starts|building permits|durable goods)/.test(t)) return true;
  if (/(pmi|ism|confidence|sentiment)/.test(t)) return true;

  if (/unemployment|jobless|jobless claims|initial claims|continuing claims/.test(t)) return false; // lower is bullish
  if (/(nonfarm|nfp|employment change|payrolls|jobs)/.test(t)) return true;

  if (/trade balance|current account/.test(t)) return true;
  if (/interest rate|rate decision|refi rate|deposit facility|bank rate|cash rate|ocr/.test(t)) return true;

  return null;
}

function impactWeight(impact: Impact): number {
  if (impact === "High") return 1.0;
  if (impact === "Medium") return 0.6;
  if (impact === "Low") return 0.3;
  return 0.2;
}

function scoreDelta(title: string, actual: number | null, forecast: number | null, previous: number | null): number {
  const dir = goodIfHigher(title);
  if (dir === null || actual === null) return 0;

  const ref = forecast ?? previous;
  if (ref === null) return 0;

  const rawDelta = (actual - ref) / (Math.abs(ref) || 1);
  const signed = dir ? rawDelta : -rawDelta;
  return clamp(signed * 4, -1, 1);
}

// fetch with timeout
async function fWithTimeout(url: string, headers?: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal, cache: "no-store", headers });
  } finally {
    clearTimeout(id);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Providers
async function fetchForexFactory(dateISO: string, windowHours: number, debugWanted: boolean): Promise<{ items: CalItem[]; debug?: any }> {
  const debug: any = { provider: "forexfactory", url: FF_XML_URL };
  try {
    const rsp = await fWithTimeout(FF_XML_URL);
    debug.status = rsp.status;
    if (!rsp.ok) return { items: [], debug };
    const xml = await rsp.text();

    const out: CalItem[] = [];

    const d1 = new Date(`${dateISO}T00:00:00Z`);
    const d2 = new Date(`${dateISO}T23:59:59Z`);
    const lo = new Date(d1.getTime() - windowHours * 3600 * 1000);
    const hi = new Date(d2.getTime() + windowHours * 3600 * 1000);

    // FF XML: <item><title>..</title><country>..</country><date>MM-DD-YYYY</date><time>HH:mm</time><impact>..</impact><forecast>..</forecast><previous>..</previous><actual>..</actual></item>
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    let hits = 0;
    while ((m = re.exec(xml))) {
      const block = m[1];

      const pick = (tag: string) =>
        (block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || "")
          .replace(/<!\[CDATA\[|\]\]>/g, "")
          .trim();

      const title = pick("title") || "Event";
      const country = pick("country") || "Global";
      const date = pick("date"); // e.g., 09-03-2025
      const time = pick("time"); // e.g., 13:30
      const impactRaw = pick("impact");
      const actualRaw = pick("actual");
      const forecastRaw = pick("forecast");
      const previousRaw = pick("previous");
      const currencyGuess =
        title.match(/\b(USD|EUR|GBP|JPY|AUD|NZD|CAD|CHF|CNY|CNH|XAU)\b/i)?.[1]?.toUpperCase() ||
        country.toUpperCase();

      // Build ISO from date & time (assume UTC for consistency)
      const iso = date && time ? new Date(`${date} ${time} UTC`).toISOString() : new Date().toISOString();
      if (!within(iso, lo, hi)) continue;

      const imp: Impact =
        /high/i.test(impactRaw) ? "High" :
        /medium/i.test(impactRaw) ? "Medium" :
        /low/i.test(impactRaw) ? "Low" : "None";

      out.push({
        title,
        country,
        currency: currencyGuess,
        impact: imp,
        time: iso,
        provider: "forexfactory",
        actual: parseNum(actualRaw),
        forecast: parseNum(forecastRaw),
        previous: parseNum(previousRaw),
        unit: null,
      });
      hits++;
    }
    debug.hits = hits;

    return { items: out, debug: debugWanted ? debug : undefined };
  } catch (e: any) {
    debug.error = e?.message || "fetch/parse error";
    return { items: [], debug: debugWanted ? debug : undefined };
  }
}

async function fetchTradingEconomics(dateISO: string, windowHours: number, debugWanted: boolean): Promise<{ items: CalItem[]; debug?: any }> {
  const d1 = new Date(`${dateISO}T00:00:00Z`);
  const d2 = new Date(`${dateISO}T23:59:59Z`);
  const lo = new Date(d1.getTime() - windowHours * 3600 * 1000);
  const hi = new Date(d2.getTime() + windowHours * 3600 * 1000);

  const url = new URL(TE_BASE);
  url.searchParams.set("d1", lo.toISOString().slice(0, 10));
  url.searchParams.set("d2", hi.toISOString().slice(0, 10));
  url.searchParams.set("c", "All");
  url.searchParams.set("format", "json");

  const debug: any = { provider: "tradingeconomics", url: url.toString() };

  try {
    const auth = Buffer.from(`${TE_USER}:${TE_PASS}`).toString("base64");
    const rsp = await fWithTimeout(url.toString(), { Authorization: `Basic ${auth}` });
    debug.status = rsp.status;
    if (!rsp.ok) return { items: [], debug: debugWanted ? debug : undefined };

    const arr: any[] = await rsp.json();
    const out: CalItem[] = [];

    let hits = 0;
    for (const e of arr) {
      const title: string = e?.Event || e?.Category || "Event";
      const iso = e?.Date ? new Date(e.Date).toISOString() : new Date().toISOString();
      if (!within(iso, lo, hi)) continue;

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
        provider: "tradingeconomics",
        actual: parseNum(e?.Actual),
        forecast: parseNum(e?.Forecast),
        previous: parseNum(e?.Previous),
        unit: e?.Unit || null,
      });
      hits++;
    }
    debug.hits = hits;

    return { items: out, debug: debugWanted ? debug : undefined };
  } catch (e: any) {
    debug.error = e?.message || "fetch/parse error";
    return { items: [], debug: debugWanted ? debug : undefined };
  }
}

async function fetchDailyFxRSS(dateISO: string, windowHours: number, debugWanted: boolean): Promise<{ items: CalItem[]; debug?: any }> {
  const debug: any = { provider: "dailyfx", url: DAILYFX_RSS_URL };
  try {
    const rsp = await fWithTimeout(DAILYFX_RSS_URL);
    debug.status = rsp.status;
    if (!rsp.ok) return { items: [], debug: debugWanted ? debug : undefined };
    const xml = await rsp.text();

    const d1 = new Date(`${dateISO}T00:00:00Z`);
    const d2 = new Date(`${dateISO}T23:59:59Z`);
    const lo = new Date(d1.getTime() - windowHours * 3600 * 1000);
    const hi = new Date(d2.getTime() + windowHours * 3600 * 1000);

    const out: CalItem[] = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    let hits = 0;

    while ((m = re.exec(xml))) {
      const block = m[1];

      const pick = (tag: string) =>
        (block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || "")
          .replace(/<!\[CDATA\[|\]\]>/g, "")
          .trim();

      const title = pick("title");
      const pub = pick("pubDate");
      const iso = pub ? new Date(pub).toISOString() : new Date().toISOString();

      if (!within(iso, lo, hi)) continue;

      const currencyGuess =
        title.match(/\b(USD|EUR|GBP|JPY|AUD|NZD|CAD|CHF|CNY|CNH|XAU)\b/i)?.[1]?.toUpperCase() || undefined;
      const imp: Impact = /high|red/i.test(title) ? "High" : /medium|yellow/i.test(title) ? "Medium" : "Low";

      out.push({
        title: title || "Event",
        country: currencyGuess || "Global",
        currency: currencyGuess,
        impact: imp,
        time: iso,
        provider: "dailyfx",
        actual: null,
        forecast: null,
        previous: null,
        unit: null,
      });
      hits++;
    }
    debug.hits = hits;

    return { items: out, debug: debugWanted ? debug : undefined };
  } catch (e: any) {
    debug.error = e?.message || "fetch/parse error";
    return { items: [], debug: debugWanted ? debug : undefined };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Bias engine
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

    if (!within(it.time, start, end)) continue;

    const delta = scoreDelta(it.title, it.actual ?? null, it.forecast ?? null, it.previous ?? null);
    if (delta === 0) continue;

    const weight = impactWeight(it.impact);
    add(it.currency, it.title, it.time, delta, weight);
  }

  for (const cur of Object.keys(per)) {
    per[cur].score = clamp(per[cur].score * 5, -5, 5);
    per[cur].label = biasLabel(Math.round(per[cur].score));
  }

  return { perCurrency: per };
}

// ──────────────────────────────────────────────────────────────────────────────
// Handler
export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  try {
    // Avoid stale carryover between instruments
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    const date = String(req.query.date || toISODate(new Date()));
    const windowHours = Math.max(6, Math.min(24 * 14, Number(req.query.windowHours || LOOKBACK_HOURS_DEFAULT || 168))); // 6h..14d
    const warnMins = Math.max(15, Math.min(240, Number(process.env.CALENDAR_WARN_MINS || WARN_MINS_DEFAULT)));
    const debugWanted = String(req.query.debug || "") === "1";

    let currencies: string[] = [];
    const instrument = String(req.query.instrument || "").toUpperCase().replace(/[^A-Z]/g, "");
    if (instrument && instrument.length >= 6) {
      currencies = [instrument.slice(0, 3), instrument.slice(-3)];
    } else if (req.query.currencies) {
      currencies = String(req.query.currencies).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    }

    // Primary: ForexFactory XML
    const ff = await fetchForexFactory(date, windowHours, debugWanted);
    let items = ff.items;
    let provider = "forexfactory";
    let structuredOk = items.length > 0;

    // Fallback: TradingEconomics
    let teDebug: any = null;
    if (!structuredOk) {
      const te = await fetchTradingEconomics(date, windowHours, debugWanted);
      teDebug = te.debug;
      if (te.items.length) {
        items = te.items;
        provider = "tradingeconomics";
        structuredOk = true;
      }
    } else {
      // Optionally, merge TE for redundancy (disabled by default)
      // const te = await fetchTradingEconomics(date, windowHours, debugWanted);
      // teDebug = te.debug;
      // if (te.items.length) { items = [...items, ...te.items]; provider = "mixed"; }
    }

    // Last fallback: DailyFX (timing only) if no structured items
    let dfxDebug: any = null;
    if (!structuredOk) {
      const df = await fetchDailyFxRSS(date, windowHours, debugWanted);
      dfxDebug = df.debug;
      if (df.items.length) {
        items = df.items;
        provider = "dailyfx";
      }
    }

    // If still no items at all
    if (!items.length) {
      return res.status(200).json({
        ok: false,
        reason: "Calendar providers unavailable",
        provider: "none",
        notes: "⚠️ Calendar results unavailable (ForexFactory + TradingEconomics failed). Please upload a calendar image manually.",
        calendar_status: "unavailable",
        debug: debugWanted ? { ff: ff.debug, te: teDebug, dfx: dfxDebug } : undefined,
      });
    }

    // Build warning (High-impact only; nearest upcoming; must match instrument currencies if provided)
    const now = new Date();
    let warning: Ok["warning"] = null;
    const upcoming = items
      .filter((i) => i.impact === "High")
      .filter((i) => (currencies.length ? (i.currency ? currencies.includes(i.currency) : true) : true))
      .map((i) => ({ i, t: new Date(i.time) }))
      .filter(({ t }) => t.getTime() >= now.getTime())
      .sort((a, b) => a.t.getTime() - b.t.getTime());

    if (upcoming.length) {
      const nearest = upcoming[0];
      const mins = (nearest.t.getTime() - now.getTime()) / 60000;
      if (mins <= warnMins) {
        warning = { title: nearest.i.title, currency: nearest.i.currency, impact: nearest.i.impact, time: nearest.i.time };
      }
    }

    // Compute bias only if structured results exist
    const hasStructured = items.some((i) => i.actual !== null || i.forecast !== null || i.previous !== null);
    const { perCurrency } = hasStructured ? computeBias(items, windowHours, currencies) : { perCurrency: {} as Record<string, BiasSummary> };

    // Optional instrument bias
    let instrumentBias: Ok["bias"]["instrument"] | undefined;
    if (currencies.length === 2) {
      const [base, quote] = currencies;
      const b = perCurrency[base]?.score || 0;
      const q = perCurrency[quote]?.score || 0;
      const score = clamp(Math.round((b - q) * 10) / 10, -5, 5);
      instrumentBias = { pair: `${base}${quote}`, score, label: biasLabel(Math.round(score)) };
    }

    // Sorting (chronological)
    const sorted = items.slice().sort((a, b) => a.time.localeCompare(b.time));

    const basePayload: Ok = {
      ok: true,
      provider,
      date,
      count: sorted.length,
      items: sorted,
      bias: {
        windowHours,
        perCurrency,
        instrument: instrumentBias,
      },
      warning,
      calendar_status: hasStructured ? "ok" : provider === "dailyfx" ? "timing-only" : "ok",
      debug: debugWanted ? { ff: ff.debug, te: teDebug, dfx: dfxDebug, currencies, instrument } : undefined,
    };

    // Transparency: if we fell to timing-only (no structured), attach a note so VisionPlan can surface it in both Fast/Full
    if (!hasStructured) {
      basePayload.notes = "⚠️ Calendar results unavailable from structured sources (ForexFactory + TradingEconomics). Timing-only fallback in use. Consider uploading a calendar image.";
      basePayload.calendar_status = provider === "dailyfx" ? "timing-only" : "unavailable";
    }

    return res.status(200).json(basePayload);
  } catch (e: any) {
    return res.status(200).json({
      ok: false,
      reason: e?.message || "calendar error",
      provider: "error",
      notes: "⚠️ Calendar error encountered. Consider uploading a calendar image.",
      calendar_status: "unavailable",
    });
  }
}
