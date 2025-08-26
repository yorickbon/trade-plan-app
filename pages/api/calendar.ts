// pages/api/calendar.ts
import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import { parseStringPromise } from "xml2js"; // for XML parsing

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { date, currencies } = req.query;

    const url = process.env.CALENDAR_RSS_URL;
    if (!url) {
      return res.status(500).json({ error: "Missing CALENDAR_RSS_URL env variable" });
    }

    // Fetch XML feed
    const { data } = await axios.get(url);

    // Convert XML -> JSON
    const parsed = await parseStringPromise(data, { explicitArray: false });

    // Depending on feed structure (varies per provider), adjust this:
    const items = parsed?.rss?.channel?.item || [];

    // Filter by currencies (if provided)
    const filterCurrencies = (currencies as string)?.split(",") || [];
    const filtered = items.filter((item: any) =>
      filterCurrencies.some((c) => item.title?.includes(c) || item.description?.includes(c))
    );

    res.status(200).json({ date, count: filtered.length, items: filtered });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || "Calendar fetch error" });
  }
}
