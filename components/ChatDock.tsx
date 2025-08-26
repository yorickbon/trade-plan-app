// components/ChatDock.tsx
"use client";
import { useState } from "react";

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
  const [log, setLog] = useState<{ role: "user" | "assistant"; text: string }[]>([]);

  async function ask() {
    if (!q.trim()) return;
    const mine = q;
    setQ("");
    setLog((L) => [...L, { role: "user", text: mine }]);

    const rsp = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: mine, planText, headlines, calendar }),
    });
    const json = await rsp.json();
    setLog((L) => [...L, { role: "assistant", text: json.answer || "No answer." }]);
  }

  return (
    <div className="fixed right-4 bottom-4 w-[380px] max-w-[90vw] bg-neutral-900 border border-neutral-700 rounded-xl p-3 shadow-lg">
      <div className="text-sm font-semibold mb-2">Ask about this setup</div>
      <div className="h-40 overflow-auto space-y-2 mb-2 text-sm">
        {log.length === 0 ? (
          <div className="text-gray-400">Questions you can ask: “Why this stop?”, “What’s the BOS?”, “What headlines mattered?”</div>
        ) : (
          log.map((m, i) => (
            <div key={i}>
              <span className={m.role === "user" ? "text-blue-300" : "text-green-300"}>
                {m.role === "user" ? "You" : "Assistant"}:
              </span>{" "}
              <span>{m.text}</span>
            </div>
          ))
        )}
      </div>
      <div className="flex gap-2">
        <input
          className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm"
          placeholder="Ask about the plan…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
        />
        <button onClick={ask} className="bg-blue-600 hover:bg-blue-500 rounded px-3 text-sm">
          Ask
        </button>
      </div>
    </div>
  );
}
