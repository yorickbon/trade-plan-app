'use client';

import React, { useEffect, useMemo, useState } from 'react';
import TradingViewTriple from '@/components/TradingViewTriple';
import HeadlinesPanel from '@/components/HeadlinesPanel';
import CalendarPanel from '@/components/CalendarPanel';
import { INSTRUMENTS, findInstrument, type Instrument } from '@/lib/symbols';

type PlanResp = {
  ok: boolean;
  text?: string;
  reason?: string;
  plan?: any;
  baseConv?: number;
};

function todayISO() {
  const d = new Date();
  // keep YYYY-MM-DD
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
    .toISOString()
    .slice(0, 10);
}

export default function Page() {
  // ---- instrument & date ----
  const [instrument, setInstrument] = useState<Instrument>(
    findInstrument('EURUSD') || INSTRUMENTS[0]
  );
  const [date, setDate] = useState<string>(todayISO());

  // ---- data buckets ----
  const [headlines, setHeadlines] = useState<any[]>([]);
  const [calendar, setCalendar] = useState<any[]>([]);
  const [planText, setPlanText] = useState<string>('');
  const [planObj, setPlanObj] = useState<any | null>(null);

  // ---- loading flags ----
  const [loadingNews, setLoadingNews] = useState(false);
  const [loadingCal, setLoadingCal] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [monitoring, setMonitoring] = useState(false);

  // TradingView symbol (your widget already knows how to handle these)
  const tvSymbol = useMemo(() => {
    // If your TradingViewTriple expects a plain code (like 'EURUSD') keep it;
    // If it needs a broker prefix, add it here (example: `OANDA:${instrument.code}`)
    return instrument.code;
  }, [instrument]);

  // ============= fetchers =============

  async function loadNews(code: string) {
    try {
      setLoadingNews(true);
      setHeadlines([]);
      const qs = new URLSearchParams({
        symbols: code.slice(0, 3) + ',' + code.slice(3), // e.g., 'EUR,USD'
      });
      const r = await fetch(`/api/news?${qs.toString()}`);
      const j = await r.json();
      setHeadlines(Array.isArray(j.items) ? j.items : []);
    } catch {
      setHeadlines([]);
    } finally {
      setLoadingNews(false);
    }
  }

  async function loadCalendar(code: string, day: string) {
    try {
      setLoadingCal(true);
      setCalendar([]);
      // backend supports either instrument or currencies; use instrument
      const qs = new URLSearchParams({ date: day, instrument: code, windowHours: '48' });
      const r = await fetch(`/api/calendar?${qs.toString()}`);
      const j = await r.json();
      setCalendar(Array.isArray(j.items) ? j.items : []);
    } catch {
      setCalendar([]);
    } finally {
      setLoadingCal(false);
    }
  }

  async function genPlan() {
    try {
      setLoadingPlan(true);
      setPlanText('');
      setPlanObj(null);

      const body = {
        instrument: { code: instrument.code, label: instrument.label },
        headlines,
        calendar,
      };
      const r = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j: PlanResp = await r.json();

      if (!j.ok) {
        setPlanText(`Standing down: ${j.reason || 'Unknown error.'}`);
        setPlanObj(null);
        return;
      }

      // prefer formatted text from server; keep object for future UI
      setPlanText(j.text || '');
      setPlanObj(j.plan || null);
    } catch (e: any) {
      setPlanText(`Standing down: ${e?.message || 'Unknown error.'}`);
      setPlanObj(null);
    } finally {
      setLoadingPlan(false);
    }
  }

  // ============= reactions =============
  // When instrument OR date changes:
  // - clear current plan (avoid stale EURUSD card),
  // - fetch news + calendar.
  useEffect(() => {
    setPlanText('');
    setPlanObj(null);
    loadNews(instrument.code);
    loadCalendar(instrument.code, date);
  }, [instrument, date]);

  // ============= UI handlers =============
  function onSelectInstrument(code: string) {
    const found = findInstrument(code);
    setInstrument(found || { code, label: code, currencies: [] });
  }

  function onReset() {
    setDate(todayISO());
    setPlanText('');
    setPlanObj(null);
    // re-fetch for today
    loadNews(instrument.code);
    loadCalendar(instrument.code, todayISO());
  }

  function onStartMon() {
    setMonitoring(true);
    // wire to your monitor page/logic if needed
    // e.g., fetch('/api/ask?msg=start-monitoring')
  }

  function onStopMon() {
    setMonitoring(false);
    // e.g., fetch('/api/ask?msg=stop-monitoring')
  }

  // ============= layout =============
  return (
    <div className="p-3 text-slate-200">
      {/* Controls Row */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-2 mb-3">
        {/* Instrument dropdown */}
        <div className="col-span-2">
          <label className="block text-xs opacity-70 mb-1">Instrument</label>
          <select
            className="w-full rounded bg-slate-800/60 px-3 py-2 outline-none"
            value={instrument.code}
            onChange={(e) => onSelectInstrument(e.target.value)}
          >
            {INSTRUMENTS.map((i) => (
              <option key={i.code} value={i.code}>
                {i.label}
              </option>
            ))}
          </select>
        </div>

        {/* Code readout (still editable if you want to type) */}
        <div>
          <label className="block text-xs opacity-70 mb-1">Code</label>
          <input
            className="w-full rounded bg-slate-800/60 px-3 py-2 outline-none"
            value={instrument.code}
            onChange={(e) => onSelectInstrument(e.target.value.toUpperCase().replace(/\s/g, ''))}
          />
        </div>

        {/* Date */}
        <div>
          <label className="block text-xs opacity-70 mb-1">Date</label>
          <input
            type="date"
            className="w-full rounded bg-slate-800/60 px-3 py-2 outline-none"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        {/* Buttons */}
        <div className="flex items-end gap-2">
          <button
            className="flex-1 rounded bg-slate-700 hover:bg-slate-600 py-2 text-sm"
            onClick={onReset}
          >
            Reset
          </button>
          <button
            className="flex-1 rounded bg-indigo-700 hover:bg-indigo-600 py-2 text-sm disabled:opacity-50"
            onClick={genPlan}
            disabled={loadingPlan}
          >
            {loadingPlan ? 'Generating…' : 'Generate Plan'}
          </button>
          <button
            className="hidden lg:block rounded bg-emerald-700 hover:bg-emerald-600 px-3 py-2 text-sm disabled:opacity-50"
            onClick={onStartMon}
            disabled={monitoring}
            title="Start monitoring"
          >
            Start monitoring
          </button>
          <button
            className="hidden lg:block rounded bg-rose-700 hover:bg-rose-600 px-3 py-2 text-sm disabled:opacity-50"
            onClick={onStopMon}
            disabled={!monitoring}
            title="Stop monitoring"
          >
            Stop monitoring
          </button>
        </div>
      </div>

      {/* Charts Row */}
      <div className="mb-4">
        <TradingViewTriple symbol={tvSymbol} />
      </div>

      {/* Bottom two-column row */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* LEFT: Calendar + Headlines */}
        <div>
          <h2 className="text-lg font-semibold mb-2">Calendar Snapshot</h2>
          <div className="rounded border border-slate-700 bg-slate-900/40 p-3 mb-4">
            <CalendarPanel items={calendar} loading={loadingCal} />
          </div>

          <h2 className="text-lg font-semibold mb-2">Macro Headlines (24–48h)</h2>
          <div className="rounded border border-slate-700 bg-slate-900/40 p-3">
            {/* smaller text for headlines */}
            <div className="text-sm">
              <HeadlinesPanel items={headlines} />
            </div>
          </div>
        </div>

        {/* RIGHT: Trade Card */}
        <div>
          <h2 className="text-lg font-semibold mb-2">Generated Trade Card</h2>
          <div className="rounded border border-slate-700 bg-slate-900/40 p-4 min-h-[320px]">
            {planText ? (
              <pre className="whitespace-pre-wrap leading-relaxed text-base">
                {planText}
              </pre>
            ) : loadingPlan ? (
              <div className="opacity-70 text-base">Building plan…</div>
            ) : (
              <div className="opacity-70 text-base">
                Click <span className="font-semibold">Generate Plan</span> to build a setup
                using 15m execution, 1h+4h context, fundamentals (calendar bias +
                headlines), and our strategy logic.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
