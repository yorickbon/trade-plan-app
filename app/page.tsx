"use client";

import React, { useState, useEffect } from "react";

// ✅ Fixed imports: now relative paths instead of "@/..."
import TradingViewTriple from "../components/TradingViewTriple";
import HeadlinesPanel from "../components/HeadlinesPanel";
import CalendarPanel from "../components/CalendarPanel";
import { INSTRUMENTS, findInstrument, type Instrument } from "../lib/symbols";

export default function Page() {
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0]);
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [headlines, setHeadlines] = useState<any[]>([]);
  const [calendar, setCalendar] = useState<any[]>([]);
  const [plan, setPlan] = useState<any>(null);

  // ✅ Reset when instrument changes
  useEffect(() => {
    setHeadlines([]);
    setCalendar([]);
    setPlan(null);
  }, [instrument]);

  const refreshHeadlines = async () => {
    try {
      const res = await fetch(`/api/news?symbols=${instrument.currencies.join(",")}`);
      const data = await res.json();
      if (data.ok) setHeadlines(data.items || []);
    } catch (err) {
      console.error("Error fetching headlines", err);
    }
  };

  const refreshCalendar = async () => {
    try {
      const res = await fetch(
        `/api/calendar?date=${date}&currencies=${instrument.currencies.join(",")}&windowHours=48`
      );
      const data = await res.json();
      if (data.ok) setCalendar(data.items || []);
    } catch (err) {
      console.error("Error fetching calendar", err);
    }
  };

  const generatePlan = async () => {
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,
          headlines,
          calendar,
        }),
      });
      const data = await res.json();
      setPlan(data);
    } catch (err) {
      console.error("Error generating plan", err);
    }
  };

  return (
    <div className="p-4 space-y-4">
      {/* Top controls */}
      <div className="flex space-x-2">
        <select
          value={instrument.code}
          onChange={(e) => {
            const inst = findInstrument(e.target.value);
            if (inst) setInstrument(inst);
          }}
          className="bg-gray-900 text-white p-2 rounded"
        >
          {INSTRUMENTS.map((inst) => (
            <option key={inst.code} value={inst.code}>
              {inst.label}
            </option>
          ))}
        </select>

        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="bg-gray-900 text-white p-2 rounded"
        />

        <button
          onClick={refreshCalendar}
          className="bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded"
        >
          Refresh Calendar
        </button>

        <button
          onClick={refreshHeadlines}
          className="bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded"
        >
          Refresh Headlines
        </button>

        <button
          onClick={generatePlan}
          className="bg-green-600 hover:bg-green-700 px-3 py-1 rounded"
        >
          Generate Plan
        </button>
      </div>

      {/* TradingView triple charts */}
      <TradingViewTriple symbol={instrument.code} />

      {/* Layout for headlines + trade card side by side */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <h2 className="text-xl font-semibold mb-2">Calendar Snapshot</h2>
          <CalendarPanel items={calendar} />

          <h2 className="text-xl font-semibold mb-2 mt-4">Macro Headlines (24–48h)</h2>
          <HeadlinesPanel items={headlines} />
        </div>

        <div>
          <h2 className="text-xl font-semibold mb-2">Generated Trade Card</h2>
          {plan ? (
            <pre className="bg-gray-800 p-2 rounded whitespace-pre-wrap text-sm">
              {plan.text || JSON.stringify(plan, null, 2)}
            </pre>
          ) : (
            <div className="text-sm opacity-70">Click Generate Plan to build a trade idea.</div>
          )}
        </div>
      </div>
    </div>
  );
}
