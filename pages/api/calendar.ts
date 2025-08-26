// /pages/api/calendar.ts
import type { NextApiRequest, NextApiResponse } from "next";

type TEEvent = {
  Country?: string;
  Category?: string;
  Importance?: number;
  Currency?: string;
  Date?: string;
  Actual?: string | number | null;
  Previous?: string | number | null;
  Forecast?: string | number | null;
};

const TZ = process.env.TIMEZONE || "UTC";

// Map FX to countries
const FX_TO_COUNTRIES: Record<string, string[]> = {
  eur: ["Euro Area", "Germany", "France", "Italy", "Spain"],
  usd: ["United States"],
  gbp: ["United Kingdom"],
  jpy: ["Japan"],
  cad: ["Canada"],
  aud: ["Australia"],
  nzd: ["New Zealand"],
  chf: ["Switzerland"],
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
    const days = Number(req.query.days ?? 0);

    const currenciesParam = ((req.query.currencies as string) || "eur,usd,gbp")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const countriesOverride = (req.query.countries as string)?.split(",").map((s) => s.trim());

    // Build country filter list
    let countries: string[] = [];
    if (countriesOverride?.length) {
      countries = countriesOverride;
    } else {
      const set = new Set<string>();
      for (const c of currenciesParam) (FX_TO_COUNTRIES[c] || []).forEach((x) => set.add(x));
      countries = [...set];
    }

    // Date range [d1, d2]
    const d1 = date;
    const d2 = new Date(date);
    d2.setDate(d2.getDate() + days);
    const d2Str = d2.toISOString().slice(0, 10);

    // ---- TradingEconomics request (use query param client=user:pass) ----
    const user = process.env.TE_API_USER || "guest";
    const pass = process.env.TE_API_PASS || "guest";
    const client = encodeURIComponent(`${user}:${pass}`);

    // fetch all countries; we'll filter locally (simpler & reliable)
    const teUrl = `https://api.tradingeconomics.com/calendar?d1=${encodeURIComponent(
      d1
    )}&d2=${encodeURIComponent(d2Str)}&format=json&client=${client}`;

    const r = await fetch(teUrl, {
      headers: { Accept: "application/json", "User-Agent": "trade-plan-app" },
      cache: "no-store",
    });

    const rawText = await r.text(); // read once (for better error messages)
    if (!r.ok) {
      return res.status(r.status).json({
        error: `TradingEconomics ${r.status}`,
        details: rawText.slice(0, 500),
      });
    }

    let data: TEEvent[];
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({
        error: "Upstream returned non-JSON",
        snippet: rawText.slice(0, 200),
      });
    }

    const filtered = countries.length
      ? data.filter((e) => (e.Country ? countries.includes(e.Country) : false))
      : data;

    const items = filtered.map((e) => ({
      time_utc: e.Date ?? null,
      timezone: TZ,
      country: e.Country ?? "",
      currency: e.Currency ?? "",
      event: e.Category ?? "",
      importance: e.Importance ?? null, // 1..3
      actual: e.Actual ?? null,
      forecast: e.Forecast ?? null,
      previous: e.Previous ?? null,
    }));

    return res.status(200).json({
      date_from: d1,
      date_to: d2Str,
      countries,
      count: items.length,
      items,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
