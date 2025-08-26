// components/HeadlinesPanel.tsx
"use client";
type Headline = { title: string; source: string; publishedAt: string; url?: string };

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
    </div>
  );
}
