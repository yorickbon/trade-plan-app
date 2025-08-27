// pages/api/news.ts
import type { NextApiRequest, NextApiResponse } from "next";

type Item = {
  title: string;
  url: string;
  source?: string;
  published_at?: string;
  description?: string;
};

// parse ?currencies=USD,JPY -> ["USD","JPY"]
function parseCurrencies(q: string | string[] | undefined): string[] {
  if (!q) return [];
  const raw = Array.isArray(q) ? q.join(",") : String(q);
  return raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
}

// soft trim long strings
function trimToLimit(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const i = cut.lastIndexOf(" ");
  return (i > 40 ? cut.slice(0, i) : cut).trim();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const currencies = parseCurrencies(req.query.currencies);
  const hours = Math.max(1, Number(req.query.hours ?? 48));
  const max = Math.min(25, Math.max(1, Number(req.query.max ?? (process.env.HEADLINES_MAX ?? 8))));
  const lang = String(process.env.HEADLINES_LANG ?? "en");
  const debug = String(req.query.debug ?? "") === "1";

  // Accept either env var name
  const API_KEY =
    process.env.NEWSDATA_API_KEY ||
    process.env.NEWS_API_KEY ||
    "";

  // No key? keep the app alive; planner will trade technicals
  if (!API_KEY) {
    return res.status(200).json({
      provider: "newsdata",
      items: [],
      note: "No News API key (NEWSDATA_API_KEY or NEWS_API_KEY). Proceeding with technicals.",
    });
  }

  try {
    // Build a SHORT query to avoid Newsdata 422 errors
    // If currencies provided -> just the codes (e.g., "USD OR JPY")
    // Else -> tiny macro query
    let q = currencies.length > 0
      ? currencies.join(" OR ")
      : `forex OR economy OR "central bank"`;

    // cap length to be safe
    if (q.length > 120) q = trimToLimit(q, 120);

    const sinceMs = Date.now() - hours * 3600 * 1000;

    const fetchOnce = async (query: string) => {
      const url = new URL("https://newsdata.io/api/1/news");
      url.searchParams.set("apikey", API_KEY);
      url.searchParams.set("q", query);
      url.searchParams.set("language", lang);
      // NOTE: do NOT set "page" on the first call (free plan quirk)

      const rsp = await fetch(url.toString(), { cache: "no-store" });
      const txt = await rsp.text().catch(() => "");
      let json: any;
      try { json = JSON.parse(txt); } catch { json = {}; }

      return { ok: rsp.ok, status: rsp.status, url: url.toString(), body: txt, json };
    };

    // try primary query
    let r = await fetchOnce(q);

    // if provider rejects (422), retry once with ultra-short query
    if (!r.ok && r.status === 422) {
      const ultra = currencies.length > 0 ? currencies[0] : "forex";
      r = await fetchOnce(ultra);
      if (!r.ok && debug) {
        return res.status(200).json({
          provider: "newsdata",
          debug: { url: r.url, status: r.status, body: r.body },
          items: [],
          note: `provider status ${r.status}`,
        });
      }
    }

    if (!r.ok) {
      if (debug) {
        return res.status(200).json({
          provider: "newsdata",
          debug: { url: r.url, status: r.status, body: r.body },
          items: [],
          note: `provider status ${r.status}`,
        });
      }
      return res.status(200).json({ provider: "newsdata", items: [], note: `provider status ${r.status}` });
    }

    const raw: any[] = Array.isArray(r.json?.results)
      ? r.json.results
      : Array.isArray(r.json?.data)
      ? r.json.data
      : [];

    const items: Item[] = raw
      .map((v: any): Item => ({
        title: String(v.title ?? v.name ?? "").trim(),
        url: String(v.link ?? v.url ?? "").trim(),
        source: String(v.source_id ?? v.source ?? "").trim(),
        published_at: String(v.pubDate ?? v.published_at ?? v.date ?? "").trim(),
        description: String(v.description ?? v.snippet ?? "").trim(),
      }))
      .filter(it => it.title && it.url)
      .filter(it => {
        const t = Date.parse(it.published_at ?? "");
        return isFinite(t) ? t >= sinceMs : true;
      })
      .slice(0, max);

    if (debug) {
      return res.status(200).json({
        provider: "newsdata",
        debug: { url: r.url, q },
        count: items.length,
        items,
      });
    }

    return res.status(200).json({ provider: "newsdata", count: items.length, items });
  } catch (err: any) {
    if (debug) {
      return res.status(200).json({ provider: "newsdata", error: err?.message ?? "fetch failed (caught)", items: [] });
    }
    return res.status(200).json({ provider: "newsdata", items: [], note: "fetch failed" });
  }
}
