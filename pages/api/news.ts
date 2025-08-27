// /pages/api/news.ts
import type { NextApiRequest, NextApiResponse } from "next";

type Item = {
  title: string;
  url: string;
  source?: string;
  published_at?: string;
  description?: string;
};

// Parse comma/array into upper-case tokens, e.g. "eur,usd" -> ["EUR","USD"]
function parseCurrencies(q: string | string[] | undefined): string[] {
  if (!q) return [];
  const raw = Array.isArray(q) ? q.join(",") : String(q);
  return raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
}

// Helper: trim a query string to a max length, cutting at a word boundary if possible
function trimToLimit(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 50 ? cut.slice(0, lastSpace) : cut).trim();
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

  // No key: don't 500 the app, just return empty with a note
  if (!API_KEY) {
    return res.status(200).json({
      provider: "newsdata",
      items: [],
      note: "No News API key detected (NEWSDATA_API_KEY or NEWS_API_KEY). Trading will proceed on technicals.",
    });
  }

  try {
    // --- Synonyms: FX, metals, indices ---
    const synonyms: Record<string, string[]> = {
      USD: ["usd", "dollar", "greenback", "us"],
      EUR: ["eur", "euro", "ecb", "eurozone"],
      GBP: ["gbp", "pound", "boe", "bank of england", "sterling"],
      JPY: ["jpy", "yen", "boj", "bank of japan"],
      AUD: ["aud", "aussie", "rba"],
      NZD: ["nzd", "kiwi", "rbnz"],
      CAD: ["cad", "loonie", "boc", "bank of canada"],
      CHF: ["chf", "franc", "snb"],

      GOLD: ["gold", "xauusd", "bullion"],
      NAS100: ["nasdaq", "ndx", "nas100"],
      SPX500: ["s&p 500", "spx", "spx500"],
      US30: ["dow jones", "djia", "us30"],
      GER40: ["dax", "ger40"],
    };

    // Build candidate terms from currencies (if provided)
    const terms: string[] =
      currencies.length === 0
        ? [] // no filter -> we'll search broad macro words below
        : currencies.flatMap((c) => [c.toLowerCase(), ...(synonyms[c] ?? [])]);

    // Build the core boolean-OR query part
    const core = terms.length > 0 ? terms.map((t) => `${t}`).join(" OR ") : "";
    // Base macro context to bias results
    const macroTail = `forex OR markets OR economy OR "central bank" OR inflation OR rates OR CPI OR GDP`;

    // First attempt: full query (may be long)
    let q = core ? `${core} OR ${macroTail}` : macroTail;

    // If too long for Newsdata (they error ~100 chars), fallback to short code query
    // We target ~90 to be safe, then trim softly.
    if (q.length > 90 && currencies.length > 0) {
      const shortCodes = currencies.join(" OR ");
      q = `${shortCodes} OR ${macroTail}`;
    }
    if (q.length > 120) {
      q = trimToLimit(q, 120);
    }

    const sinceMs = Date.now() - hours * 3600 * 1000;

    // Small helper to fetch with a given q
    const fetchOnce = async (query: string) => {
      const url = new URL("https://newsdata.io/api/1/news");
      url.searchParams.set("apikey", API_KEY);
      url.searchParams.set("q", query); // IMPORTANT: use q, not country
      url.searchParams.set("language", lang);
      url.searchParams.set("page", "1");

      const rsp = await fetch(url.toString(), { cache: "no-store" });
      const bodyText = await rsp.text().catch(() => "");

      if (!rsp.ok) {
        // Surface provider errors (e.g., 422) without throwing
        return {
          ok: false,
          status: rsp.status,
          bodyText,
          url: url.toString(),
          json: null as any,
        };
      }

      let json: any = {};
      try {
        json = JSON.parse(bodyText);
      } catch {
        json = {};
      }

      return { ok: true, status: rsp.status, bodyText, url: url.toString(), json };
    };

    // Attempt 1: use (possibly long) query
    let r1 = await fetchOnce(q);

    // If provider says 422 (query too long / unsupported), retry once with a very short query
    if (!r1.ok && r1.status === 422) {
      const ultraShort =
        currencies.length > 0 ? currencies.join(" OR ") : `forex OR economy`;
      r1 = await fetchOnce(ultraShort);
      if (!r1.ok && debug) {
        return res.status(200).json({
          provider: "newsdata",
          debug: { url: r1.url, status: r1.status, body: r1.bodyText },
          items: [],
          note: `provider status ${r1.status}`,
        });
      }
    }

    if (!r1.ok) {
      // Other provider error
      if (debug) {
        return res.status(200).json({
          provider: "newsdata",
          debug: { url: r1.url, status: r1.status, body: r1.bodyText },
          items: [],
          note: `provider status ${r1.status}`,
        });
      }
      return res.status(200).json({ provider: "newsdata", items: [], note: `provider status ${r1.status}` });
    }

    // Map items
    const raw: any[] = Array.isArray(r1.json?.results)
      ? r1.json.results
      : Array.isArray(r1.json?.data)
      ? r1.json.data
      : [];

    const items: Item[] = raw
      .map((r: any): Item => ({
        title: String(r.title ?? r?.name ?? "").trim(),
        url: String(r.link ?? r.url ?? "").trim(),
        source: String(r.source_id ?? r?.source ?? "").trim(),
        published_at: String(r.pubDate ?? r.published_at ?? r?.date ?? "").trim(),
        description: String(r.description ?? r?.snippet ?? "").trim(),
      }))
      .filter((it) => it.title && it.url)
      // Client-side time filter (best-effort on free plan)
      .filter((it) => {
        const t = Date.parse(it.published_at ?? "");
        return isFinite(t) ? t >= sinceMs : true;
      })
      .slice(0, max);

    if (debug) {
      return res.status(200).json({
        provider: "newsdata",
        debug: { url: r1.url, q },
        count: items.length,
        items,
      });
    }

    return res.status(200).json({ provider: "newsdata", count: items.length, items });
  } catch (err: any) {
    // Never crash the planner if the provider hiccups
    if (String(req.query.debug ?? "") === "1") {
      return res
        .status(200)
        .json({ provider: "newsdata", error: err?.message ?? "fetch failed (caught)", items: [] });
    }
    return res.status(200).json({ provider: "newsdata", items: [], note: "fetch failed" });
  }
}
