"use client";

import React from "react";

type CalendarItem = {
  date: string;
  time: string;
  country: string;
  currency: string;
  impact: string;
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
  return (
    <div className="p-4 border rounded bg-neutral-900 border-neutral-800">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-bold">Calendar Snapshot</h2>
        {loading && <span className="text-sm text-gray-400">Loading…</span>}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-gray-400">
          No items found (server filters by selected currencies and date).
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-gray-400">
              <tr>
                <th className="py-1 pr-3">Time</th>
                <th className="py-1 pr-3">Country</th>
                <th className="py-1 pr-3">Currency</th>
                <th className="py-1 pr-3">Impact</th>
                <th className="py-1 pr-3">Event</th>
                <th className="py-1 pr-3">Actual</th>
                <th className="py-1 pr-3">Forecast</th>
                <th className="py-1 pr-3">Previous</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={idx} className="border-t border-neutral-800">
                  <td className="py-1 pr-3">{it.time || "—"}</td>
                  <td className="py-1 pr-3">{it.country}</td>
                  <td className="py-1 pr-3">{it.currency}</td>
                  <td className="py-1 pr-3">{it.impact}</td>
                  <td className="py-1 pr-3">{it.title}</td>
                  <td className="py-1 pr-3">{it.actual ?? "—"}</td>
                  <td className="py-1 pr-3">{it.forecast ?? "—"}</td>
                  <td className="py-1 pr-3">{it.previous ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
