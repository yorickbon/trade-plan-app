// key tweaks inside HeadlinesPanel.tsx

// 1) Cap the list to 6 with a collapsible "Show more"
const MAX_VISIBLE = 6;
const [expanded, setExpanded] = useState(false);
const visible = expanded ? items : items.slice(0, MAX_VISIBLE);

// 2) UI
<div className="space-y-2 max-h-[220px] overflow-y-auto pr-2">
  {visible.map((h, i) => (
    <div key={i} className="text-sm leading-5">
      <a href={h.url} target="_blank" className="underline hover:no-underline">{h.title}</a>
      <div className="text-[11px] opacity-70">
        {h.source ?? h.provider} · {new Date(h.published_at).toLocaleString()} · {h.sentiment?.label}
      </div>
    </div>
  ))}
  {items.length > MAX_VISIBLE && (
    <button className="text-xs underline mt-2" onClick={() => setExpanded(!expanded)}>
      {expanded ? "Show less" : `Show ${items.length - MAX_VISIBLE} more`}
    </button>
  )}
</div>// components/HeadlinesPanel.tsx
"use client";
type Headline = { title: string; source: string; publishedAt: string; url?: string };
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

export default function HeadlinesPanel({ items, loading }: { items: Headline[]; loading: boolean }) {
  return (
    <div className="mt-6">
      <h2 className="text-lg font-semibold mb-2">Headlines Snapshot</h2>
      {loading ? (
        <p className="text-sm text-gray-400">Loading headlines…</p>
      ) : !items.length ? (
        <p className="text-sm text-gray-400">No headlines found for the selected instrument/date.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((h, i) => (
            <li key={i} className="text-sm">
              <span className="font-medium">{h.source}</span>:{" "}
              {h.url ? (
                <a className="underline" href={h.url} target="_blank" rel="noreferrer">
                  {h.title}
                </a>
              ) : (
                h.title
              )}{" "}
              <span className="text-gray-400">({new Date(h.publishedAt).toLocaleString()})</span>
            </li>
          ))}
        </ul>
      )}
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
