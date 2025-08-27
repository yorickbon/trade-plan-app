"use client";

import { useEffect, useState } from "react";
import TradingViewTriple from "../components/TradingViewTriple";
import CalendarPanel, { CalendarItem } from "../components/CalendarPanel";
import HeadlinesPanel, { Headline } from "../components/HeadlinesPanel";
import { INSTRUMENTS } from "../lib/symbols";

type PlanResponse = {
  ok: boolean;
  plan?: { text: string; conviction?: number | null };
  reason?: string;
  usedHeadlines: Headline[];
  usedCalendar: CalendarItem[];
};

export default function Page() {
  const [instrument, setInstrument] = useState(INSTRUMENTS[0]);
  const [dateStr, setDateStr] = useState(new Date().toISOString().slice(0, 10));

  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [headlines, setHeadlines] = useState<Headline[]>([]);

  const [loadingCal, setLoadingCal] = useState(false);
  const [loadingNews, setLoadingNews] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);

  const [planText, setPlanText] = useState("");
  const [standDown, setStandDown] = useState<string | null>(null);

  const [monitoring, setMonitoring] = useState<boolean | null>(null);
  const [monitorMsg, setMonitorMsg] = useState("");

  // ---- fetch calendar ----
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
    } catch {
      setCalendar([]);
    } finally {
      setLoadingCal(false);
    }
  }

  // ---- fetch headlines ----
  async function fetchHeadlines() {
    setLoadingNews(true);
    try {
      const curr = (instrument.currencies ?? []).join(",");
      const rsp = await fetch(`/api/news?currencies=${encodeURIComponent(curr)}`, {
        cache: "no-store",
      });
      const json = await rsp.json();
      setHeadlines(Array.isArray(json.items) ? json.items : []);
    } catch {
      setHeadlines([]);
    } finally {
      setLoadingNews(false);
    }
  }

  // ---- monitoring state ----
  async function fetchMonitorState() {
    try {
      const rsp = await fetch("/api/trade-state", { cache: "no-store" });
      if (!rsp.ok) return;
      const j = await rsp.json();
      setMonitoring(j?.active);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    fetchCalendar();
    fetchHeadlines();
    fetchMonitorState();
  }, [instrument, dateStr]);

  // ---- generate plan ----
  async function generatePlan() {
    setLoadingPlan(true);
    setPlanText("");
    setStandDown(null);

    try {
      const rsp = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument, date: dateStr, calendar, headlines }),
      });
      const json: PlanResponse = await rsp.json();
      if (json.ok) {
        setPlanText(json.plan?.text || "");
        setStandDown(null);
      } else {
        setPlanText("");
        setStandDown(json.reason || "No trade idea returned.");
      }
    } catch {
      setPlanText("");
      setStandDown("Server error while generating plan.");
    } finally {
      setLoadingPlan(false);
    }
  }

  // ---- full reset (and refetch) ----
  function resetSession() {
    setPlanText("");
    setStandDown(null);
    setCalendar([]);
    setHeadlines([]);
    setMonitoring(null);
    setMonitorMsg("");
    fetchCalendar();
    fetchHeadlines();
  }

  // ---- monitoring controls ----
  async function startMonitoring() {
    try {
      setMonitorMsg("");
      const rsp = await fetch("/api/trade-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument, active: true }),
      });
      const j = await rsp.json();
      if (rsp.ok && j.ok === true) {
        setMonitoring(true);
        setMonitorMsg("Monitoring started.");
      } else {
        setMonitorMsg("Could not start monitoring.");
      }
    } catch {
      setMonitorMsg("Could not start monitoring.");
    }
  }

  async function stopMonitoring() {
    try {
      setMonitorMsg("");
      const rsp = await fetch("/api/trade-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      const j = await rsp.json();
      if (rsp.ok && j.ok === true) {
        setMonitoring(false);
        setMonitorMsg("Monitoring stopped.");
      } else {
        setMonitorMsg("Could not stop monitoring.");
      }
    } catch {
      setMonitorMsg("Could not stop monitoring.");
    }
  }

  return (
    <main className="max-w-7xl mx-auto space-y-6 p-6">
      {/* Controls row */}
      <div className="flex items-end gap-4 flex-wrap">
        <div className="flex flex-col">
          <label className="text-sm text-gray-400">Instrument</label>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-2"
            value={instrument.code}
            onChange={(e) => {
              const found = INSTRUMENTS.find((i) => i.code === e.target.value);
              if (found) {
                setInstrument(found);
                resetSession(); // full reset on change
              }
            }}
          >
            {INSTRUMENTS.map((i) => (
              <option key={i.code} value={i.code}>
                {i.code}
              </option>
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

        <button
          onClick={generatePlan}
          disabled={loadingPlan}
          className="rounded bg-blue-600 hover:bg-blue-500 px-4 py-2 disabled:opacity-50"
        >
          {loadingPlan ? "Generating..." : "Generate Plan"}
        </button>

        <button
          onClick={resetSession}
          className="rounded bg-neutral-800 hover:bg-neutral-700 px-4 py-2"
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

      {/* Charts */}
      <TradingViewTriple symbol={instrument.code} />

      {/* Calendar */}
      <div className="mt-6">
        <h2 className="text-xl font-semibold mb-2">Calendar Snapshot</h2>
        <CalendarPanel items={calendar} loading={loadingCal} />
      </div>

      {/* Headlines (smaller text) */}
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
        <div className="text-xs text-gray-400 mt-1">{monitorMsg}</div>
      </div>

      {/* Generated Trade Card (bigger text) */}
      <div>
        <h2 className="text-lg font-bold mb-2">Generated Trade Card</h2>
        {standDown ? (
          <div className="text-yellow-300">
            <strong>Standing down:</strong> {standDown}
          </div>
        ) : (
          <pre className="whitespace-pre-wrap text-base">{planText || ""}</pre>
        )}
      </div>
    </main>
  );
}
