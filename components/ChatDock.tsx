// components/ChatDock.tsx
"use client";

import { useState } from "react";

type Msg = { role: "user" | "assistant" | "system"; text: string };

export default function ChatDock({
  planText,
  headlines,
  calendar,
}: {
  planText: string;
  headlines: any[];
  calendar: any[];
}) {
  const [q, setQ] = useState("");
  const [log, setLog] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function ask() {
    const question = q.trim();
    if (!question) return;
    setErr(null);
    setQ("");

    // echo user in log
    setLog((L) => [...L, { role: "user", text: question }]);
    setBusy(true);

    try {
      // Send JSON to /api/ask (proxy to /api/chat)
      const rsp = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question,
          planText,     // anchor to current plan
          headlines,    // give macro context
          calendar,     // give events context
        }),
      });

      const j = await rsp.json().catch(() => ({} as any));
      const answer =
        (j && (j.answer || j.text || j.message)) ||
        (typeof j === "string" ? j : "") ||
        "";

      if (!rsp.ok) {
        setErr(j?.error || j?.reason || "Chat request failed.");
        setLog((L) => [...L, { role: "assistant", text: "Sorry — I couldn't reply just now." }]);
      } else if (!answer) {
        setLog((L) => [
          ...L,
          {
            role: "assistant",
            text:
              "I didn’t get a response there. Try rephrasing, or ask something like “Was this a BOS?” or “Why is conviction only 40%?”",
          },
        ]);
      } else {
        setLog((L) => [...L, { role: "assistant", text: answer }]);
      }
    } catch (e: any) {
      setErr(e?.message || "Network error.");
      setLog((L) => [...L, { role: "assistant", text: "Network error." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-neutral-800 p-3 space-y-3">
      <div className="text-xs opacity-70">
        Ask about this setup: “Why this stop?”, “What’s the BOS?”, “What headlines mattered?”,
        “What would raise conviction above 60%?”, etc.
      </div>

      {/* transcript */}
      <div className="bg-neutral-900 rounded p-2 max-h-64 overflow-auto text-sm space-y-2">
        {log.length === 0 ? (
          <div className="opacity-60">No messages yet.</div>
        ) : (
          log.map((m, i) => (
            <div key={i} className="leading-6">
              <span
                className={`mr-2 px-2 py-0.5 rounded text-[11px] ${
                  m.role === "user"
                    ? "bg-sky-700"
                    : m.role === "assistant"
                    ? "bg-emerald-700"
                    : "bg-neutral-700"
                }`}
              >
                {m.role === "user" ? "You" : m.role === "assistant" ? "Assistant" : "System"}
              </span>
              <span>{m.text}</span>
            </div>
          ))
        )}
      </div>

      {err && <div className="text-rose-400 text-xs">{err}</div>}

      <div className="flex gap-2">
        <input
          className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm"
          placeholder="Ask about the plan…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && ask()}
          disabled={busy}
        />
        <button
          onClick={ask}
          disabled={busy}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded px-3 text-sm"
        >
          {busy ? "…" : "Ask"}
        </button>
      </div>
    </div>
  );
}
