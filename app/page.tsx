'use client'
import { useEffect, useMemo, useState } from 'react'
import TradingViewTriple from '@/components/TradingViewTriple'
import { INSTRUMENTS } from '@/lib/symbols'

type CalendarItem = { time: string, currency: string, impact?: string, title: string, actual?: string, forecast?: string, previous?: string }

export default function Page() {
  const [instrument, setInstrument] = useState(INSTRUMENTS[0])
  const [dateStr, setDateStr] = useState(() => new Date().toISOString().slice(0,10))
  const [calendar, setCalendar] = useState<CalendarItem[]>([])
  const [loadingCal, setLoadingCal] = useState(false)
  const [plan, setPlan] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [conviction, setConviction] = useState<number|null>(null)

  async function fetchCalendar() {
    setLoadingCal(true)
    try {
      const res = await fetch(`/api/calendar?date=${dateStr}&currencies=${instrument.currencies.join(',')}`)
      const json = await res.json()
      setCalendar(json.items || [])
    } catch (e) {
      console.error(e)
      setCalendar([])
    } finally {
      setLoadingCal(false)
    }
  }

  useEffect(() => { fetchCalendar() }, [instrument, dateStr])

  async function generatePlan() {
    setAiLoading(true)
    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrument: instrument.code, date: dateStr, calendar })
      })
      const json = await res.json()
      setPlan(json.plan?.text || '')
      setConviction(json.plan?.conviction ?? null)
    } finally {
      setAiLoading(false)
    }
  }

  function resetSession() {
    setPlan('')
    setConviction(null)
    setCalendar([])
    fetchCalendar()
  }

  const calText = useMemo(() => calendar.map(i => `${i.time} ${i.currency} ${i.title}${i.impact ? ' ('+i.impact+')' : ''}${i.actual ? ' | A:'+i.actual : ''}${i.forecast ? ' F:'+i.forecast : ''}${i.previous ? ' P:'+i.previous : ''}`).join('\n'), [calendar])

  return (
    <div className="container">
      <h1>Trade Plan Assistant</h1>
      <div className="card" style={{marginTop:12}}>
        <div className="row" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
          <div>
            <div className="label">Instrument</div>
            <select value={instrument.code} onChange={e => setInstrument(INSTRUMENTS.find(x=>x.code===e.target.value) || INSTRUMENTS[0])}>
              {INSTRUMENTS.map(i => <option key={i.code} value={i.code}>{i.display}</option>)}
            </select>
          </div>
          <div>
            <div className="label">Date</div>
            <input className="input" type="date" value={dateStr} onChange={e=>setDateStr(e.target.value)} />
          </div>
          <div>
            <div className="label">Actions</div>
            <div style={{display:'flex',gap:8}}>
              <button className="button" onClick={generatePlan} disabled={aiLoading}>{aiLoading?'Generating…':'Generate Plan'}</button>
              <button onClick={resetSession}>End Session</button>
            </div>
          </div>
        </div>
      </div>

      <div style={{marginTop:12}}><TradingViewTriple symbol={instrument.tv} /></div>

      <div className="card" style={{marginTop:12}}>
        <div className="label">Calendar Snapshot (auto)</div>
        {loadingCal ? <div className="small">Loading calendar…</div> : (
          <pre>{calText || 'No items found (set CALENDAR_RSS_URL or paste key events manually).'}</pre>
        )}
        <div className="small">Tip: Server pulls from CALENDAR_RSS_URL env (RSS). We filter by: {instrument.currencies.join(', ')}.</div>
      </div>

      <div className="card" style={{marginTop:12}}>
        <div className="label">Generated Trade Card</div>
        <div style={{display:'flex',gap:8, alignItems:'center'}}>
          <span className="badge">Conviction: {conviction ?? '—'}%</span>
          <a href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(instrument.tv)}`} target="_blank">Open in TradingView</a>
        </div>
        <pre style={{marginTop:8}}>{plan || 'Click Generate Plan to create an Entry/SL/TP1/TP2 + reasoning.'}</pre>
      </div>
    </div>
  )
}
