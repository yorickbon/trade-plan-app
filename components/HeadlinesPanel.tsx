"use client";

import React from "react";

export type Headline = {
  title?: string;
  url?: string;
  source?: string;
  published_at?: string;
  sentiment?: { score?: number; label?: string } | string;
};

function isStr(v: any): v is string {
  return typeof v === "string";
}

function fmtWhen(s?: string) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function HeadlinesPanel({
  items,
  compact = false,
}: {
  items: any;
  /** When true, render smaller typography for list items */
  compact?: boolean;
}) {
  const list: Headline[] = Array.isArray(items) ? items : [];

  if (!list.length) {
    return (
      <div className={compact ? "text-xs opacity-70" : "text-sm opacity-70"}>
        No notable headlines.
      </div>
    );
  }

  const liClass = compact ? "text-xs" : "text-sm";
  const linkClass = "text-sky-300 hover:underline";

  return (
    <ul className="space-y-1">
      {list.slice(0, 24).map((h, i) => {
        const title = isStr(h?.title) ? h!.title : "(untitled)";
        const url = isStr(h?.url) ? h!.url : undefined;
        const src = isStr((h as any)?.source) ? (h as any).source : "";
        const when = isStr((h as any)?.published_at) ? (h as any).published_at : "";
        let sent = "";
        if (isStr(h?.sentiment)) sent = h!.sentiment as string;
        else if (h?.sentiment && typeof h.sentiment === "object") {
          sent = isStr((h.sentiment as any).label) ? (h.sentiment as any).label : "";
        }

        return (
          <li key={`${i}-${title.slice(0, 40)}`} className={liClass}>
            {url ? (
              <a href={url} target="_blank" rel="noreferrer" className={linkClass}>
                {title}
              </a>
            ) : (
              <span>{title}</span>
            )}
            <span className="opacity-60 ml-2">
              {src && `— ${src}`} {when && `— ${fmtWhen(when)}`} {sent && `— ${sent}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
