"use client";

import { useEffect, useMemo, useState } from "react";
import TradingViewTriple from "../components/TradingViewTriple";
import CalendarPanel from "../components/CalendarPanel";
import HeadlinesPanel from "../components/HeadlinesPanel";
import { INSTRUMENTS } from "../lib/symbols";

// ---------- Local types (kept aligned with API) ----------
type Instrument = { code: string; currencies?: string[] };
type CalendarItem = {
  date: string;
  time?: string;
  country?: string;
  currency?: string;
  impact?: "Low" | "Medium" | "High" | "Undefined" | string;
  title: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};
type HeadlineItem = {
  title: string;
  url: string;
  source: string;
  seen?: string;        // ISO timestamp when shown
  published_at?: string; // optional from /api/news
};

type PlanResponse = {
  ok: boolean;
  plan?: { text: string; conviction?: number | null };
  reason?: string;
  usedHeadlines?: HeadlineItem[];
  usedCalendar?: CalendarItem[];
};

export default function Page() {
  // ---------- Core UI state ----------
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0]);
  const [dateStr, setDateStr] = useState<string>(new Date().toISOString().slice(0, 10));

  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [headlines, setHeadlines] = useState<HeadlineItem[]>([]);

  const [loadingCal, setLoadingCal] = useState(false);
  const [loadingNews, setLoadingNews] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);

  const [planText, setPlanText] = useState<string>("");
  const [standDown, setStandDown] = useState<string | null>(null);

  const [monitoring, setMonitoring] = useState<boolean | null>(null);
  const [monitorMsg, setMonitorMsg] = useState<string>("");

  // Used to hard-reset child components (charts) by changing React key
  const [sessionKey, setSessionKey] = useState<number>(() => Date.now());

  // Bust fetch caches (Vercel/Next) after resets/changes
  const bust = useMemo(() => `sid=${sessionKey}`, [sessionKey]);

  // ---------- Fetch Calendar ----------
  async function fetchCalendar() {
    setLoadingCal(true);
    try {
      const q = new URLSearchParams({
        date: dateStr,
        currencies: (instrument.currencies ?? []).join(","),
        _b: bust,
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

  // ---------- Fetch Headlines ----------
  async function fetchHeadlines() {
    setLoadingNews(true);
    try {
      const curr = (instrument.currencies ?? []).join(",");
      const rsp = await fetch(`/api/news?currencies=${encodeURIComponent(curr)}&${bust}`, {
        cache: "no-store",
      });
      const json = await rsp.json();
      setHeadlines(Array.isArray(json.items) ? json.items : []);
    } catch (e) {
      console.error(e);
      setHeadlines([]);
    } finally {
      setLoadingNews(false);
    }
  }

  // ---------- Read current monitor state (optional endpoint) ----------
  async function fetchMonitorState() {
    try {
      const rsp = await fetch(`/api/trade-state?${bust}`, { cache: "no-store" });
      if (!rsp.ok) return;
      const j = await rsp.json();
      setMonitoring(!!j?.active);
    } catch {
      // endpoint may not exist yet
    }
  }

  // ---------- Initial load ----------
  useEffect(() => {
    fetchCalendar();
    fetchHeadlines();
    fetchMonitorState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument.code, dateStr, sessionKey]); // re-run on instrument/date or hard reset

  // ---------- Generate Plan ----------
  async function generatePlan() {
    setLoadingPlan(true);
    setPlanText("");
    setStandDown(null);
    setMonitorMsg("");
    try {
      const rsp = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,
          date: dateStr,
          calendar,  // pass snapshot we already fetched
          headlines, // pass snapshot we already fetched
          _bust: bust,
        }),
      });
      const json: PlanResponse = await rsp.json();

      if (json.ok) {
        setPlanText(json.plan?.text || "");
        setStandDown(null);
      } else {
        setPlanText("");
        setStandDown(json.reason || "No trade idea returned.");
      }
    } catch (e) {
      console.error(e);
      setPlanText("");
      setStandDown("Server error while generating plan.");
    } finally {
      setLoadingPlan(false);
    }
  }

  // ---------- Hard Reset ----------
  function hardReset() {
    // clear UI
    setPlanText("");
    setStandDown(null);
    setMonitorMsg("");
    setCalendar([]);
    setHeadlines([]);
    setLoadingCal(false);
    setLoadingNews(false);
    setLoadingPlan(false);
    setMonitoring(null);

    // reset date to today
    setDateStr(new Date().toISOString().slice(0, 10));

    // bump session key (remount children + bust caches)
    setSessionKey(Date.now());
  }

  // When instrument changes: FULL reset, then set instrument
  function onChangeInstrument(code: string) {
    const found = INSTRUMENTS.find((i) => i.code === code);
    if (!found) return;
    // first switch instrument
    setInstrument(found);
    // then hard reset the rest so app behaves like a fresh open
    hardReset();
  }

  // ---------- Monitoring (optional) ----------
  async function startMonitoring() {
    setMonitorMsg("");
    try {
      const rsp = await fetch("/api/trade-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: true, instrument }),
      });
      const j = await rsp.json();
      if (rsp.ok && j?.ok !== false) {
        setMonitoring(true);
        setMonitorMsg("Monitoring started. Alerts will be sent to Telegram if configured.");
      } else {
        setMonitoring(false);
        setMonitorMsg(j?.error || "Could not start monitoring.");
      }
    } catch {
      setMonitoring(false);
      setMonitorMsg("Could not start monitoring.");
    }
  }

  async function stopMonitoring() {
    setMonitorMsg("");
    try {
      const rsp = await fetch("/api/trade-state", {
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
    <main className="max-w-7xl mx-auto space-y-6 px-3 pb-16">
      {/* Controls */}
      <div className="mt-4 space-y-3">
        {/* Instrument */}
        <div className="flex flex-col md:flex-row md:items-center gap-2">
          <label className="text-sm text-gray-400 w-28">Instrument</label>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-2"
            value={instrument.code}
            onChange={(e) => onChangeInstrument(e.target.value)}
          >
            {INSTRUMENTS.map((i) => (
              <option key={i.code} value={i.code}>
                {i.code}
              </option>
            ))}
          </select>
        </div>

        {/* Date */}
        <div className="flex flex-col md:flex-row md:items-center gap-2">
          <label className="text-sm text-gray-400 w-28">Date</label>
          <input
            type="date"
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-2"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
          />
        </div>

        {/* Actions — horizontal row */}
        <div className="flex items-center flex-wrap gap-3 pt-2">
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
            title="Full reset (as if reopening the app)"
          >
            Reset
          </button>

          <button
            onClick={startMonitoring}
            className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2"
            title="Start Telegram / news monitoring for this instrument"
          >
            Start monitoring
          </button>

          <button
            onClick={stopMonitoring}
            className="rounded bg-rose-600 hover:bg-rose-500 px-4 py-2"
            title="Stop Telegram / news monitoring"
          >
            Stop monitoring
          </button>
        </div>
      </div>

      {/* Charts (remount on sessionKey change) */}
      <TradingViewTriple key={sessionKey} symbol={instrument.code} />

      {/* Calendar */}
      <div className="mt-6">
        <h2 className="text-xl font-semibold mb-2">Calendar Snapshot</h2>
        <CalendarPanel items={calendar} loading={loadingCal} />
      </div>

      {/* Headlines (smaller text requested) */}
      <div className="mt-6 text-sm">
        <h2 className="text-xl font-semibold mb-2">Macro Headlines (24–48h)</h2>
        <HeadlinesPanel items={headlines} loading={loadingNews} />
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

      {/* Generated Trade Card (bigger text requested) */}
      <div className="bg-neutral-900 border border-neutral-800 rounded p-3">
        <h2 className="text-lg font-bold mb-2">Generated Trade Card</h2>

        {standDown ? (
          <div className="text-yellow-300">
            <strong>Standing down:</strong> {standDown}
          </div>
        ) : null}

        <pre className="whitespace-pre-wrap text-base md:text-lg leading-6 mt-2">
          {planText || ""}
        </pre>
      </div>
    </main>
  );
}
