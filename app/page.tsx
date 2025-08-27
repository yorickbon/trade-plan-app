"use client";

import { useEffect, useMemo, useState } from "react";
import TradingViewTriple from "../components/TradingViewTriple";
import CalendarPanel from "../components/CalendarPanel";
import HeadlinesPanel from "../components/HeadlinesPanel";
import { INSTRUMENTS } from "../lib/symbols";

// ---------------- Local types (aligned with API, but lenient for UI) ------------
type Instrument = {
  code: string;           // e.g. "EURUSD"
  currencies?: string[];  // e.g. ["EUR","USD"]
};

// NOTE: we keep these very permissive to avoid compile breaks if the panel types differ.
// The panels only read fields they need; extra fields are ignored.
type CalendarItem = {
  date?: string;
  time?: string;
  country?: string;
  currency?: string;
  impact?: string;
  title?: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};

type HeadlineItem = {
  title: string;
  url?: string;
  source?: string;
  seen?: string;        // ISO timestamp when shown (optional)
  published_at?: string;
};

// API response for /api/plan
type PlanResponse = {
  ok: boolean;
  plan?: { text: string; conviction?: number | null };
  reason?: string;
  usedHeadlines?: HeadlineItem[];
  usedCalendar?: CalendarItem[];
};

export default function Page() {
  // ------------ state ------------
  const [instrument, setInstrument] = useState<Instrument>(INSTRUMENTS[0]);
  const [dateStr, setDateStr] = useState<string>(new Date().toISOString().slice(0, 10));

  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [headlines, setHeadlines] = useState<HeadlineItem[]>([]);

  const [loadingCal, setLoadingCal] = useState(false);
  const [loadingNews, setLoadingNews] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);

  const [planText, setPlanText] = useState<string>("");
  const [standDown, setStandDown] = useState<string | null>(null);

  // monitor state messaging
  const [monitoring, setMonitoring] = useState<boolean | null>(null);
  const [monitorMsg, setMonitorMsg] = useState<string>("");

  // forces a full “fresh mount” of children (charts, etc) when we reset or change instrument
  const [sessionKey, setSessionKey] = useState<number>(() => Date.now());

  // helper: “fresh page” reset
  function hardReset(nextInstrument?: Instrument) {
    setPlanText("");
    setStandDown(null);
    setCalendar([]);
    setHeadlines([]);
    setLoadingCal(false);
    setLoadingNews(false);
    setLoadingPlan(false);
    setMonitoring(null);
    setMonitorMsg("");
    if (nextInstrument) setInstrument(nextInstrument);
    // bump sessionKey so children unmount/remount (clears any cached fetch / local state)
    setSessionKey(Date.now());
  }

  // ------------- fetch calendar -------------
  async function fetchCalendar() {
    setLoadingCal(true);
    try {
      const q = new URLSearchParams({
        date: dateStr,
        currencies: (instrument.currencies ?? []).join(","),
      }).toString();

      const rsp = await fetch(`/api/calendar?${q}`, { cache: "no-store" });
      const json = await rsp.json();
      setCalendar(Array.isArray(json.items) ? json.items : []);
    } catch (e) {
      console.error(e);
      setCalendar([]);
    } finally {
      setLoadingCal(false);
    }
  }

  // ------------- fetch headlines -------------
  async function fetchHeadlines() {
    setLoadingNews(true);
    try {
      const curr = (instrument.currencies ?? []).join(",");
      const rsp = await fetch(`/api/news?currencies=${encodeURIComponent(curr)}`, {
        cache: "no-store",
      });
      const json = await rsp.json();
      setHeadlines(Array.isArray(json.items) ? json.items : []);
    } catch (e) {
      console.error(e);
      setHeadlines([]);
    } finally {
      setLoadingNews(false);
    }
  }

  // ------------- read current monitor state (if endpoint exists) -------------
  async function fetchMonitorState() {
    try {
      const rsp = await fetch("/api/trade-state", { cache: "no-store" });
      if (!rsp.ok) return;
      const j = await rsp.json();
      setMonitoring(!!j?.active);
    } catch {
      /* endpoint may not exist yet; ignore */
    }
  }

  // initial load OR when instrument/date changes -> refetch everything
  useEffect(() => {
    fetchCalendar();
    fetchHeadlines();
    fetchMonitorState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument.code, dateStr, sessionKey]);

  // ------------- generate plan -------------
  async function generatePlan() {
    setLoadingPlan(true);
    setPlanText("");
    setStandDown(null);
    try {
      const rsp = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,
          date: dateStr,
          calendar,   // pass snapshot already fetched
          headlines,  // pass snapshot already fetched
        }),
      });

      const json: PlanResponse = await rsp.json();
      if (json.ok) {
        setPlanText(json.plan?.text || "");
        setStandDown(null);
      } else {
        setPlanText("");
        setStandDown(json.reason || "No trade idea returned.");
      }
    } catch (e) {
      console.error(e);
      setPlanText("");
      setStandDown("Server error while generating plan.");
    } finally {
      setLoadingPlan(false);
    }
  }

  // ------------- start / stop monitoring -------------
  async function startMonitoring() {
    try {
      setMonitorMsg("");
      const rsp = await fetch("/api/trade-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          active: true,
          instrument,
          // later we can include parsed entry/sl/tp from planText
        }),
      });
      const j = await rsp.json();
      if (rsp.ok && j?.ok === true) {
        setMonitoring(true);
        setMonitorMsg("Monitoring started. Alerts will be sent to Telegram (if configured).");
      } else {
        setMonitoring(false);
        setMonitorMsg(j?.error || "Could not start monitoring.");
      }
    } catch (e: any) {
      setMonitoring(false);
      setMonitorMsg("Could not start monitoring.");
    }
  }

  async function stopMonitoring() {
    try {
      setMonitorMsg("");
      const rsp = await fetch("/api/trade-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      const j = await rsp.json();
      if (rsp.ok && j?.ok === true) {
        setMonitoring(false);
        setMonitorMsg("Monitoring stopped.");
      } else {
        setMonitorMsg(j?.error || "Could not stop monitoring.");
      }
    } catch (e: any) {
      setMonitorMsg("Could not stop monitoring.");
    }
  }

  // ------------- render -------------
  const instrumentOptions = useMemo(
    () =>
      INSTRUMENTS.map((i) => (
        <option key={i.code} value={i.code}>
          {i.code}
        </option>
      )),
    []
  );

  return (
    <main className="max-w-7xl mx-auto space-y-6 px-3 pb-10">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={generatePlan}
          disabled={loadingPlan}
          className="rounded bg-blue-600 hover:bg-blue-500 px-4 py-2 disabled:opacity-50"
        >
          {loadingPlan ? "Generating..." : "Generate Plan"}
        </button>

        <button
          onClick={() => hardReset()}
          className="rounded bg-neutral-800 hover:bg-neutral-700 px-4 py-2"
          title="Full reset (like a fresh open)"
        >
          Reset
        </button>

        <button
          onClick={startMonitoring}
          className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2"
          title="Start Telegram / news monitoring for this instrument"
        >
          Start monitoring
        </button>

        <button
          onClick={stopMonitoring}
          className="rounded bg-rose-600 hover:bg-rose-500 px-4 py-2"
          title="Stop Telegram / news monitoring"
        >
          Stop monitoring
        </button>
      </div>

      {/* Instrument + Date */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="flex flex-col">
          <label className="text-sm text-gray-400">Instrument</label>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-2"
            value={instrument.code}
            onChange={(e) => {
              const found = INSTRUMENTS.find((i) => i.code === e.target.value);
              // hard reset on instrument change (fresh session)
              hardReset(found || instrument);
            }}
          >
            {instrumentOptions}
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
      </div>

      {/* Charts */}
      <TradingViewTriple key={sessionKey} symbol={instrument.code} />

      {/* Calendar */}
      <div className="mt-6">
        <h2 className="text-xl font-semibold mb-2">Calendar Snapshot</h2>
        {/* Calendar items component – unchanged */}
        <CalendarPanel items={calendar as any} loading={loadingCal} />
      </div>

      {/* Headlines (smaller text requested) */}
      <div className="mt-6 text-sm">
        <h2 className="text-xl font-semibold mb-2">Macro Headlines (24–48h)</h2>
        {/* Smaller typographic scale handled inside the panel via parent font-size */}
        <HeadlinesPanel items={headlines as any} loading={loadingNews} />
      </div>

      {/* Monitoring status */}
      <div className="mt-2 text-sm text-gray-300">
        {monitoring === null ? (
          <span className="text-gray-500">Monitor status: unknown</span>
        ) : monitoring ? (
          <span className="text-emerald-400">Monitoring: ON</span>
        ) : (
          <span className="text-gray-400">Monitoring: OFF</span>
        )}
        {monitorMsg ? <div className="text-xs text-gray-400 mt-1">{monitorMsg}</div> : null}
      </div>

      {/* Generated Trade Card */}
      <div className="mt-6 border rounded border-neutral-800 bg-neutral-900 p-3">
        <h2 className="text-lg font-bold mb-2">Generated Trade Card</h2>
        {standDown ? (
          <div className="text-yellow-300">
            <strong>Standing down:</strong> {standDown}
          </div>
        ) : (
          <pre className="whitespace-pre-wrap text-base">{planText || ""}</pre>
        )}
      </div>
    </main>
  );
}
