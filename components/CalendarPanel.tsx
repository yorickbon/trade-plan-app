// components/CalendarPanel.tsx
import React from "react";

export type CalendarItem = {
  date: string;       // 'YYYY-MM-DD'
  time?: string;      // 'HH:mm' or ''
  country: string;    // e.g. 'United States'
  currency: string;   // e.g. 'USD'
  impact?: string;    // e.g. 'High' | 'Medium' | 'Low' | ''
  title: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};

export default function CalendarPanel({
  items,
  loading,
}: {
  items: CalendarItem[];
  loading: boolean;
}) {
  if (loading) {
    return <div className="text-sm text-gray-400">Loading calendar…</div>;
  }
  if (!items || items.length === 0) {
    return (
      <div className="text-sm text-gray-300">
        No items found (server filters by selected currencies and date).
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {items.map((it, idx) => (
        <div
          key={`${it.date}-${it.time}-${idx}`}
          className="text-sm border border-neutral-800 rounded p-2"
        >
          <div className="font-semibold">
            {it.date} {it.time ? `• ${it.time}` : ""} • {it.country} ({it.currency})
          </div>
          <div>{it.title}</div>
          <div className="text-xs text-gray-400">
            Impact: {it.impact || "-"} | Actual: {it.actual || "-"} | Forecast:{" "}
            {it.forecast || "-"} | Previous: {it.previous || "-"}
          </div>
        </div>
      ))}
    </div>
  );
}
