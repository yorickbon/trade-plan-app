"use client";

import { useEffect, useState } from "react";
import TradingViewTriple from "../components/TradingViewTriple";
import CalendarPanel, { type CalendarItem } from "../components/CalendarPanel";
import HeadlinesPanel from "../components/HeadlinesPanel";
// If you created ChatDock, uncomment the next line and the JSX at the bottom.
// import ChatDock from "../components/ChatDock";

import { INSTRUMENTS } from "../lib/symbols";

// Very light types for server responses
type PlanResp = {
  plan: { text: string; conviction?: number | null };
};

export default function Page() {
  // ---- UI state ----
  const [instrument, setInstrument] = useState(INSTRUMENTS[0]);
  const [dateStr, setDateStr] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );

  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [headlines, setHeadlines] = useState<any[]>([]); // keep loose to avoid type drift
  const [loadingCal, setLoadingCal] = useState(false);
  const [loadingNews, setLoadingNews] = useState(false);

  const [planText, setPlanText] = useState<string>("");
  const [conviction, setConviction] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // ---- fetch helpers ----
  async function fetchCalendar() {
    setLoadingCal(true);
    try {
      const res = await fetch(
        `/api/calendar?date=${dateStr}&currencies=${instrument.currencies.join(",")}`
      );
      const json = await res.json();
      // API returns { items: CalendarItem[] }
      setCalendar(Array.isArray(json.items) ? json.items : []);
    } catch (e) {
      console.error(e);
      setCalendar([]);
    } finally {
      setLoadingCal(false);
    }
  }

  async function fetchHeadlines() {
    setLoadingNews(true);
    try {
      const res = await fetch(`/api/news?q=${instrument.code}`);
      const json = await res.json();
      // API returns { items: Headline[] }
      setHeadlines(Array.isArray(json.items) ? json.items : []);
    } catch (e) {
      console.error(e);
      setHeadlines([]);
    } finally {
      setLoadingNews(false);
    }
  }

  useEffect(() => {
    fetchCalendar();
    fetchHeadlines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument, dateStr]);

  // ---- actions ----
  async function generatePlan() {
    setLoading(true);
    setPlanText("");
    setConviction(null);
    try {
      const rsp = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,
          date: dateStr,
          calendar,   // pass calendar snapshot
          headlines,  // pass headlines snapshot
        }),
      });
      const json: PlanResp = await rsp.json();
      setPlanText(json?.plan?.text ?? "");
      setConviction(json?.plan?.conviction ?? null);
    } catch (e) {
      console.error(e);
      setPlanText("Error generating plan.");
      setConviction(null);
    } finally {
      setLoading(false);
    }
  }

  function resetSession() {
    setPlanText("");
    setConviction(null);
    setCalendar([]);
    setHeadlines([]);
    fetchCalendar();
    fetchHeadlines();
  }

  // ---- UI ----
  return (
    <main className="p-4 space-y-6">
      {/* Controls */}
      <div className="grid md:grid-cols-3 gap-4">
        <div className="flex flex-col">
          <label className="text-sm text-gray-400">Instrument</label>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-2"
            value={instrument.code}
            onChange={(e) => {
              const next = INSTRUMENTS.find((i) => i.code === e.target.value);
              if (next) setInstrument(next);
            }}
          >
            {INSTRUMENTS.map((i) => (
              <option key={i.code} value={i.code}>
                {i.label ?? i.code}
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

        <div className="flex items-end gap-3">
          <button
            onClick={generatePlan}
            disabled={loading}
            className="rounded bg-blue-600 hover:bg-blue-500 px-4 py-2 disabled:opacity-60"
          >
            {loading ? "Generating…" : "Generate Plan"}
          </button>
          <button
            onClick={resetSession}
            className="rounded bg-neutral-800 hover:bg-neutral-700 px-4 py-2"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Charts */}
      <TradingViewTriple symbol={instrument.code} />

      {/* Calendar */}
      <section className="space-y-2">
        <h2 className="text-xl font-semibold mb-2">Calendar Snapshot</h2>
        <CalendarPanel items={calendar} loading={loadingCal} />
      </section>

      {/* Headlines */}
      <section className="space-y-2">
        <h2 className="text-xl font-semibold mb-2">Macro Headlines (24h)</h2>
        <HeadlinesPanel items={headlines} loading={loadingNews} />
      </section>

      {/* Generated card */}
      <section className="p-4 border rounded border-neutral-800 bg-neutral-900">
        <h2 className="text-lg font-bold mb-2">Generated Trade Card</h2>
        {conviction != null && (
          <div className="text-sm mb-2">
            Conviction: <span className="font-semibold">{conviction}%</span>
          </div>
        )}
        <pre className="whitespace-pre-wrap text-sm">{planText || ""}</pre>
      </section>

      {/* Optional chat box — uncomment if you added ChatDock component */}
      {/*
      <section>
        <ChatDock symbol={instrument.code} />
      </section>
      */}
    </main>
  );
}
