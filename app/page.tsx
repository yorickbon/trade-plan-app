// app/page.tsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';

// === components (use the relative paths that compile in your repo) ===
import TradingViewTriple from '../components/TradingViewTriple';
import HeadlinesPanel from '../components/HeadlinesPanel';
// If you have CalendarPanel and want to render it, you can import it too:
// import CalendarPanel from '../components/CalendarPanel';

// ---------------- helpers ----------------
function todayISO() {
  const d = new Date();
  const iso = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  return iso.toISOString().slice(0, 10);
}

function toSymbolsForNews(code: string): string[] {
  // EURUSD -> ["EUR","USD"]; GBPJPY -> ["GBP","JPY"]; XAUUSD -> ["XAU","USD"] ...
  const m = code.toUpperCase().trim();
  if (m.length >= 6) return [m.slice(0, 3), m.slice(3, 6)];
  // fallback: guess currency-like tokens
  return [m];
}

// ---------------- page ----------------
export default function Page() {
  // ---- state ----
  const [instrument, setInstrument] = useState<string>('EURUSD');
  const [dateStr, setDateStr] = useState<string>(todayISO());

  const [loadingCalendar, setLoadingCalendar] = useState(false);
  const [calendarItems, setCalendarItems] = useState<any[]>([]);

  const [loadingNews, setLoadingNews] = useState(false);
  const [headlines, setHeadlines] = useState<any[]>([]);

  const [generating, setGenerating] = useState(false);
  const [planText, setPlanText] = useState<string>('');
  const [status, setStatus] = useState<string>(''); // small UI status line

  // Clear previous output whenever instrument or date changes
  useEffect(() => {
    setPlanText('');
    setStatus('');
  }, [instrument, dateStr]);

  // auto-load headlines when instrument changes
  useEffect(() => {
    (async () => {
      await refreshNews();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument]);

  // ---------------- fetchers ----------------
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
      if (j?.ok && Array.isArray(j.items)) {
        setCalendarItems(j.items);
      } else {
        setCalendarItems([]);
      }
    } catch (err) {
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
      const list = toSymbolsForNews(instrument);
      const url =
        `/api/news?symbols=${encodeURIComponent(list.join(','))}&hours=48`;
      const r = await fetch(url);
      const j = await r.json();
      if (j?.ok && Array.isArray(j.items)) {
        setHeadlines(j.items);
      } else if (Array.isArray(j.items)) {
        setHeadlines(j.items);
      } else {
        setHeadlines([]);
      }
    } catch (err) {
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
      // Pass instrument in both query and body (prevents stale EURUSD)
      const r = await fetch(`/api/plan?instrument=${encodeURIComponent(instrument)}&date=${encodeURIComponent(dateStr)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instrument,
          date: dateStr,
          calendar: calendarItems,
          headlines,
        }),
      });
      const j = await r.json();
      if (j?.ok && typeof j.text === 'string') {
        setPlanText(j.text);
      } else if (j?.reason) {
        setPlanText(`Standing down: ${j.reason}`);
      } else {
        setPlanText('Standing down: Unknown server response.');
      }
    } catch (err: any) {
      setPlanText(`Standing down: ${err?.message ?? 'Network error'}`);
    } finally {
      setGenerating(false);
      setStatus('');
    }
  }

  // ---------------- UI ----------------
  return (
    <div className="page">
      {/* top controls */}
      <div className="toolbar">
        <div className="row">
          <label>Instrument</label>
          <input
            value={instrument}
            onChange={(e) => setInstrument(e.target.value.toUpperCase().replace(/\s+/g, ''))}
            placeholder="EURUSD / GBPJPY / XAUUSD"
          />
        </div>
        <div className="row">
          <label>Date</label>
          <input
            type="date"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
          />
        </div>
        <div className="buttons">
          <button onClick={refreshCalendar} disabled={loadingCalendar}>
            Refresh Calendar
          </button>
          <button onClick={generatePlan} disabled={generating}>
            {generating ? 'Generating…' : 'Generate Plan'}
          </button>
          <button onClick={() => setStatus('Monitoring started (stub)')}>
            Start monitoring
          </button>
          <button onClick={() => setStatus('Monitoring stopped')}>
            Stop monitoring
          </button>
        </div>
      </div>

      {status ? <div className="status">{status}</div> : null}

      {/* charts: 3 side-by-side */}
      <div className="charts3">
        <TradingViewTriple symbol={instrument} />
      </div>

      {/* calendar snapshot (text note only; when TE key is live, this will fill) */}
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
          <span>No calendar items found from providers. (Once your TradingEconomics key is active, this will populate automatically.)</span>
        )}
      </div>

      {/* headlines + trade card in two columns */}
      <div className="grid2">
        <div className="leftCol">
          <h3 className="sectionTitle">Macro Headlines (24–48h)</h3>
          {/* Your base HeadlinesPanel takes only {items}. Do not pass non-existing props. */}
          <HeadlinesPanel items={headlines} />
        </div>
        <div className="rightCol">
          <h3 className="sectionTitle">Generated Trade Card</h3>
          {planText ? (
            <pre className="planBox">{planText}</pre>
          ) : (
            <div className="planEmpty">
              <em>
                Click <strong>Generate Plan</strong> to build a setup using 15m execution,
                1h+4h context, fundamentals (calendar bias + headlines), and your strategy logic.
              </em>
            </div>
          )}
        </div>
      </div>

      {/* local styles so you don’t have to touch global CSS */}
      <style jsx>{`
        .page { padding: 10px 14px; color: #d9e1ee; background: #0b1220; min-height: 100vh; }
        .toolbar { display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: end; }
        .row { display: grid; grid-template-columns: 80px 1fr; gap: 8px; align-items: center; }
        label { color: #9bb0cA; font-size: 12px; }
        input { background: #121a2b; border: 1px solid #2a3a5a; color: #e9f2ff; padding: 6px 8px; border-radius: 6px; }
        .buttons { display: flex; gap: 8px; justify-content: flex-end; }
        button { background: #182338; border: 1px solid #2a3a5a; color: #e9f2ff; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
        button:disabled { opacity: .6; cursor: default; }
        .status { margin: 8px 0 2px; color: #9bb0ca; font-size: 12px; }

        .charts3 { margin-top: 10px; }
        /* TradingViewTriple already renders 3 frames in a row; no extra layout here */

        .sectionTitle { margin: 18px 0 8px; font-size: 16px; font-weight: 600; color: #cfe3ff; }

        .calendarNote { font-size: 13px; color: #b8c5dd; padding-bottom: 4px; }
        .calendarNote ul { margin: 6px 0 0 16px; }

        .grid2 { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 18px; margin-top: 10px; }
        .leftCol { min-width: 0; }
        .rightCol { min-width: 0; }

        /* Make headlines smaller */
        :global(.headlines-panel) { font-size: 13px; line-height: 1.35; }
        :global(.headlines-panel a) { color: #9fd1ff; }

        /* Make Trade Card bigger and stacked */
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
          background: #0e1626; border: 1px dashed #324466; border-radius: 10px;
          padding: 14px; color: #9bb0ca; font-size: 14px;
        }

        @media (max-width: 1200px) {
          .grid2 { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
