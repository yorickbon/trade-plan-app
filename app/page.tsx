"use client";

import { useEffect, useState } from "react";
import TradingViewTriple from "../components/TradingViewTriple";
import { INSTRUMENTS } from "../lib/symbols";
import CalendarPanel from "../components/CalendarPanel";

type Instrument = {
  code: string;
  currencies: string[];
};

type CalendarItem = {
  date: string;
  time: string;
  country: string;
  currency: string;
  impact: string;
  title: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};

export default function Page() {
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0] as Instrument);
  const [dateStr, setDateStr] = useState<string>(new Date().toISOString().slice(0, 10));

  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [loadingCal, setLoadingCal] = useState<boolean>(false);

  const [planText, setPlanText] = useState<string>("");
  const [aiLoading, setAiLoading] = useState<boolean>(false);
  const [conviction, setConviction] = useState<number | null>(null);

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

  useEffect(() => {
    fetchCalendar();
  }, [instrument, dateStr]);

  async function generatePlan() {
    try {
      setAiLoading(true);
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument: instrument.code,
          date: dateStr,
          calendar,
        }),
      });
      const json = await res.json();
      setPlanText(json?.plan?.text ?? json?.reply ?? "No response.");
      setConviction(json?.plan?.conviction ?? null);
    } catch (e) {
      console.error(e);
      setPlanText("Error generating plan.");
      setConviction(null);
    } finally {
      setAiLoading(false);
    }
  }

  function resetSession() {
    setPlanText("");
    setConviction(null);
    setCalendar([]);
    fetchCalendar();
  }

  return (
    <main className="p-4 space-y-6">
      <div className="flex flex-wrap gap-4 items-end">
        <div className="flex flex-col">
          <label className="text-sm text-gray-400">Instrument</label>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-2"
            value={instrument.code}
            onChange={(e) => {
              const next = INSTRUMENTS.find((i) => i.code === e.target.value) as Instrument;
              setInstrument(next);
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

        <div className="flex gap-3">
          <button
            onClick={generatePlan}
            disabled={aiLoading}
            className="rounded bg-blue-600 hover:bg-blue-500 px-3 py-2 disabled:opacity-50"
          >
            {aiLoading ? "Generating..." : "Generate Plan"}
          </button>

        <button
            onClick={resetSession}
            className="rounded bg-neutral-800 hover:bg-neutral-700 px-3 py-2"
          >
            Reset
          </button>
        </div>
      </div>

      <TradingViewTriple symbol={instrument.code} />

      <CalendarPanel items={calendar} loading={loadingCal} />

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
