// app/page.tsx
"use client";

import { useEffect, useState } from "react";
import TradingViewTriple from "../components/TradingViewTriple";
import CalendarPanel from "../components/CalendarPanel";
import { INSTRUMENTS } from "../lib/symbols";

type Instrument = { code: string; currencies: string[]; label?: string };
type CalendarItem = {
  date: string; time?: string;
  country?: string; currency?: string;
  impact?: string; title?: string;
  actual?: string; forecast?: string; previous?: string;
};
type HeadlineItem = { title: string; url: string; source?: string; seen?: string };
type CandlesBundle = { symbol: string; h4: any[]; h1: any[]; m15: any[] };

export default function Page() {
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0] as Instrument);
  const [dateStr, setDateStr] = useState<string>(new Date().toISOString().slice(0, 10));

  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [headlines, setHeadlines] = useState<HeadlineItem[]>([]);
  const [candles, setCandles] = useState<CandlesBundle | null>(null);

  const [loadingCal, setLoadingCal] = useState(false);
  const [loadingNews, setLoadingNews] = useState(false);
  const [loadingCandles, setLoadingCandles] = useState(false);

  const [planText, setPlanText] = useState<string>("");
  const [conviction, setConviction] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // Chat state
  const [chatQ, setChatQ] = useState("");
  const [chatA, setChatA] = useState("");
  const [chatBusy, setChatBusy] = useState(false);

  // ---------- helpers to fetch snapshots ----------
  async function fetchCalendar() {
    try {
      setLoadingCal(true);
      const url = `/api/calendar?date=${dateStr}&currencies=${encodeURIComponent(instrument.currencies.join(","))}`;
      const r = await fetch(url);
      const j = await r.json();
      setCalendar(Array.isArray(j.items) ? j.items : []);
    } catch (e) {
      console.error(e);
      setCalendar([]);
    } finally {
      setLoadingCal(false);
    }
  }

  async function fetchHeadlines() {
    try {
      setLoadingNews(true);
      const q = encodeURIComponent(instrument.currencies.join(","));
      const url = `/api/news?q=${q}`;
      const r = await fetch(url);
      const j = await r.json();
      setHeadlines(Array.isArray(j.items) ? j.items : []);
    } catch (e) {
      console.error(e);
      setHeadlines([]);
    } finally {
      setLoadingNews(false);
    }
  }

  async function fetchCandles() {
    try {
      setLoadingCandles(true);
      const url = `/api/candles?symbol=${encodeURIComponent(instrument.code)}&h4=200&h1=200&m15=200`;
      const r = await fetch(url);
      const j = await r.json();
      setCandles(j);
    } catch (e) {
      console.error(e);
      setCandles(null);
    } finally {
      setLoadingCandles(false);
    }
  }

  // initial load
  useEffect(() => {
    fetchCalendar();
    fetchHeadlines();
    fetchCandles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument, dateStr]);

  // ---------- Generate Plan ----------
  async function generatePlan() {
    if ((window as any).__GEN_BUSY) return;
    (window as any).__GEN_BUSY = true;

    setLoading(true);
    setPlanText("");
    setConviction(null);

    try {
      // Ensure we have fresh snapshots for this click
      const [calRes, newsRes, candlesRes] = await Promise.all([
        fetch(`/api/calendar?date=${dateStr}&currencies=${encodeURIComponent(instrument.currencies.join(","))}`),
        fetch(`/api/news?q=${encodeURIComponent(instrument.currencies.join(","))}`),
        fetch(`/api/candles?symbol=${encodeURIComponent(instrument.code)}&h4=200&h1=200&m15=200`),
      ]);

      const calJ = await calRes.json();
      const newsJ = await newsRes.json();
      const candlesJ = await candlesRes.json();

      setCalendar(Array.isArray(calJ.items) ? calJ.items : []);
      setHeadlines(Array.isArray(newsJ.items) ? newsJ.items : []);
      setCandles(candlesJ);

      const rsp = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,
          date: dateStr,
          calendar: Array.isArray(calJ.items) ? calJ.items : [],
          headlines: Array.isArray(newsJ.items) ? newsJ.items : [],
          // plan endpoint can also use candles if you want to pass them:
          candles: candlesJ ?? null,
        }),
      });

      const plan = await rsp.json();
      setPlanText(plan?.plan?.text || plan?.text || "");
      setConviction(plan?.plan?.conviction ?? plan?.conviction ?? null);
    } catch (e) {
      console.error(e);
      setPlanText("Error generating plan.");
      setConviction(null);
    } finally {
      setLoading(false);
      (window as any).__GEN_BUSY = false;
    }
  }

  function resetSession() {
    setPlanText("");
    setConviction(null);
    setChatQ("");
    setChatA("");
    fetchCalendar();
    fetchHeadlines();
    fetchCandles();
  }

  // ---------- Chat with full context ----------
  async function askChat() {
    if (!chatQ.trim()) return;
    setChatBusy(true);
    setChatA("");

    try {
      const rsp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,
          date: dateStr,
          calendar,
          headlines,
          candles,      // <-- REAL ARRAYS
          question: chatQ.trim(),
        }),
      });
      const j = await rsp.json();
      setChatA(j?.answer || "(no answer)");
    } catch (e) {
      console.error(e);
      setChatA("Error while asking. Check console.");
    } finally {
      setChatBusy(false);
    }
  }

  // ---------- UI ----------
  return (
    <main className="p-4 max-w-6xl mx-auto text-sm text-gray-200">
      {/* Controls */}
      <div className="mb-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="flex flex-col">
          <label className="text-sm text-gray-400">Instrument</label>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-2"
            value={instrument.code}
            onChange={(e) => {
              const found = INSTRUMENTS.find((x: any) => x.code === e.target.value) as Instrument;
              if (found) setInstrument(found);
            }}
          >
            {INSTRUMENTS.map((i: any) => (
              <option key={i.code} value={i.code}>{i.label ?? i.code}</option>
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

        <div className="flex items-end gap-2">
          <button
            onClick={generatePlan}
            disabled={loading}
            className="rounded bg-blue-600 hover:bg-blue-500 px-4 py-2 disabled:opacity-50"
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
      <div className="mt-6">
        <h2 className="text-xl font-semibold mb-2">Calendar Snapshot</h2>
        <CalendarPanel items={calendar} loading={loadingCal} />
      </div>

      {/* Headlines */}
      <div className="mt-6">
        <h2 className="text-xl font-semibold mb-2">Macro Headlines (24h)</h2>
        {loadingNews ? (
          <div className="text-gray-400">Loading…</div>
        ) : headlines.length === 0 ? (
          <div className="text-gray-400">No recent headlines.</div>
        ) : (
          <ul className="space-y-1">
            {headlines.map((h, idx) => (
              <li key={idx} className="text-gray-200">
                <a className="underline" href={h.url} target="_blank" rel="noreferrer">
                  {h.title}
                </a>
                {h.source ? <span className="text-gray-400"> — {h.source}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Generated Card */}
      <div className="mt-6 p-4 border rounded bg-neutral-900 border-neutral-800">
        <h2 className="text-lg font-bold mb-2">Generated Trade Card</h2>
        {conviction != null && (
          <div className="text-sm mb-2">Conviction: <span className="font-semibold">{conviction}%</span></div>
        )}
        <pre className="whitespace-pre-wrap text-sm">{planText || ""}</pre>
      </div>

      {/* Chat Box */}
      <div className="mt-6 p-4 border rounded bg-neutral-900 border-neutral-800">
        <h2 className="text-lg font-bold mb-2">Ask About This Setup</h2>
        <textarea
          className="w-full h-28 bg-neutral-950 border border-neutral-700 rounded p-2 mb-2"
          placeholder="e.g., If 15m breaks structure up but 1h OB sits above, where is the safest pullback?"
          value={chatQ}
          onChange={(e) => setChatQ(e.target.value)}
        />
        <div className="flex gap-2">
          <button
            onClick={askChat}
            disabled={chatBusy}
            className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2 disabled:opacity-50"
          >
            {chatBusy ? "Thinking…" : "Ask"}
          </button>
          <div className="self-center text-xs text-gray-400">
            {loadingCandles ? "Refreshing candles…" : candles ? "Candles attached ✅" : "No candles ⚠️"}
          </div>
        </div>
        {chatA && (
          <div className="mt-3 p-3 bg-neutral-950 border border-neutral-800 rounded text-sm whitespace-pre-wrap">
            {chatA}
          </div>
        )}
      </div>
    </main>
  );
}
