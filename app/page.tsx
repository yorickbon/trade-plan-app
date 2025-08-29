"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";

import CalendarPanel from "../components/CalendarPanel";
import HeadlinesPanel from "../components/HeadlinesPanel";

// charts client-only (prevents hydration issues)
const TradingViewTriple = dynamic(
  () => import("../components/TradingViewTriple"),
  { ssr: false }
);

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

function baseQuoteFromInstrument(instr: string): [string, string] {
  const s = (instr || "").toUpperCase().replace("/", "");
  if (s.length >= 6) return [s.slice(0, 3), s.slice(-3)];
  if (s.endsWith("USD")) return [s.replace("USD", ""), "USD"];
  return [s, "USD"];
}

function currenciesFromBias(bias?: CalendarBias) {
  return bias ? Object.keys(bias.perCurrency || {}) : [];
}

/** Ensure readable multi-line text for Trade Card */
function toReadableText(v: any): string {
  let raw: string;
  if (v == null) return "";
  if (typeof v === "string") raw = v;
  else if (typeof v === "object") {
    if (v.card && typeof v.card.text === "string") raw = v.card.text;
    else if (typeof v.text === "string") raw = v.text;
    else if (typeof v.plan === "string") raw = v.plan;
    else {
      try { raw = JSON.stringify(v, null, 2); } catch { raw = String(v); }
    }
  } else raw = String(v);
  return raw.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "    ");
}

export default function Page() {
  const [instrument, setInstrument] = useState("EURUSD");
  const [dateStr, setDateStr] = useState(todayISO());

  const [calendar, setCalendar] = useState<CalendarResp | null>(null);
  const [loadingCal, setLoadingCal] = useState(false);

  const [headlines, setHeadlines] = useState<any[]>([]);
  const [loadingNews, setLoadingNews] = useState(false);

  const [planText, setPlanText] = useState<string>("");
  const [generating, setGenerating] = useState(false);

  // ---- prevent stale updates (only minimal use here) ----
  const requestIdRef = useRef(0);
  const planAbortRef = useRef<AbortController | null>(null);

  // ✅ Reset plan whenever instrument OR date changes (your request)
  useEffect(() => {
    setPlanText("");
    setGenerating(false);
    if (planAbortRef.current) {
      try { planAbortRef.current.abort(); } catch {}
      planAbortRef.current = null;
    }
  }, [instrument, dateStr]);

  const calendarCurrencies = useMemo(
    () => currenciesFromBias((calendar as any)?.bias),
    [calendar]
  );

  const loadHeadlinesFor = useCallback(async (symbols: string[]) => {
    if (!symbols.length) {
      setHeadlines([]);
      return;
    }
    setLoadingNews(true);
    try {
      const r = await fetch(`/api/news?symbols=${symbols.join(",")}`, { cache: "no-store" });
      const j: NewsResp = await r.json();
      if (j?.ok) setHeadlines(j.items || []);
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
      const r = await fetch(
        `/api/calendar?date=${dateStr}&instrument=${instrument}&windowHours=48`,
        { cache: "no-store" }
      );
      const j: CalendarResp = await r.json();
      setCalendar(j);

      if (j?.ok) {
        const ccy = currenciesFromBias(j.bias);
        await loadHeadlinesFor(ccy.length ? ccy : baseQuoteFromInstrument(instrument));
      } else {
        await loadHeadlinesFor(baseQuoteFromInstrument(instrument));
      }
    } catch {
      setCalendar({ ok: false, reason: "Calendar request failed" });
      await loadHeadlinesFor(baseQuoteFromInstrument(instrument));
    } finally {
      setLoadingCal(false);
    }
  }, [dateStr, instrument, loadHeadlinesFor]);

  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);

  const generatePlan = useCallback(async () => {
    // Abort any older request
    const myId = ++requestIdRef.current;
    if (planAbortRef.current) {
      try { planAbortRef.current.abort(); } catch {}
    }
    const controller = new AbortController();
    planAbortRef.current = controller;

    setGenerating(true);
    setPlanText("");

    try {
      // ✅ ALSO include instrument/date in the URL query so legacy plan routes that read query still work
      const r = await fetch(`/api/plan?instrument=${instrument}&date=${dateStr}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instrument, date: dateStr, calendar, headlines }),
        signal: controller.signal,
      });

      if (myId !== requestIdRef.current) return; // ignore stale

      const contentType = r.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const j: any = await r.json();
        if (myId !== requestIdRef.current) return;
        if (j?.ok) setPlanText(toReadableText(j));
        else setPlanText(toReadableText(j?.reason || j));
      } else {
        const t = await r.text();
        if (myId !== requestIdRef.current) return;
        setPlanText(toReadableText(t));
      }
    } catch (e: any) {
      if (controller.signal.aborted) return;
      if (myId === requestIdRef.current) setPlanText(toReadableText(e?.message || e));
    } finally {
      if (myId === requestIdRef.current) setGenerating(false);
    }
  }, [instrument, dateStr, calendar, headlines]);

  // Buttons you asked for (kept)
  const resetAll = useCallback(() => {
    setPlanText("");
    setCalendar(null);
    setHeadlines([]);
    setLoadingCal(false);
    setLoadingNews(false);
    console.info("Reset complete.");
  }, []);

  const callMonitor = useCallback(
    async (action: "start" | "stop") => {
      try {
        const r = await fetch("/api/monitor", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, instrument, date: dateStr }),
        });
        const j = await r.json();
        if (j?.ok) console.info(`[monitor] ${action} ok`, j);
        else console.warn(`[monitor] ${action} responded`, j);
      } catch (e) {
        console.warn(`[monitor] ${action} failed`, e);
      }
    },
    [instrument, dateStr]
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
            <option>AUDUSD</option><option>EURUSD</option><option>GBPUSD</option>
            <option>USDJPY</option><option>USDCAD</option><option>EURGBP</option>
            <option>EURJPY</option><option>GBPJPY</option><option>EURAUD</option>
            <option>NZDUSD</option>
            {/* Indices */}
            <option>SPX500</option><option>NAS100</option><option>US30</option><option>GER40</option>
            {/* Metals/Crypto */}
            <option>XAUUSD</option><option>BTCUSD</option><option>ETHUSD</option>
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

        {/* Buttons restored */}
        <button
          onClick={resetAll}
          className="px-3 py-1 text-sm rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
        >
          Reset
        </button>

        <button
          onClick={() => callMonitor("start")}
          className="px-3 py-1 text-sm rounded bg-sky-700 hover:bg-sky-600"
        >
          Start monitoring
        </button>
        <button
          onClick={() => callMonitor("stop")}
          className="px-3 py-1 text-sm rounded bg-rose-700 hover:bg-rose-600"
        >
          Stop monitoring
        </button>
      </div>

      {/* Charts row (unchanged) */}
      <TradingViewTriple symbol={instrument} />

      {/* Calendar */}
      <div className="rounded-lg border border-neutral-800 p-4">
        <h2 className="text-lg font-semibold mb-2">Calendar Snapshot</h2>
        {loadingCal && <div className="text-sm opacity-75">Loading calendar…</div>}
        {!loadingCal && calendar?.ok && Array.isArray(calendar.items) && (
          <CalendarPanel items={calendar.items} />
        )}
        {!loadingCal && (!calendar || !calendar.ok) && (
          <div className="text-sm opacity-75">
            No calendar items found from providers. (Once your TradingEconomics key is active, this will populate automatically.)
          </div>
        )}
      </div>

      {/* Headlines (left) + Trade Card (right) */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-7 rounded-lg border border-neutral-800 p-4">
          <h2 className="text-lg font-semibold mb-2">Macro Headlines (24–48h)</h2>
          <HeadlinesPanel items={headlines} />
          <div className="text-xs mt-2 opacity-60">
            {loadingNews
              ? "Loading headlines…"
              : headlines.length
              ? `${headlines.length} headlines found`
              : "No notable headlines."}
          </div>
        </div>

        <div className="col-span-12 lg:col-span-5 rounded-lg border border-neutral-800 p-4">
          <h2 className="text-lg font-semibold mb-2">Generated Trade Card</h2>
          {planText ? (
            <pre className="whitespace-pre-wrap text-sm leading-5 opacity-95 max-h-[60vh] overflow-auto">
              {planText}
            </pre>
          ) : generating ? (
            <div className="text-sm opacity-80">Generating…</div>
          ) : (
            <div className="text-sm opacity-70">
              Click <b>Generate Plan</b> to build a setup using 15m execution,
              1h+4h context, fundamentals (calendar bias + headlines), and our strategy logic.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
