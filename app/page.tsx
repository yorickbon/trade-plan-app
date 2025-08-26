// app/page.tsx
"use client";

import { useEffect, useState } from "react";
import TradingViewTriple from "../components/TradingViewTriple";
import CalendarPanel, { CalendarItem } from "../components/CalendarPanel";
import { INSTRUMENTS } from "../lib/symbols";

type Instrument = {
  code: string;           // e.g. "EURUSD"
  label?: string;         // UI label if present
  currencies: string[];   // e.g. ["EUR","USD"]
};

export default function Page() {
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0] as Instrument);
  const [dateStr, setDateStr] = useState<string>(new Date().toISOString().slice(0, 10));

  // calendar + headlines state
  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [loadingCal, setLoadingCal] = useState(false);
  const [headlines, setHeadlines] = useState<
    { title: string; url: string; source: string; seen: string }[]
  >([]);
  const [loadingNews, setLoadingNews] = useState(false);

  // generated plan state
  const [planText, setPlanText] = useState<string>("");
  const [conviction, setConviction] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  async function fetchCalendar() {
    setLoadingCal(true);
    try {
      const res = await fetch(
        `/api/calendar?date=${dateStr}&currencies=${instrument.currencies.join(",")}`
      );
      const json = await res.json();
      setCalendar(json.items || []);
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
      setHeadlines(json.items || []);
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

  async function generatePlan() {
    setLoading(true);
    try {
      const rsp = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,
          date: dateStr,
          calendar,    // pass snapshot pulled above
          headlines,   // pass headlines pulled above
        }),
      });

      const json = await rsp.json();
      setPlanText(json.plan?.text || "");
      setConviction(json.plan?.conviction ?? null);
    } catch (e) {
      console.error(e);
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

  return (
    <main className="p-4 space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap gap-4 items-end">
        <div className="flex flex-col">
          <label className="text-sm text-gray-400">Instrument</label>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={instrument.code}
            onChange={(e) => {
              const found = INSTRUMENTS.find((i) => i.code === e.target.value) as Instrument;
              setInstrument(found);
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
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
          />
        </div>

        <button
          onClick={generatePlan}
          disabled={loading}
          className="rounded bg-blue-600 hover:bg-blue-500 px-3 py-2 disabled:opacity-60"
        >
          {loading ? "Generating…" : "Generate Plan"}
        </button>

        <button
          onClick={resetSession}
          className="rounded bg-neutral-800 hover:bg-neutral-700 px-3 py-2"
        >
          Reset
        </button>
      </div>

      {/* Charts */}
      <TradingViewTriple symbol={instrument.code} />

      {/* Calendar */}
      <div>
        <h2 className="text-xl font-semibold mb-2">Calendar Snapshot</h2>
        <CalendarPanel items={calendar} loading={loadingCal} />
      </div>

      {/* Headlines (simple list for now) */}
      <div>
        <h2 className="text-xl font-semibold mb-2">Macro Headlines (24h)</h2>
        {loadingNews ? (
          <div className="text-sm text-gray-300 italic">Loading headlines…</div>
        ) : headlines.length === 0 ? (
          <div className="text-sm text-gray-300">No recent headlines.</div>
        ) : (
          <ul className="space-y-2">
            {headlines.map((h, idx) => (
              <li key={idx} className="text-sm">
                <a className="underline" href={h.url} target="_blank" rel="noreferrer">
                  {h.title}
                </a>{" "}
                <span className="text-gray-400">• {h.source}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Generated card */}
      <div className="p-4 border rounded bg-neutral-900 border-neutral-800">
        <h2 className="text-lg font-bold mb-2">Generated Trade Card</h2>
        {conviction !== null && (
          <div className="text-sm mb-2">
            Conviction: <span className="font-semibold">{conviction}%</span>
          </div>
        )}
        <pre className="whitespace-pre-wrap text-sm">{planText || ""}</pre>
      </div>
    </main>
  );
}
