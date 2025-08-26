// pages/api/calendar.ts
import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { date, currencies } = req.query;

  try {
    // Trading Economics free (guest login)
    const username = process.env.TE_API_USER || "guest";
    const password = process.env.TE_API_PASS || "guest";

    // Build URL
    const url = `https://api.tradingeconomics.com/calendar?d=${date}&c=${currencies}`;

    const response = await axios.get(url, {
      auth: { username, password }
    });

    res.status(200).json(response.data);
  } catch (err: any) {
    console.error("Calendar API error:", err.message);
    res.status(500).json({ error: err.message || "Calendar fetch failed" });
  }
}
