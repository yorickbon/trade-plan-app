// components/VisionUpload.tsx
"use client";

import React, { useEffect, useRef, useState } from "react";

type Props = {
  instrument: string;
  onResult: (text: string) => void;
  onBusyChange?: (busy: boolean) => void;
  resetSignal?: number; // increments when parent wants a hard reset
};

export default function VisionUpload({ instrument, onResult, onBusyChange, resetSignal = 0 }: Props) {
  const [m15, setM15] = useState<File | null>(null);
  const [h1, setH1] = useState<File | null>(null);
  const [h4, setH4] = useState<File | null>(null);
  const [calendar, setCalendar] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // refs to clear native inputs (lets users re-upload the *same* file again)
  const refM15 = useRef<HTMLInputElement>(null);
  const refH1 = useRef<HTMLInputElement>(null);
  const refH4 = useRef<HTMLInputElement>(null);
  const refCal = useRef<HTMLInputElement>(null);

  const ready = !!m15 && !!h1 && !!h4;

  function clearAll() {
    setM15(null);
    setH1(null);
    setH4(null);
    setCalendar(null);
    setError(null);
    if (refM15.current) refM15.current.value = "";
    if (refH1.current) refH1.current.value = "";
    if (refH4.current) refH4.current.value = "";
    if (refCal.current) refCal.current.value = "";
  }

  // hard reset when instrument changes or when parent bumps resetSignal
  useEffect(() => {
    clearAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument, resetSignal]);

  async function submit() {
    try {
      setError(null);
      setBusy(true);
      onBusyChange?.(true);

      const fd = new FormData();
      fd.append("instrument", instrument);
      fd.append("m15", m15 as File);
      fd.append("h1", h1 as File);
      fd.append("h4", h4 as File);
      if (calendar) fd.append("calendar", calendar);

      const rsp = await fetch("/api/vision-plan", { method: "POST", body: fd });
      const j = await rsp.json();

      if (!j?.ok) {
        const msg = j?.reason || "Failed to generate from images.";
        setError(msg);
        onResult(msg);
        return;
      }
      onResult(j.text || "");

      // optional: keep selections so user can tweak just one image and re-run
      // If you prefer to clear after each generation, uncomment the next line:
      // clearAll();
    } catch (e: any) {
      const msg = e?.message || "Upload failed.";
      setError(msg);
      onResult(msg);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  function fileHint(f: File | null) {
    return f ? `${f.name} (${Math.round(f.size / 1024)} KB)` : "Choose file…";
  }

  // For re-uploading the *same* file path, clear input on click so onChange fires
  function clickableClearOnOpen(e: React.MouseEvent<HTMLInputElement>) {
    (e.currentTarget as HTMLInputElement).value = "";
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs opacity-75">15m (execution)</label>
          <input
            ref={refM15}
            type="file"
            accept="image/*"
            disabled={busy}
            onClick={clickableClearOnOpen}
            onChange={(e) => setM15(e.target.files?.[0] || null)}
          />
          <div className="text-[11px] opacity-60">{fileHint(m15)}</div>
          {m15 && (
            <button
              type="button"
              onClick={() => {
                setM15(null);
                if (refM15.current) refM15.current.value = "";
              }}
              className="self-start text-[11px] mt-1 px-2 py-0.5 rounded border border-neutral-700 hover:bg-neutral-800"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs opacity-75">1h (context)</label>
          <input
            ref={refH1}
            type="file"
            accept="image/*"
            disabled={busy}
            onClick={clickableClearOnOpen}
            onChange={(e) => setH1(e.target.files?.[0] || null)}
          />
          <div className="text-[11px] opacity-60">{fileHint(h1)}</div>
          {h1 && (
            <button
              type="button"
              onClick={() => {
                setH1(null);
                if (refH1.current) refH1.current.value = "";
              }}
              className="self-start text-[11px] mt-1 px-2 py-0.5 rounded border border-neutral-700 hover:bg-neutral-800"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs opacity-75">4h (context)</label>
          <input
            ref={refH4}
            type="file"
            accept="image/*"
            disabled={busy}
            onClick={clickableClearOnOpen}
            onChange={(e) => setH4(e.target.files?.[0] || null)}
          />
          <div className="text-[11px] opacity-60">{fileHint(h4)}</div>
          {h4 && (
            <button
              type="button"
              onClick={() => {
                setH4(null);
                if (refH4.current) refH4.current.value = "";
              }}
              className="self-start text-[11px] mt-1 px-2 py-0.5 rounded border border-neutral-700 hover:bg-neutral-800"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs opacity-75">Calendar (optional)</label>
          <input
            ref={refCal}
            type="file"
            accept="image/*"
            disabled={busy}
            onClick={clickableClearOnOpen}
            onChange={(e) => setCalendar(e.target.files?.[0] || null)}
          />
          <div className="text-[11px] opacity-60">{fileHint(calendar)}</div>
          {calendar && (
            <button
              type="button"
              onClick={() => {
                setCalendar(null);
                if (refCal.current) refCal.current.value = "";
              }}
              className="self-start text-[11px] mt-1 px-2 py-0.5 rounded border border-neutral-700 hover:bg-neutral-800"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {error && <div className="text-sm text-rose-400">{error}</div>}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={submit}
          disabled={!ready || busy}
          className="px-3 py-1 text-sm rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50"
        >
          {busy ? "Generating…" : "Generate from Images"}
        </button>

        <button
          type="button"
          onClick={clearAll}
          disabled={busy}
          className="px-3 py-1 text-sm rounded border border-neutral-700 hover:bg-neutral-800"
        >
          Clear All
        </button>

        <span className="text-xs opacity-70">
          Required: 15m + 1h + 4h. Calendar is optional.
        </span>
      </div>
    </div>
  );
}
