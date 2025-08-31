"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";

import CalendarPanel from "../components/CalendarPanel";
import HeadlinesPanel from "../components/HeadlinesPanel";
import ChatDock from "../components/ChatDock";
import VisionUpload from "../components/VisionUpload";

const TradingViewTriple = dynamic(() => import("../components/TradingViewTriple"), {
  ssr: false,
  loading: () => (
    <div className="rounded-lg border border-neutral-800 p-4">
      <div className="text-sm opacity-75">Loading charts…</div>
    </div>
  ),
});

type CalendarBias = {
  perCurrency: Record<string, { score: number; label: string; count: number; evidence: any[] }>;
  instrument?: { pair: string; score: number; label: string };
};

type CalendarResp =
  | { ok: true; provider?: string; date?: string; count: number; items: any[]; bias: CalendarBias }
  | { ok: false; reason: string };

type NewsResp = { ok: true; items: any[]; count?: number; provider?: string } | { ok: false; reason: string };

const todayISO = () => new Date().toISOString().slice(0, 10);
const currenciesFromBias = (bias?: CalendarBias) => (bias ? Object.keys(bias.perCurrency || {}) : []);

function baseQuoteFromInstrument(instr: string): [string, string] {
  const s = (instr || "").toUpperCase().replace("/", "");
  if (s.length >= 6) return [s.slice(0, 3), s.slice(-3)];
  if (s.endsWith("USD")) return [s.replace("USD", ""), "USD"];
  return [s, "USD"];
}

function normalizePlanText(v: any): string {
  if (!v) return "";
  if (typeof v === "string") return v.replace(/\\n/g, "\n");
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export default function Page() {
  const [instrument, setInstrument] = useState<string>("EURUSD");
  const [dateStr, setDateStr] = useState<string>(todayISO());

  const [calendar, setCalendar] = useState<CalendarResp | null>(null);
  const [loadingCal, setLoadingCal] = useState<boolean>(false);

  const [headlines, setHeadlines] = useState<any[]>([]);
  const [loadingNews, setLoadingNews] = useState<boolean>(false);

  const [planText, setPlanText] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const [enlargedCard, setEnlargedCard] = useState<boolean>(false);
  const [resetTick, setResetTick] = useState<number>(0);

  // headlines request coordination
  const headlinesSeqRef = useRef(0);
  const headlinesAbortRef = useRef<AbortController | null>(null);

  // -------- headlines loader with cache-buster + last-request-wins --------
  const loadHeadlinesForSymbols = useCallback(async (symbols: string[]) => {
    setHeadlines([]); // clear immediately so old list doesn’t linger
    if (!symbols.length) return;

    // cancel any in-flight
    if (headlinesAbortRef.current) {
      try {
        headlinesAbortRef.current.abort();
      } catch {}
    }

    const controller = new AbortController();
    headlinesAbortRef.current = controller;
    const reqId = ++headlinesSeqRef.current;

    setLoadingNews(true);
    try {
      const cacheBuster = `_t=${reqId}`; // defeats any edge/browser cache
      const url = `/api/news?symbols=${encodeURIComponent(symbols.join(","))}&${cacheBuster}`;
      const nr = await fetch(url, { cache: "no-store", signal: controller.signal });
      const nj: NewsResp = await nr.json();

      if (reqId === headlinesSeqRef.current) {
        setHeadlines(nj?.ok ? nj.items || [] : []);
      }
    } catch {
      if (reqId === headlinesSeqRef.current) setHeadlines([]);
    } finally {
      if (reqId === headlinesSeqRef.current) setLoadingNews(false);
    }
  }, []);

  // ----- calendar loader -----
  const loadCalendar = useCallback(async () => {
    setLoadingCal(true);
    try {
      const u = `/api/calendar?date=${dateStr}&instrument=${instrument}&windowHours=48`;
      const r = await fetch(u, { cache: "no-store" });
      const j: CalendarResp = await r.json();
      setCalendar(j);

      if (j?.ok) {
        const ccy = currenciesFromBias(j.bias);
        if (ccy.length) {
          await loadHeadlinesForSymbols(ccy);
        } else {
          const [base, quote] = baseQuoteFromInstrument(instrument);
          await loadHeadlinesForSymbols([base, quote]);
        }
      } else {
        const [base, quote] = baseQuoteFromInstrument(instrument);
        await loadHeadlinesForSymbols([base, quote]);
      }
    } catch {
      setCalendar({ ok: false, reason: "Calendar request failed" });
      const [base, quote] = baseQuoteFromInstrument(instrument);
      await loadHeadlinesForSymbols([base, quote]);
    } finally {
      setLoadingCal(false);
    }
  }, [dateStr, instrument, loadHeadlinesForSymbols]);

  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);

  const resetAll = useCallback(() => {
    setPlanText("");
    setHeadlines([]);
    setCalendar(null);
    setDateStr(todayISO());
    setEnlargedCard(false);
    if (headlinesAbortRef.current) {
      try {
        headlinesAbortRef.current.abort();
      } catch {}
    }
    setResetTick((t) => t + 1);
    setTimeout(() => loadCalendar(), 0);
  }, [loadCalendar]);

  const onInstrumentChange = useCallback(
    (next: string) => {
      setInstrument(next.toUpperCase());
      setPlanText("");
      setEnlargedCard(false);

      if (headlinesAbortRef.current) {
        try {
          headlinesAbortRef.current.abort();
        } catch {}
      }
      setHeadlines([]);

      setResetTick((t) => t + 1);
      setTimeout(() => loadCalendar(), 0);
    },
    [loadCalendar]
  );

  useEffect(() => {
    if (!enlargedCard) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEnlargedCard(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [enlargedCard]);

  const calendarCurrencies = useMemo(() => currenciesFromBias((calendar as any)?.bias), [calendar]);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4 space-y-4">
      {/* controls, charts, uploader — unchanged from your current working version */}
      {/* ... */}
      {/* (Omitted here only to keep this answer focused; keep the rest of your file exactly as we last shipped) */}

      {/* Headlines panel (unchanged UI) */}
      <div className="rounded-lg border border-neutral-800 p-4">
        <h2 className="text-lg font-semibold mb-2">Macro Headlines (24–48h)</h2>
        <div style={{ fontSize: "12px", lineHeight: "1.3" }}>
          <HeadlinesPanel items={Array.isArray(headlines) ? headlines : []} />
        </div>
        <div className="text-[11px] mt-2 opacity-60">
          {loadingNews
            ? "Loading headlines…"
            : headlines.length
            ? `${headlines.length} headlines found`
            : calendarCurrencies.length
            ? "No notable headlines."
            : "Fetched by instrument (calendar empty)."}
        </div>
      </div>

      {/* keep the rest of page.tsx as we already finalized (fullscreen reader, etc.) */}
    </div>
  );
}
