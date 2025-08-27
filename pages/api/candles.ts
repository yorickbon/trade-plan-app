// pages/api/candles.ts
import type { NextApiRequest, NextApiResponse } from "next";

type OutCandle = { t: number; o: number; h: number; l: number; c: number };

const KEY = process.env.TWELVEDATA_API_KEY || "";

// Only these three TFs are used by the plan/chat logic
const TF_MAP: Record<string, string> = {
  "15m": "15min",
  "1h": "1h",
  "4h": "4h",
};

// ---------------- vendor symbol helpers ----------------

// Special-case mappings for non-FX instruments
function toVendorSymbol(sym: string): string {
  const upper = sym.toUpperCase();

  // Common non-FX
  if (upper === "XAUUSD") return "XAU/USD";
  if (upper === "BTCUSD") return "BTC/USD";
  if (upper === "ETHUSD") return "ETH/USD";

  // Indices (TwelveData canonical tickers)
  if (upper === "NAS100" || upper === "NDX") return "NDX";
  if (upper === "SPX500" || upper === "SPX") return "SPX";
  if (upper === "US30" || upper === "DJI") return "DJI";
  if (upper === "GER40" || upper === "DAX") return "DAX";

  // Already in AAA/BBB form
  if (upper.includes("/")) return upper;

  // 6-letter FX like EURUSD -> EUR/USD
  if (upper.length === 6) return `${upper.slice(0, 3)}/${upper.slice(3)}`;

  // fallback passthrough
  return upper;
}

// ---------------- TwelveData fetch + mapping ----------------

async function fetchTD(symbol: string, interval: string, size: number) {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(size));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", KEY);

  const rsp = await fetch(url.toString(), { cache: "no-store" });
  if (!rsp.ok) {
    const text = await rsp.text().catch(() => "");
    throw new Error(`TwelveData ${rsp.status}: ${text || rsp.statusText}`);
  }
  return rsp.json();
}

function mapValues(json: any): OutCandle[] {
  const arr: any[] = json?.values || json?.data || [];
  if (!Array.isArray(arr)) return [];

  // TwelveData returns newest->oldest; reverse to oldest->newest
  return arr
    .slice()
    .reverse()
    .map((v: any) => ({
      t: Number.isFinite(Date.parse(v?.datetime ?? v?.date ?? v?.time ?? ""))
        ? Math.floor(Date.parse(v.datetime ?? v.date ?? v.time) / 1000)
        : NaN,
      o: Number(v?.open),
      h: Number(v?.high),
      l: Number(v?.low),
      c: Number(v?.close),
    }))
    .filter(
      (x) =>
        Number.isFinite(x.t) &&
        [x.o, x.h, x.l, x.c].every((n) => Number.isFinite(n))
    );
}

// ---------------- API handler ----------------

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const symbol = String(req.query.symbol || "").trim();
    const tf = String(req.query.interval || "").trim(); // expect "15m" | "1h" | "4h"
    const n = Math.min(Number(req.query.limit ?? 200) || 200, 500);
    const debug = String(req.query.debug || "") === "1";

    if (!KEY) {
      return res.status(500).json({ error: "Missing TWELVEDATA_API_KEY" });
    }
    if (!symbol || !TF_MAP[tf]) {
      return res
        .status(400)
        .json({ error: "Bad query. Use symbol=EURUSD&interval=15m|1h|4h&limit=200" });
    }

    // Try raw (as given) then mapped vendor form
    const trySymbols = [symbol.toUpperCase(), toVendorSymbol(symbol)];
    let lastErr: unknown = null;

    for (const s of trySymbols) {
      try {
        const json = await fetchTD(s, TF_MAP[tf], n);
        const candles = mapValues(json);
        if (candles.length > 0) {
          return res
            .status(200)
            .json({ symbol: s, tf, n, candles, ...(debug ? { raw: json } : null) });
        }
        // keep json in case we need to show debug later
        lastErr = json;
      } catch (e) {
        lastErr = e;
      }
    }

    // Nothing worked
    if (debug) {
      return res
        .status(200)
        .json({ symbol, tf, n, candles: [], debug: String(lastErr) });
    }
    return res.status(200).json({ symbol, tf, n, candles: [] });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
