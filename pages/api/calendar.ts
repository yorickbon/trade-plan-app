// pages/api/calendar.ts
import type { NextApiRequest, NextApiResponse } from "next";

// Expected env:
// CALENDAR_RSS_URL = https://nfs.faireconomy.media/ff_calendar_thisweek.json   (or ...today.json / ...tomorrow.json)
// TIMEZONE          (optional, e.g. "Europe/London")

type FFItem = {
  title: string;             // e.g. "German Ifo Business Climate"
  country: string;           // e.g. "EUR", "USD", "GBP", "JPY"
  currency?: string;         // some variants expose currency here
  impact?: string;           // "Low" | "Medium" | "High" | "Holiday"
  date: string;              // "2025-08-26"
  time: string;              // "09:00"
  timestamp?: number;        // (sometimes present)
};

function sameDate(a: string, b: string) {
  // both in YYYY-MM-DD
  return a === b;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { date, currencies = "" } = req.query as { date?: string; currencies?: string };
    if (!date) {
      return res.status(400).json({ error: "Missing ?date=YYYY-MM-DD" });
    }

    // currencies=EUR,USD -> ["EUR","USD"]
    const want = currencies
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    const url = process.env.CALENDAR_RSS_URL ||
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`Calendar HTTP ${r.status}`);
    const json: FFItem[] = await r.json();

    // Normalize & filter
    const items = json
      .map(it => {
        const cur = (it.currency || it.country || "").toUpperCase();
        return {
          title: it.title,
          currency: cur,
          impact: it.impact || "",
          date: it.date,       // already YYYY-MM-DD in this feed
          time: it.time || "",
        };
      })
      .filter(it => sameDate(it.date, date))
      .filter(it => (want.length ? want.includes(it.currency) : true))
      // Keep only actionable events (optional tweak)
      .filter(it => it.impact.toLowerCase() !== "holiday")
      .slice(0, 25);

    return res.status(200).json({ date, currencies: want, count: items.length, items });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "server error" });
  }
}
