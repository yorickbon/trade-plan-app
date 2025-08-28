// /components/HeadlinesPanel.tsx
import React from "react";

export type Headline = {
  title: string;
  url: string;
  source?: string;
  // your base uses `seen`; our API may return `published_at`.
  seen?: string;            // ISO timestamp
  published_at?: string;    // ISO timestamp (optional)
};

type Props = {
  items: Headline[];
  loading?: boolean;
  max?: number;             // default 12; set lower in caller if you want
};

function fmtWhen(h: Headline): string {
  const iso = h.seen || h.published_at;
  if (!iso) return "today";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "today";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function HeadlinesPanel({ items, loading, max = 12 }: Props) {
  if (loading) {
    return <div className="text-sm text-gray-400">Loading headlines…</div>;
  }

  const list = Array.isArray(items) ? items.slice(0, max) : [];

  if (list.length === 0) {
    return (
      <div className="text-sm text-gray-300">
        No notable headlines in the selected lookback window. We’ll still trade off technicals; conviction may be slightly reduced.
      </div>
    );
  }

  return (
    <div className="space-y-2 text-sm leading-snug">
      <div className="text-gray-400">
        {list.length} headline{list.length > 1 ? "s" : ""} found
      </div>

      {list.map((h, i) => (
        <div key={i} className="pb-2 border-b border-neutral-800">
          <a
            href={h.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium hover:underline"
          >
            {h.title}
          </a>
          <div className="text-xs text-gray-400">
            {h.source || "News"} · {fmtWhen(h)}
          </div>
        </div>
      ))}

      {Array.isArray(items) && items.length > max && (
        <div className="text-xs text-gray-400">
          Showing {max} of {items.length}. Check News tab for more.
        </div>
      )}
    </div>
  );
}
