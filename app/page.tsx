"use client";

import { useEffect, useState } from "react";
import TradingViewTriple from "../components/TradingViewTriple";
import { INSTRUMENTS } from "../lib/symbols";
import CalendarPanel from "../components/CalendarPanel";

type Instrument = {
  code: string;            // e.g. "EURUSD"
  currencies: string[];    // e.g. ["EUR","USD"]
};

type CalendarItem = {
  date: string;
  country: string;
  currency: string;
  impact: string;
  title: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};

export default function Page() {
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0]);
  const [datestr, setDatestr] = useState<string>(new Date().toISOString().slice(0, 10));
  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [loadingCal, setLoadingCal] = useState(false);
  const [planText, setPlanText] = useState<string>("");
  const [aiLoading, setAILoading] = useState(false);
  const [conviction, setConviction] = useState<number | null>(null);

  async function fetchCalendar() {
    setLoadingCal(true);
    try {
      const res = await fetch(
        `/api/calendar?date=${datestr}&currencies=${instrument.currencies.join(",")}`
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
  }, [instrument, datestr]);

  async function generatePlan() {
    setAILoading(true);
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument: instrument.code,
          date: datestr,
          calendar,
        }),
      });
      const json = await res.json();
      setPlanText(json.plan.text || "");
      setConviction(json.plan.conviction ?? null);
    } catch (e) {
      console.error(e);
    } finally {
      setAILoading(false);
    }
  }

  function resetSession() {
    setPlanText("");
    setConviction(null);
    setCalendar([]);
    fetchCalendar();
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex space-x-2">
        <select
          className="border p-2"
          value={instrument.code}
          onChange={(e) =>
            setInstrument(INSTRUMENTS.find((it) => it.code === e.target.value)!)
          }
        >
          {INSTRUMENTS.map((it) => (
            <option key={it.code} value={it.code}>
              {it.code}
            </option>
          ))}
        </select>

        <input
          type="date"
          className="border p-2"
          value={datestr}
          onChange={(e) => setDatestr(e.target.value)}
        />

        <button
          onClick={generatePlan}
          className="bg-blue-600 text-white px-4 py-2 rounded"
          disabled={aiLoading}
        >
          {aiLoading ? "Generating…" : "Generate Plan"}
        </button>

        <button
          onClick={resetSession}
          className="bg-gray-500 text-white px-4 py-2 rounded"
        >
          Reset
        </button>
      </div>

      <TradingViewTriple symbol={instrument.code} />

      <CalendarPanel items={calendar} loading={loadingCal} />

      <div className="p-4 border rounded bg-white">
        <h2 className="text-lg font-bold mb-2">Generated Trade Card</h2>
        {planText ? (
          <pre className="whitespace-pre-wrap">{planText}</pre>
        ) : (
          <p className="text-gray-500">Click Generate Plan to create one.</p>
        )}
        {conviction !== null && (
          <p className="mt-2">Conviction: {conviction}%</p>
        )}
      </div>
    </div>
  );
}
