// /components/CalendarUpload.tsx
import React, { useState } from "react";
// add: npm i tesseract.js
import Tesseract from "tesseract.js";

type Parsed = {
  title: string;
  currency?: string;
  impact?: "High"|"Medium"|"Low"|"None";
  time: string;               // ISO
  actual?: number|null;
  forecast?: number|null;
  previous?: number|null;
};

function parseNumbers(s:string): number | null {
  const n = Number(String(s).replace(/[^\d.+-]/g,""));
  return Number.isFinite(n) ? n : null;
}

// Very light parser for common calendar rows (ForexFactory/Investing style)
function roughParse(text: string, defaultDateISO: string): Parsed[] {
  const lines = text.split(/\n+/).map(l=>l.trim()).filter(Boolean);
  const out: Parsed[] = [];
  const curRE = /\b(EUR|USD|GBP|JPY|AUD|NZD|CAD|CHF|CNY|XAU)\b/i;
  const impRE = /\b(High|Medium|Low)\b/i;
  const timeRE = /\b(\d{1,2}:\d{2})\b/; // 08:30 style

  for (let i=0;i<lines.length;i++){
    const L = lines[i];
    const currency = curRE.exec(L)?.[1]?.toUpperCase();
    const impact = impRE.exec(L)?.[1] as Parsed["impact"];
    const timeHit = timeRE.exec(L)?.[1]; // "08:30"
    const title = L.replace(curRE,"").replace(impRE,"").trim();

    if (currency && timeHit && title.length>2){
      const timeISO = new Date(`${defaultDateISO}T${timeHit}:00Z`).toISOString();
      // try to sniff numbers from neighbors
      const neighborhood = lines.slice(Math.max(0,i-1), i+3).join(" ");
      const actual = /Actual[:\s-]*([+\-]?\d[\d.,+-]*)/i.exec(neighborhood)?.[1];
      const forecast = /Forecast[:\s-]*([+\-]?\d[\d.,+-]*)/i.exec(neighborhood)?.[1];
      const previous = /Previous[:\s-]*([+\-]?\d[\d.,+-]*)/i.exec(neighborhood)?.[1];

      out.push({
        title: title.replace(/\s{2,}/g," "),
        currency,
        impact: impact || "Medium",
        time: timeISO,
        actual: actual ? parseNumbers(actual) : null,
        forecast: forecast ? parseNumbers(forecast) : null,
        previous: previous ? parseNumbers(previous) : null,
      });
    }
  }
  return out;
}

export default function CalendarUpload({
  instrument,
  onComplete,
}: {
  instrument?: string;
  onComplete?: (resp: any)=>void;
}) {
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<Parsed[]>([]);
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0,10));
  const [error, setError] = useState<string>("");

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setError("");
    try {
      const { data } = await Tesseract.recognize(file, "eng", { tessedit_char_whitelist: undefined });
      const parsed = roughParse(data.text, date);
      if (!parsed.length) setError("Could not auto-parse. You can still add rows manually below.");
      setItems(parsed);
    } catch (err:any) {
      setError(err?.message || "OCR error");
    } finally {
      setBusy(false);
    }
  }

  function addEmpty() {
    setItems(x => [...x, {
      title: "", currency: "USD", impact: "Medium",
      time: new Date(`${date}T12:00:00Z`).toISOString(),
      actual: null, forecast: null, previous: null
    }]);
  }

  async function submit() {
    setBusy(true); setError("");
    try {
      const rsp = await fetch("/api/calendar-manual", {
        method: "POST", headers: {"content-type":"application/json"},
        body: JSON.stringify({ items, instrument }),
      });
      const j = await rsp.json();
      if (!j?.ok) throw new Error(j?.reason || "upload failed");
      onComplete?.(j);
    } catch (e:any) { setError(e?.message || "submit failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border border-neutral-800 p-4 space-y-3">
      <div className="text-sm text-gray-300">
        No calendar feed? Upload a screenshot/photoshot of your calendar. We’ll OCR it locally,
        let you review, then compute blackout & fundamental bias.
      </div>

      <div className="flex gap-3 items-center">
        <label className="text-sm">Date:</label>
        <input
          type="date" value={date}
          onChange={(e)=>setDate(e.target.value)}
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
        />
        <input type="file" accept="image/*,.png,.jpg,.jpeg"
               onChange={onFile}
               className="text-sm" />
        <button onClick={addEmpty} className="text-xs px-2 py-1 rounded bg-neutral-800 border border-neutral-700">
          + Add row
        </button>
      </div>

      {busy && <div className="text-xs text-gray-400">Processing…</div>}
      {error && <div className="text-xs text-red-400">{error}</div>}

      {items.length>0 && (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-400">
              <tr><th>Time (ISO)</th><th>CCY</th><th>Impact</th><th>Title</th><th>Actual</th><th>Forecast</th><th>Previous</th></tr>
            </thead>
            <tbody>
              {items.map((it,idx)=>(
                <tr key={idx}>
                  <td><input className="w-48 bg-neutral-900 border border-neutral-700 rounded px-1"
                             value={it.time} onChange={e=>setItems(s=>s.map((r,i)=>i===idx?{...r,time:e.target.value}:r))}/></td>
                  <td><input className="w-12 bg-neutral-900 border border-neutral-700 rounded px-1"
                             value={it.currency||""} onChange={e=>setItems(s=>s.map((r,i)=>i===idx?{...r,currency:e.target.value.toUpperCase()}:r))}/></td>
                  <td>
                    <select className="bg-neutral-900 border border-neutral-700 rounded"
                      value={it.impact||"Medium"}
                      onChange={e=>setItems(s=>s.map((r,i)=>i===idx?{...r,impact:e.target.value as any}:r))}>
                      <option>High</option><option>Medium</option><option>Low</option><option>None</option>
                    </select>
                  </td>
                  <td><input className="w-96 bg-neutral-900 border border-neutral-700 rounded px-1"
                             value={it.title} onChange={e=>setItems(s=>s.map((r,i)=>i===idx?{...r,title:e.target.value}:r))}/></td>
                  <td><input className="w-20 bg-neutral-900 border border-neutral-700 rounded px-1"
                             value={it.actual??""} onChange={e=>setItems(s=>s.map((r,i)=>i===idx?{...r,actual:parseNumbers(e.target.value)}:r))}/></td>
                  <td><input className="w-20 bg-neutral-900 border border-neutral-700 rounded px-1"
                             value={it.forecast??""} onChange={e=>setItems(s=>s.map((r,i)=>i===idx?{...r,forecast:parseNumbers(e.target.value)}:r))}/></td>
                  <td><input className="w-20 bg-neutral-900 border border-neutral-700 rounded px-1"
                             value={it.previous??""} onChange={e=>setItems(s=>s.map((r,i)=>i===idx?{...r,previous:parseNumbers(e.target.value)}:r))}/></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={items.length===0 || busy}
          className="px-3 py-1 text-sm rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50">
          Use these events
        </button>
      </div>
    </div>
  );
}
