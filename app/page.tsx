// app/page.tsx
"use client";
import { useEffect, useState } from "react";
import TradingViewTriple from "../components/TradingViewTriple";
import { INSTRUMENTS } from "../lib/symbols";
import CalendarPanel from "../components/CalendarPanel";
import HeadlinesPanel from "../components/HeadlinesPanel";
import ChatDock from "../components/ChatDock";

type Instrument = { code: string; currencies: string[]; label?: string };
type CalendarItem = { date: string; currency: string; impact: string; title: string; country?: string };
type Headline = { title: string; source: string; publishedAt: string; url?: string };

export default function Page() {
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0] as Instrument);
  const [dateStr, setDateStr] = useState<string>(new Date().toISOString().slice(0, 10));

  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [loadingCal, setLoadingCal] = useState(false);

  const [headlines, setHeadlines] = useState<Headline[]>([]);
  const [loadingNews, setLoadingNews] = useState(false);

  const [planText, setPlanText] = useState("");
  const [conviction, setConviction] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  async function fetchCalendar() {
    setLoadingCal(true);
    try {
      const url = `/api/calendar?date=${dateStr}&currencies=${instrument.currencies.join(",")}`;
      const res = await fetch(url);
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
      const res = await fetch(`/api/news?q=${encodeURIComponent(instrument.code)}`);
      const json = await res.json();
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

  async function generatePlan() {
    setLoading(true);
    try {
      const res = await fetch(`/api/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instrument: instrument.code, date: dateStr }),
      });
      const json = await res.json();
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
      <div className="flex flex-wrap gap-4 items-end">
        <div className="flex flex-col">
          <label className="text-sm text-gray-400">Instrument</label>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={instrument.code}
            onChange={(e) => setInstrument(INSTRUMENTS.find((x: any) => x.code === e.target.value) as Instrument)}
          >
            {INSTRUMENTS.map((i: any) => (
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

        <button onClick={generatePlan} disabled={loading} className="rounded bg-blue-600 hover:bg-blue-500 px-3 py-2">
          {loading ? "Generating…" : "Generate Plan"}
        </button>

        <button onClick={resetSession} className="rounded bg-neutral-800 hover:bg-neutral-700 px-3 py-2">
          Reset
        </button>
      </div>

      {/* Charts */}
      <TradingViewTriple symbol={instrument.code} />

      {/* Calendar */}
      <CalendarPanel items={calendar} loading={loadingCal} />

      {/* Headlines */}
      <HeadlinesPanel items={headlines} loading={loadingNews} />

      {/* Generated card */}
      <div className="p-4 border rounded bg-neutral-900 border-neutral-800">
        <h2 className="text-lg font-bold mb-2">Generated Trade Card</h2>
        {conviction !== null && (
          <div className="text-sm mb-2">
            Conviction: <span className="font-semibold">{conviction}%</span>
          </div>
        )}
        <pre className="whitespace-pre-wrap text-sm">{planText || "—"}</pre>
      </div>

      {/* Chat Q&A */}
      <ChatDock planText={planText} headlines={headlines} calendar={calendar} />
    </main>
  );
}
