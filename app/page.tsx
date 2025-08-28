"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";

// ⬇️ use RELATIVE paths (no tsconfig alias required)
import CalendarPaste from "../components/CalendarPaste";
import CalendarPanel from "../components/CalendarPanel";
import HeadlinesPanel from "../components/HeadlinesPanel";
import TradingViewTriple from "../components/TradingViewTriple";

// ----------------- helpers -----------------
const todayISO = () => new Date().toISOString().slice(0, 10);

type CalendarBias = {
  perCurrency: Record<
    string,
    { score: number; label: string; count: number; evidence: any[] }
  >;
  instrument?: { pair: string; score: number; label: string };
};

type CalendarRespOK = {
  ok: true;
  provider?: string;
  date?: string;
  count: number;
  items: any[];
  bias: CalendarBias;
};
type CalendarResp = CalendarRespOK | { ok: false; reason: string };

type NewsResp =
  | { ok: true; items: any[]; count?: number; provider?: string }
  | { ok: false; reason: string };

function currenciesFromBias(bias?: CalendarBias): string[] {
  return bias ? Object.keys(bias.perCurrency || {}) : [];
}

// ----------------- page -----------------
export default function Page() {
  // controls
  const [instrument, setInstrument] = useState<string>("EURUSD");
  const [dateStr, setDateStr] = useState<string>(todayISO());

  // calendar + news state
  const [calendar, setCalendar] = useState<CalendarResp | null>(null);
  const [needManualCalendar, setNeedManualCalendar] = useState<boolean>(false);
  const [loadingCal, setLoadingCal] = useState<boolean>(false);

  const [headlines, setHeadlines] = useState<any[]>([]);
  const [loadingNews, setLoadingNews] = useState<boolean>(false);

  // plan state
  const [planText, setPlanText] = useState<string>("");
  const [generating, setGenerating] = useState<boolean>(false);
  const [monitoring, setMonitoring] = useState<boolean>(false);

  // ------- load calendar (auto) -------
  const loadCalendar = useCallback(async () => {
    setLoadingCal(true);
    setNeedManualCalendar(false);
    try {
      const u = `/api/calendar?date=${dateStr}&instrument=${instrument}&windowHours=48`;
      const r = await fetch(u, { cache: "no-store" });
      const j: CalendarResp = await r.json();

      if (j?.ok) {
        setCalendar(j);
        // load headlines for currencies present
        const ccy = currenciesFromBias(j.bias);
        if (ccy.length) {
          setLoadingNews(true);
          try {
            const nr = await fetch(`/api/news?symbols=${ccy.join(",")}`, {
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
        } else {
          setHeadlines([]);
        }
      } else {
        // provider empty -> manual paste fallback
        setCalendar(null);
        setNeedManualCalendar(true);
        setHeadlines([]);
      }
    } catch {
      setCalendar(null);
      setNeedManualCalendar(true);
      setHeadlines([]);
    } finally {
      setLoadingCal(false);
    }
  }, [dateStr, instrument]);

  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);

  // ------- manual calendar (paste) completed -------
  const onCalendarManual = useCallback(
    async (resp: any) => {
      // resp structure comes from /api/calendar-manual.ts
      const ok: CalendarRespOK = {
        ok: true,
        provider: "manual",
        date: dateStr,
        count: resp?.count || 0,
        items: resp?.items || [],
        bias: resp?.bias || { perCurrency: {} },
      };
      setCalendar(ok);
      setNeedManualCalendar(false);

      // headlines from currencies detected
      const ccy = currenciesFromBias(ok.bias);
      if (ccy.length) {
        setLoadingNews(true);
        try {
          const nr = await fetch(`/api/news?symbols=${ccy.join(",")}`, {
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
      } else {
        setHeadlines([]);
      }
    },
    [dateStr]
  );

  // ------- generate plan (server combines TA + FA) -------
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

  const calendarCurrencies = useMemo(
    () => currenciesFromBias((calendar as any)?.bias),
    [calendar]
  );

  // ----------------- UI -----------------
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

      {/* Calendar + Headlines */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Calendar panel (auto or paste fallback) */}
        <div className="rounded-lg border border-neutral-800 p-4">
          <h2 className="text-lg font-semibold mb-2">Calendar Snapshot</h2>

          {loadingCal && (
            <div className="text-sm opacity-75">Loading calendar…</div>
          )}

          {!loadingCal && needManualCalendar && (
            <div className="space-y-3">
              <div className="text-sm opacity-75">
                No items found from providers. Paste a calendar table below to
                continue:
              </div>
              <CalendarPaste
                instrument={instrument}
                onComplete={onCalendarManual}
              />
            </div>
          )}

          {!needManualCalendar && calendar?.ok && (
            <CalendarPanel items={(calendar as CalendarRespOK).items || []} />
          )}

          {!needManualCalendar && !calendar?.ok && !loadingCal && (
            <div className="text-sm opacity-75">No items found.</div>
          )}
        </div>

        {/* Headlines */}
        <div className="rounded-lg border border-neutral-800 p-4">
          <h2 className="text-lg font-semibold mb-2">Macro Headlines (24–48h)</h2>
          <HeadlinesPanel items={headlines} />
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
            Click <b>Generate Plan</b> to build a setup using 15m execution,
            1h+4h context, fundamentals (calendar bias + headlines), and
            strategy logic.
          </div>
        )}
      </div>
    </div>
  );
}
