// /components/CalendarPaste.tsx
import React, { useMemo, useState } from "react";

type Impact = "High" | "Medium" | "Low" | "None";
type Parsed = {
  time: string;          // ISO
  currency?: string;     // USD, EUR ...
  impact?: Impact;
  title: string;
  actual?: number | null;
  forecast?: number | null;
  previous?: number | null;
};

function toISO(date: string, timeHHMM: string, tzOffsetMinutes: number) {
  // date = "2025-08-29", time="08:30"
  const [hh, mm] = timeHHMM.split(":").map((n) => Number(n));
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCHours(hh, mm, 0, 0);
  // apply local timezone offset (minutes) -> convert to UTC ISO
  return new Date(d.getTime() - tzOffsetMinutes * 60000).toISOString();
}

function num(x: string | undefined | null): number | null {
  if (!x) return null;
  const n = Number(String(x).replace(/[^\d.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toImpact(x: string | undefined | null): Impact | undefined {
  if (!x) return undefined;
  const s = x.toLowerCase();
  if (s.includes("high")) return "High";
  if (s.includes("medium") || s.includes("med")) return "Medium";
  if (s.includes("low")) return "Low";
  if (s.includes("none")) return "None";
  return undefined;
}

function toCCY(x: string | undefined | null): string | undefined {
  const m = String(x || "").toUpperCase().match(/\b(EUR|USD|GBP|JPY|AUD|NZD|CAD|CHF|CNY|XAU)\b/);
  return m?.[1];
}

function trimCols(cols: string[]) {
  return cols.map((c) => c.trim()).filter((c, i, a) => !(i === a.length - 1 && c === "")); // drop last empty col
}

/** Parse pasted table text. Accepts:
 * - Tab-delimited (best when copying from web tables / Excel / Sheets)
 * - Comma-delimited (CSV)
 * - Whitespace columns (fallback)
 * Expected columns (any order): Time, Currency, Impact, Event/Title, Actual, Forecast, Previous
 */
function parsePasted(text: string, dateISO: string, tzOffsetMin: number): Parsed[] {
  // normalize newlines and strip repeated spaces
  const rows = text
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((r) => r.trim())
    .filter(Boolean);

  const out: Parsed[] = [];

  for (const row of rows) {
    // Choose the splitter: tabs first, then commas, then multiple spaces
    let cols =
      row.includes("\t")
        ? row.split("\t")
        : row.includes(",")
        ? row.split(",")
        : row.split(/\s{2,}/);
    cols = trimCols(cols);

    // Try to detect time as HH:MM
    const timeCol = cols.find((c) => /^\d{1,2}:\d{2}$/.test(c));
    const timeHHMM = timeCol || "12:00"; // if missing, default noon
    const timeISO = toISO(dateISO, timeHHMM, tzOffsetMin);

    // currency / impact / title heuristics
    const currency = toCCY(cols.find(toCCY));
    const impact = toImpact(cols.find((c) => toImpact(c)));
    // Prefer a column with words that isn't time/currency/impact/numbers
    const title =
      cols.find(
        (c) =>
          c !== timeCol &&
          c !== currency &&
          c !== impact &&
          !/^[\d,.%+\-]+$/.test(c) &&
          c.length > 2
      ) || row; // fallback: entire row

    // numeric fields
    const actual = num(cols.find((c) => /actual/i.test(c)) || cols.find((c) => /^-?[\d,.%+\-]+$/.test(c)));
    // When labeled CSV/TSV, Actual/Forecast/Previous often are at the tail. Try to map by labels too:
    const forecast =
      num(cols.find((c) => /forecast/i.test(c))) ||
      num(cols.slice(-3)[1]); // heuristic: middle of the last three numeric cols
    const previous =
      num(cols.find((c) => /previous/i.test(c))) ||
      num(cols.slice(-3)[2]); // heuristic: last of last three numeric cols

    // Only accept a useful row (title + time ok)
    if (title && timeISO) {
      out.push({
        title: title.replace(/\s{2,}/g, " "),
        currency,
        impact,
        time: timeISO,
        actual,
        forecast,
        previous,
      });
    }
  }

  // de-dup by (time+title)
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.time}__${r.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export default function CalendarPaste({
  instrument,
  onComplete,
}: {
  instrument?: string;
  onComplete?: (resp: any) => void;
}) {
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  // timezone offset in minutes (default: your local tz offset sign-flipped to get UTC)
  const defaultOffset = useMemo(() => -new Date().getTimezoneOffset(), []);
  const [tzOffset, setTzOffset] = useState<number>(defaultOffset);

  const [raw, setRaw] = useState("");
  const [items, setItems] = useState<Parsed[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function handleParse() {
    setErr("");
    const parsed = parsePasted(raw, date, tzOffset);
    if (!parsed.length) setErr("Nothing recognized. Try copying the table (tabs) or a CSV-like block.");
    setItems(parsed);
  }

  function addRow() {
    setItems((x) => [
      ...x,
      {
        title: "",
        currency: "USD",
        impact: "Medium",
        time: toISO(date, "12:00", tzOffset),
        actual: null,
        forecast: null,
        previous: null,
      },
    ]);
  }

  async function submit() {
    try {
      setBusy(true);
      setErr("");
      const rsp = await fetch("/api/calendar-manual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items, instrument }),
      });
      const j = await rsp.json();
      if (!j?.ok) throw new Error(j?.reason || "Upload failed");
      onComplete?.(j);
    } catch (e: any) {
      setErr(e?.message || "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-neutral-800 p-4 space-y-3">
      <div className="text-sm text-gray-300">
        Paste a calendar table (from a website or spreadsheet). We’ll parse rows, you can edit, then
        we’ll compute <b>blackout</b> and <b>fundamental bias</b>.
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label>Date</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
        />
        <label>Time offset (min)</label>
        <input
          type="number"
          value={tzOffset}
          onChange={(e) => setTzOffset(Number(e.target.value))}
          className="w-24 bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
          title="Minutes to subtract from pasted local time to get UTC (e.g. +120 for UTC+2)"
        />
        <button
          onClick={handleParse}
          className="px-3 py-1 rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
        >
          Parse
        </button>
        <button
          onClick={addRow}
          className="px-3 py-1 rounded bg-neutral-800 border border-neutral-700"
        >
          + Add row
        </button>
      </div>

      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder={`Example (tab or comma separated):
08:30\tUSD\tHigh\tNonfarm Payrolls\t275k\t190k\t165k
08:30\tUSD\tHigh\tUnemployment Rate\t3.9\t3.8\t3.8
10:00\tEUR\tMedium\tCPI (YoY)\t2.4%\t2.5%\t2.6%`}
        rows={8}
        className="w-full text-sm leading-5 bg-neutral-900 border border-neutral-700 rounded p-2 font-mono"
      />

      {err && <div className="text-xs text-red-400">{err}</div>}

      {items.length > 0 && (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-400 sticky top-0 bg-neutral-950">
              <tr>
                <th className="text-left p-1">Time (ISO)</th>
                <th className="text-left p-1">CCY</th>
                <th className="text-left p-1">Impact</th>
                <th className="text-left p-1">Title</th>
                <th className="text-left p-1">Actual</th>
                <th className="text-left p-1">Forecast</th>
                <th className="text-left p-1">Previous</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td className="p-1">
                    <input
                      className="w-56 bg-neutral-900 border border-neutral-700 rounded px-1"
                      value={it.time}
                      onChange={(e) =>
                        setItems((s) => s.map((r, idx) => (idx === i ? { ...r, time: e.target.value } : r)))
                      }
                    />
                  </td>
                  <td className="p-1">
                    <input
                      className="w-16 bg-neutral-900 border border-neutral-700 rounded px-1"
                      value={it.currency || ""}
                      onChange={(e) =>
                        setItems((s) =>
                          s.map((r, idx) => (idx === i ? { ...r, currency: e.target.value.toUpperCase() } : r))
                        )
                      }
                    />
                  </td>
                  <td className="p-1">
                    <select
                      className="bg-neutral-900 border border-neutral-700 rounded"
                      value={it.impact || "Medium"}
                      onChange={(e) =>
                        setItems((s) => s.map((r, idx) => (idx === i ? { ...r, impact: e.target.value as Impact } : r)))
                      }
                    >
                      <option>High</option>
                      <option>Medium</option>
                      <option>Low</option>
                      <option>None</option>
                    </select>
                  </td>
                  <td className="p-1">
                    <input
                      className="w-[28rem] bg-neutral-900 border border-neutral-700 rounded px-1"
                      value={it.title}
                      onChange={(e) =>
                        setItems((s) => s.map((r, idx) => (idx === i ? { ...r, title: e.target.value } : r)))
                      }
                    />
                  </td>
                  <td className="p-1">
                    <input
                      className="w-20 bg-neutral-900 border border-neutral-700 rounded px-1"
                      value={it.actual ?? ""}
                      onChange={(e) =>
                        setItems((s) =>
                          s.map((r, idx) => (idx === i ? { ...r, actual: num(e.target.value) } : r))
                        )
                      }
                    />
                  </td>
                  <td className="p-1">
                    <input
                      className="w-20 bg-neutral-900 border border-neutral-700 rounded px-1"
                      value={it.forecast ?? ""}
                      onChange={(e) =>
                        setItems((s) =>
                          s.map((r, idx) => (idx === i ? { ...r, forecast: num(e.target.value) } : r))
                        )
                      }
                    />
                  </td>
                  <td className="p-1">
                    <input
                      className="w-20 bg-neutral-900 border border-neutral-700 rounded px-1"
                      value={it.previous ?? ""}
                      onChange={(e) =>
                        setItems((s) =>
                          s.map((r, idx) => (idx === i ? { ...r, previous: num(e.target.value) } : r))
                        )
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={busy || items.length === 0}
          className="px-3 py-1 text-sm rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50"
        >
          Use these events
        </button>
      </div>
    </div>
  );
}
