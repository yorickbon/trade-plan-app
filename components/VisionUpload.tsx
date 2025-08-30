// components/VisionUpload.tsx
"use client";

import React, { useState } from "react";

type Props = {
  instrument: string;
  onResult: (text: string) => void;
  onBusyChange?: (busy: boolean) => void;
};

export default function VisionUpload({ instrument, onResult, onBusyChange }: Props) {
  const [m15, setM15] = useState<File | null>(null);
  const [h1, setH1] = useState<File | null>(null);
  const [h4, setH4] = useState<File | null>(null);
  const [calendar, setCalendar] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = !!m15 && !!h1 && !!h4;

  async function submit() {
    try {
      setError(null);
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
        setError(j?.reason || "Failed to generate from images.");
        onResult(j?.reason || "Failed to generate from images.");
        return;
      }
      onResult(j.text || "");
    } catch (e: any) {
      setError(e?.message || "Upload failed.");
      onResult(e?.message || "Upload failed.");
    } finally {
      onBusyChange?.(false);
    }
  }

  function fileHint(f: File | null) {
    return f ? `${f.name} (${Math.round(f.size / 1024)} KB)` : "Choose file…";
    }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs opacity-75">15m (execution)</label>
          <input type="file" accept="image/*" onChange={(e) => setM15(e.target.files?.[0] || null)} />
          <div className="text-[11px] opacity-60">{fileHint(m15)}</div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs opacity-75">1h (context)</label>
          <input type="file" accept="image/*" onChange={(e) => setH1(e.target.files?.[0] || null)} />
          <div className="text-[11px] opacity-60">{fileHint(h1)}</div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs opacity-75">4h (context)</label>
          <input type="file" accept="image/*" onChange={(e) => setH4(e.target.files?.[0] || null)} />
          <div className="text-[11px] opacity-60">{fileHint(h4)}</div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs opacity-75">Calendar (optional)</label>
          <input type="file" accept="image/*" onChange={(e) => setCalendar(e.target.files?.[0] || null)} />
          <div className="text-[11px] opacity-60">{fileHint(calendar)}</div>
        </div>
      </div>

      {error && <div className="text-sm text-rose-400">{error}</div>}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={submit}
          disabled={!ready}
          className="px-3 py-1 text-sm rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50"
        >
          Generate from Images
        </button>
        <span className="text-xs opacity-70">
          Required: 15m + 1h + 4h. Calendar is optional.
        </span>
      </div>
    </div>
  );
}
