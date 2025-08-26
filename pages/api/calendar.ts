// pages/api/calendar.ts
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { date, currencies } = req.query;
    if (!date || !currencies) {
      return res.status(400).json({ error: "Missing date or currencies" });
    }

    const apiKey = process.env.FMP_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "FMP_API_KEY is not set" });
    }

    const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${date}&to=${date}&apikey=${apiKey}`;

    const response = await fetch(url);
    const data = await response.json();

    // Filter by currencies (EUR, USD, etc.)
    const symbols = (currencies as string).split(",");
    const filtered = data.filter((event: any) =>
      symbols.some((s) => event.currency?.toUpperCase().includes(s.toUpperCase()))
    );

    res.status(200).json({ date, currencies: symbols, events: filtered });
  } catch (err: any) {
    console.error("Calendar API error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}
