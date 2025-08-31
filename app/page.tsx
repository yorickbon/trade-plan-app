"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import CalendarPanel from "../components/CalendarPanel";
import HeadlinesPanel from "../components/HeadlinesPanel";
import ChatDock from "../components/ChatDock";
import VisionUpload from "../components/VisionUpload";

// client-only chart import
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
  | {
      ok: true;
      provider?: string;
      date?: string;
      count: number;
      items: any[];
      bias: CalendarBias;
    }
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

function normalizePlanText(v: any): string {
  if (!v) return "";
  if (typeof v === "string") return v.replace(/\\n/g, "\n");
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
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
  const [busy, setBusy] = useState<boolean>(false); // used by VisionUpload

  // NEW: fullscreen toggle for trade card
  const [showFullCard, setShowFullCard] = useState<boolean>(false);

  // force-reset signal for VisionUpload (increments on Reset and on instrument change)
  const [resetTick, setResetTick] = useState<number>(0);

  // ----- load headlines for currencies / instrument -----
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

  // ----- load calendar (provider only) -----
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

  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);

  // reset
  const resetAll = useCallback(() => {
    setPlanText("");
    setHeadlines([]);
    setCalendar(null);
    setDateStr(todayISO());
    // hard reset the uploader
    setResetTick((t) => t + 1);
    // re-pull with fresh date/instrument
    setTimeout(() => loadCalendar(), 0);
  }, [loadCalendar]);

  // when instrument changes, also hard-reset uploader & clear plan
  const onInstrumentChange = useCallback(
    (next: string) => {
      setInstrument(next.toUpperCase());
      setPlanText("");
      setResetTick((t) => t + 1);
      // calendar will reload via useEffect (dependency = instrument)
      setTimeout(() => loadCalendar(), 0);
    },
    [loadCalendar]
  );

  const calendarCurrencies = useMemo(
    () => currenciesFromBias((calendar as any)?.bias),
    [calendar]
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4 space-y-4">
      {/* Controls (single row) */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm opacity-80">Instrument</span>
          <select
            value={instrument}
            onChange={(e) => onInstrumentChange(e.target.value)}
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm inline-block w-auto"
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
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm inline-block w-auto"
          />
        </div>

        <button
          onClick={resetAll}
          className="inline-flex items-center justify-center whitespace-nowrap w-auto px-3 py-1 text-sm rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
          disabled={loadingCal || busy}
        >
          Reset
        </button>

        {/* (future) monitoring hooks */}
        <button className="inline-flex items-center justify-center whitespace-nowrap w-auto px-3 py-1 text-sm rounded bg-sky-700 hover:bg-sky-600">
          Start monitoring
        </button>
        <button className="inline-flex items-center justify-center whitespace-nowrap w-auto px-3 py-1 text-sm rounded bg-rose-700 hover:bg-rose-600">
          Stop monitoring
        </button>

        <span className="text-xs opacity-70 ml-auto">
          Images only. Numeric candles are disabled by design.
        </span>
      </div>

      {/* Charts */}
      <TradingViewTriple symbol={instrument} />

      {/* Image uploader */}
      <div className="rounded-lg border border-neutral-800 p-4">
        <h2 className="text-lg font-semibold mb-2">Image Upload (4H / 1H / 15M + optional Calendar)</h2>
        <VisionUpload
          key={resetTick /* ensures hard remount as fallback */}
          instrument={instrument}
          resetSignal={resetTick}
          onBusyChange={setBusy}
          onResult={(txt) => setPlanText(normalizePlanText(txt))}
        />
      </div>

      {/* Two columns: LEFT (Calendar + Headlines) | RIGHT (Trade Card + Chat) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* LEFT: Calendar + Headlines stacked (span 2 columns) */}
        <div className="lg:col-span-2 space-y-4">
          {/* Calendar */}
          <div className="rounded-lg border border-neutral-800 p-4">
            <h2 className="text-lg font-semibold mb-2">Calendar Snapshot</h2>

            {loadingCal && <div className="text-sm opacity-75">Loading calendar…</div>}

            {!loadingCal && calendar?.ok && Array.isArray(calendar.items) && (
              <CalendarPanel items={calendar.items} />
            )}

            {!loadingCal && (!calendar || !calendar.ok) && (
              <div className="text-sm opacity-75">
                No calendar items found from providers. (Once your TradingEconomics key is active,
                this will populate automatically.)
              </div>
            )}
          </div>

          {/* Headlines – forced small font */}
          <div className="rounded-lg border border-neutral-800 p-4">
            <h2 className="text-lg font-semibold mb-2">Macro Headlines (24–48h)</h2>
            <div style={{ fontSize: "12px", lineHeight: "1.3" }}>
              <HeadlinesPanel items={Array.isArray(headlines) ? headlines : []} />
            </div>
            <div className="text-[11px] mt-2 opacity-60">
              {loadingNews
                ? "Loading headlines…"
                : headlines.length
                ? `${headlines.length} headlines found`
                : currenciesFromBias((calendar as any)?.bias).length
                ? "No notable headlines."
                : "Fetched by instrument (calendar empty)."}
            </div>
          </div>
        </div>

        {/* RIGHT: Trade Card (bigger) + Chat */}
        <div className="rounded-lg border border-neutral-800 p-4 flex flex-col gap-4 max-h-[80vh]">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold mb-2">Generated Trade Card</h2>
            {/* NEW: fullscreen toggle button */}
            <button
              type="button"
              className="ml-3 inline-flex items-center justify-center whitespace-nowrap px-2 py-1 text-xs rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
              onClick={() => setShowFullCard(true)}
              disabled={!planText}
              title="Open fullscreen"
            >
              Fullscreen
            </button>
          </div>

          <div>
            {planText ? (
              <pre className="whitespace-pre-wrap text-base md:text-[17px] leading-7 opacity-95 max-h-[54vh] overflow-auto pr-2">
                {planText}
              </pre>
            ) : busy ? (
              <div className="text-sm opacity-80">Analyzing images…</div>
            ) : (
              <div className="text-sm opacity-70">
                Upload your 4H/1H/15M (and optional calendar) above, then click <b>Generate from Images</b>.
              </div>
            )}
          </div>

          {/* ChatDock */}
          <div className="border-top border-neutral-800 pt-3">
            <h3 className="text-base font-semibold mb-2">Discuss the Plan</h3>
            <ChatDock
              planText={planText}
              headlines={Array.isArray(headlines) ? headlines : []}
              calendar={Array.isArray((calendar as any)?.items) ? (calendar as any).items : []}
            />
          </div>
        </div>
      </div>

      {/* NEW: fullscreen overlay for the trade card */}
      {showFullCard && planText && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="relative w-full h-full max-w-6xl max-h-[95vh] bg-neutral-950 border border-neutral-800 rounded-lg shadow-xl overflow-hidden">
            <div className="flex items-center justify-between p-3 border-b border-neutral-800">
              <div className="text-base font-semibold">Generated Trade Card — {instrument}</div>
              <button
                type="button"
                aria-label="Close"
                className="inline-flex items-center justify-center w-8 h-8 rounded hover:bg-neutral-800"
                onClick={() => setShowFullCard(false)}
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="p-4 overflow-auto">
              <pre className="whitespace-pre-wrap text-[17px] md:text-[18px] leading-8 opacity-95">
                {planText}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
