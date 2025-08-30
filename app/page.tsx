"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import CalendarPanel from "../components/CalendarPanel";
import HeadlinesPanel from "../components/HeadlinesPanel";
import ChatDock from "../components/ChatDock";
import VisionUpload from "../components/VisionUpload";

// ✅ client-only chart import to avoid client-side exception
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

// normalize plan text so it prints line-by-line
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
  const [generating, setGenerating] = useState<boolean>(false);

  // mode toggle
  type Mode = "images" | "numeric";
  const [mode, setMode] = useState<Mode>("images"); // default to Images

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
        // Load headlines using currencies from calendar bias
        const ccy = currenciesFromBias(j.bias);
        if (ccy.length) {
          await loadHeadlinesForSymbols(ccy);
        } else {
          // If bias missing, fallback to instrument symbols
          const [base, quote] = baseQuoteFromInstrument(instrument);
          await loadHeadlinesForSymbols([base, quote]);
        }
      } else {
        // Provider empty: fallback to instrument symbols (Google News will almost always have something)
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

  // ----- generate (numeric) plan -----
  const generatePlanNumeric = useCallback(async () => {
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
      if (j?.ok) {
        const raw = j?.plan || j?.card || j?.text || j;
        setPlanText(normalizePlanText(raw));
      } else setPlanText(normalizePlanText(j?.reason || "Server error while generating plan."));
    } catch (e: any) {
      setPlanText(normalizePlanText(e?.message || "Error generating plan."));
    } finally {
      setGenerating(false);
    }
  }, [instrument, dateStr, calendar, headlines]);

  const calendarCurrencies = useMemo(
    () => currenciesFromBias((calendar as any)?.bias),
    [calendar]
  );

  // reset = clear outputs and re-fetch calendar/news
  const resetAll = useCallback(() => {
    setPlanText("");
    setHeadlines([]);
    setCalendar(null);
    setDateStr(todayISO());
    // re-pull with fresh date/instrument
    setTimeout(() => loadCalendar(), 0);
  }, [loadCalendar]);

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

        {/* Mode toggle */}
        <div className="flex items-center gap-2 ml-2">
          <span className="text-sm opacity-80">Mode</span>
          <div className="inline-flex rounded-lg overflow-hidden border border-neutral-700">
            <button
              onClick={() => setMode("images")}
              className={`px-3 py-1 text-sm ${
                mode === "images" ? "bg-emerald-600" : "bg-neutral-800 hover:bg-neutral-700"
              }`}
            >
              Images
            </button>
            <button
              onClick={() => setMode("numeric")}
              className={`px-3 py-1 text-sm ${
                mode === "numeric" ? "bg-emerald-600" : "bg-neutral-800 hover:bg-neutral-700"
              }`}
            >
              Numeric
            </button>
          </div>
        </div>

        {/* Buttons — one line */}
        <button
          onClick={resetAll}
          className="px-3 py-1 text-sm rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
          disabled={loadingCal}
        >
          Reset
        </button>

        {mode === "numeric" ? (
          <button
            onClick={generatePlanNumeric}
            className="px-3 py-1 text-sm rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50"
            disabled={generating}
          >
            {generating ? "Generating…" : "Generate Plan"}
          </button>
        ) : (
          <span className="text-xs opacity-70">Use the uploader below to Generate from Images</span>
        )}

        {/* (future) wire these to your monitoring endpoints */}
        <button className="px-3 py-1 text-sm rounded bg-sky-700 hover:bg-sky-600">
          Start monitoring
        </button>
        <button className="px-3 py-1 text-sm rounded bg-rose-700 hover:bg-rose-600">
          Stop monitoring
        </button>
      </div>

      {/* Charts */}
      <TradingViewTriple symbol={instrument} />

      {/* Images uploader (only in Images mode) */}
      {mode === "images" && (
        <div className="rounded-lg border border-neutral-800 p-4">
          <h2 className="text-lg font-semibold mb-2">Image Upload (4H / 1H / 15M + optional Calendar)</h2>
          <VisionUpload
            instrument={instrument}
            onBusyChange={setGenerating}
            onResult={(txt) => setPlanText(normalizePlanText(txt))}
          />
        </div>
      )}

      {/* 2+1 columns: LEFT (Calendar + Headlines) | RIGHT (Trade Card + Chat) */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* LEFT: Calendar + Headlines stacked (span 2 columns) */}
        <div className="xl:col-span-2 space-y-4">
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

          {/* Headlines – smaller font */}
          <div className="rounded-lg border border-neutral-800 p-4">
            <h2 className="text-lg font-semibold mb-2">Macro Headlines (24–48h)</h2>
            {/* Make li/text inside HeadlinesPanel smaller without touching that component */}
            <div className="text-xs leading-5 [&_li]:text-xs [&_a]:text-sky-300">
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

        {/* RIGHT: Trade Card – bigger font & now easier to read */}
        <div className="rounded-lg border border-neutral-800 p-4 flex flex-col gap-4 max-h-[80vh]">
          <div>
            <h2 className="text-lg font-semibold mb-2">Generated Trade Card</h2>
            {planText ? (
              <pre className="whitespace-pre-wrap text-[15px] leading-7 opacity-95 max-h-[50vh] overflow-auto pr-2">
                {planText}
              </pre>
            ) : generating ? (
              <div className="text-sm opacity-80">Generating…</div>
            ) : (
              <div className="text-sm opacity-70">
                {mode === "images" ? (
                  <>Upload your 4H/1H/15M (and optional calendar) above, then click <b>Generate</b>.</>
                ) : (
                  <>Click <b>Generate Plan</b> to build a setup from numeric candles + fundamentals.</>
                )}
              </div>
            )}
          </div>

          {/* ChatDock: discuss the current plan */}
          <div className="border-t border-neutral-800 pt-3">
            <h3 className="text-base font-semibold mb-2">Discuss the Plan</h3>
            <ChatDock
              planText={planText}
              headlines={Array.isArray(headlines) ? headlines : []}
              calendar={Array.isArray((calendar as any)?.items) ? (calendar as any).items : []}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
