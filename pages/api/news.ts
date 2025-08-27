// pages/api/news.ts
import type { NextApiRequest, NextApiResponse } from "next";

type Item = {
  title: string;
  url: string;
  source?: string;
  published_at?: string;
  description?: string;
};

function parseCurrencies(q: string | string[] | undefined): string[] {
  if (!q) return [];
  const raw = Array.isArray(q) ? q.join(",") : String(q);
  return raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const currencies = parseCurrencies(req.query.currencies);
  const hours = Math.max(1, Number(req.query.hours ?? 48));
  const max = Math.min(25, Math.max(1, Number(req.query.max ?? process.env.HEADLINES_MAX ?? 8)));
  const lang = String(process.env.HEADLINES_LANG ?? "en");
  const debug = String(req.query.debug ?? "") === "1";

  const provider = (process.env.NEWS_API_PROVIDER ?? "newsdata").toLowerCase();

  // Accept either env var name
  const API_KEY =
    process.env.NEWSDATA_API_KEY ||
    process.env.NEWS_API_KEY || "";

  // If no key, don’t 500 — just return an empty list with a note
  if (!API_KEY) {
    return res.status(200).json({
      provider,
      items: [],
      note: "No news API key detected (NEWSDATA_API_KEY or NEWS_API_KEY). Trading will proceed on technicals.",
    });
  }

  try {
    // Build a query string for newsdata.io
    // Docs: https://newsdata.io/  (apikey, q, language, page)
    const synonyms: Record<string, string[]> = {
      USD: ["usd","dollar","greenback","u.s.","us "],
      EUR: ["eur","euro","ecb","eurozone"],
      JPY: ["jpy","yen","boj","bank of japan"],
      GBP: ["gbp","pound","boe","bank of england","sterling"],
      AUD: ["aud","aussie","rba"],
      CAD: ["cad","loonie","boc","bank of canada"],
      NZD: ["nzd","kiwi","rbnz"],
      CHF: ["chf","franc","snb"],
    };

    const terms: string[] =
      currencies.length === 0
        ? [] // no filter -> broad market headlines
        : currencies.flatMap(c => [c.toLowerCase(), ...(synonyms[c] ?? [])]);

    // Simple boolean OR query; newsdata treats spaces as AND, so join with OR
    const q = terms.length ? terms.map(t => `"${t}"`).join(" OR ") : "markets OR economy OR central bank";

    const sinceMs = Date.now() - hours * 3600 * 1000;
    // newsdata.io doesn’t have a strict "since" param on free plan; we’ll filter client-side

    const url = new URL("https://newsdata.io/api/1/news");
    url.searchParams.set("apikey", API_KEY);
    url.searchParams.set("q", q);
    url.searchParams.set("language", lang);
    url.searchParams.set("page", "1");

    const rsp = await fetch(url.toString(), { cache: "no-store" });
    if (!rsp.ok) {
      const text = await rsp.text().catch(() => "");
      if (debug) {
        return res.status(200).json({
          provider, debug: { url: url.toString(), status: rsp.status, body: text },
          items: []
        });
      }
      return res.status(200).json({ provider, items: [], note: `provider status ${rsp.status}` });
    }

    const json: any = await rsp.json();
    const raw: any[] = Array.isArray(json?.results) ? json.results : Array.isArray(json?.data) ? json.data : [];

    const items: Item[] = raw
      .map((r: any) => ({
        title: String(r.title ?? r?.name ?? "").trim(),
        url: String(r.link ?? r.url ?? ""),
        source: String(r.source_id ?? r.source ?? "").trim(),
        published_at: String(r.pubDate ?? r.published_at ?? r.date ?? "").trim(),
        description: String(r.description ?? r.snippet ?? "").trim(),
      }))
      .filter(it => it.title && it.url)
      .filter(it => {
        // client-side time filter (best-effort)
        const t = Date.parse(it.published_at ?? "");
        return isFinite(t) ? t >= sinceMs : true;
      })
      .slice(0, max);

    if (debug) {
      return res.status(200).json({
        provider,
        debug: { url: url.toString(), q, currencies },
        count: items.length,
        items,
      });
    }

    return res.status(200).json({ provider, count: items.length, items });
  } catch (err: any) {
    // Don’t crash the planner if the provider has a hiccup
    if (debug) {
      return res.status(200).json({ provider, error: err?.message || "fetch failed (caught)", items: [] });
    }
    return res.status(200).json({ provider, items: [], note: "fetch failed" });
  }
}
