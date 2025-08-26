// components/CalendarPanel.tsx
import React from "react";

export type CalendarItem = {
  date: string;                 // ISO or human readable
  time?: string;
  country?: string;             // ← panel expects this
  impact?: "Low" | "Medium" | "High";
  title: string;
};

export default function CalendarPanel({
  items,
  loading = false,
}: {
  items: CalendarItem[];
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="text-sm text-gray-300 italic">Loading calendar…</div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div className="text-sm text-gray-300">
        No items found (server filters by selected currencies and date).
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((it, idx) => (
        <li
          key={idx}
          className="text-sm rounded border border-neutral-800 p-2 bg-neutral-900"
        >
          <div className="font-medium">{it.title}</div>
          <div className="text-gray-400">
            {it.date}
            {it.time ? ` • ${it.time}` : ""} {it.country ? `• ${it.country}` : ""}
            {it.impact ? ` • Impact: ${it.impact}` : ""}
          </div>
        </li>
      ))}
    </ul>
  );
}
