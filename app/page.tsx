// app/page.tsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import TradingViewTriple from '../components/TradingViewTriple';
import HeadlinesPanel from '../components/HeadlinesPanel';

// Try to import your project’s canonical instrument list.
// If the import fails (path differences), we’ll fall back to a small local list.
let SYMBOLS: { code: string; label?: string }[] = [];
try {
  // adjust the path if your symbols file lives elsewhere
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../symbols'); // expects default export or named INSTRUMENTS
  SYMBOLS = (mod?.default || mod?.INSTRUMENTS || []) as { code: string; label?: string }[];
} catch {
  SYMBOLS = [
    { code: 'EURUSD', label: 'EUR / USD' },
    { code: 'GBPJPY', label: 'GBP / JPY' },
    { code: 'USDJPY', label: 'USD / JPY' },
    { code: 'XAUUSD', label: 'Gold / USD' },
    { code: 'BTCUSD', label: 'Bitcoin / USD' },
  ];
}

function todayISO() {
  const d = new Date();
  const iso = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  return iso.toISOString().slice(0, 10);
}
function toSymbolsForNews(code: string): string[] {
  const m = code.toUpperCase().trim();
  if (m.length >= 6) return [m.slice(0, 3), m.slice(3, 6)];
  return [m];
}

export default function Page() {
  // -------- state --------
  const [instrument, setInstrument] = useState<string>('EURUSD');
  const [dateStr, setDateStr] = useState<string>(todayISO());

  const [loadingCalendar, setLoadingCalendar] = useState(false);
  const [calendarItems, setCalendarItems] = useState<any[]>([]);

  const [loadingNews, setLoadingNews] = useState(false);
  const [headlines, setHeadlines] = useState<any[]>([]);

  const [generating, setGenerating] = useState(false);
  const [planText, setPlanText] = useState<string>('');
  const [status, setStatus] = useState<string>('');

  // Reset plan whenever instrument/date changes
  useEffect(() => {
    setPlanText('');
    setStatus('');
  }, [instrument, dateStr]);

  // Fetch headlines when instrument changes
  useEffect(() => {
    refreshNews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument]);

  // -------- actions --------
  async function refreshCalendar() {
    setLoadingCalendar(true);
    setStatus('Refreshing calendar...');
    try {
      const url =
        `/api/calendar?date=${encodeURIComponent(dateStr)}&instrument=${encodeURIComponent(
          instrument
        )}&windowHours=48`;
      const r = await fetch(url);
      const j = await r.json();
      if (j?.ok && Array.isArray(j.items)) setCalendarItems(j.items);
      else setCalendarItems([]);
    } catch {
      setCalendarItems([]);
    } finally {
      setLoadingCalendar(false);
      setStatus('');
    }
  }

  async function refreshNews() {
    setLoadingNews(true);
    setStatus('Fetching headlines...');
    try {
      const parts = toSymbolsForNews(instrument);
      const url = `/api/news?symbols=${encodeURIComponent(parts.join(','))}&hours=48`;
      const r = await fetch(url);
      const j = await r.json();
      if (j?.ok && Array.isArray(j.items)) setHeadlines(j.items);
      else if (Array.isArray(j.items)) setHeadlines(j.items);
      else setHeadlines([]);
    } catch {
      setHeadlines([]);
    } finally {
      setLoadingNews(false);
      setStatus('');
    }
  }

  async function generatePlan() {
    setGenerating(true);
    setPlanText('');
    setStatus('Generating plan...');
    try {
      const r = await fetch(
        `/api/plan?instrument=${encodeURIComponent(instrument)}&date=${encodeURIComponent(
          dateStr
        )}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            instrument,
            date: dateStr,
            calendar: calendarItems,
            headlines,
          }),
        }
      );
      const j = await r.json();
      if (j?.ok && typeof j.text === 'string') setPlanText(j.text);
      else if (j?.reason) setPlanText(`Standing down: ${j.reason}`);
      else setPlanText('Standing down: Unknown server response.');
    } catch (err: any) {
      setPlanText(`Standing down: ${err?.message ?? 'Network error'}`);
    } finally {
      setGenerating(false);
      setStatus('');
    }
  }

  function resetAll() {
    setInstrument('EURUSD');
    setDateStr(todayISO());
    setCalendarItems([]);
    setHeadlines([]);
    setPlanText('');
    setStatus('');
  }

  // -------- UI --------
  return (
    <div className="page">
      {/* controls */}
      <div className="toolbar">
        {/* dropdown + custom field in one line */}
        <div className="row">
          <label>Instrument</label>
          <div className="instFlex">
            <select
              value={instrument}
              onChange={(e) => setInstrument(e.target.value)}
              className="instSelect"
            >
              {SYMBOLS.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label ? `${s.label} (${s.code})` : s.code}
                </option>
              ))}
            </select>
            <input
              className="instInput"
              value={instrument}
              onChange={(e) =>
                setInstrument(e.target.value.toUpperCase().replace(/\s+/g, ''))
              }
              placeholder="Custom (e.g., NZDUSD)"
              title="Type any custom symbol here"
            />
          </div>
        </div>

        <div className="row">
          <label>Date</label>
          <input type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} />
        </div>

        <div className="buttons">
          <button onClick={resetAll}>Reset</button>
          <button onClick={refreshCalendar} disabled={loadingCalendar}>
            Refresh Calendar
          </button>
          <button onClick={generatePlan} disabled={generating}>
            {generating ? 'Generating…' : 'Generate Plan'}
          </button>
          <button onClick={() => setStatus('Monitoring started (stub)')}>Start monitoring</button>
          <button onClick={() => setStatus('Monitoring stopped')}>Stop monitoring</button>
        </div>
      </div>

      {status ? <div className="status">{status}</div> : null}

      {/* charts */}
      <div className="charts3">
        <TradingViewTriple symbol={instrument} />
      </div>

      {/* calendar */}
      <h3 className="sectionTitle">Calendar Snapshot</h3>
      <div className="calendarNote">
        {loadingCalendar ? (
          <em>Loading calendar…</em>
        ) : calendarItems.length ? (
          <ul>
            {calendarItems.map((e, i) => (
              <li key={i}>
                {e?.time ?? ''} — <strong>{e?.title ?? e?.name ?? 'Event'}</strong>{' '}
                ({e?.currency ?? ''}) {e?.impact ? `— ${e.impact}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <span>
            No calendar items found from providers. (Once your TradingEconomics key is active, this
            will populate automatically.)
          </span>
        )}
      </div>

      {/* headlines + plan */}
      <div className="grid2">
        <div className="leftCol">
          <h3 className="sectionTitle">Macro Headlines (24–48h)</h3>
          <HeadlinesPanel items={headlines} />
        </div>
        <div className="rightCol">
          <h3 className="sectionTitle">Generated Trade Card</h3>
          {planText ? (
            <pre className="planBox">{planText}</pre>
          ) : (
            <div className="planEmpty">
              <em>
                Click <strong>Generate Plan</strong> to build a setup using 15m execution, 1h+4h
                context, fundamentals (calendar bias + headlines), and your strategy logic.
              </em>
            </div>
          )}
        </div>
      </div>

      {/* styles */}
      <style jsx>{`
        .page {
          padding: 10px 14px;
          color: #d9e1ee;
          background: #0b1220;
          min-height: 100vh;
        }
        .toolbar {
          display: grid;
          grid-template-columns: 1fr 1fr auto;
          gap: 12px;
          align-items: end;
        }
        .row {
          display: grid;
          grid-template-columns: 80px 1fr;
          gap: 8px;
          align-items: center;
        }
        label {
          color: #9bb0ca;
          font-size: 12px;
        }
        input {
          background: #121a2b;
          border: 1px solid #2a3a5a;
          color: #e9f2ff;
          padding: 6px 8px;
          border-radius: 6px;
        }
        .instFlex {
          display: grid;
          grid-template-columns: minmax(160px, 260px) 1fr;
          gap: 8px;
        }
        .instSelect,
        .instInput {
          background: #121a2b;
          border: 1px solid #2a3a5a;
          color: #e9f2ff;
          padding: 6px 8px;
          border-radius: 6px;
        }
        .buttons {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          flex-wrap: wrap;
        }
        button {
          background: #182338;
          border: 1px solid #2a3a5a;
          color: #e9f2ff;
          padding: 8px 10px;
          border-radius: 6px;
          cursor: pointer;
        }
        button:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .status {
          margin: 8px 0 2px;
          color: #9bb0ca;
          font-size: 12px;
        }
        .charts3 {
          margin-top: 10px;
        }
        .sectionTitle {
          margin: 18px 0 8px;
          font-size: 16px;
          font-weight: 600;
          color: #cfe3ff;
        }
        .calendarNote {
          font-size: 13px;
          color: #b8c5dd;
          padding-bottom: 4px;
        }
        .calendarNote ul {
          margin: 6px 0 0 16px;
        }
        .grid2 {
          display: grid;
          grid-template-columns: 1.1fr 0.9fr;
          gap: 18px;
          margin-top: 10px;
        }
        .leftCol,
        .rightCol {
          min-width: 0;
        }
        :global(.headlines-panel) {
          font-size: 13px;
          line-height: 1.35;
        }
        :global(.headlines-panel a) {
          color: #9fd1ff;
        }
        .planBox {
          white-space: pre-wrap;
          background: #0e1626;
          border: 1px solid #2a3a5a;
          border-radius: 10px;
          padding: 12px 14px;
          font-size: 14px;
          line-height: 1.4;
        }
        .planEmpty {
          background: #0e1626;
          border: 1px dashed #324466;
          border-radius: 10px;
          padding: 14px;
          color: #9bb0ca;
          font-size: 14px;
        }
        @media (max-width: 1200px) {
          .grid2 {
            grid-template-columns: 1fr;
          }
          .instFlex {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}
