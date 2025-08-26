"use client";

import { useEffect, useState } from "react";
import TradingViewTriple from "../components/TradingViewTriple";
import CalendarPanel from "../components/CalendarPanel";
import { INSTRUMENTS } from "../lib/symbols";

/** Types (kept minimal to match our APIs) */
type Instrument = { code: string; currencies?: string[] };

type CalendarItem = {
  date: string; // ISO timestamp preferred
  time?: string;
  currency?: string;
  impact?: "Low" | "Medium" | "High";
  title?: string;
};

type Headline = { title: string; url: string; source?: string; seen?: string };

type AltSetup = {
  strategy: string;
  dir: "Buy" | "Sell";
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  score: number;
};

export default function Page() {
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0]);
  const [dateStr, setDateStr] = useState<string>(new Date().toISOString().slice(0, 10));

  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [headlines, setHeadlines] = useState<Headline[]>([]);
  const [loadingCal, setLoadingCal] = useState(false);
  const [loadingNews, setLoadingNews] = useState(false);

  const [planText, setPlanText] = useState<string>("");
  const [conviction, setConviction] = useState<number | null>(null);
  const [alternatives, setAlternatives] = useState<AltSetup[]>([]);
  const [loadingPlan, setLoadingPlan] = useState(false);

  // Chat (optional – uses the generated plan as context; can wire to your /api/chat later)
  const [chatQ, setChatQ] = useState("");
  const [chatA, setChatA] = useState("");

  /** Fetch calendar snapshot for the selected date & currencies */
  async function fetchCalendar() {
    setLoadingCal(true);
    try {
      const currencies = (instrument.currencies || []).join(",");
      const res = await fetch(`/api/calendar?date=${dateStr}&currencies=${encodeURIComponent(currencies)}`);
      const json = await res.json();
      setCalendar(json.items || []);
    } catch (e) {
      console.error(e);
      setCalendar([]);
    } finally {
      setLoadingCal(false);
    }
  }

  /** Fetch headlines snapshot (24h) */
  async function fetchHeadlines() {
    setLoadingNews(true);
    try {
      const q =
        instrument.currencies?.length
          ? instrument.currencies.join(" OR ")
          : instrument.code;
      const res = await fetch(`/api/news?q=${encodeURIComponent(q)}&sinceHours=24`);
      const json = await res.json();
      setHeadlines(json.items || []);
    } catch (e) {
      console.error(e);
      setHeadlines([]);
    } finally {
      setLoadingNews(false);
    }
  }

  /** Generate the plan — THIS is where we pass calendar + headlines */
  async function generatePlan() {
    setLoadingPlan(true);
    setPlanText("");
    setConviction(null);
    setAlternatives([]);
    try {
      const rsp = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,       // { code, currencies? } object
          date: dateStr,
          calendar,         // <-- pass snapshot already fetched
          headlines,        // <-- pass snapshot already fetched
        }),
      });
      const json = await rsp.json();
      setPlanText(json?.plan?.text || "");
      setConviction(json?.plan?.conviction ?? null);
      setAlternatives(json?.meta?.alternatives || []);
    } catch (e) {
      console.error(e);
      setPlanText("Error generating plan.");
      setConviction(null);
      setAlternatives([]);
    } finally {
      setLoadingPlan(false);
    }
  }

  /** Simple Q&A about the current setup (optional) */
  async function askChat() {
    if (!chatQ.trim()) return;
    setChatA("Thinking…");
    try {
      // You can later replace this endpoint with your /api/chat enhanced context.
      const res = await fetch("/api/openai-ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `
You are my trading copilot. I have this trade card:

${planText || "(no plan yet)"}

Calendar:
${JSON.stringify(calendar, null, 2)}

Headlines:
${JSON.stringify(headlines.slice(0, 6), null, 2)}

My question:
${chatQ}
          `.trim(),
        }),
      });
      const json = await res.json();
      setChatA(json.reply || "No reply.");
    } catch (e) {
      console.error(e);
      setChatA("Error.");
    }
  }

  /** Pull calendar + headlines whenever instrument or date changes */
  useEffect(() => {
    fetchCalendar();
    fetchHeadlines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument.code, dateStr]);

  function resetSession() {
    setPlanText("");
    setConviction(null);
    setAlternatives([]);
    setChatQ("");
    setChatA("");
    fetchCalendar();
    fetchHeadlines();
  }

  return (
    <main className="mx-auto max-w-7xl p-4 space-y-6">
      {/* Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="flex flex-col">
          <label className="text-sm text-gray-400">Instrument</label>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-2"
            value={instrument.code}
            onChange={(e) => {
              const next = INSTRUMENTS.find((x) => x.code === e.target.value) || INSTRUMENTS[0];
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

        <div className="flex items-end gap-3">
          <button
            onClick={generatePlan}
            disabled={loadingPlan}
            className="rounded bg-blue-600 hover:bg-blue-500 px-3 py-2 disabled:opacity-50"
          >
            {loadingPlan ? "Generating…" : "Generate Plan"}
          </button>
          <button
            onClick={resetSession}
            className="rounded bg-neutral-800 hover:bg-neutral-700 px-3 py-2"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Charts */}
      <TradingViewTriple symbol={instrument.code} />

      {/* Calendar + Headlines */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <h2 className="text-xl font-semibold mb-2">Calendar Snapshot</h2>
          <CalendarPanel items={calendar} loading={loadingCal} />
        </div>
        <div>
          <h2 className="text-xl font-semibold mb-2">Macro Headlines (24h)</h2>
          <div className="border border-neutral-800 rounded p-3 min-h-24">
            {loadingNews ? (
              <div className="text-sm text-gray-400">Loading headlines…</div>
            ) : headlines.length === 0 ? (
              <div className="text-sm text-gray-400">No headlines found.</div>
            ) : (
              <ul className="list-disc list-inside space-y-1">
                {headlines.slice(0, 8).map((h, idx) => (
                  <li key={idx} className="text-sm">
                    <a className="underline" href={h.url} target="_blank" rel="noreferrer">
                      {h.title}
                    </a>{" "}
                    {h.source ? <span className="text-xs text-gray-400">({h.source})</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Generated Trade Card */}
      <div className="p-4 border rounded bg-neutral-900 border-neutral-800">
        <h2 className="text-lg font-bold mb-2">Generated Trade Card</h2>
        {conviction !== null && (
          <div className="text-sm mb-2">
            Conviction: <span className="font-semibold">{conviction}%</span>
          </div>
        )}
        <pre className="whitespace-pre-wrap text-sm">{planText || "—"}</pre>
      </div>

      {/* Other Considered Setups */}
      <div className="p-4 border rounded bg-neutral-900 border-neutral-800">
        <h3 className="text-lg font-semibold mb-2">Other Considered Setups</h3>
        {alternatives.length === 0 ? (
          <div className="text-sm text-gray-400">—</div>
        ) : (
          <ul className="space-y-1 text-sm">
            {alternatives.map((alt, i) => (
              <li key={i} className="text-gray-200">
                <span className="font-medium">{alt.strategy}</span>{" "}
                {alt.dir} @ {alt.entry} (SL {alt.stop}, TP1 {alt.tp1}, TP2 {alt.tp2}) — Score {alt.score}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Q&A Chat about this setup (optional utility) */}
      <div className="p-4 border rounded bg-neutral-900 border-neutral-800 space-y-3">
        <h3 className="text-lg font-semibold">Ask about this setup</h3>
        <textarea
          className="w-full bg-neutral-950 border border-neutral-800 rounded p-2 h-24"
          placeholder="e.g., If price wicks above entry then returns, how should I manage risk?"
          value={chatQ}
          onChange={(e) => setChatQ(e.target.value)}
        />
        <div className="flex gap-2">
          <button onClick={askChat} className="rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-2">
            Ask
          </button>
          <button
            onClick={() => {
              setChatQ("");
              setChatA("");
            }}
            className="rounded bg-neutral-800 hover:bg-neutral-700 px-3 py-2"
          >
            Clear
          </button>
        </div>
        {chatA && <div className="text-sm border-t border-neutral-800 pt-3 whitespace-pre-wrap">{chatA}</div>}
      </div>
    </main>
  );
}
