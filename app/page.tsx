"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import CalendarPanel from "../components/CalendarPanel";
import HeadlinesPanel from "../components/HeadlinesPanel";

// client-only chart import (avoids client-side exception)
const TradingViewTriple = dynamic(() => import("../components/TradingViewTriple"), {
  ssr: false,
  loading: () => (
    <div className="rounded-lg border border-neutral-800 p-4">
      <div className="text-sm opacity-75">Loading charts…</div>
    </div>
  ),
});

// ---------- types / helpers ----------
type CalendarBias = {
  perCurrency: Record<
    string,
    { score: number; label: string; count: number; evidence: any[] }
  >;
  instrument?: { pair: string; score: number; label: string };
};

type CalendarResp =
  | { ok: true; provider?: string; date?: string; count: number; items: any[]; bias: CalendarBias }
  | { ok: false; reason: string };

type NewsResp =
  | { ok: true; items: any[]; count?: number; provider?: string }
  | { ok: false; reason: string };

const todayISO = () => new Date().toISOString().slice(0, 10);
const currenciesFromBias = (bias?: CalendarBias) =>
  bias ? Object.keys(bias.perCurrency || {}) : [];

function baseQuoteFromInstrument(instr: string): [string, string] {
  const s = (instr || "").toUpperCase().replace("/", "");
  if (s.length >= 6) return [s.slice(0, 3), s.slice(-3)];
  if (s.endsWith("USD")) return [s.replace("USD", ""), "USD"];
  return [s, "USD"];
}

// ---------- page ----------
export default function Page() {
  // controls
  const [instrument, setInstrument] = useState<string>("EURUSD");
  const [dateStr, setDateStr] = useState<string>(todayISO());

  // calendar + headlines
  const [calendar, setCalendar] = useState<CalendarResp | null>(null);
  const [loadingCal, setLoadingCal] = useState<boolean>(false);

  const [headlines, setHeadlines] = useState<any[]>([]);
  const [loadingNews, setLoadingNews] = useState<boolean>(false);

  // plan
  const [planText, setPlanText] = useState<string>("");
  const [generating, setGenerating] = useState<boolean>(false);
  const [monitoring, setMonitoring] = useState<boolean>(false);

  // ----- load headlines for a list of symbols -----
  const loadHeadlinesForSymbols = useCallback(async (symbols: string[]) => {
    if (!symbols.length) {
      setHeadlines([]);
      return;
    }
    setLoadingNews(true);
    try {
      const nr = await fetch(`/api/news?symbols=${symbols.join(",")}`, {
        cache: "no-store",
      });
      const nj: NewsResp = await nr.json();
      if (nj?.ok) setHeadlines(nj.items || []);
      else setHeadlines([]);
    } catch {
      setHeadlines([]);
    } finally {
      setLoadingNews(false);
    }
  }, []);

  // ----- load calendar from provider only (no manual fallback) -----
  const loadCalendar = useCallback(async () => {
    setLoadingCal(true);
    try {
      const u = `/api/calendar?date=${dateStr}&instrument=${instrument}&windowHours=48`;
      const r = await fetch(u, { cache: "no-store" });
      const j: CalendarResp = await r.json();
      setCalendar(j);

      if (j?.ok) {
        const ccy = currenciesFromBias(j.bias);
        if (ccy.length) {
          await loadHeadlinesForSymbols(ccy);
        } else {
          const [base, quote] = baseQuoteFromInstrument(instrument);
          await loadHeadlinesForSymbols([base, quote]);
        }
      } else {
        const [base, quote] = baseQuoteFromInstrument(instrument);
        await loadHeadlinesForSymbols([base, quote]);
      }
    } catch {
      setCalendar({ ok: false, reason: "Calendar request failed" });
      const [base, quote] = baseQuoteFromInstrument(instrument);
      await loadHeadlinesForSymbols([base, quote]);
    } finally {
      setLoadingCal(false);
    }
  }, [dateStr, instrument, loadHeadlinesForSymbols]);

  // auto-load when instrument/date changes
  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);

  // ----- generate plan -----
  const generatePlan = useCallback(async () => {
    setGenerating(true);
    setPlanText("");
    try {
      const r = await fetch("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instrument,
          date: dateStr,
          calendar,
          headlines,
        }),
      });
      const j = await r.json();
      if (j?.ok) setPlanText(j?.plan || j?.card || JSON.stringify(j, null, 2));
      else setPlanText(j?.reason || "Server error while generating plan.");
    } catch (e: any) {
      setPlanText(e?.message || "Error generating plan.");
    } finally {
      setGenerating(false);
    }
  }, [instrument, dateStr, calendar, headlines]);

  // Reset (no Refresh Calendar button)
  const resetAll = useCallback(() => {
    setPlanText("");
    loadCalendar();
  }, [loadCalendar]);

  const calendarCurrencies = useMemo(
    () => currenciesFromBias((calendar as any)?.bias),
    [calendar]
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4 space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex items-center gap-2">
          <span className="text-sm opacity-80">Instrument</span>
          <select
            value={instrument}
            onChange={(e) => setInstrument(e.target.value.toUpperCase())}
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
          >
            {/* Forex */}
            <option>AUDUSD</option>
            <option>EURUSD</option>
            <option>GBPUSD</option>
            <option>USDJPY</option>
            <option>USDCAD</option>
            <option>EURGBP</option>
            <option>EURJPY</option>
            <option>GBPJPY</option>
            <option>EURAUD</option>
            <option>NZDUSD</option>
            {/* Indices */}
            <option>SPX500</option>
            <option>NAS100</option>
            <option>US30</option>
            <option>GER40</option>
            {/* Metals/Crypto */}
            <option>XAUUSD</option>
            <option>BTCUSD</option>
            <option>ETHUSD</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm opacity-80">Date</span>
          <input
            type="date"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
          />
        </div>

        <button
          onClick={resetAll}
          className="px-3 py-1 text-sm rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
          disabled={loadingCal}
        >
          Reset
        </button>

        <button
          onClick={generatePlan}
          className="px-3 py-1 text-sm rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50"
          disabled={generating}
        >
          {generating ? "Generating…" : "Generate Plan"}
        </button>

        <button
          onClick={() => setMonitoring(true)}
          className="px-3 py-1 text-sm rounded bg-sky-700 hover:bg-sky-600"
        >
          Start monitoring
        </button>
        <button
          onClick={() => setMonitoring(false)}
          className="px-3 py-1 text-sm rounded bg-rose-700 hover:bg-rose-600"
        >
          Stop monitoring
        </button>
      </div>

      {/* Charts */}
      <TradingViewTriple symbol={instrument} />

      {/* Layout: LEFT (calendar + headlines) | RIGHT (trade card) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* LEFT side (span 2 cols on desktop) */}
        <div className="lg:col-span-2 order-2 lg:order-1 space-y-4">
          {/* Calendar */}
          <div className="rounded-lg border border-neutral-800 p-4">
            <h2 className="text-lg font-semibold mb-2">Calendar Snapshot</h2>

            {loadingCal && <div className="text-sm opacity-75">Loading calendar…</div>}

            {!loadingCal && calendar?.ok && Array.isArray(calendar.items) && (
              <CalendarPanel items={calendar.items} />
            )}

            {!loadingCal && (!calendar || !calendar.ok) && (
              <div className="text-sm opacity-75">
                No calendar items found from providers. (Once your
                TradingEconomics key is active, this will populate automatically.)
              </div>
            )}
          </div>

          {/* Headlines (smaller text) */}
          <div className="rounded-lg border border-neutral-800 p-4">
            <h2 className="text-lg font-semibold mb-2">Macro Headlines (24–48h)</h2>
            <div className="text-xs [&_li]:text-xs">
              <HeadlinesPanel items={Array.isArray(headlines) ? headlines : []} />
            </div>
            <div className="text-[11px] mt-2 opacity-60">
              {loadingNews
                ? "Loading headlines…"
                : headlines.length
                ? `${headlines.length} headlines found`
                : calendarCurrencies.length
                ? "No notable headlines."
                : "Fetched by instrument (calendar empty)."}
            </div>
          </div>
        </div>

        {/* RIGHT side: Trade Card (sticky on desktop, larger font) */}
        <div className="rounded-lg border border-neutral-800 p-4 order-1 lg:order-2 lg:sticky lg:top-4 h-fit">
          <h2 className="text-xl font-semibold mb-3">Generated Trade Card</h2>
          {planText ? (
            <pre className="whitespace-pre-wrap text-lg leading-7 opacity-95 max-w-prose">
              {planText}
            </pre>
          ) : generating ? (
            <div className="text-sm opacity-80">Generating…</div>
          ) : (
            <div className="text-sm opacity-70">
              Click <b>Generate Plan</b> to build a setup using 15m execution,
              1h+4h context, fundamentals (calendar bias + headlines), and our
              strategy logic.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
