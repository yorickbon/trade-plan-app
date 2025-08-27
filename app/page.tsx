// app/page.tsx
"use client";

import { useEffect, useState } from "react";
import TradingViewTriple from "../components/TradingViewTriple";
import CalendarPanel from "../components/CalendarPanel";
import HeadlinesPanel from "../components/HeadlinesPanel";
import { INSTRUMENTS } from "../lib/symbols";

/* ---------- local types (aligned with API) ---------- */
type Instrument = { code: string; currencies?: string[] };
type CalendarItem = {
  date: string;
  time?: string;
  country?: string;
  currency?: string;
  impact?: "Low" | "Medium" | "High" | "Undefined" | string;
  title?: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};
type Headline = {
  title: string;
  url?: string;
  source?: string;
  seen?: string; // ISO timestamp we set when displaying
  published_at?: string;
};
type PlanResponse =
  | { ok: true; plan: { text: string }; usedHeadlines: Headline[]; usedCalendar: CalendarItem[] }
  | { ok: false; reason: string; usedHeadlines: Headline[]; usedCalendar: CalendarItem[] };

export default function Page() {
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0]);
  const [dateStr, setDateStr] = useState<string>(new Date().toISOString().slice(0, 10));

  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [headlines, setHeadlines] = useState<Headline[]>([]);

  const [loadingCal, setLoadingCal] = useState(false);
  const [loadingNews, setLoadingNews] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);

  const [planText, setPlanText] = useState("");
  const [standDown, setStandDown] = useState<string | null>(null);

  const [monitoring, setMonitoring] = useState<boolean | null>(null);
  const [monitorMsg, setMonitorMsg] = useState("");

  /* ---------------- fetch calendar ---------------- */
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

  /* ---------------- fetch headlines ---------------- */
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

  /* --------------- read current monitor state --------------- */
  async function fetchMonitorState() {
    try {
      const rsp = await fetch("/api/trade-state", { cache: "no-store" });
      if (!rsp.ok) return;
      const j = await rsp.json();
      setMonitoring(!!j?.active);
    } catch {
      /* endpoint may not exist yet; ignore */
    }
  }

  /* ------------------- generate plan ------------------- */
  async function generatePlan() {
    setLoadingPlan(true);
    setPlanText("");
    setStandDown(null);
    try {
      const rsp = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,
          date: dateStr,
          calendar,  // pass snapshot already fetched
          headlines, // pass snapshot already fetched
        }),
      });
      const json: PlanResponse = await rsp.json();

      if (json.ok) {
        setPlanText(json.plan.text || "");
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

  /* ----------------------- reset ----------------------- */
  function resetSession() {
    // full UI reset (like fresh load)
    setPlanText("");
    setStandDown(null);
    setMonitoring(null);
    setMonitorMsg("");
    setCalendar([]);
    setHeadlines([]);
    // re-fetch fresh snapshots
    fetchCalendar();
    fetchHeadlines();
    fetchMonitorState();
  }

  /* ------- monitoring controls (Start / Stop) ------- */
  async function startMonitoring() {
    setMonitorMsg("");
    try {
      const rsp = await fetch("/api/trade-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: true, instrument }),
      });
      const j = await rsp.json();
      if (rsp.ok && j?.ok === true) {
        setMonitoring(true);
        setMonitorMsg("Monitoring started. Alerts will be sent to Telegram if configured.");
      } else {
        setMonitoring(false);
        setMonitorMsg(j?.error || "Could not start monitoring.");
      }
    } catch {
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
      if (rsp.ok && j?.ok === true) {
        setMonitoring(false);
        setMonitorMsg("Monitoring stopped.");
      } else {
        setMonitorMsg(j?.error || "Could not stop monitoring.");
      }
    } catch {
      setMonitorMsg("Could not stop monitoring.");
    }
  }

  /* -------- initial load -------- */
  useEffect(() => {
    fetchCalendar();
    fetchHeadlines();
    fetchMonitorState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------- when instrument changes, do a full reset -------- */
  useEffect(() => {
    resetSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument.code, dateStr]);

  /* ------------------------ UI ------------------------ */
  return (
    <main className="max-w-7xl mx-auto space-y-6 px-4">
      {/* Controls */}
      <div className="flex flex-col gap-3">
        {/* Instrument + Date row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="flex flex-col">
            <label className="text-sm text-gray-400">Instrument</label>
            <select
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-2"
              value={instrument.code}
              onChange={(e) => {
                const found = INSTRUMENTS.find(i => i.code === e.target.value);
                if (found) setInstrument(found);
              }}
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

        {/* Action buttons (horizontal, wraps on small screens) */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={generatePlan}
            disabled={loadingPlan}
            className="rounded bg-blue-600 hover:bg-blue-500 px-4 py-2 disabled:opacity-50"
            title="Generate plan"
          >
            {loadingPlan ? "Generating…" : "Generate Plan"}
          </button>

          <button
            onClick={resetSession}
            className="rounded bg-neutral-800 hover:bg-neutral-700 px-4 py-2"
            title="Reset"
          >
            Reset
          </button>

          <button
            onClick={startMonitoring}
            className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2"
            title="Start Telegram / news monitoring"
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

      {/* Charts */}
      <TradingViewTriple symbol={instrument.code} />

      {/* Calendar */}
      <div className="mt-6">
        <h2 className="text-xl font-semibold mb-2">Calendar Snapshot</h2>
        <CalendarPanel items={calendar} loading={loadingCal} />
      </div>

      {/* Headlines (smaller text requested) */}
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

      {/* Generated Trade Card (bigger text requested) */}
      <div className="mt-6 bg-neutral-900 border border-neutral-800 rounded p-4">
        <h2 className="text-2xl font-bold mb-2">Generated Trade Card</h2>

        {standDown ? (
          <div className="text-yellow-300 text-base">
            <strong>Standing down:</strong> {standDown}
          </div>
        ) : (
          <pre className="whitespace-pre-wrap text-lg">{planText || ""}</pre>
        )}
      </div>
    </main>
  );
}
