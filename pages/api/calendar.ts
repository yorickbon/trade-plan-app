// pages/api/calendar.ts
import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { date, currencies } = req.query;

    if (!date) {
      return res.status(400).json({ error: "Missing ?date=YYYY-MM-DD" });
    }

    const apiKey = process.env.FMP_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "FMP_API_KEY not set in environment" });
    }

    // Fetch economic calendar from FMP
    const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${date}&to=${date}&apikey=${apiKey}`;
    const { data } = await axios.get(url);

    // Optional currency filter (e.g. EUR,USD)
    let events = data;
    if (currencies) {
      const list = (currencies as string).split(",").map(s => s.trim().toUpperCase());
      events = data.filter((e: any) =>
        list.includes(e.currency?.toUpperCase())
      );
    }

    res.status(200).json(events);
  } catch (err: any) {
    console.error("Calendar API error:", err.message || err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}
