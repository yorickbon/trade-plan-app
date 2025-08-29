"use client";

import React, { useEffect, useState } from "react";
import TradingViewTriple from "../components/TradingViewTriple";
import HeadlinesPanel from "../components/HeadlinesPanel";
import { INSTRUMENTS, findInstrument, type Instrument } from "../lib/symbols";

function todayISO() {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
    .toISOString()
    .slice(0, 10);
}

export default function Page() {
  // ---- state ----
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0]);
  const [dateStr, setDateStr] = useState<string>(todayISO());

  const [calendarItems, setCalendarItems] = useState<any[]>([]);
  const [headlines, setHeadlines] = useState<any[]>([]);

  const [generating, setGenerating] = useState(false);
  const [planText, setPlanText] = useState<string>("");

  // Clear the Trade Card whenever instrument or date changes
  useEffect(() => {
    setPlanText("");
  }, [instrument, dateStr]);

  // ---- fetchers (kept minimal) ----
  async function refreshCalendar() {
    try {
      const url = `/api/calendar?date=${encodeURIComponent(
        dateStr
      )}&instrument=${encodeURIComponent(instrument.code)}&windowHours=48`;
      const r = await fetch(url, { cache: "no-store" });
      const j = await r.json();
      if (j?.ok && Array.isArray(j.items)) setCalendarItems(j.items);
      else setCalendarItems([]);
    } catch {
      setCalendarItems([]);
    }
  }

  async function refreshHeadlines() {
    try {
      const ccy = (instrument as any).currencies ?? [];
      const r = await fetch(
        `/api/news?symbols=${encodeURIComponent(ccy.join(","))}&hours=48`,
        { cache: "no-store" }
      );
      const j = await r.json();
      setHeadlines(Array.isArray(j?.items) ? j.items : []);
    } catch {
      setHeadlines([]);
    }
  }

  async function generatePlan() {
    setGenerating(true);
    setPlanText("");
    try {
      // IMPORTANT FIX: send ONLY the symbol string in both query AND body
      const r = await fetch(
        `/api/plan?instrument=${encodeURIComponent(
          instrument.code
        )}&date=${encodeURIComponent(dateStr)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            instrument: instrument.code,   // <-- send string, not object (fixes empty candles)
            date: dateStr,
            calendar: calendarItems,
            headlines,
          }),
        }
      );
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const j = await r.json();
        if (j?.ok && typeof j.text === "string") setPlanText(j.text);
        else if (j?.reason) setPlanText(`Standing down: ${j.reason}`);
        else setPlanText("Standing down: Unknown server response.");
      } else {
        const t = await r.text();
        setPlanText(t || "Standing down: Non-JSON response.");
      }
    } catch (e: any) {
      setPlanText(`Standing down: ${e?.message || "Network error"}`);
    } finally {
      setGenerating(false);
    }
  }

  function resetAll() {
    setInstrument(INSTRUMENTS[0]);
    setDateStr(todayISO());
    setCalendarItems([]);
    setHeadlines([]);
    setPlanText("");
  }

  // ---- UI ----
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4 space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col">
          <label className="text-xs opacity-70 mb-1">Instrument</label>
          <select
            value={instrument.code}
            onChange={(e) => {
              const next = findInstrument(e.target.value);
              if (next) setInstrument(next);
            }}
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
          >
            {INSTRUMENTS.map((i) => (
              <option key={i.code} value={i.code}>
                {(i as any).label ?? i.code} ({i.code})
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col">
          <label className="text-xs opacity-70 mb-1">Date</label>
          <input
            type="date"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
          />
        </div>

        <div className="flex gap-2 ml-auto">
          <button
            onClick={resetAll}
            className="px-3 py-1 text-sm rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
          >
            Reset
          </button>
          <button
            onClick={refreshCalendar}
            className="px-3 py-1 text-sm rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
          >
            Refresh Calendar
          </button>
          <button
            onClick={refreshHeadlines}
            className="px-3 py-1 text-sm rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
          >
            Refresh Headlines
          </button>
          <button
            onClick={generatePlan}
            className="px-3 py-1 text-sm rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50"
            disabled={generating}
          >
            {generating ? "Generating…" : "Generate Plan"}
          </button>
        </div>
      </div>

      {/* Charts */}
      <TradingViewTriple symbol={instrument.code} />

      {/* Calendar (lightweight) */}
      <div className="rounded-lg border border-neutral-800 p-4">
        <h2 className="text-lg font-semibold mb-2">Calendar Snapshot</h2>
        {calendarItems.length ? (
          <ul className="text-sm">
            {calendarItems.map((e, i) => (
              <li key={i}>
                {e?.time ?? ""} — <b>{e?.title ?? e?.name ?? "Event"}</b>{" "}
                {e?.currency ? `(${e.currency})` : ""}{" "}
                {e?.impact ? `— ${e.impact}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm opacity-75">
            No calendar items found from providers. (Once your TradingEconomics key is active, this will populate automatically.)
          </div>
        )}
      </div>

      {/* Headlines (left, smaller) + Trade Card (right, bigger) */}
      <div className="grid grid-cols-12 gap-4 items-start">
        <div className="col-span-12 lg:col-span-7 rounded-lg border border-neutral-800 p-4">
          <h2 className="text-lg font-semibold mb-2">Macro Headlines (24–48h)</h2>
          <div className="text-xs">
            <HeadlinesPanel items={headlines} />
          </div>
        </div>

        <div className="col-span-12 lg:col-span-5 rounded-lg border border-neutral-800 p-4">
          <h2 className="text-lg font-semibold mb-2">Generated Trade Card</h2>
          {planText ? (
            <pre className="whitespace-pre-wrap text-base md:text-lg leading-[1.35] opacity-95 max-h-[60vh] overflow-auto">
              {planText}
            </pre>
          ) : generating ? (
            <div className="text-sm opacity-80">Generating…</div>
          ) : (
            <div className="text-sm opacity-70">
              Click <b>Generate Plan</b> to build a setup using 15m execution,
              1h+4h context, fundamentals (calendar bias + headlines), and your strategy logic.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
