"use client";

import React, { useEffect, useMemo, useState } from "react";
import TradingViewTriple from "@/components/TradingViewTriple";
import HeadlinesPanel from "@/components/HeadlinesPanel";
import CalendarPanel from "@/components/CalendarPanel";
import { INSTRUMENTS, findInstrument, type Instrument } from "@/lib/symbols";

type PlanResp = {
  ok: boolean;
  text?: string;          // pretty printed trade plan
  plan?: {                // compact fields we already use
    direction?: string;
    entry?: number;
    sl?: number;
    tp1?: number;
    tp2?: number;
    conviction?: number;
  };
  reason?: string;
};

export default function Page() {
  // ------- state -------
  const [instCode, setInstCode] = useState<string>("EURUSD"); // default
  const [inst, setInst] = useState<Instrument | undefined>(() =>
    findInstrument("EURUSD")
  );
  const [dateStr, setDateStr] = useState<string>(() =>
    new Date().toISOString().slice(0, 10)
  );

  const [loadingNews, setLoadingNews] = useState(false);
  const [headlines, setHeadlines] = useState<any[]>([]);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [planText, setPlanText] = useState<string>("");

  // derive currencies for news query
  const newsSymbols = useMemo(() => {
    const ccy = inst?.currencies || [];
    return ccy.slice(0, 2); // e.g., ["EUR", "USD"]
  }, [inst]);

  // ------- helpers -------
  function resetAll() {
    setHeadlines([]);
    setPlanText("");
  }

  async function fetchHeadlines() {
    if (!newsSymbols?.length) {
      setHeadlines([]);
      return;
    }
    setLoadingNews(true);
    try {
      const url = `/api/news?symbols=${encodeURIComponent(
        newsSymbols.join(",")
      )}&hours=48`;
      const r = await fetch(url);
      const j = await r.json();
      setHeadlines(Array.isArray(j?.items) ? j.items : []);
    } catch (e) {
      setHeadlines([]);
    } finally {
      setLoadingNews(false);
    }
  }

  async function fetchPlan() {
    setLoadingPlan(true);
    setPlanText("");
    try {
      const r = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument: { code: instCode },
          headlines,
          calendar: [], // your calendar stays as-is; backend handles empty
        }),
      });
      const j: PlanResp = await r.json();
      if (j?.ok && (j.text || j.plan)) {
        // Prefer pretty text from backend (already formatted with newlines)
        const txt =
          j.text ||
          [
            "Quick Plan (Actionable)",
            `• Direction: ${j.plan?.direction ?? "—"}`,
            `• Entry: ${j.plan?.entry ?? "—"}`,
            `• Stop Loss: ${j.plan?.sl ?? "—"}`,
            `• Take Profit(s): TP1 ${j.plan?.tp1 ?? "—"} / TP2 ${
              j.plan?.tp2 ?? "—"
            }`,
            `• Conviction: ${j.plan?.conviction ?? "—"}%`,
          ].join("\n");
        setPlanText(txt);
      } else {
        setPlanText(
          JSON.stringify(
            { ok: false, reason: j?.reason || "No plan produced" },
            null,
            2
          )
        );
      }
    } catch (e) {
      setPlanText(JSON.stringify({ ok: false, reason: String(e) }, null, 2));
    } finally {
      setLoadingPlan(false);
    }
  }

  // ------- effects -------
  // when instrument code changes: sync instrument object, clear old data, refetch news
  useEffect(() => {
    const i = findInstrument(instCode);
    setInst(i);
    // wipe old outputs so EURUSD plan doesn't linger when switching
    setHeadlines([]);
    setPlanText("");
    // fetch fresh headlines for the new instrument
    fetchHeadlines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instCode]);

  // ------- UI -------
  return (
    <div className="p-3 space-y-3">
      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Instrument dropdown (left) */}
        <div className="flex items-center gap-2">
          <label className="opacity-70 text-sm">Instrument</label>
          <select
            className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1"
            value={inst?.code || instCode}
            onChange={(e) => setInstCode(e.target.value)}
          >
            {INSTRUMENTS.map((it) => (
              <option key={it.code} value={it.code}>
                {it.label} ({it.code})
              </option>
            ))}
          </select>

          {/* code mirror (kept for parity with your base) */}
          <input
            value={instCode}
            onChange={(e) => setInstCode(e.target.value.toUpperCase())}
            className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 w-32"
          />
        </div>

        {/* Date (kept from base) */}
        <input
          type="date"
          value={dateStr}
          onChange={(e) => setDateStr(e.target.value)}
          className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1"
        />

        {/* Buttons (exactly the ones you asked to keep) */}
        <div className="flex items-center gap-2 ml-auto">
          <button
            className="px-3 py-1 rounded bg-neutral-700 hover:bg-neutral-600"
            onClick={resetAll}
          >
            Reset
          </button>
          <button
            className="px-3 py-1 rounded bg-sky-700 hover:bg-sky-600"
            onClick={fetchPlan}
            disabled={loadingPlan}
          >
            {loadingPlan ? "Generating…" : "Generate Plan"}
          </button>
          <button
            className="px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600"
            onClick={() => fetch("/api/openai-ping?cmd=start").catch(() => {})}
          >
            Start monitoring
          </button>
          <button
            className="px-3 py-1 rounded bg-rose-700 hover:bg-rose-600"
            onClick={() => fetch("/api/openai-ping?cmd=stop").catch(() => {})}
          >
            Stop monitoring
          </button>
        </div>
      </div>

      {/* Charts row */}
      <TradingViewTriple symbol={instCode} />

      {/* Two-column content: news+calendar (left) | trade card (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT: Calendar + Headlines */}
        <div className="lg:col-span-2 space-y-4">
          <section>
            <h2 className="text-sm font-semibold mb-2">Calendar Snapshot</h2>
            {/* Your existing calendar panel; shows “no items” when empty */}
            <CalendarPanel date={dateStr} instrument={instCode} />
          </section>

          <section>
            <h2 className="text-sm font-semibold mb-2">
              Macro Headlines (24–48h)
            </h2>
            <div className="text-xs opacity-70 mb-2">
              {loadingNews ? "Loading headlines…" : null}
            </div>
            <HeadlinesPanel items={headlines} />
          </section>
        </div>

        {/* RIGHT: Trade Card */}
        <div className="lg:col-span-1">
            <h2 className="text-sm font-semibold mb-2">Generated Trade Card</h2>
            <pre className="text-xs bg-neutral-900 border border-neutral-700 rounded p-3 whitespace-pre-wrap">
              {planText || "—"}
            </pre>
        </div>
      </div>
    </div>
  );
}
