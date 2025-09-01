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
  // File states (existing)
  const [m15, setM15] = useState<File | null>(null);
  const [h1, setH1] = useState<File | null>(null);
  const [h4, setH4] = useState<File | null>(null);
  const [calendar, setCalendar] = useState<File | null>(null);

  // NEW — TradingView image links (optional; if present, skip file for that TF)
  const [m15Url, setM15Url] = useState<string>("");
  const [h1Url, setH1Url] = useState<string>("");
  const [h4Url, setH4Url] = useState<string>("");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // refs to clear native inputs (lets users re-upload the *same* file again)
  const refM15 = useRef<HTMLInputElement>(null);
  const refH1 = useRef<HTMLInputElement>(null);
  const refH4 = useRef<HTMLInputElement>(null);
  const refCal = useRef<HTMLInputElement>(null);

  // Ready if each TF has either a file OR a URL
  const ready =
    (!!m15 || !!m15Url.trim()) &&
    (!!h1 || !!h1Url.trim()) &&
    (!!h4 || !!h4Url.trim());

  function clearAll() {
    setM15(null);
    setH1(null);
    setH4(null);
    setCalendar(null);
    setM15Url("");
    setH1Url("");
    setH4Url("");
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

      // Files (only append if present)
      if (m15) fd.append("m15", m15);
      if (h1) fd.append("h1", h1);
      if (h4) fd.append("h4", h4);
      if (calendar) fd.append("calendar", calendar);

      // URLs (only append if present)
      const u15 = m15Url.trim();
      const uH1 = h1Url.trim();
      const uH4 = h4Url.trim();
      if (u15) fd.append("m15Url", u15);
      if (uH1) fd.append("h1Url", uH1);
      if (uH4) fd.append("h4Url", uH4);

      const rsp = await fetch("/api/vision-plan", { method: "POST", body: fd });
      const j = await rsp.json();

      if (!j?.ok) {
        const msg = j?.reason || "Failed to generate from images.";
        setError(msg);
        onResult(msg);
        return;
      }
      onResult(j.text || "");

      // Keep selections so user can tweak just one image and re-run.
      // If you prefer to clear after each generation, uncomment:
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

  const InputSection: React.FC<{
    label: string;
    fileRef: React.RefObject<HTMLInputElement>;
    fileState: File | null;
    setFile: (f: File | null) => void;
    urlState: string;
    setUrl: (s: string) => void;
    disabled?: boolean;
  }> = ({ label, fileRef, fileState, setFile, urlState, setUrl, disabled }) => {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs opacity-75">{label}</label>

        {/* File select */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          disabled={!!disabled}
          onClick={clickableClearOnOpen}
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        <div className="text-[11px] opacity-60">{fileHint(fileState)}</div>

        {/* Optional clear file */}
        {fileState && (
          <button
            type="button"
            onClick={() => {
              setFile(null);
              if (fileRef.current) fileRef.current.value = "";
            }}
            className="self-start text-[11px] mt-1 px-2 py-0.5 rounded border border-neutral-700 hover:bg-neutral-800"
          >
            Clear file
          </button>
        )}

        {/* OR paste TradingView link */}
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] opacity-60">or TV link</span>
          <input
            type="url"
            placeholder="https://www.tradingview.com/x/abc123/"
            value={urlState}
            onChange={(e) => setUrl(e.target.value)}
            disabled={!!disabled}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[12px] outline-none focus:border-neutral-500"
          />
          {urlState && (
            <button
              type="button"
              onClick={() => setUrl("")}
              className="text-[11px] px-2 py-0.5 rounded border border-neutral-700 hover:bg-neutral-800"
            >
              Clear link
            </button>
          )}
        </div>
        <div className="text-[10px] opacity-60">
          Paste TradingView “Copy link to image”. If a link is given, the file is optional.
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <InputSection
          label="15m (execution)"
          fileRef={refM15}
          fileState={m15}
          setFile={setM15}
          urlState={m15Url}
          setUrl={setM15Url}
          disabled={busy}
        />

        <InputSection
          label="1h (context)"
          fileRef={refH1}
          fileState={h1}
          setFile={setH1}
          urlState={h1Url}
          setUrl={setH1Url}
          disabled={busy}
        />

        <InputSection
          label="4h (HTF)"
          fileRef={refH4}
          fileState={h4}
          setFile={setH4}
          urlState={h4Url}
          setUrl={setH4Url}
          disabled={busy}
        />

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
          <div className="text-[10px] opacity-60 mt-1">
            Keep calendar as image for now.
          </div>
        </div>
      </div>

      {error && <div className="text-sm text-rose-400">{error}</div>}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={submit}
          disabled={!ready || busy}
          className="px-3 py-1 text-sm rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50"
        >
          {busy ? "Generating…" : "Generate from Images/Links"}
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
          Required: 15m + 1h + 4h — either files or TV links. Calendar is optional.
        </span>
      </div>
    </div>
  );
}
