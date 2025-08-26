// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import getCandles, { Candle } from "../../lib/prices";

type CalItem = {
  date: string;
  currency: string;
  impact: string;
  title: string;
  country?: string;
};
type NewsItem = { title: string; url: string; source: string; publishedAt: string };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function fmtC(c: Candle) {
  // keep both formats for safety
  const close = (c as any).close ?? (c as any).c ?? 0;
  return { t: c.datetime ?? (c as any).t, o: c.open ?? (c as any).o, h: c.high ?? (c as any).h, l: c.low ?? (c as any).l, c: close };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { instrument, date, debug } = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) || {};
    if (!instrument || !date) return res.status(400).json({ error: "instrument and date are required" });

    // 1) Candles (4h, 1h, 15m) — the 15m key must be "15m"
    const [h4, h1, m15] = await Promise.all([
      getCandles(instrument, "4h", 200),
      getCandles(instrument, "1h", 200),
      getCandles(instrument, "15m", 200),
    ]);

    const c15 = Array.isArray(m15) && m15.length ? fmtC(m15[m15.length - 1]) : null;
    const currentPrice = c15 ? c15.c : 0;

    // 2) News blackout (±90 min) from Calendar panel
    // Fetch Calendar + Headlines on server so GPT has fundamentals context
    const calUrl = `${process.env.NEXT_PUBLIC_BASE_URL || ""}/api/calendar?date=${encodeURIComponent(
      date
    )}&currencies=${encodeURIComponent(instrument.slice(0, 3) + "," + instrument.slice(3))}`;
    const newsUrl = `${process.env.NEXT_PUBLIC_BASE_URL || ""}/api/news?q=${encodeURIComponent(instrument)}`;

    const [calRsp, newsRsp] = await Promise.all([fetch(calUrl), fetch(newsUrl)]);
    const calJson = calRsp.ok ? await calRsp.json() : { items: [] as CalItem[] };
    const newsJson = newsRsp.ok ? await newsRsp.json() : { items: [] as NewsItem[] };

    const calendarItems: CalItem[] = Array.isArray(calJson.items) ? calJson.items : [];
    const headlines: NewsItem[] = Array.isArray(newsJson.items) ? newsJson.items.slice(0, 6) : [];

    // 3) System prompt — strict format with proper Setup/Type
    const system = `
You are a trading assistant. Use ONLY the live data provided.
Return a concise trade card in markdown.

Rules:
- Use the current 15m price exactly.
- Identify **Setup** from this controlled list only:
  ["Breakout/BOS","Pullback","Range Play","Trend Continuation","Reversal","Liquidity Grab","Fibonacci Pullback"]
- Direction must be "Buy" or "Sell".
- Entry must be a precise level (price). Stops beyond logical swing/structure/liquidity. TP1 conservative, TP2 stretch.
- Add "Timeframe Alignment" comment (do H4/H1/15m agree? If not, say so and lower conviction).
- Add "Invalidation Notes" (what change kills the idea).
- Use Calendar and Headlines for **fundamental bias** and to warn about risks. If empty, state "No calendar/headlines of note."
- Output fields (exact keys): Instrument, Setup, Direction, Entry, Stop, TP1, TP2, Conviction %, Reasoning, Timeframe Alignment, Invalidation Notes, Headlines Considered.
- Keep it tight—no fluff.`.trim();

    // 4) Build model context
    const context = {
      instrument,
      date,
      currentPrice,
      candles: {
        h4: h4.slice(-120).map(fmtC),
        h1: h1.slice(-120).map(fmtC),
        m15: m15.slice(-120).map(fmtC),
      },
      calendar: calendarItems.map((i) => ({
        time: i.date,
        currency: i.currency,
        impact: i.impact,
        title: i.title,
        country: i.country ?? "",
      })),
      headlines: headlines.map((h) => ({
        title: h.title,
        source: h.source,
        time: h.publishedAt,
      })),
    };

    const rsp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content:
            "Produce the trade card. Use markdown with bullet-like key:value pairs. Be precise with levels.",
        },
        { role: "user", content: JSON.stringify(context) },
      ],
    });

    const text = rsp.choices[0]?.message?.content?.trim() || "No plan.";
    const conviction = (() => {
      const m = text.match(/Conviction\s*%:\s*([0-9]+)%/i);
      return m ? Number(m[1]) : null;
    })();

    return res.status(200).json({
      instrument,
      date,
      plan: { text, conviction },
      used: {
        hasCalendar: calendarItems.length,
        headlines: headlines.length,
      },
      debug: debug ? context : undefined,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
