"use client";

import React, { useEffect, useState } from "react";
import TradingViewTriple from "../components/TradingViewTriple";
import CalendarPanel from "../components/CalendarPanel";
import { INSTRUMENTS } from "../lib/symbols";

// If you don't have types in lib/symbols yet, this light type keeps TS happy
type Instrument = {
  code: string;             // e.g. "EURUSD"
  label: string;            // e.g. "Euro / U.S. Dollar"
  currencies: string[];     // e.g. ["EUR","USD"]
};

type PlanResponse = {
  plan?: { text: string; conviction?: number };
  reply?: string;                // for debug/simple mode
  model?: string;                // echo back model
};

export default function Page() {
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0] as Instrument);
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [planText, setPlanText] = useState<string>("");
  const [conviction, setConviction] = useState<number | null>(null);
  const [allLoading, setAllLoading] = useState<boolean>(false);

  // Generate trade plan via API
  async function generatePlan() {
    setAllLoading(true);
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instrument: instrument.code,
          date,
          // You can attach calendar items later if you want the LLM to “see” them.
          // calendar: <array of items>,
        }),
      });

      const json: PlanResponse = await res.json();

      // Prefer structured plan text when available; fall back to “reply”
      const text =
        json?.plan?.text ??
        json?.reply ??
        "No Trade – insufficient or unclear data.";
      setPlanText(text);

      setConviction(
        typeof json?.plan?.conviction === "number" ? json.plan!.conviction : null
      );
    } catch (err) {
      console.error(err);
      setPlanText("Server error while generating plan.");
      setConviction(null);
    } finally {
      setAllLoading(false);
    }
  }

  function resetSession() {
    setPlanText("");
    setConviction(null);
  }

  return (
    <main className="mx-auto max-w-7xl p-4 space-y-6">
      {/* Top controls */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
        <div>
          <label className="block text-sm mb-1">Instrument</label>
          <select
            className="w-full rounded border px-3 py-2 bg-black/20"
            value={instrument.code}
            onChange={(e) => {
              const next = INSTRUMENTS.find(
                (it: any) => it.code === e.target.value
              ) as Instrument;
              if (next) {
                setInstrument(next);
                resetSession();
              }
            }}
          >
            {INSTRUMENTS.map((it: any) => (
              <option key={it.code} value={it.code}>
                {it.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm mb-1">Date</label>
          <input
            type="date"
            className="w-full rounded border px-3 py-2 bg-black/20"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              resetSession();
            }}
          />
        </div>

        <div className="flex gap-2">
          <button
            className="flex-1 rounded bg-white/10 hover:bg-white/20 px-4 py-2"
            onClick={generatePlan}
            disabled={allLoading}
          >
            {allLoading ? "Generating…" : "Generate Plan"}
          </button>
          <button
            className="rounded bg-white/5 hover:bg-white/15 px-4 py-2"
            onClick={resetSession}
          >
            Reset
          </button>
        </div>
      </section>

      {/* Charts */}
      <section>
        <TradingViewTriple symbol={instrument.code} />
      </section>

      {/* Calendar snapshot (fetched inside the component) */}
      <section>
        <CalendarPanel
          date={date}
          currencies={instrument.currencies.join(",")}
        />
      </section>

      {/* Generated Plan */}
      <section className="rounded border p-4 space-y-2">
        <div className="text-sm opacity-70">
          Generated Trade Card
          {typeof conviction === "number" ? (
            <span className="ml-2">• Conviction: {conviction}%</span>
          ) : null}
        </div>

        <pre className="whitespace-pre-wrap text-sm leading-6">
          {planText || "Click Generate Plan to create an Entry/SL/TP1/TP2 + reasoning."}
        </pre>
      </section>
    </main>
  );
}
