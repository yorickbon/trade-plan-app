"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import CalendarPaste from "@/components/CalendarPaste";
import CalendarPanel from "@/components/CalendarPanel";
import HeadlinesPanel from "@/components/HeadlinesPanel";
import TradingViewTriple from "@/components/TradingViewTriple";

// ---------- Types that match your APIs ----------
type Headline = {
  title: string;
  url: string;
  published_at?: string;
  sentiment?: { score: number; label: "positive" | "negative" | "neutral" };
  source?: string;
  symbols?: string[];
};

type CalendarBias = {
  perCurrency: Record<
    string,
    { score: number; label: string; count: number; evidence: any[] }
  >;
  instrument?: { pair: string; score: number; label: string };
};

type CalendarResp =
  | {
      ok: true;
      provider: string;
      date: string;
      count: number;
      items: any[];
      bias: CalendarBias;
    }
  | { ok: false; reason: string };

type NewsResp =
  | { ok: true; items: Headline[]; count: number; provider?: string }
  | { ok: false; reason: string };

// ---------- Helpers ----------
const todayISO = () => new Date().toISOString().slice(0, 10);

// Extract currencies from calendar bias
function currenciesFromBias(bias?: CalendarBias): string[] {
  return bias ? Object.keys(bias.perCurrency || {}) : [];
}

// ---------- Page ----------
export default function Page() {
  // Core state
  const [instrument, setInstrument] = useState<string>("EURUSD");
  const [dateStr, setDateStr] = useState<string>(todayISO());

  // Calendar state
  const [calendar, setCalendar] = useState<CalendarResp | null>(null);
  const [needManualCalendar, setNeedManualCalendar] = useState<boolean>(false);
  const [loadingCal, setLoadingCal] = useState<boolean>(false);

  // Headlines state
  const [headlines, setHeadlines] = useState<Headline[]>([]);
  const [loadingNews, setLoadingNews] = useState<boolean>(false);

  // Plan state
  const [planText, setPlanText] = useState<string>("");
  const [generating, setGenerating] = useState<boolean>(false);
  const [monitoring, setMonitoring] = useState<boolean>(false);

  // ---------- Load Calendar (auto) ----------
  const loadCalendar = useCallback(async () => {
    setLoadingCal(true);
    setNeedManualCalendar(false);
    try {
      const url = `/api/calendar?date=${dateStr}&instrument=${instrument}&windowHours=48`;
      const r = await fetch(url, { cache: "no-store" });
      const j: CalendarResp = await r.json();

      setCalendar(j);

      if (!j?.ok) {
        // no provider data -> enable paste fallback
        setNeedManualCalendar(true);
        setHeadlines([]); // will be loaded after manual submit
        return;
      }

      // calendar ok → load news for currencies present
      const ccy = currenciesFromBias(j.bias);
      if (ccy.length) await loadNews(ccy);
    } catch (e) {
      setNeedManualCalendar(true);
    } finally {
      setLoadingCal(false);
    }
  }, [dateStr, instrument]);

  // ---------- Load News ----------
  const loadNews = useCallback(
    async (symbols: string[]) => {
      if (!symbols.length) return;
      setLoadingNews(true);
      try {
        const u = `/api/news?symbols=${symbols.join(",")}`;
        const r = await fetch(u, { cache: "no-store" });
        const j: NewsResp = await r.json();
        if (j?.ok) setHeadlines(j.items || []);
        else setHeadlines([]);
      } catch {
        setHeadlines([]);
      } finally {
        setLoadingNews(false);
      }
    },
    []
  );

  // ---------- Manual calendar (paste) completed ----------
  const onCalendarManual = useCallback(
    async (resp: any) => {
      // resp has same shape from /api/calendar-manual.ts
      const j: CalendarResp = {
        ok: true,
        provider: "manual",
        date: dateStr,
        count: resp?.count || 0,
        items: resp?.items || [],
        bias: resp?.bias || { perCurrency: {} },
      };
      setCalendar(j);
      setNeedManualCalendar(false);

      // fetch news based on currencies present
      const ccy = currenciesFromBias(j.bias);
      if (ccy.length) await loadNews(ccy);
    },
    [dateStr, loadNews]
  );

  // ---------- Generate Plan ----------
  const generatePlan = useCallback(async () => {
    setGenerating(true);
    setPlanText("");
    try {
      const body = {
        instrument,
        date: dateStr,
        // pass headlines + calendar to server for combined conviction
        headlines,
        calendar,
      };
      const r = await fetch("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j?.ok) setPlanText(j?.plan || j?.card || JSON.stringify(j));
      else setPlanText(j?.reason || "Server error while generating plan.");
    } catch (e: any) {
      setPlanText(e?.message || "Error generating plan.");
    } finally {
      setGenerating(false);
    }
  }, [instrument, dateStr, headlines, calendar]);

  // ---------- Effects: initial loads ----------
  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);

  // ---------- Derived ----------
  const calendarCurrencies = useMemo(
    () => currenciesFromBias((calendar as any)?.bias),
    [calendar]
  );

  // ---------- UI ----------
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
          onClick={loadCalendar}
          className="px-3 py-1 text-sm rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
          disabled={loadingCal}
        >
          Refresh Calendar
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

      {/* Calendar + Headlines row */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Left: Calendar (auto) or Paste fallback */}
        <div className="rounded-lg border border-neutral-800 p-4">
          <h2 className="text-lg font-semibold mb-2">Calendar Snapshot</h2>

          {loadingCal && <div className="text-sm opacity-75">Loading calendar…</div>}

          {!loadingCal && needManualCalendar && (
            <div className="space-y-3">
              <div className="text-sm opacity-75">
                No items found from providers. Paste a calendar table below to continue:
              </div>
              <CalendarPaste
                instrument={instrument}
                onComplete={onCalendarManual}
              />
            </div>
          )}

          {!needManualCalendar && calendar?.ok && (
            <CalendarPanel items={(calendar as any).items || []} />
          )}

          {!needManualCalendar && !calendar?.ok && !loadingCal && (
            <div className="text-sm opacity-75">No items found.</div>
          )}
        </div>

        {/* Right: Headlines */}
        <div className="rounded-lg border border-neutral-800 p-4">
          <h2 className="text-lg font-semibold mb-2">
            Macro Headlines (24–48h)
          </h2>
          <HeadlinesPanel items={headlines as any} />
          <div className="text-xs mt-2 opacity-60">
            {loadingNews
              ? "Loading headlines…"
              : headlines.length
              ? `${headlines.length} headlines found`
              : calendarCurrencies.length
              ? "No notable headlines."
              : "Select an instrument or load calendar to fetch related headlines."}
          </div>
        </div>
      </div>

      {/* Generated Trade Card */}
      <div className="rounded-lg border border-neutral-800 p-4">
        <h2 className="text-lg font-semibold mb-2">Generated Trade Card</h2>
        {planText ? (
          <pre className="whitespace-pre-wrap text-sm leading-5 opacity-95">
            {planText}
          </pre>
        ) : generating ? (
          <div className="text-sm opacity-80">Generating…</div>
        ) : (
          <div className="text-sm opacity-70">
            Click <b>Generate Plan</b> to build a setup using 15m execution, 1h+4h
            context, fundamentals (calendar bias + headlines), and our strategy
            logic.
          </div>
        )}
      </div>
    </div>
  );
}
