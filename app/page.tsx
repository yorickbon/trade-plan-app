// app/page.tsx
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";

import CalendarPanel from "../components/CalendarPanel";
import HeadlinesPanel from "../components/HeadlinesPanel";
import ChatDock from "../components/ChatDock";
import VisionUpload from "../components/VisionUpload";
import { INSTRUMENTS } from "../lib/symbols";

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

// Extract trailing ```ai_meta { ... } ``` JSON block
function extractAiMetaFromText(text: string): any | null {
  if (!text) return null;
  const re = /```ai_meta\s*({[\s\S]*?})\s*```/i;
  const m = text.match(re);
  if (!m || !m[1]) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
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

  // fullscreen toggle for trade card
  const [enlargedCard, setEnlargedCard] = useState<boolean>(false);

  // force-reset signal for VisionUpload (increments on Reset and on instrument change)
  const [resetTick, setResetTick] = useState<number>(0);

  // headlines request coordination
  const headlinesSeqRef = useRef(0);
  const headlinesAbortRef = useRef<AbortController | null>(null);

  // ----- derive A→Z instrument list from lib/symbols.ts -----
  const instrumentsAZ = useMemo(
    () =>
      [...INSTRUMENTS].sort((a, b) =>
        (a.label || a.code).localeCompare(b.label || b.code, "en", {
          sensitivity: "base",
        })
      ),
    []
  );

  // ----- load headlines for currencies / instrument -----
  const loadHeadlinesForSymbols = useCallback(async (symbols: string[]) => {
    setHeadlines([]);
    if (!symbols.length) return;

    if (headlinesAbortRef.current) {
      try { headlinesAbortRef.current.abort(); } catch {}
    }

    const controller = new AbortController();
    headlinesAbortRef.current = controller;
    const reqId = ++headlinesSeqRef.current;

    setLoadingNews(true);
    try {
      const nr = await fetch(`/api/news?symbols=${symbols.join(",")}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const nj: NewsResp = await nr.json();
      if (reqId === headlinesSeqRef.current) {
        setHeadlines(nj?.ok ? nj.items || [] : []);
      }
    } catch {
      if (reqId === headlinesSeqRef.current) setHeadlines([]);
    } finally {
      if (reqId === headlinesSeqRef.current) setLoadingNews(false);
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

  useEffect(() => { loadCalendar(); }, [loadCalendar]);

  // reset
  const resetAll = useCallback(() => {
    setPlanText("");
    setHeadlines([]);
    setCalendar(null);
    setDateStr(todayISO());
    setEnlargedCard(false);
    if (headlinesAbortRef.current) { try { headlinesAbortRef.current.abort(); } catch {} }
    setResetTick((t) => t + 1);
    setTimeout(() => loadCalendar(), 0);
  }, [loadCalendar]);

  // when instrument changes, also hard-reset uploader & clear plan
  const onInstrumentChange = useCallback(
    (next: string) => {
      setInstrument(next.toUpperCase());
      setPlanText("");
      setEnlargedCard(false);
      if (headlinesAbortRef.current) { try { headlinesAbortRef.current.abort(); } catch {} }
      setHeadlines([]);
      setResetTick((t) => t + 1);
      setTimeout(() => loadCalendar(), 0);
    },
    [loadCalendar]
  );

  // ESC closes fullscreen
  useEffect(() => {
    if (!enlargedCard) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setEnlargedCard(false); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [enlargedCard]);

  const calendarCurrencies = useMemo(
    () => currenciesFromBias((calendar as any)?.bias),
    [calendar]
  );

  // ---- Derive model-read price (from ai_meta) for a tiny sanity line ----
  const modelReadPrice = useMemo(() => {
    const meta = extractAiMetaFromText(planText);
    const p = Number(meta?.currentPrice);
    return Number.isFinite(p) ? p : null;
  }, [planText]);

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
            {instrumentsAZ.map((it) => (
              <option key={it.code} value={it.code}>
                {it.label || it.code}
              </option>
            ))}
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

        {/* (future) monitoring hooks) */}
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

        {/* RIGHT: Trade Card (normal) + Chat */}
        <div className="rounded-lg border border-neutral-800 p-4 flex flex-col gap-4 max-h-[80vh]">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold mb-1">Generated Trade Card</h2>
              {modelReadPrice != null && (
                <div className="text-xs opacity-70">
                  Model read price: <b>{modelReadPrice}</b>
                </div>
              )}
            </div>

            {/* Fullscreen toggle now expands to a full-width reader below */}
            <button
              type="button"
              className="ml-3 inline-flex items-center justify-center whitespace-nowrap px-2 py-1 text-xs rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
              onClick={() => setEnlargedCard((v) => !v)}
              title={enlargedCard ? "Close fullscreen" : "Open fullscreen"}
            >
              {enlargedCard ? "Close fullscreen" : "Fullscreen"}
            </button>
          </div>

          {/* In-panel normal reader (hidden when enlarged to full width) */}
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
                  Upload your 4H/1H/15M (and optional calendar) above, then click <b>Generate from Images</b>.
                </div>
              )}
            </div>
          )}

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

      {/* Full-width reader row below the grid (appears when enlarged) */}
      {enlargedCard && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-950">
          {/* Sticky header */}
          <div className="sticky top-0 z-10 bg-neutral-950/95 backdrop-blur-sm border-b border-neutral-800">
            <div className="max-w-[1100px] mx-auto flex items-center justify-between px-6 py-3">
              <h2 className="text-lg font-semibold">Generated Trade Card — Full Width</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center justify-center whitespace-nowrap px-2 py-1 text-xs rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
                  onClick={() => {
                    if (planText) navigator.clipboard?.writeText(planText).catch(() => {});
                  }}
                  title="Copy card to clipboard"
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center whitespace-nowrap px-2 py-1 text-xs rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
                  onClick={() => setEnlargedCard(false)}
                  title="Close fullscreen (Esc)"
                >
                  Close
                </button>
              </div>
            </div>
          </div>

          {/* Reader content — use <pre> to preserve layout exactly */}
          <div className="max-w-[1100px] mx-auto p-6">
            {planText ? (
              <pre className="card-enlarged-pre whitespace-pre-wrap font-mono opacity-95">
                {planText}
                <style jsx>{`
                  .card-enlarged-pre {
                    font-size: 24px !important;
                    line-height: 2.0rem !important;
                    letter-spacing: 0.005em;
                    white-space: pre-wrap !important;
                    tab-size: 2;
                  }
                  @media (min-width: 768px) {
                    .card-enlarged-pre { font-size: 26px !important; }
                  }
                `}</style>
              </pre>
            ) : (
              <div className="text-base opacity-80 p-2">No plan yet.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
