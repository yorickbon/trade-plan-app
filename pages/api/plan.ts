// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import getCandles from "../../lib/prices";

// ---------------- Short plan cache (5 minutes) ----------------
const PLAN_CACHE_TTL = 5 * 60 * 1000; // 5 min
type CacheVal = { at: number; json: any };
const G = global as unknown as { __PLAN_CACHE__?: Map<string, CacheVal> };
if (!G.__PLAN_CACHE__) G.__PLAN_CACHE__ = new Map();
function planGet(key: string) {
  const hit = G.__PLAN_CACHE__!.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PLAN_CACHE_TTL) {
    G.__PLAN_CACHE__!.delete(key);
    return null;
  }
  return hit.json;
}
function planSet(key: string, json: any) {
  G.__PLAN_CACHE__!.set(key, { at: Date.now(), json });
}

// ---------------- Types ----------------
type Interval = "4h" | "1h" | "15m";
type Candle = { t: string | number | Date; o: number; h: number; l: number; c: number };

type CalendarItem = {
  date: string; time?: string;
  country?: string; currency?: string;
  impact?: string; title: string;
  actual?: string; forecast?: string; previous?: string;
};

type NewsItem = { title: string; url: string; source?: string; seen?: string };

type Candidate = {
  name: "Pullback" | "BOS" | "Breakout";
  direction: "Buy" | "Sell";
  entry: number; stop: number; tp1: number; tp2: number;
  rationale: string[]; confluence: string[]; score: number;
};

// ---------------- Utils ----------------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

function last<T>(arr: T[]) { return arr[arr.length - 1]; }
function asNum(n: number) { return Number.isFinite(n) ? n : 0; }

function nDec(price: number): number {
  const p = Math.abs(price);
  if (p >= 1000) return 2;
  if (p >= 100) return 3;
  if (p >= 10) return 4;
  return 5;
}
function fmt(price: number) { return asNum(price).toFixed(nDec(price)); }

function atr(c: Candle[], period = 14) {
  if (c.length < period + 1) return 0;
  let sum = 0;
  for (let i = c.length - period; i < c.length; i++) {
    const cur = c[i], prev = c[i - 1] ?? cur;
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c)
    );
    sum += tr;
  }
  return sum / period;
}

function findSwings(c: Candle[], lookback = 60) {
  const hiIdxs: number[] = [];
  const loIdxs: number[] = [];
  const len = Math.min(c.length - 1, lookback);
  for (let i = c.length - len; i < c.length - 1; i++) {
    if (i <= 0 || i >= c.length - 1) continue;
    if (c[i].h > c[i - 1].h && c[i].h > c[i + 1].h) hiIdxs.push(i);
    if (c[i].l < c[i - 1].l && c[i].l < c[i + 1].l) loIdxs.push(i);
  }
  const lastHi = hiIdxs.length ? hiIdxs[hiIdxs.length - 1] : -1;
  const lastLo = loIdxs.length ? loIdxs[loIdxs.length - 1] : -1;
  return { lastHi, lastLo };
}

function fibs(high: number, low: number) {
  const range = high - low;
  return {
    "0.382": low + 0.382 * range,
    "0.5": low + 0.5 * range,
    "0.618": low + 0.618 * range,
    "0.705": low + 0.705 * range,
  };
}

function hasFVGNear(c: Candle[], price: number, tol: number) {
  for (let i = 2; i < c.length; i++) {
    const a = c[i - 2], b = c[i - 1], d = c[i];
    const bull = a.h < d.l && Math.abs((a.h + d.l) / 2 - price) <= tol;
    const bear = a.l > d.h && Math.abs((a.l + d.h) / 2 - price) <= tol;
    if (bull || bear) return true;
  }
  return false;
}

function nearestStructure(c: Candle[], price: number, tol: number) {
  for (let i = 1; i < c.length - 1; i++) {
    const isHi = c[i].h > c[i - 1].h && c[i].h > c[i + 1].h;
    const isLo = c[i].l < c[i - 1].l && c[i].l < c[i + 1].l;
    const lvl = isHi ? c[i].h : isLo ? c[i].l : null;
    if (lvl !== null && Math.abs(lvl - price) <= tol) return lvl;
  }
  return null;
}

function compressRatio(c: Candle[], bars = 24) {
  const seg = c.slice(-bars);
  const hi = Math.max(...seg.map(x => x.h));
  const lo = Math.min(...seg.map(x => x.l));
  const rng = hi - lo;
  const segAtr = atr(seg, Math.min(14, seg.length - 1));
  return segAtr ? rng / segAtr : Infinity;
}

// ---------------- Handler ----------------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const {
      instrument,                // { code: 'EURUSD', currencies?: string[] }
      date,
      calendar = [] as CalendarItem[],
      headlines = [] as NewsItem[],
      candles: clientCandles = null, // optional { h4, h1, m15 } from client
    } = req.body || {};

    if (!instrument?.code) return res.status(400).json({ error: "Missing instrument" });

    // -------- Cache key (stable across clicks) --------
    // We intentionally do NOT include price to allow reuse within TTL.
    // Keyed by instrument + date + counts + first headline/calendar titles (coarse snapshot).
    const calSig = String(calendar.length) + "|" + (calendar[0]?.title ?? "");
    const newsSig = String(headlines.length) + "|" + (headlines[0]?.title ?? "");
    const cacheKey = JSON.stringify({ code: instrument.code, date: date || "", calSig, newsSig });

    const cached = planGet(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=60");
      return res.status(200).json(cached);
    }

    // -------- Candles (server fetch if not supplied) --------
    const [h4, h1, m15]: [Candle[], Candle[], Candle[]] = clientCandles?.h4 && clientCandles?.h1 && clientCandles?.m15
      ? [clientCandles.h4, clientCandles.h1, clientCandles.m15]
      : await Promise.all([
          getCandles(instrument, "4h", 200),
          getCandles(instrument, "1h", 200),
          getCandles(instrument, "15m", 220),
        ]);

    if (!m15?.length || !h1?.length || !h4?.length) {
      const payload = { plan: { text: "No Trade – insufficient candle data.", conviction: 0 } };
      planSet(cacheKey, payload);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(payload);
    }

    const p = last(m15).c;
    const vol = atr(m15, 14) || Math.max(1e-6, Math.abs(m15[m15.length - 1].h - m15[m15.length - 1].l));

    // -------- Macro signals (calendar + headlines) --------
    const highImpactSoon = calendar.some((e) => /high/i.test(e.impact ?? ""));
    const headlineText = (headlines || []).map(h => `${h.title} (${h.source ?? ""})`).join("\n").toLowerCase();
    let macroBias: "hawkish" | "dovish" | "mixed" | "none" = "none";
    if (/hawk|rate hike|inflation hot|sticky inflation|tighten/.test(headlineText)) macroBias = "hawkish";
    else if (/dove|rate cut|disinflation|slowdown|recession/.test(headlineText)) macroBias = "dovish";
    else if (headlineText.length) macroBias = "mixed";

    // -------- Build candidates (Pullback, BOS, Breakout) --------
    // Pullback (Fib GP + confluence)
    const sw15 = findSwings(m15, 80);
    let pullback: Candidate | null = null;
    if (sw15.lastHi !== -1 && sw15.lastLo !== -1) {
      // Determine impulse direction by the last swing that formed
      const longImpulse = sw15.lastHi < sw15.lastLo; // last swing is Low -> up impulse
      const hi = Math.max(...m15.map(x => x.h));
      const lo = Math.min(...m15.map(x => x.l));
      const F = longImpulse ? fibs(hi, lo) : fibs(lo, hi);
      const z1 = longImpulse ? F["0.618"] : F["0.382"];
      const z2 = longImpulse ? F["0.705"] : F["0.618"];
      const entry = (z1 + z2) / 2;

      const tol = vol * 1.2;
      const conf: string[] = ["Fib golden pocket"];
      if (hasFVGNear(m15, entry, tol)) conf.push("FVG near zone");
      const sLvl = nearestStructure(m15, entry, tol);
      if (sLvl !== null) conf.push("Structure near zone");

      const dir: "Buy" | "Sell" = longImpulse ? "Buy" : "Sell";
      const stop = dir === "Buy" ? Math.min(lo, entry - 1.5 * vol) : Math.max(hi, entry + 1.5 * vol);
      const tp1 = dir === "Buy" ? entry + 1.2 * (entry - stop) : entry - 1.2 * (stop - entry);
      const tp2 = dir === "Buy" ? entry + 2.0 * (entry - stop) : entry - 2.0 * (stop - entry);

      let score = 60 + conf.length * 10;
      const dist = Math.abs(entry - p);
      if (dist < 0.5 * vol) score += 8;
      if (dist > 2.5 * vol) score -= 8;
      if (highImpactSoon) score -= 12;

      pullback = {
        name: "Pullback",
        direction: dir, entry, stop, tp1, tp2,
        rationale: [
          `15m impulse ${longImpulse ? "up" : "down"}; plan limit at GP (0.62–0.705).`,
        ],
        confluence: conf,
        score,
      };
    }

    // BOS + Retest
    let bos: Candidate | null = null;
    {
      const recent = m15.slice(-40);
      const swingHigh = Math.max(...recent.map(c => c.h));
      const swingLow  = Math.min(...recent.map(c => c.l));
      const prev = m15[m15.length - 2].c;

      if (p > swingHigh && prev <= swingHigh) {
        const entry = swingHigh;
        const stop  = swingLow;
        const tp1   = entry + 0.75 * (entry - stop);
        const tp2   = entry + 1.25 * (entry - stop);
        let score = 55;
        // 1H confirmation
        const r1 = h1.slice(-60);
        const h1High = Math.max(...r1.map(c => c.h));
        if (last(h1).c > h1High) score += 10;
        if (highImpactSoon) score -= 10;
        bos = {
          name: "BOS", direction: "Buy",
          entry, stop, tp1, tp2,
          rationale: ["Broke prior swing high; plan retest entry."],
          confluence: ["Structure retest", "1H confirmation (if present)"],
          score,
        };
      } else if (p < swingLow && prev >= swingLow) {
        const entry = swingLow;
        const stop  = swingHigh;
        const tp1   = entry - 0.75 * (swingHigh - swingLow);
        const tp2   = entry - 1.25 * (swingHigh - swingLow);
        let score = 55;
        const r1 = h1.slice(-60);
        const h1Low = Math.min(...r1.map(c => c.l));
        if (last(h1).c < h1Low) score += 10;
        if (highImpactSoon) score -= 10;
        bos = {
          name: "BOS", direction: "Sell",
          entry, stop, tp1, tp2,
          rationale: ["Broke prior swing low; plan retest entry."],
          confluence: ["Structure retest", "1H confirmation (if present)"],
          score,
        };
      }
    }

    // Range Breakout (only if tight)
    let breakout: Candidate | null = null;
    {
      const ratio = compressRatio(m15, 24); // smaller => tighter
      if (ratio < 1.6) {
        const seg = m15.slice(-24);
        const hi = Math.max(...seg.map(x => x.h));
        const lo = Math.min(...seg.map(x => x.l));
        const dir: "Buy" | "Sell" = p > (hi + lo) / 2 ? "Buy" : "Sell";
        const entry = dir === "Buy" ? hi + 0.25 * vol : lo - 0.25 * vol;
        const stop  = dir === "Buy" ? entry - 1.2 * vol : entry + 1.2 * vol;
        const tp1   = dir === "Buy" ? entry + 1.2 * (entry - stop) : entry - 1.2 * (stop - entry);
        const tp2   = dir === "Buy" ? entry + 2.0 * (entry - stop) : entry - 2.0 * (stop - entry);
        let score = 50;
        if (highImpactSoon) score -= 10;
        breakout = {
          name: "Breakout", direction: dir,
          entry, stop, tp1, tp2,
          rationale: ["Tight range; stop-order breakout play."],
          confluence: ["Range compression"],
          score,
        };
      }
    }

    const candidates = [pullback, bos, breakout].filter(Boolean) as Candidate[];
    if (!candidates.length) {
      const payload = {
        instrument,
        date,
        plan: { text: "No Trade – no clean setup (pullback/BOS/breakout) found.", conviction: 0 },
        meta: { price: p, calendarCount: calendar.length, headlinesCount: headlines.length, alternatives: [] }
      };
      planSet(cacheKey, payload);
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=60");
      return res.status(200).json(payload);
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    let conviction = Math.max(0, Math.min(95, Math.round(best.score)));
    if (highImpactSoon) conviction = Math.max(20, Math.min(conviction, 70));

    const calNote = calendar.length
      ? `Calendar: ${calendar.length} item(s)${highImpactSoon ? " (high impact present)" : ""}.`
      : "Calendar: none.";
    const topNews = headlines.slice(0, 3).map(n => `${n.source ?? "News"}: ${n.title}`);
    const newsNote = headlines.length
      ? `Headlines scanned: ${headlines.length}. Top: ${topNews.join(" | ")}`
      : "Headlines scanned: none.";

    const lines: string[] = [];
    lines.push(`**Trade Card: ${instrument.code}**`, "");
    lines.push(`**Strategy:** ${best.name}`);
    lines.push(`**Direction:** ${best.direction}`);
    lines.push(`**Entry:** ${fmt(best.entry)}`);
    lines.push(`**Stop:** ${fmt(best.stop)}`);
    lines.push(`**TP1:** ${fmt(best.tp1)}`);
    lines.push(`**TP2:** ${fmt(best.tp2)}`);
    lines.push(`**Conviction %:** ${conviction}%`, "");
    lines.push(`**Why this setup (auto):**`);
    best.rationale.forEach(r => lines.push(`- ${r}`));
    if (best.confluence.length) lines.push(`- Confluence: ${best.confluence.join(", ")}`);
    lines.push("");
    lines.push(`**Timeframe Alignment (auto):** 4H / 1H for bias; 15M for execution.`);
    lines.push("");
    lines.push(`**Invalidation Note:** Close beyond stop invalidates; no chase.`);
    lines.push("");
    lines.push(`**Risk Notice:** ${calNote}`);
    lines.push(`**News Note:** ${newsNote}`);
    if (highImpactSoon) {
      lines.push(`**Caution:** Upcoming high-impact event — consider waiting for post-event retest.`);
    }

    // Optionally polish wording (kept off by default)
    let finalText = lines.join("\n");
    if (process.env.OPENAI_POLISH === "true" && process.env.OPENAI_API_KEY) {
      try {
        const rsp = await client.chat.completions.create({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0.2,
          messages: [
            { role: "system", content: "Polish for clarity. Keep all numbers exactly the same. Output plain text only." },
            { role: "user", content: finalText },
          ],
        });
        finalText = rsp.choices?.[0]?.message?.content?.trim() || finalText;
      } catch { /* ignore polish failure */ }
    }

    const alts = candidates.slice(1).map(c => ({
      strategy: c.name, dir: c.direction,
      entry: Number(fmt(c.entry)),
      stop: Number(fmt(c.stop)),
      tp1: Number(fmt(c.tp1)),
      tp2: Number(fmt(c.tp2)),
      score: c.score,
    }));

    const payload = {
      instrument,
      date,
      plan: { strategy: best.name, conviction, text: finalText },
      meta: { price: p, calendarCount: calendar.length, headlinesCount: headlines.length, alternatives: alts }
    };

    // --------- Save & return (cached) ---------
    planSet(cacheKey, payload);
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=60");
    return res.status(200).json(payload);

  } catch (err: any) {
    console.error("PLAN API error:", err?.message || err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
