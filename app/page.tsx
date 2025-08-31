"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import CalendarPanel from "../components/CalendarPanel";
import HeadlinesPanel from "../components/HeadlinesPanel";
import ChatDock from "../components/ChatDock";
import VisionUpload from "../components/VisionUpload";

const TradingViewTriple = dynamic(() => import("../components/TradingViewTriple"), {
  ssr: false,
  loading: () => (
    <div className="rounded-lg border border-neutral-800 p-4">
      <div className="text-sm opacity-75">Loading charts…</div>
    </div>
  ),
});

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

export default function Page() {
  const [instrument, setInstrument] = useState<string>("EURUSD");
  const [dateStr, setDateStr] = useState<string>(todayISO());

  const [calendar, setCalendar] = useState<CalendarResp | null>(null);
  const [loadingCal, setLoadingCal] = useState<boolean>(false);

  const [headlines, setHeadlines] = useState<any[]>([]);
  const [loadingNews, setLoadingNews] = useState<boolean>(false);

  const [planText, setPlanText] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  // fullscreen toggle
  const [enlargedCard, setEnlargedCard] = useState<boolean>(false);

  const [resetTick, setResetTick] = useState<number>(0);

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

  const resetAll = useCallback(() => {
    setPlanText("");
    setHeadlines([]);
    setCalendar(null);
    setDateStr(todayISO());
    setEnlargedCard(false);
    setResetTick((t) => t + 1);
    setTimeout(() => loadCalendar(), 0);
  }, [loadCalendar]);

  const onInstrumentChange = useCallback(
    (next: string) => {
      setInstrument(next.toUpperCase());
      setPlanText("");
      setEnlargedCard(false);
      setResetTick((t) => t + 1);
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
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm opacity-80">Instrument</span>
          <select
            value={instrument}
            onChange={(e) => onInstrumentChange(e.target.value)}
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm inline-block w-auto"
          >
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
            <option>SPX500</option>
            <option>NAS100</option>
            <option>US30</option>
            <option>GER40</option>
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
      </div>

      <TradingViewTriple symbol={instrument} />

      <div className="rounded-lg border border-neutral-800 p-4">
        <h2 className="text-lg font-semibold mb-2">
          Image Upload (4H / 1H / 15M + optional Calendar)
        </h2>
        <VisionUpload
          key={resetTick}
          instrument={instrument}
          resetSignal={resetTick}
          onBusyChange={setBusy}
          onResult={(txt) => setPlanText(normalizePlanText(txt))}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* LEFT */}
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-lg border border-neutral-800 p-4">
            <h2 className="text-lg font-semibold mb-2">Calendar Snapshot</h2>
            {loadingCal && <div className="text-sm opacity-75">Loading calendar…</div>}
            {!loadingCal && calendar?.ok && Array.isArray(calendar.items) && (
              <CalendarPanel items={calendar.items} />
            )}
            {!loadingCal && (!calendar || !calendar.ok) && (
              <div className="text-sm opacity-75">No calendar items found.</div>
            )}
          </div>

          <div className="rounded-lg border border-neutral-800 p-4">
            <h2 className="text-lg font-semibold mb-2">Macro Headlines (24–48h)</h2>
            <div style={{ fontSize: "12px", lineHeight: "1.3" }}>
              <HeadlinesPanel items={Array.isArray(headlines) ? headlines : []} />
            </div>
          </div>
        </div>

        {/* RIGHT */}
        <div className="rounded-lg border border-neutral-800 p-4 flex flex-col gap-4 max-h-[80vh]">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold mb-2">Generated Trade Card</h2>
            <button
              type="button"
              className="ml-3 inline-flex items-center justify-center whitespace-nowrap px-2 py-1 text-xs rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
              onClick={() => setEnlargedCard((v) => !v)}
              title={enlargedCard ? "Close fullscreen" : "Open fullscreen"}
            >
              {enlargedCard ? "Close fullscreen" : "Fullscreen"}
            </button>
          </div>

          {!enlargedCard && (
            <div>
              {planText ? (
                <pre className="whitespace-pre-wrap text-base md:text-[17px] leading-7 opacity-95 max-h-[54vh] overflow-auto pr-2">
                  {planText}
                </pre>
              ) : busy ? (
                <div className="text-sm opacity-80">Analyzing images…</div>
              ) : (
                <div className="text-sm opacity-70">
                  Upload your 4H/1H/15M (and optional calendar) above, then click{" "}
                  <b>Generate from Images</b>.
                </div>
              )}
            </div>
          )}

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

      {/* Full-width reader */}
      {enlargedCard && (
        <div className="rounded-lg border border-neutral-800 p-4 bg-neutral-950">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Generated Trade Card — Full Width</h2>
            <button
              type="button"
              className="inline-flex items-center justify-center whitespace-nowrap px-2 py-1 text-xs rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
              onClick={() => setEnlargedCard(false)}
              title="Close fullscreen"
            >
              Close
            </button>
          </div>
          {planText ? (
            <div className="card-enlarged whitespace-pre-wrap font-mono opacity-95 p-4">
              {planText}
              <style jsx>{`
                .card-enlarged {
                  font-size: 44px !important;
                  line-height: 3.5rem !important;
                }
                @media (min-width: 768px) {
                  .card-enlarged {
                    font-size: 48px !important;
                  }
                }
              `}</style>
            </div>
          ) : (
            <div className="text-base opacity-80 p-2">No plan yet.</div>
          )}
        </div>
      )}
    </div>
  );
}
