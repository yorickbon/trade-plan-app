"use client";

import { useEffect, useMemo, useState } from "react";

type CalendarItem = {
  title: string;
  country: string;
  impact?: "low" | "medium" | "high";
  time?: string;
  actual?: string | number | null;
  forecast?: string | number | null;
  previous?: string | number | null;
};

type ApiResponse = {
  date_from: string;
  date_to: string;
  countries: string[];
  count: number;
  items: CalendarItem[];
};

export default function CalendarPanel({
  date,
  currencies = "EUR,USD,GBP",
}: {
  date: string; // YYYY-MM-DD
  currencies?: string; // CSV, e.g. "EUR,USD,GBP"
}) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Map FX currencies to likely countries (very rough, good enough for guest mode)
  const countries = useMemo(() => {
    const map: Record<string, string[]> = {
      EUR: ["Euro Area", "Germany", "France", "Italy", "Spain"],
      USD: ["United States"],
      GBP: ["United Kingdom"],
      JPY: ["Japan"],
      AUD: ["Australia"],
      CAD: ["Canada"],
      NZD: ["New Zealand"],
      CHF: ["Switzerland"],
    };
    const list = currencies
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .flatMap((c) => map[c] ?? []);
    // de-dupe while keeping order
    return [...new Set(list)];
  }, [currencies]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setErr(null);
      setData(null);
      try {
        const params = new URLSearchParams();
        params.set("date", date);
        if (countries.length) params.set("countries", countries.join(","));
        const res = await fetch(`/api/calendar?${params.toString()}`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        if (!cancelled) setData(json as ApiResponse);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "Failed to load calendar.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [date, countries.join("|")]);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">
          Calendar Snapshot (auto)
        </h3>
        <span className="text-xs text-zinc-500">
          {date} · {countries.length ? countries.join(", ") : "All"}
        </span>
      </div>

      {loading && (
        <div className="text-sm text-zinc-400">Loading economic calendar…</div>
      )}

      {err && (
        <div className="text-sm text-red-400">
          {err}
          <div className="text-xs text-zinc-500 mt-1">
            Tip: guest access often returns no items for future dates. Your app
            will still work; upgrade TE creds later for full data.
          </div>
        </div>
      )}

      {!loading && !err && data && data.items.length === 0 && (
        <div className="text-sm text-zinc-400">
          No high-impact events found for this date (guest mode).
        </div>
      )}

      {!loading && !err && data && data.items.length > 0 && (
        <ul className="space-y-2">
          {data.items.map((it, i) => (
            <li
              key={i}
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-zinc-200">{it.title}</div>
                <div className="text-xs text-zinc-500">
                  {it.country}
                  {it.time ? ` · ${it.time}` : ""}
                  {it.impact ? ` · ${it.impact.toUpperCase()}` : ""}
                </div>
              </div>
              {(it.actual ?? it.forecast ?? it.previous) != null && (
                <div className="mt-1 grid grid-cols-3 gap-2 text-xs text-zinc-400">
                  <div>
                    <span className="text-zinc-500">Actual: </span>
                    {it.actual ?? "—"}
                  </div>
                  <div>
                    <span className="text-zinc-500">Forecast: </span>
                    {it.forecast ?? "—"}
                  </div>
                  <div>
                    <span className="text-zinc-500">Previous: </span>
                    {it.previous ?? "—"}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
