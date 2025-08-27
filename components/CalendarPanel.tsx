// components/CalendarPanel.tsx
import React from "react";

export type CalendarItem = {
  date: string;
  time?: string;
  country?: string;
  currency?: string;
  impact?: string; // keep flexible; server can pass any label
  title: string;
  previous?: string;
  actual?: string;
  forecast?: string;
};

export default function CalendarPanel({
  items,
  loading,
}: {
  items: CalendarItem[];
  loading?: boolean;
}) {
  if (loading) return <div className="text-sm text-gray-400">Loading calendar…</div>;
  if (!items || items.length === 0)
    return (
      <div className="text-sm">
        No items found (server filters by selected currencies and date).
      </div>
    );
  return (
    <div className="text-sm">
      {items.map((it, idx) => (
        <div key={idx} className="border-b border-neutral-800 py-2">
          <div className="font-semibold">{(it.time || "") + " " + it.title}</div>
          <div className="text-gray-400">
            {it.currency || it.country || ""} · Impact: {it.impact || "—"} · Prev:{" "}
            {it.previous || "—"} · Fcst: {it.forecast || "—"} · Actual:{" "}
            {it.actual || "—"}
          </div>
        </div>
      ))}
    </div>
  );
}
