// /components/HeadlinesPanel.tsx
"use client";
import React, { useMemo } from "react";

type Headline = {
  title: string;
  url: string;
  published_at?: string;
  source?: string;
  language?: string;
};

export default function HeadlinesPanel({ items }: { items: Headline[] }) {
  const MAX = 8; // trim for readability
  const head = useMemo(() => (Array.isArray(items) ? items.slice(0, MAX) : []), [items]);

  const fmt = (iso?: string) => {
    try {
      if (!iso) return "today";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "today";
      return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch { return "today"; }
  };

  if (!head.length) return <div className="text-sm opacity-70">No headlines found in the selected lookback window.</div>;

  return (
    <div className="space-y-2">
      {head.map((h, i) => (
        <div key={i} className="text-sm leading-snug">
          <a href={h.url} target="_blank" rel="noreferrer" className="underline hover:no-underline">
            {h.title}
          </a>
          <div className="opacity-60">
            {h.source || "News"} • {fmt(h.published_at)}
          </div>
          {i < head.length - 1 && <div className="border-b border-white/10 my-2" />}
        </div>
      ))}
      {Array.isArray(items) && items.length > MAX && (
        <div className="text-xs opacity-70">Showing {MAX} of {items.length}. Check News tab for more.</div>
      )}
    </div>
  );
}
