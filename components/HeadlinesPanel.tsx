// /components/HeadlinesPanel.tsx
import React from "react";

export interface Headline {
  title: string;
  url: string;
  source?: string;
  published_at?: string;
  sentiment?: { score: number; label: string };
}

type Props = {
  items: Headline[];
  loading?: boolean;
};

export default function HeadlinesPanel({ items, loading }: Props) {
  if (loading) {
    return <div className="text-gray-400">Loading headlines…</div>;
  }

  if (!items || items.length === 0) {
    return (
      <div className="text-gray-400">
        No notable headlines in the selected window.
      </div>
    );
  }

  return (
    <ul className="space-y-2 text-sm">
      {items.map((h, i) => (
        <li key={i}>
          <a
            href={h.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline"
          >
            {h.title}
          </a>
          {h.source ? (
            <span className="text-gray-500 ml-2">— {h.source}</span>
          ) : null}
          {h.sentiment ? (
            <span className="ml-2 text-xs italic text-gray-400">
              {h.sentiment.label}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
