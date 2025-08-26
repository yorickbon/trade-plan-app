import type { NextApiRequest, NextApiResponse } from "next";

// quick + light RSS parser for ForexFactory feed
async function fetchFF(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();

  // split by <item> … </item>
  const items = xml.split("<item>").slice(1).map(block => {
    const get = (tag: string) => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
    };
    return {
      title: get("title"),          // e.g. "USD - New Home Sales"
      description: get("description"),
      link: get("link"),
      pubDate: get("pubDate"),
    };
  });

  return items;
}

const ALL_CCY = ["USD","EUR","GBP","JPY","AUD","CAD","CHF","NZD","CNY","MXN","ZAR","SEK","NOK"];

function currenciesFromTitle(title: string) {
  const hits: string[] = [];
  for (const c of ALL_CCY) {
    if (new RegExp(`\\b${c}\\b`).test(title)) hits.push(c);
  }
  return hits;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const dateStr = (req.query.date as string) || new Date().toISOString().slice(0,10);
    const wanted = (req.query.currencies as string | undefined)?.split(",").map(s => s.trim().toUpperCase()) ?? [];

    const rssUrl = process.env.CALENDAR_RSS_URL;
    if (!rssUrl) return res.status(200).json({ items: [], note: "No CALENDAR_RSS_URL set" });

    const raw = await fetchFF(rssUrl);

    // filter this week’s events
    const weekStart = new Date(dateStr); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 7);

    const items = raw
      .map(it => {
        const ccyInTitle = currenciesFromTitle(it.title);
        return {
          title: it.title,
          date: it.pubDate,
          link: it.link,
          currencies: ccyInTitle,
        };
      })
      .filter(it => {
        const passCcy = wanted.length ? it.currencies.some(c => wanted.includes(c)) : true;
        const t = it.date ? new Date(it.date) : null;
        const passDate = t ? (t >= weekStart && t < weekEnd) : true;
        return passCcy && passDate;
      })
      .slice(0, 40);

    return res.status(200).json({ items });
  } catch (e: any) {
    return res.status(200).json({ items: [], error: e.message ?? "calendar error" });
  }
}
