// /pages/api/news.ts
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
  return raw
    .split(",")
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
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
    process.env.NEWS_API_KEY ||
    "";

  // If no key, don't 500 — return empty and let planner trade technicals
  if (!API_KEY) {
    return res.status(200).json({
      provider,
      items: [],
      note: "No News API key detected (NEWSDATA_API_KEY or NEWS_API_KEY). Trading will proceed on technicals.",
    });
  }

  // ------------------ currency synonyms (short & index/metal) ------------------
  const synonyms: Record<string, string[]> = {
    USD: ["usd", "dollar", "greenback", "us $", "us$"],
    EUR: ["eur", "euro", "ecb", "eurozone"],
    JPY: ["jpy", "yen", "boj", "bank of japan"],
    GBP: ["gbp", "pound", "boe", "bank of england", "sterling"],
    AUD: ["aud", "aussie", "rba"],
    CAD: ["cad", "loonie", "boc", "bank of canada"],
    NZD: ["nzd", "kiwi", "rbnz"],
    CHF: ["chf", "franc", "snb"],
    GOLD: ["gold", "xauusd", "bullion"],
    NAS100: ["nasdaq", "ndx", "nas100"],
    SPX500: ["s&p 500", "spx", "spx500"],
    US30: ["dow jones", "djia", "us30"],
    GER40: ["dax", "ger40"],
  };

  // -------------- build terms (short when many currencies selected) ------------
  const terms: string[] =
    currencies.length > 1
      ? currencies.map(c => c.toLowerCase())
      : currencies.flatMap(c => [c.toLowerCase(), ...(synonyms[c] ?? [])]);

  // Build a q under Newsdata's 100-char limit
  function buildQueryWithinLimit(core: string, extraTerms: string[], maxLen = 95): string {
    // q = "<core> OR <extra1> OR <extra2> ..."
    let q = core;
    for (const t of extraTerms) {
      const next = q.length === 0 ? t : `${q} OR ${t}`;
      if (next.length > maxLen) break;
      q = next;
    }
    return q;
  }

  // We bias for macro context; extras (currency codes/synonyms) are appended as space allows
  const macroCore = 'markets OR economy OR "central bank" OR inflation OR rates OR CPI OR GDP';

  async function requestNews(q: string) {
    const url = new URL("https://newsdata.io/api/1/news");
    url.searchParams.set("apikey", API_KEY);
    url.searchParams.set("q", q);
    url.searchParams.set("language", lang);
    url.searchParams.set("page", "1"); // free plan pagination: we only use first page

    const rsp = await fetch(url.toString(), { cache: "no-store" });
    const status = rsp.status;
    const bodyText = await rsp.text().catch(() => "");
    let json: any = null;
    try { json = JSON.parse(bodyText); } catch {}

    return { ok: rsp.ok, status, url: url.toString(), bodyText, json };
  }

  // First attempt: macro + (shortened) terms
  let q = buildQueryWithinLimit(macroCore, terms);
  let first = await requestNews(q);

  // If provider rejects with 422 (e.g., “query too long” or invalid filter),
  // retry once with codes-only, then once with macro-only.
  if (!first.ok && first.status === 422) {
    // Retry 1: codes-only (no synonyms)
    const codesOnly = currencies.map(c => c.toLowerCase());
    const qShort = buildQueryWithinLimit(macroCore, codesOnly);
    first = await requestNews(qShort);

    if (!first.ok && first.status === 422) {
      // Retry 2: macro-only, no currency filter
      first = await requestNews(macroCore);
    }
  }

  // Provider returned a non-OK that we didn’t handle
  if (!first.ok) {
    const note = `provider status ${first.status}`;
    if (debug) {
      return res.status(200).json({
        provider,
        debug: { url: first.url, status: first.status, body: first.bodyText },
        items: [],
        note,
      });
    }
    return res.status(200).json({ provider, items: [], note });
  }

  // Parse payload
  const raw: any[] = Array.isArray(first.json?.results)
    ? first.json.results
    : Array.isArray(first.json?.data)
    ? first.json.data
    : [];

  const sinceMs = Date.now() - hours * 3600 * 1000;

  const items: Item[] = raw
    .map((r: any): Item => ({
      title: String(r.title ?? r.name ?? "").trim(),
      url: String(r.link ?? r.url ?? "").trim(),
      source: String(r.source_id ?? r.source ?? "").trim(),
      published_at: String(r.pubDate ?? r.published_at ?? r.date ?? "").trim(),
      description: String(r.description ?? r.snippet ?? "").trim(),
    }))
    .filter(it => it.title && it.url)
    // best-effort time filter on free plan
    .filter(it => {
      const t = Date.parse(it.published_at ?? "");
      return Number.isFinite(t) ? t >= sinceMs : true;
    })
    .slice(0, max);

  if (debug) {
    return res.status(200).json({
      provider,
      debug: { q, currencies, url: first.url, count: items.length },
      items,
    });
  }

  return res.status(200).json({ provider, count: items.length, items });
}
