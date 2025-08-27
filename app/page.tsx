// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import { getCandles } from "@/lib/prices"; // named export

// ---- short cache (5 minutes) ------------------------------------------------
const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;
type CacheKey = string;
type CacheEntry = { at: number; data: any };
const CACHE: Map<CacheKey, CacheEntry> =
  (globalThis as any).__PLAN_CACHE__ ?? new Map();
(globalThis as any).__PLAN_CACHE__ = CACHE;

function getCache(key: CacheKey) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PLAN_CACHE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return hit.data;
}
function setCache(key: CacheKey, data: any) {
  CACHE.set(key, { at: Date.now(), data });
}

// ---- types from the UI/API contracts ---------------------------------------
type Instrument = { code: string; currencies?: string[] };

type CalendarItem = {
  date: string;
  time?: string;
  country?: string;
  currency?: string;
  impact?: "Low" | "Medium" | "High" | "Undefined" | string;
  title: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};

type Headline = { title: string; url: string; source: string; seen: string };

type Candle = { t: number; o: number; h: number; l: number; c: number };

// ---- tiny helpers -----------------------------------------------------------
function sma(values: number[], n: number) {
  if (values.length < n) return null;
  const s = values.slice(-n).reduce((a, b) => a + b, 0);
  return s / n;
}

function trendOf(closes: number[]) {
  const fast = sma(closes, 5);
  const slow = sma(closes, 20);
  if (fast == null || slow == null) return "neutral";
  if (fast > slow) return "up";
  if (fast < slow) return "down";
  return "neutral";
}

function lastBOS(c: Candle[]): "bull_bos" | "bear_bos" | "none" {
  if (c.length < 5) return "none";
  const last = c[c.length - 1];
  const prev = c[c.length - 2];
  if (last.c > prev.h) return "bull_bos";
  if (last.c < prev.l) return "bear_bos";
  return "none";
}

// very light “pullback” hint: price back to 38.2–62% of the last impulse
function pullbackZone(c: Candle[]) {
  if (c.length < 8) return null;
  const swing = c.slice(-8);
  const hi = Math.max(...swing.map((x) => x.h));
  const lo = Math.min(...swing.map((x) => x.l));
  const fib382 = lo + (hi - lo) * 0.382;
  const fib620 = lo + (hi - lo) * 0.62;
  return { hi, lo, fib382, fib620 };
}

function levelFmt(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toFixed(3);
}

// -----------------------------------------------------------------------------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { instrument, date, calendar = [], headlines = [] } = req.body as {
      instrument: Instrument;
      date: string;
      calendar?: CalendarItem[];
      headlines?: Headline[];
    };

    if (!instrument?.code) {
      return res.status(400).json({ error: "Missing instrument" });
    }

    // ---- cache key
    const cacheKey = JSON.stringify({
      k: "plan",
      code: instrument.code,
      date,
      hCount: (headlines || []).length,
      cCount: (calendar || []).length,
    });
    const cached = getCache(cacheKey);
    if (cached) return res.status(200).json(cached);

    // ---- fetch candles (4h / 1h / 15m)
    const [h4, h1, m15] = await Promise.all([
      getCandles(instrument.code, "4h", 200),
      getCandles(instrument.code, "1h", 200),
      getCandles(instrument.code, "15m", 200),
    ]);

    const okData =
      Array.isArray(h4) && h4.length > 10 &&
      Array.isArray(h1) && h1.length > 10 &&
      Array.isArray(m15) && m15.length > 10;

    if (!okData) {
      const out = {
        ok: false as const,
        reason: "Not enough market data to form a setup.",
        usedHeadlines: headlines,
        usedCalendar: calendar,
      };
      setCache(cacheKey, out);
      return res.status(200).json(out);
    }

    // ---- compute quick structure signals
    const h4Trend = trendOf(h4.map((x) => x.c));
    const h1Trend = trendOf(h1.map((x) => x.c));
    const m15Trend = trendOf(m15.map((x) => x.c));
    const bos15 = lastBOS(m15);
    const pull = pullbackZone(m15);

    // ---- “bias from news” (OPTIONAL)
    // Headlines are optional. If none, we keep bias = neutral and subtract a bit from conviction.
    let bias: "up" | "down" | "neutral" = "neutral";
    const hasHeadlines = Array.isArray(headlines) && headlines.length > 0;

    if (hasHeadlines) {
      const joined = headlines.map((h) => h.title).join(" \n ");
      // crude sentiment: positive words vs negative words
      const pos = (joined.match(/\b(rebound|beats|eases|cooling|optimism|deal|growth|expands)\b/gi) || []).length;
      const neg = (joined.match(/\b(falls|misses|hotter|spikes|conflict|sanction|contract|recession)\b/gi) || []).length;
      if (pos > neg + 1) bias = "up";
      else if (neg > pos + 1) bias = "down";
    }

    // ---- choose setup candidate
    type Setup = {
      type: "BOS" | "Pullback";
      direction: "Buy" | "Sell";
      entry: number;
      stop: number;
      tp1: number;
      tp2: number;
      conviction: number; // 0–100
      notes: string[];
    };

    const last = m15[m15.length - 1];
    const px = last.c;

    // base conviction from alignment
    let conviction = 60;
    const alignedUp = h4Trend === "up" && h1Trend === "up" && m15Trend === "up";
    const alignedDn = h4Trend === "down" && h1Trend === "down" && m15Trend === "down";
    if (alignedUp || alignedDn) conviction += 10;

    // adjust for headlines presence
    if (!hasHeadlines) conviction -= 5; // still tradeable
    if (bias === "up") conviction += 5;
    if (bias === "down") conviction += 5;

    // calendar caution: if any High impact event in next ~90 minutes, trim conviction
    const soonHigh = (calendar as CalendarItem[]).some((ev) => {
      const imp = (ev.impact || "").toString().toLowerCase();
      if (!ev.time) return false;
      const dt = new Date(`${ev.date}T${ev.time}:00Z`);
      const diffMin = (dt.getTime() - Date.now()) / 60000;
      return imp.includes("high") && diffMin > -15 && diffMin < 90;
    });
    if (soonHigh) conviction -= 10;

    // Clamp
    conviction = Math.max(30, Math.min(90, conviction));

    const notes: string[] = [];
    if (!hasHeadlines) notes.push("No notable headlines in the last lookback window; conviction slightly reduced.");
    if (bias !== "neutral") notes.push(`Headline bias: ${bias}.`);
    if (soonHigh) notes.push("High-impact event within ~90 minutes — caution / smaller size.");

    let setup: Setup | null = null;

    // Prefer BOS when it agrees with M15 trend; else pullback into 38.2–62%.
    if (bos15 === "bull_bos" && m15Trend !== "down") {
      const stop = Math.min(...m15.slice(-5).map((x) => x.l));
      setup = {
        type: "BOS",
        direction: "Buy",
        entry: px,
        stop,
        tp1: px + (px - stop) * 1.0,
        tp2: px + (px - stop) * 1.6,
        conviction,
        notes,
      };
    } else if (bos15 === "bear_bos" && m15Trend !== "up") {
      const stop = Math.max(...m15.slice(-5).map((x) => x.h));
      setup = {
        type: "BOS",
        direction: "Sell",
        entry: px,
        stop,
        tp1: px - (stop - px) * 1.0,
        tp2: px - (stop - px) * 1.6,
        conviction,
        notes,
      };
    } else if (pull) {
      // pullback preference aligned with trend/bias
      const wantUp = m15Trend === "up" || bias === "up";
      const wantDn = m15Trend === "down" || bias === "down";

      if (wantUp) {
        const entry = pull.fib382; // conservative
        const stop = pull.lo - (pull.hi - pull.lo) * 0.05;
        setup = {
          type: "Pullback",
          direction: "Buy",
          entry,
          stop,
          tp1: pull.hi,
          tp2: pull.hi + (pull.hi - entry) * 0.5,
          conviction,
          notes,
        };
      } else if (wantDn) {
        const entry = pull.fib620;
        const stop = pull.hi + (pull.hi - pull.lo) * 0.05;
        setup = {
          type: "Pullback",
          direction: "Sell",
          entry,
          stop,
          tp1: pull.lo,
          tp2: pull.lo - (entry - pull.lo) * 0.5,
          conviction,
          notes,
        };
      }
    }

    // Fallback: neutral sketch if neither BOS nor pullback made sense
    if (!setup) {
      const stop = Math.max(...m15.slice(-5).map((x) => x.h));
      setup = {
        type: "Pullback",
        direction: "Sell",
        entry: px,
        stop,
        tp1: px - (stop - px) * 1.0,
        tp2: px - (stop - px) * 1.6,
        conviction: Math.max(35, conviction - 10),
        notes: notes.concat([
          "Structure is mixed; using a conservative fallback template.",
        ]),
      };
    }

    // ---- format trade card text (markdown)
    const card =
      `**Trade Card: ${instrument.code}**\n\n` +
      `**Type:** ${setup.type}\n` +
      `**Direction:** ${setup.direction}\n` +
      `**Entry:** ${levelFmt(setup.entry)}\n` +
      `**Stop:** ${levelFmt(setup.stop)}\n` +
      `**TP1:** ${levelFmt(setup.tp1)}\n` +
      `**TP2:** ${levelFmt(setup.tp2)}\n` +
      `**Conviction %:** ${Math.round(setup.conviction)}%\n\n` +
      `**Notes:**\n- ${setup.notes.join("\n- ") || "—"}`;

    const out = {
      ok: true as const,
      plan: { text: card, conviction: setup.conviction },
      usedHeadlines: headlines,
      usedCalendar: calendar,
    };
    setCache(cacheKey, out);
    return res.status(200).json(out);
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Plan generation failed" });
  }
}
