// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import getCandles from "../../lib/prices";

type Candle = { datetime: string; open: number; high: number; low: number; close: number };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- helpers ---
function parseCurrencies(code: string): string[] {
  const m = code.match(/^([A-Z]{3})([A-Z]{3})$/);
  if (!m) return [];
  return [m[1], m[2]];
}

function anyHighImpactSoon(calendar: any[], minutes = 90): boolean {
  const now = Date.now();
  const horizon = now + minutes * 60 * 1000;
  return (calendar || []).some((ev: any) => {
    if (!ev?.time || !ev?.impact) return false;
    const t = new Date(ev.time).getTime();
    return ev.impact?.toLowerCase() === "high" && t >= now && t <= horizon;
  });
}

function fmtHeadlinesForPrompt(items: { title: string; source: string; published_at: string }[]) {
  if (!items?.length) return "None in the last window.";
  return items
    .map(
      (h) =>
        `• ${h.title} — ${h.source} (${new Date(h.published_at).toISOString().slice(0, 16).replace("T", " ")})`
    )
    .join("\n");
}

async function getHeadlines(query: string): Promise<{ title: string; source: string; url: string; published_at: string }[]> {
  const provider = (process.env.NEWS_API_PROVIDER || "").toLowerCase();
  const apiKey = process.env.NEWS_API_KEY || "";
  const lang = process.env.HEADLINES_LANG || "en";
  const hours = parseInt(process.env.HEADLINES_SINCE_HOURS || "48", 10);
  const limit = parseInt(process.env.HEADLINES_MAX || "8", 10);

  if (!provider || !apiKey) return [];

  const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  if (provider === "newsdata") {
    const url = new URL("https://newsdata.io/api/1/news");
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("q", query);
    url.searchParams.set("language", lang);
    url.searchParams.set("category", "business,politics,world");
    url.searchParams.set("page", "1");

    try {
      const r = await fetch(url.toString(), { timeout: 20_000 as any });
      if (!r.ok) return [];
      const data = await r.json();
      const raw = Array.isArray(data?.results) ? data.results : [];
      return raw
        .map((it: any) => ({
          title: String(it?.title || "").trim(),
          source: String(it?.source_id || it?.source || "Unknown"),
          url: String(it?.link || it?.url || "#"),
          published_at: new Date(it?.pubDate || it?.pub_date || Date.now()).toISOString(),
        }))
        .filter((h: any) => new Date(h.published_at).getTime() >= new Date(sinceIso).getTime())
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  return [];
}

function lastClose(arr: Candle[] | null | undefined): number | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return Number(arr[arr.length - 1]?.close ?? null);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { instrument, date, calendar = [] } = req.body as {
      instrument: string; // e.g., "EURUSD"
      date: string;       // "YYYY-MM-DD"
      calendar?: any[];
    };

    if (!instrument || !date) {
      return res.status(400).json({ error: "instrument and date are required" });
    }

    // 1) Fetch live candles (structure context)
    const [h4, h1, m15] = await Promise.all([
      getCandles(instrument, "4h", 200),
      getCandles(instrument, "1h", 200),
      getCandles(instrument, "15m", 200),
    ]);

    const price = lastClose(m15) ?? lastClose(h1) ?? lastClose(h4) ?? 0;

    // 2) News blackout guard (90m) using provided calendar (client fetches /api/calendar)
    if (anyHighImpactSoon(calendar, 90)) {
      return res.status(200).json({
        instrument,
        date,
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        reply: "No Trade.",
        reason: "High-impact event in the next 90 minutes.",
        plan: { text: "", conviction: null, fundamentals: { calendarSummary: "", headlines: [] } },
      });
    }

    // 3) Headlines (last 48h)
    const currencies = parseCurrencies(instrument);
    const q = currencies.length ? currencies.join(" OR ") : instrument;
    const headlines = await getHeadlines(q);

    // 4) Build GPT system prompt
    const system = [
      "You are a senior FX trader.",
      "Craft **one** precise trade setup using ONLY the candles provided.",
      "Hard rules:",
      "- Use the current price as anchor; levels must be realistic and near recent structure.",
      "- Output *one* of {Pullback, BOS/Breakout, Range Fade, Reversal}.",
      "- Provide: Type, Direction, Entry, Stop, TP1, TP2, Conviction%, Reasoning.",
      "- Add 'Timeframe Alignment' note (4H vs 1H vs 15m).",
      "- Add 'Invalidation Notes' (exactly what breaks the idea).",
      "- If information is unclear: reply 'No Trade'.",
      "",
      "Calendar (filtered for this instrument's currencies):",
      Array.isArray(calendar) && calendar.length
        ? calendar
            .slice(0, 6)
            .map((ev: any) => `• ${ev.time} ${ev.country} ${ev.title} (impact: ${ev.impact || "n/a"})`)
            .join("\n")
        : "• None found.",
      "",
      "Recent headlines (last window):",
      fmtHeadlinesForPrompt(headlines),
      "",
      "Incorporate fundamentals ONLY if materially relevant (CB policy, CPI, jobs, geopolitics). If headlines conflict with the tech setup, lower conviction and note it."
    ].join("\n");

    const user = {
      instrument,
      date,
      currentPrice: price,
      candles: {
        h4: h4?.slice(-200) ?? [],
        h1: h1?.slice(-200) ?? [],
        m15: m15?.slice(-200) ?? [],
      },
    };

    // 5) Call GPT
    const rsp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content:
            "Return a clean trade card in plain text. Keep numbers to typical market precision (pips). If no trade, say 'No Trade'.",
        },
        { role: "user", content: JSON.stringify(user) },
      ],
    });

    const text = rsp.choices?.[0]?.message?.content?.trim() || "No Trade.";
    // simple conviction parse if present like "Conviction %: 75%"
    const cvMatch = text.match(/Conviction\s*%?:\s*(\d+)%/i);
    const conviction = cvMatch ? Number(cvMatch[1]) : null;

    return res.status(200).json({
      instrument,
      date,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      reply: text,
      plan: {
        text,
        conviction,
        fundamentals: {
          calendarSummary: Array.isArray(calendar) ? `${calendar.length} item(s)` : "0",
          headlines: headlines.slice(0, 8),
        },
      },
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
