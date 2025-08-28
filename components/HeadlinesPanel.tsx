// components/HeadlinesPanel.tsx
import React from "react";

export type Headline = {
  title: string;
  url: string;
  source: string;
  seen: string; // ISO timestamp
};

export default function HeadlinesPanel({
  items,
  loading,
  max = 12,
}: {
  items: Headline[];
  loading?: boolean;
  max?: number;
}) {
  if (loading) return <div className="text-sm text-gray-400">Loading headlines…</div>;

  const list = Array.isArray(items) ? items.slice(0, max) : [];

  if (list.length === 0) {
    return (
      <div className="text-sm text-gray-300">
        No notable headlines in the selected lookback window. We’ll still trade off technicals; conviction may be slightly reduced.
      </div>
    );
  }

  return (
    <div className="space-y-2 text-sm">
      <div className="text-gray-400">{list.length} headline{list.length > 1 ? "s" : ""} found</div>
      {list.map((h, i) => (
        <div key={i} className="border-b border-neutral-800 pb-2">
          <a
            href={h.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium hover:underline"
          >
            {h.title}
          </a>
          <div className="text-xs text-gray-400">
            {h.source || "—"} · {new Date(h.seen).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}
