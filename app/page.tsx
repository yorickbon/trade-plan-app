"use client";

import React, { useState, useEffect } from "react";
import { INSTRUMENTS, findInstrument, Instrument } from "../lib/symbols";
import TradingViewTriple from "../components/TradingViewTriple";
import HeadlinesPanel from "../components/HeadlinesPanel";

export default function Page() {
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0]);
  const [dateStr, setDateStr] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [headlines, setHeadlines] = useState<any[]>([]);
  const [loadingNews, setLoadingNews] = useState(false);
  const [planText, setPlanText] = useState<string>("");

  // DEBUG – remove after confirming it loads the big list
  // eslint-disable-next-line no-console
  console.log("INSTRUMENTS loaded:", INSTRUMENTS.map(i => i.code));

  // reset plan every time instrument changes
  useEffect(() => {
    setPlanText("");
  }, [instrument]);

  const fetchHeadlines = async (inst: Instrument, date: string) => {
    setLoadingNews(true);
    try {
      const res = await fetch(
        `/api/news?symbols=${inst.currencies.join(",")}&date=${date}`
      );
      const data = await res.json();
      if (data.ok) {
        setHeadlines(data.items || []);
      } else {
        setHeadlines([]);
      }
    } catch (err) {
      console.error(err);
      setHeadlines([]);
    } finally {
      setLoadingNews(false);
    }
  };

  const generatePlan = async () => {
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,     // <- THIS is the selected instrument object
          headlines,      // <- fresh headlines for current instrument
          calendar: [],   // <- will wire your TE key here later
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setPlanText(data.text);
      } else {
        setPlanText("Error: " + data.reason);
      }
    } catch (err) {
      console.error(err);
      setPlanText("Error generating plan");
    }
  };

  const resetAll = () => {
    setHeadlines([]);
    setPlanText("");
    setDateStr(new Date().toISOString().slice(0, 10));
  };

  return (
    <div className="p-4 space-y-4">

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={instrument.code}
          onChange={(e) => {
            const inst = findInstrument(e.target.value);
            if (inst) setInstrument(inst);
          }}
          className="bg-gray-900 text-white p-2 rounded"
        >
          {INSTRUMENTS.map((i) => (
            <option key={i.code} value={i.code}>
              {i.label} ({i.code})
            </option>
          ))}
        </select>

        <input
          type="date"
          value={dateStr}
          onChange={(e) => setDateStr(e.target.value)}
          className="bg-gray-900 text-white p-2 rounded"
        />

        <button
          onClick={() => fetchHeadlines(instrument, dateStr)}
          className="bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded"
        >
          Refresh Calendar
        </button>

        <button
          onClick={generatePlan}
          className="bg-green-600 hover:bg-green-700 px-3 py-1 rounded"
        >
          Generate Plan
        </button>

        <button
          onClick={resetAll}
          className="bg-red-600 hover:bg-red-700 px-3 py-1 rounded"
        >
          Reset
        </button>

        {/* DEBUG – remove after confirming */}
        <div className="text-xs opacity-60">
          debug instruments: {INSTRUMENTS.length} –{" "}
          {INSTRUMENTS.slice(0, 8).map((i) => i.code).join(", ")}
          {INSTRUMENTS.length > 8 ? " …" : ""}
        </div>
      </div>

      {/* Charts */}
      <TradingViewTriple symbol={instrument.code} />

      {/* Two-column layout: headlines left, plan right */}
      <div className="grid grid-cols-2 gap-6">
        <div>
          <h2 className="text-xl font-semibold mb-2">
            Macro Headlines (24–48h)
          </h2>
          <HeadlinesPanel items={headlines} loading={loadingNews} />
        </div>

        <div>
          <h2 className="text-xl font-semibold mb-2">Generated Trade Card</h2>
          <pre className="bg-gray-800 text-white p-4 rounded whitespace-pre-wrap text-base leading-6">
            {planText || "Click Generate Plan to build a setup using the 15m execution, 1h/4h context, and fundamentals."}
          </pre>
        </div>
      </div>
    </div>
  );
}
