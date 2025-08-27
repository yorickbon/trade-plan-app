"use client";

import { useEffect, useState } from "react";
import TradingViewTriple from "./components/TradingViewTriple";
import CalendarPanel from "./components/CalendarPanel";
import HeadlinesPanel from "./components/HeadlinesPanel";
import { INSTRUMENTS } from "../lib/symbols";

/* ---------------- Local types (decouple from child components) ---------------- */
type Instrument = { code: string; currencies?: string[] };
type CalendarItem = {
  date: string; time?: string;
  country?: string; currency?: string;
  impact?: "Low"|"Medium"|"High"|"Undefined"|string;
  title?: string; actual?: string; forecast?: string; previous?: string;
};
type Headline = { title: string; url?: string; source?: string; seen?: string; published_at?: string };
type PlanResponse =
  | { ok: true; plan: { text: string }; usedHeadlines: Headline[]; usedCalendar: CalendarItem[] }
  | { ok: false; reason: string };

/* ------------------------------ Page ------------------------------ */
export default function Page() {
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0]);
  const [dateStr, setDateStr] = useState<string>(new Date().toISOString().slice(0,10));

  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [headlines, setHeadlines] = useState<Headline[]>([]);

  const [loadingCal, setLoadingCal] = useState(false);
  const [loadingNews, setLoadingNews] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);

  const [planText, setPlanText] = useState<string>("");
  const [standDown, setStandDown] = useState<string | null>(null);

  const [monitoring, setMonitoring] = useState<boolean | null>(null);
  const [monitorMsg, setMonitorMsg] = useState<string>("");

  // force re-mount charts on reset/instrument change
  const [chartKey, setChartKey] = useState<number>(0);

  /* ----------------------- fetch calendar ------------------------ */
  async function fetchCalendar() {
    setLoadingCal(true);
    try {
      const q = new URLSearchParams({
        date: dateStr,
        currencies: (instrument.currencies ?? []).join(","),
      }).toString();
      const rsp = await fetch(`/api/calendar?${q}`, { cache: "no-store" });
      const json = await rsp.json();
      setCalendar(Array.isArray(json.items) ? json.items : []);
    } catch (e) {
      console.error(e);
      setCalendar([]);
    } finally {
      setLoadingCal(false);
    }
  }

  /* ----------------------- fetch headlines ----------------------- */
  async function fetchHeadlines() {
    setLoadingNews(true);
    try {
      const curr = (instrument.currencies ?? []).join(",");
      const rsp = await fetch(`/api/news?currencies=${encodeURIComponent(curr)}`, { cache: "no-store" });
      const json = await rsp.json();
      setHeadlines(Array.isArray(json.items) ? json.items : []);
    } catch (e) {
      console.error(e);
      setHeadlines([]);
    } finally {
      setLoadingNews(false);
    }
  }

  /* --------------- read current monitor state (optional) --------- */
  async function fetchMonitorState() {
    try {
      const rsp = await fetch(`/api/trade-state`, { cache: "no-store" });
      if (!rsp.ok) return;
      const j = await rsp.json();
      setMonitoring(!!j?.active);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    fetchCalendar();
    fetchHeadlines();
    fetchMonitorState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument.code, dateStr]);

  /* ------------------------- generate plan ----------------------- */
  async function generatePlan() {
    setLoadingPlan(true);
    setPlanText("");
    setStandDown(null);

    try {
      const rsp = await fetch(`/api/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,
          date: dateStr,
          calendar,   // pass snapshots we already fetched
          headlines,  // pass snapshots we already fetched
        }),
      });
      const json: PlanResponse = await rsp.json();

      if ((json as any).ok) {
        setPlanText((json as any).plan?.text || "");
        setStandDown(null);
      } else {
        setPlanText("");
        setStandDown((json as any).reason || "No trade idea returned.");
      }
    } catch (e) {
      console.error(e);
      setPlanText("");
      setStandDown("Server error while generating plan.");
    } finally {
      setLoadingPlan(false);
    }
  }

  /* ---------------------------- reset ---------------------------- */
  function hardReset() {
    setPlanText("");
    setStandDown(null);
    setCalendar([]);
    setHeadlines([]);
    setLoadingCal(false);
    setLoadingNews(false);
    setLoadingPlan(false);
    setMonitorMsg("");
    setMonitoring(null);
    setChartKey(k => k + 1); // force re-mount charts
  }

  function onInstrumentChange(nextCode: string) {
    const found = INSTRUMENTS.find(i => i.code === nextCode);
    if (found) setInstrument(found);
    // full reset on instrument change
    hardReset();
    // re-fetch fresh data for the new instrument
    setTimeout(() => { fetchCalendar(); fetchHeadlines(); }, 0);
  }

  /* ---------------------- monitor start/stop --------------------- */
  async function startMonitoring() {
    setMonitorMsg("");
    try {
      const rsp = await fetch(`/api/trade-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: true, instrument }),
      });
      const j = await rsp.json();
      if (rsp.ok && j?.ok !== false) {
        setMonitoring(true);
        setMonitorMsg("Monitoring started. Alerts will be sent to Telegram if configured.");
      } else {
        setMonitorMsg(j?.error || "Could not start monitoring.");
      }
    } catch {
      setMonitorMsg("Could not start monitoring.");
    }
  }

  async function stopMonitoring() {
    setMonitorMsg("");
    try {
      const rsp = await fetch(`/api/trade-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      const j = await rsp.json();
      if (rsp.ok && j?.ok !== false) {
        setMonitoring(false);
        setMonitorMsg("Monitoring stopped.");
      } else {
        setMonitorMsg(j?.error || "Could not stop monitoring.");
      }
    } catch {
      setMonitorMsg("Could not stop monitoring.");
    }
  }

  return (
    <main className="max-w-7xl mx-auto space-y-6 px-4">
      {/* Controls */}
      <div className="flex flex-col gap-4">
        {/* Instrument & Date in a row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="flex flex-col">
            <label className="text-sm text-gray-400">Instrument</label>
            <select
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-2"
              value={instrument.code}
              onChange={(e) => onInstrumentChange(e.target.value)}
            >
              {INSTRUMENTS.map(i => (
                <option key={i.code} value={i.code}>{i.code}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-sm text-gray-400">Date</label>
            <input
              type="date"
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-2"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value)}
            />
          </div>
        </div>

        {/* Action buttons: horizontal row */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={generatePlan}
            disabled={loadingPlan}
            className="rounded bg-blue-600 hover:bg-blue-500 px-4 py-2 disabled:opacity-50"
          >
            {loadingPlan ? "Generating..." : "Generate Plan"}
          </button>

          <button
            onClick={hardReset}
            className="rounded bg-neutral-800 hover:bg-neutral-700 px-4 py-2"
          >
            Reset
          </button>

          <button
            onClick={startMonitoring}
            title="Start Telegram / news monitoring for this instrument"
            className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2"
          >
            Start monitoring
          </button>

          <button
            onClick={stopMonitoring}
            title="Stop Telegram / news monitoring"
            className="rounded bg-rose-600 hover:bg-rose-500 px-4 py-2"
          >
            Stop monitoring
          </button>
        </div>
      </div>

      {/* Charts */}
      <TradingViewTriple key={chartKey} symbol={instrument.code} />

      {/* Calendar */}
      <div className="mt-6">
        <h2 className="text-xl font-semibold mb-2">Calendar Snapshot</h2>
        <CalendarPanel items={calendar} loading={loadingCal} />
      </div>

      {/* Headlines (smaller text) */}
      <div className="mt-6">
        <h2 className="text-xl font-semibold mb-2">Macro Headlines (24–48h)</h2>
        <div className="text-sm">
          <HeadlinesPanel items={headlines} loading={loadingNews} />
        </div>
      </div>

      {/* Monitoring status */}
      <div className="mt-2 text-sm text-gray-300">
        {monitoring === null ? (
          <span className="text-gray-500">Monitor status: unknown</span>
        ) : monitoring ? (
          <span className="text-emerald-400">Monitoring: ON</span>
        ) : (
          <span className="text-gray-400">Monitoring: OFF</span>
        )}
        {monitorMsg && <div className="text-xs text-gray-400 mt-1">{monitorMsg}</div>}
      </div>

      {/* Generated trade card */}
      <div className="mt-6 rounded bg-neutral-900 border border-neutral-800 p-4">
        <h2 className="text-lg font-bold mb-2">Generated Trade Card</h2>
        {standDown ? (
          <div className="text-yellow-300"><strong>Standing down:</strong> {standDown}</div>
        ) : (
          <pre className="whitespace-pre-wrap text-lg">{planText || ""}</pre>
        )}
      </div>
    </main>
  );
}
