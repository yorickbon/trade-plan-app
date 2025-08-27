// /pages/api/news.ts
import type { NextApiRequest, NextApiResponse } from "next";

type Item = {
  title: string;
  url: string;
  source: string;
  published_at: string; // ISO
  description?: string;
};

// ---- helpers -------------------------------------------------

function parseCurrencies(q: string | string[] | undefined): string[] {
  if (!q) return [];
  const raw = Array.isArray(q) ? q.join(",") : String(q);
  return raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
}

// Coerce various provider date formats to ISO so Date.parse works
function normalizeToISO(s: string): string {
  const t = (s || "").trim();
  if (!t) return "";
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return t; // already ISO
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(t)) return t.replace(" ", "T") + "Z"; // "YYYY-MM-DD HH:mm"
  if (/^\d{10}(\d{3})?$/.test(t)) { // epoch secs/ms
    const ms = t.length === 13 ? Number(t) : Number(t) * 1000;
    return new Date(ms).toISOString();
  }
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

// --------------------------------------------------------------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const currencies = parseCurrencies(req.query.currencies);
  const hours = Math.max(1, Number(req.query.hours ?? 48));
  const max = Math.min(25, Math.max(1, Number(req.query.max ?? (process.env.HEADLINES_MAX ?? 8))));
  const lang = String(process.env.HEADLINES_LANG ?? "en");
  const debug = String(req.query.debug ?? "") === "1";

  // Accept either env var name for safety
  const API_KEY = process.env.NEWSDATA_API_KEY || process.env.NEWS_API_KEY || "";

  if (!API_KEY) {
    return res.status(200).json({
      provider: "newsdata",
      items: [],
      note: "No News API key (NEWSDATA_API_KEY or NEWS_API_KEY). Proceeding with technicals.",
    });
  }

  try {
    // Build a SHORT boolean-OR query
    const synonyms: Record<string, string[]> = {
      USD: ["usd","dollar","greenback","u.s.","us"],
      EUR: ["eur","euro","ecb","eurozone"],
      JPY: ["jpy","yen","boj","bank of japan"],
      GBP: ["gbp","pound","boe","bank of england","sterling"],
      AUD: ["aud","aussie","rba"],
      CAD: ["cad","loonie","boc","bank of canada"],
      NZD: ["nzd","kiwi","rbnz"],
      CHF: ["chf","franc","snb"],
      GOLD:["gold","xauusd","bullion"],
      NAS100:["nasdaq","ndx","nas100"],
      SPX500:["s&p 500","spx","spx500"],
      US30:["dow jones","djia","us30"],
      GER40:["dax","ger40"],
    };

    const terms =
      currencies.length === 0
        ? []
        : currencies.flatMap(c => [c.toLowerCase(), ...(synonyms[c] ?? [])]);

    const core =
      terms.length > 0
        ? terms.map(t => `"${t}"`).join(" OR ")
        : 'forex OR markets OR economy OR "central bank"';

    const q = `${core} OR inflation OR rates OR CPI OR GDP`;

    const sinceMs = Date.now() - hours * 3600_000;

    const url = new URL("https://newsdata.io/api/1/news");
    url.searchParams.set("apikey", API_KEY);
    url.searchParams.set("q", q);
    url.searchParams.set("language", lang);

    const rsp = await fetch(url.toString(), { cache: "no-store" });
    const bodyText = await rsp.text().catch(() => "");
    if (!rsp.ok) {
      if (debug) {
        return res.status(200).json({
          provider: "newsdata",
          debug: { status: rsp.status, url: url.toString(), body: bodyText },
          items: [],
          note: `provider status ${rsp.status}`,
        });
      }
      return res.status(200).json({ provider: "newsdata", items: [], note: `provider status ${rsp.status}` });
    }

    let json: any = {};
    try { json = JSON.parse(bodyText); } catch {}

    const raw: any[] = Array.isArray(json?.results)
      ? json.results
      : Array.isArray(json?.data)
      ? json.data
      : [];

    const items: Item[] = raw
      .map((r: any): Item => ({
        title: String(r?.title ?? r?.name ?? "").trim(),
        url: String(r?.link ?? r?.url ?? "").trim(),
        source: String(r?.source_id ?? r?.source ?? "").trim(),
        published_at: normalizeToISO(String(r?.pubDate ?? r?.published_at ?? r?.date ?? "")),
        description: String(r?.description ?? r?.snippet ?? "").trim(),
      }))
      .filter(it => it.title && it.url)
      .filter(it => {
        const t = Date.parse(it.published_at || "");
        return Number.isFinite(t) ? t >= sinceMs : true;
      })
      .slice(0, max);

    if (debug) {
      return res.status(200).json({
        provider: "newsdata",
        debug: { url: url.toString(), q, currencies },
        count: items.length,
        items,
      });
    }

    return res.status(200).json({ provider: "newsdata", count: items.length, items });
  } catch (err: any) {
    if (debug) {
      return res.status(200).json({
        provider: "newsdata",
        error: err?.message || "fetch failed (caught)",
        items: [],
      });
    }
    return res.status(200).json({ provider: "newsdata", items: [], note: "fetch failed" });
  }
}
