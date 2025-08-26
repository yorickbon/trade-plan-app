// pages/api/calendar.ts
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { date, currencies } = req.query;
    if (!date) {
      return res.status(400).json({ error: "Missing date" });
    }

    const apiKey = process.env.FMP_API_KEY; // <-- Make sure you added this in Vercel env
    if (!apiKey) {
      return res.status(500).json({ error: "Missing FMP_API_KEY in environment" });
    }

    // Get events for the selected date (FMP needs a from/to range)
    const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${date}&to=${date}&apikey=${apiKey}`;
    const rsp = await fetch(url);
    const data = await rsp.json();

    // Optional: filter by currencies passed in query (?currencies=EUR,USD)
    let events = data;
    if (currencies) {
      const list = (currencies as string).split(",").map(s => s.trim().toUpperCase());
      events = data.filter((e: any) =>
        list.includes(e.currency?.toUpperCase())
      );
    }

    res.status(200).json({ date, events });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}
