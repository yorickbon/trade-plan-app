// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import getCandles from "../../lib/prices";

// ---------- Types ----------
type Interval = "4h" | "1h" | "15m";

type Candle = {
  t: string | number | Date;
  o: number;
  h: number;
  l: number;
  c: number;
};

type CalendarItem = {
  time: string;      // ISO
  country: string;
  currency: string;
  impact: string;    // "High" | "Medium" | "Low" | etc
  title: string;
};

type NewsItem = {
  title: string;
  url: string;
  source: string;
  seen?: string;
};

type Candidate = {
  name: "Pullback" | "BOS" | "Breakout";
  direction: "Buy" | "Sell";
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  rationale: string[];
  confluence: string[];
  score: number; // computed
};

// ---------- Helpers ----------
function asNum(n: number) { return Number.isFinite(n) ? n : 0; }

function nDec(price: number): number {
  const p = Math.abs(price);
  if (p >= 1000) return 2;
  if (p >= 100) return 3;
  if (p >= 10) return 4;
  return 5;
}
function fmt(price: number) {
  return asNum(price).toFixed(nDec(price));
}

function atr(candles: Candle[], period = 14) {
  if (candles.length < period + 1) return 0;
  let trs: number[] = [];
  for (let i = 1; i < Math.min(candles.length, period + 1); i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(
      c.h - c.l,
      Math.abs(c.h - p.c),
      Math.abs(c.l - p.c)
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function last(c: Candle[]) { return c[c.length - 1]; }

function findSwings(c: Candle[], lookback = 40) {
  const hiIdxs: number[] = [];
  const loIdxs: number[] = [];
  for (let i = 1; i < Math.min(c.length - 1, lookback); i++) {
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

// quick 3-candle FVG near price
function hasFVGNear(c: Candle[], price: number, tol: number) {
  for (let i = 2; i < c.length; i++) {
    const a = c[i - 2], b = c[i - 1], d = c[i];
    // bullish fvg: a.h < d.l and b.l > a.h
    const bull = a.h < d.l && Math.abs((a.h + d.l) / 2 - price) <= tol;
    // bearish fvg: a.l > d.h and b.h < a.l
    const bear = a.l > d.h && Math.abs((a.l + d.h) / 2 - price) <= tol;
    if (bull || bear) return true;
  }
  return false;
}

function nearestStructure(c: Candle[], price: number, tol: number) {
  // look for any swing high/low near price
  for (let i = 1; i < c.length - 1; i++) {
    const isHi = c[i].h > c[i - 1].h && c[i].h > c[i + 1].h;
    const isLo = c[i].l < c[i - 1].l && c[i].l < c[i + 1].l;
    const lvl = isHi ? c[i].h : isLo ? c[i].l : null;
    if (lvl !== null && Math.abs(lvl - price) <= tol) {
      return lvl;
    }
  }
  return null;
}

function compressRatio(c: Candle[], bars = 20) {
  const seg = c.slice(-bars);
  const hi = Math.max(...seg.map(x => x.h));
  const lo = Math.min(...seg.map(x => x.l));
  const rng = hi - lo;
  const segAtr = atr(seg, Math.min(14, seg.length - 1));
  return segAtr ? rng / segAtr : Infinity; // smaller is tighter
}

// ---------- Main handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { instrument, date } = req.body as { instrument: string; date: string };

    if (!instrument) {
      return res.status(400).json({ error: "Missing instrument" });
    }

    // 1) Pull live candles
    const [h4, h1, m15] = await Promise.all([
      getCandles(instrument, "4h", 200),
      getCandles(instrument, "1h", 200),
      getCandles(instrument, "15m", 220),
    ]);

    if (!m15?.length || !h1?.length || !h4?.length) {
      return res.status(500).json({ error: "No candles returned" });
    }

    const last15 = last(m15);
    const p = last15?.c ?? 0;
    const vol = atr(m15, 14) || 0.0005; // fallback

    // 2) Calendar + Headlines (optional)
    const base =
      process.env.NEXT_PUBLIC_BASE_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

    // Try to infer currencies from instrument code (simple guess)
    const guessCurrencies = instrument.toUpperCase().includes("USD") ? ["USD"] : [];
    if (instrument.toUpperCase().includes("EUR")) guessCurrencies.push("EUR");
    if (instrument.toUpperCase().includes("GBP")) guessCurrencies.push("GBP");
    if (instrument.toUpperCase().includes("JPY")) guessCurrencies.push("JPY");
    if (instrument.toUpperCase().includes("XAU")) guessCurrencies.push("USD"); // gold = USD sensitivity

    let cal: CalendarItem[] = [];
    let news: NewsItem[] = [];

    try {
      const cRes = await fetch(
        `${base}/api/calendar?date=${encodeURIComponent(date || new Date().toISOString().slice(0, 10))}&currencies=${encodeURIComponent(guessCurrencies.join(","))}`
      );
      if (cRes.ok) {
        const cj = await cRes.json();
        cal = cj?.items ?? [];
      }
    } catch {}

    try {
      const nRes = await fetch(
        `${base}/api/news?q=${encodeURIComponent(guessCurrencies.join(" OR "))}&sinceHours=24`
      );
      if (nRes.ok) {
        const nj = await nRes.json();
        news = nj?.items ?? [];
      }
    } catch {}

    const highImpactSoon =
      cal?.some((e) => /high/i.test(e.impact)) || false;

    const headlinePing =
      news?.slice(0, 3).map((n) => `${n.source}: ${n.title}`) ?? [];

    // 3) Build candidates

    // 3a) Pullback (Fib + confluence) from the last impulse on 15m
    const { lastHi, lastLo } = findSwings(m15, 80);
    let pullback: Candidate | null = null;
    if (lastHi !== -1 && lastLo !== -1) {
      // Determine last impulse direction: whichever swing is later
      const longImpulse = lastHi < lastLo; // last swing is a Low -> up impulse
      const hi = longImpulse ? m15[lastHi].h : Math.max(...m15.slice(lastLo).map(x => x.h));
      const lo = longImpulse ? Math.min(...m15.slice(lastHi).map(x => x.l)) : m15[lastLo].l;

      const F = longImpulse ? fibs(hi, lo) : fibs(lo, hi);
      // Golden pocket
      const z1 = longImpulse ? F["0.618"] : F["0.382"];
      const z2 = longImpulse ? F["0.705"] : F["0.618"];
      const zoneMid = (z1 + z2) / 2;

      const tol = vol * 1.2;
      const hasFVG = hasFVGNear(m15, zoneMid, tol);
      const strLvl = nearestStructure(m15, zoneMid, tol);
      const conf: string[] = [];
      if (hasFVG) conf.push("FVG near zone");
      if (strLvl !== null) conf.push("Structure near zone");
      conf.push("Fib GP confluence");

      const dir: "Buy" | "Sell" = longImpulse ? "Buy" : "Sell";
      const entry = zoneMid;
      const stop = longImpulse ? Math.min(lo, entry - 1.5 * vol) : Math.max(hi, entry + 1.5 * vol);
      const rr = 1.2;
      const tp1 = dir === "Buy" ? entry + rr * (entry - stop) : entry - rr * (stop - entry);
      const tp2 = dir === "Buy" ? entry + 2 * (entry - stop) : entry - 2 * (stop - entry);

      // score: confluence + distance (prefer entries not too far)
      let score = 60 + conf.length * 10;
      const dist = Math.abs(entry - p);
      if (dist < 0.5 * vol) score += 10;
      if (dist > 2.5 * vol) score -= 10;

      if (highImpactSoon) score -= 15;

      pullback = {
        name: "Pullback",
        direction: dir,
        entry, stop, tp1, tp2,
        rationale: [
          `Use ${dir.toLowerCase()} limit at Fib golden pocket.`,
          `Impulse identified on 15m (${longImpulse ? "up" : "down"}).`,
        ],
        confluence: conf,
        score,
      };
    }

    // 3b) BOS + Retest
    let bos: Candidate | null = null;
    {
      // previous swing levels
      const sw = findSwings(m15, 60);
      let dir: "Buy" | "Sell" | null = null;
      let level: number | null = null;

      if (sw.lastHi !== -1 && last15.c > m15[sw.lastHi].h) {
        dir = "Buy";
        level = m15[sw.lastHi].h;
      } else if (sw.lastLo !== -1 && last15.c < m15[sw.lastLo].l) {
        dir = "Sell";
        level = m15[sw.lastLo].l;
      }

      if (dir && level) {
        const entry = level; // retest
        const stop = dir === "Buy" ? entry - 1.5 * vol : entry + 1.5 * vol;
        const tp1 = dir === "Buy" ? entry + 1.2 * (entry - stop) : entry - 1.2 * (stop - entry);
        const tp2 = dir === "Buy" ? entry + 2 * (entry - stop) : entry - 2 * (stop - entry);

        let score = 55;
        // if we actually broke on multiple TFs (confirm with 1h)
        const h1Sw = findSwings(h1, 80);
        if (dir === "Buy" && h1Sw.lastHi !== -1 && last(h1).c > h1[h1Sw.lastHi].h) score += 10;
        if (dir === "Sell" && h1Sw.lastLo !== -1 && last(h1).c < h1[h1Sw.lastLo].l) score += 10;
        if (highImpactSoon) score -= 10;

        bos = {
          name: "BOS",
          direction: dir,
          entry, stop, tp1, tp2,
          rationale: [
            `Recent break of structure (${dir === "Buy" ? "above prior swing high" : "below prior swing low"}).`,
            `Plan retest of broken level for entry.`,
          ],
          confluence: ["Structure retest", "Multi-TF confirmation (where present)"],
          score,
        };
      }
    }

    // 3c) Range Breakout (only if compression is tight)
    let breakout: Candidate | null = null;
    {
      const ratio = compressRatio(m15, 24); // smaller -> tighter range
      if (ratio < 1.6) {
        const seg = m15.slice(-24);
        const hi = Math.max(...seg.map(x => x.h));
        const lo = Math.min(...seg.map(x => x.l));
        const dir: "Buy" | "Sell" = p > (hi + lo) / 2 ? "Buy" : "Sell";

        const entry = dir === "Buy" ? hi + 0.25 * vol : lo - 0.25 * vol; // stop order
        const stop = dir === "Buy" ? entry - 1.2 * vol : entry + 1.2 * vol;
        const tp1 = dir === "Buy" ? entry + 1.2 * (entry - stop) : entry - 1.2 * (stop - entry);
        const tp2 = dir === "Buy" ? entry + 2.0 * (entry - stop) : entry - 2.0 * (stop - entry);

        let score = 50;
        if (highImpactSoon) score -= 10;

        breakout = {
          name: "Breakout",
          direction: dir,
          entry, stop, tp1, tp2,
          rationale: ["Tight range; plan stop-order breakout play."],
          confluence: ["Range compression"],
          score,
        };
      }
    }

    const candidates = [pullback, bos, breakout].filter(Boolean) as Candidate[];
    if (!candidates.length) {
      return res.status(200).json({
        instrument,
        date,
        plan: { text: "No Trade.", strategy: "None", conviction: 0 },
        meta: { calendar: cal?.length || 0, headlines: news?.length || 0 }
      });
    }

    // pick best
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // conviction from score (bounded)
    let conviction = Math.max(0, Math.min(95, Math.round(best.score)));
    if (highImpactSoon) conviction = Math.max(20, Math.min(conviction, 70));

    // Calendar / headlines notes
    const calNote = cal?.length
      ? `Calendar: ${cal.length} item(s) today${highImpactSoon ? " (high impact present)" : ""}.`
      : "Calendar: no matching items.";
    const newsNote = news?.length
      ? `Headlines scanned: ${news.length}. Top: ${headlinePing.join(" | ")}`
      : "Headlines scanned: none matched keywords.";

    // 4) Build final trade card text (readable for your UI)
    const lines: string[] = [];
    lines.push(`**Trade Card: ${instrument}**`);
    lines.push("");
    lines.push(`**Strategy:** ${best.name}`);
    lines.push(`**Direction:** ${best.direction}`);
    lines.push(`**Entry:** ${fmt(best.entry)}`);
    lines.push(`**Stop:** ${fmt(best.stop)}`);
    lines.push(`**TP1:** ${fmt(best.tp1)}`);
    lines.push(`**TP2:** ${fmt(best.tp2)}`);
    lines.push(`**Conviction %:** ${conviction}%`);
    lines.push("");
    lines.push(`**Why this setup (auto):**`);
    best.rationale.forEach(r => lines.push(`- ${r}`));
    if (best.confluence.length) {
      lines.push(`- Confluence: ${best.confluence.join(", ")}`);
    }
    lines.push("");
    lines.push(`**Timeframe Alignment (auto):** 4H / 1H / 15M checked for impulse, BOS, and range conditions.`);
    lines.push("");
    lines.push(`**Invalidation Note:** If price closes beyond the stop, setup is invalidated (no chase).`);
    lines.push("");
    lines.push(`**Risk Notice:** ${calNote}`);
    lines.push(`**News Note:** ${newsNote}`);
    if (highImpactSoon) {
      lines.push(`**Caution:** Upcoming high-impact event detected — consider waiting for post-event retest before executing.`);
    }

    // include alternatives (short)
    const alts = candidates.slice(1).map(c => ({
      strategy: c.name,
      dir: c.direction,
      entry: Number(fmt(c.entry)),
      stop: Number(fmt(c.stop)),
      tp1: Number(fmt(c.tp1)),
      tp2: Number(fmt(c.tp2)),
      score: c.score
    }));

    // Optional: also ask GPT to lightly polish the English (kept OFF by default to save tokens)
    // If you want it on, set OPENAI_POLISH=true in env.
    let finalText = lines.join("\n");
    if (process.env.OPENAI_POLISH === "true" && process.env.OPENAI_API_KEY) {
      try {
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
        const rsp = await client.chat.completions.create({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0.2,
          messages: [
            { role: "system", content: "Polish the trading card for clarity. Keep all numbers unchanged. Output plain text only." },
            { role: "user", content: finalText }
          ]
        });
        const polished = rsp.choices?.[0]?.message?.content?.trim();
        if (polished) finalText = polished;
      } catch {
        // ignore polish failure
      }
    }

    return res.status(200).json({
      instrument,
      date,
      plan: {
        strategy: best.name,
        conviction,
        text: finalText
      },
      meta: {
        price: p,
        calendarCount: cal?.length || 0,
        headlinesCount: news?.length || 0,
        alternatives: alts
      }
    });

  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
