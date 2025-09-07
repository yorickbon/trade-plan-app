// components/VisionUpload.tsx
"use client";

import React, { useEffect, useRef, useState } from "react";

type Props = {
  instrument: string;
  onResult: (text: string) => void;
  onBusyChange?: (busy: boolean) => void;
  resetSignal?: number; // increments when parent wants a hard reset
};

type ApiMeta = {
  cacheKey?: string;
  mode?: "fast" | "full" | "expand";
  sources?: any;
};

export default function VisionUpload({
  instrument,
  onResult,
  onBusyChange,
  resetSignal = 0,
}: Props) {
  // File states
  const [m15, setM15] = useState<File | null>(null);
  const [h1, setH1] = useState<File | null>(null);
  const [h4, setH4] = useState<File | null>(null);
  const [calendar, setCalendar] = useState<File | null>(null);

  // URL states
  const [m15Url, setM15Url] = useState("");
  const [h1Url, setH1Url] = useState("");
  const [h4Url, setH4Url] = useState("");

  // Mode & flow
  const [mode, setMode] = useState<"fast" | "full">("fast");
  const [model, setModel] = useState<"gpt-4o" | "gpt-5">("gpt-4o"); // NEW toggle
  const [cacheKey, setCacheKey] = useState<string | null>(null);
  const [stage1Text, setStage1Text] = useState<string>("");

  // UI
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bundledHeadlines, setBundledHeadlines] = useState<number>(0);

  // Refs
  const refM15 = useRef<HTMLInputElement>(null);
  const refH1 = useRef<HTMLInputElement>(null);
  const refH4 = useRef<HTMLInputElement>(null);
  const refCal = useRef<HTMLInputElement>(null);

  function setBusyState(b: boolean) {
    setBusy(b);
    onBusyChange?.(b);
  }

  function clearAll() {
    setM15(null);
    setH1(null);
    setH4(null);
    setCalendar(null);
    setM15Url("");
    setH1Url("");
    setH4Url("");
    setCacheKey(null);
    setStage1Text("");
    setError(null);
    setBundledHeadlines(0);
    if (refM15.current) refM15.current.value = "";
    if (refH1.current) refH1.current.value = "";
    if (refH4.current) refH4.current.value = "";
    if (refCal.current) refCal.current.value = "";
  }

  useEffect(() => {
    clearAll();
  }, [instrument, resetSignal]);

  async function fetchHeadlinesForInstrument(code: string) {
    try {
      const url = `/api/news?instrument=${encodeURIComponent(
        code
      )}&hours=48&max=12&_t=${Date.now()}`;
      const r = await fetch(url, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      const items: any[] = Array.isArray(j?.items) ? j.items : [];
      return items.slice(0, 12);
    } catch {
      return [];
    }
  }

  async function handleGenerate() {
    try {
      setError(null);
      setBusyState(true);

      const fd = new FormData();
      fd.append("instrument", instrument);
      fd.append("model", model); // <-- send model to backend
      if (mode === "fast") fd.append("mode", "fast");

      if (m15) fd.append("m15", m15);
      if (h1) fd.append("h1", h1);
      if (h4) fd.append("h4", h4);
      if (calendar) fd.append("calendar", calendar);

      if (m15Url) fd.append("m15Url", m15Url.trim());
      if (h1Url) fd.append("h1Url", h1Url.trim());
      if (h4Url) fd.append("h4Url", h4Url.trim());

      const headlines = await fetchHeadlinesForInstrument(instrument);
      if (headlines.length) {
        fd.append("headlinesJson", JSON.stringify(headlines));
        setBundledHeadlines(headlines.length);
      } else {
        setBundledHeadlines(0);
      }

      const rsp = await fetch("/api/vision-plan", { method: "POST", body: fd });
      const j = await rsp.json();
      if (!rsp.ok || !j?.ok) throw new Error(j?.reason || "Generate failed");

      const text: string = j.text || "";
      const meta: ApiMeta = j.meta || {};

      if (mode === "fast") {
        setStage1Text(text);
        if (meta?.cacheKey) setCacheKey(meta.cacheKey);
      } else {
        setCacheKey(null);
        setStage1Text("");
      }

      onResult(text);
    } catch (e: any) {
      setError(e?.message || "Error generating plan");
    } finally {
      setBusyState(false);
    }
  }

  async function handleExpand() {
    if (!cacheKey) return;
    try {
      setError(null);
      setBusyState(true);
      const rsp = await fetch(
        `/api/vision-plan?mode=expand&cache=${encodeURIComponent(cacheKey)}`,
        { method: "POST" }
      );
      const j = await rsp.json();
      if (!rsp.ok || !j?.ok) throw new Error(j?.reason || "Expand failed");
      const stage2 = j.text || "";
      const combined = stage1Text ? `${stage1Text}\n\n${stage2}` : stage2;
      onResult(combined);
    } catch (e: any) {
      setError(e?.message || "Error expanding card");
    } finally {
      setBusyState(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Mode selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">Mode:</label>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="radio"
            name="mode"
            value="fast"
            checked={mode === "fast"}
            onChange={() => setMode("fast")}
            disabled={busy}
          />
          Fast (Stage-1)
        </label>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="radio"
            name="mode"
            value="full"
            checked={mode === "full"}
            onChange={() => setMode("full")}
            disabled={busy}
          />
          Full (one shot)
        </label>
      </div>

      {/* Model selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">Model:</label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value as "gpt-4o" | "gpt-5")}
          disabled={busy}
          className="px-2 py-1 rounded bg-neutral-900 border border-neutral-700 text-sm"
        >
          <option value="gpt-4o">GPT-4o (default, faster)</option>
          <option value="gpt-5">GPT-5 (deeper, slower)</option>
        </select>
      </div>

      {/* URLs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <input
          className="px-2 py-1 rounded bg-neutral-900 border border-neutral-700"
          placeholder="15m image URL"
          value={m15Url}
          onChange={(e) => setM15Url(e.target.value)}
          disabled={busy}
        />
        <input
          className="px-2 py-1 rounded bg-neutral-900 border border-neutral-700"
          placeholder="1H image URL"
          value={h1Url}
          onChange={(e) => setH1Url(e.target.value)}
          disabled={busy}
        />
        <input
          className="px-2 py-1 rounded bg-neutral-900 border border-neutral-700"
          placeholder="4H image URL"
          value={h4Url}
          onChange={(e) => setH4Url(e.target.value)}
          disabled={busy}
        />
      </div>

      {/* Files */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <input
          type="file"
          ref={refM15}
          accept="image/*"
          onChange={(e) => setM15(e.target.files?.[0] || null)}
          disabled={busy}
        />
        <input
          type="file"
          ref={refH1}
          accept="image/*"
          onChange={(e) => setH1(e.target.files?.[0] || null)}
          disabled={busy}
        />
        <input
          type="file"
          ref={refH4}
          accept="image/*"
          onChange={(e) => setH4(e.target.files?.[0] || null)}
          disabled={busy}
        />
      </div>

      {/* Calendar */}
      <div>
        <input
          type="file"
          ref={refCal}
          accept="image/*"
          onChange={(e) => setCalendar(e.target.files?.[0] || null)}
          disabled={busy}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleGenerate}
          disabled={busy}
          className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-60"
        >
          {mode === "fast" ? "Generate (Stage-1)" : "Generate Full"}
        </button>
        <button
          onClick={handleExpand}
          disabled={busy || !cacheKey}
          className="px-3 py-1 rounded border border-neutral-700 hover:bg-neutral-800 disabled:opacity-50"
        >
          Expand Full Breakdown
        </button>
        <button
          onClick={clearAll}
          disabled={busy}
          className="px-3 py-1 text-sm rounded border border-neutral-700 hover:bg-neutral-800"
        >
          Clear All
        </button>
        {cacheKey && (
          <span className="text-xs opacity-70">
            cache: {cacheKey.slice(0, 10)}…
          </span>
        )}
      </div>

      {/* Inline helpers */}
      {bundledHeadlines > 0 && (
        <div className="text-xs text-emerald-400">
          Headlines bundled: {bundledHeadlines}
        </div>
      )}
      {error && (
        <div className="text-sm text-red-400 whitespace-pre-wrap border border-red-800/60 bg-red-900/10 rounded p-2">
          {error}
        </div>
      )}
      <div className="text-xs opacity-70">
        Required: 15m + 1h + 4h — either files or URLs. Calendar optional.
      </div>
    </div>
  );
}
