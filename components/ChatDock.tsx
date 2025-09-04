// components/ChatDock.tsx
"use client";

import React from "react";

type ChatDockProps = {
  instrument?: string;
  planText?: string;
  headlines?: any[];
  calendar?: any[];
};

type Msg = { role: "user" | "assistant"; content: string };

export default function ChatDock({
  instrument,
  planText,
  headlines,
  calendar,
}: ChatDockProps) {
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  // local headlines that auto-refresh when instrument changes
  const [localHeadlines, setLocalHeadlines] = React.useState<any[]>(headlines || []);
  const [newsLoading, setNewsLoading] = React.useState(false);

  const abortRef = React.useRef<AbortController | null>(null);
  const newsAbortRef = React.useRef<AbortController | null>(null);
  const lastInstrumentRef = React.useRef<string | undefined>(instrument);

  const addMsg = React.useCallback((m: Msg) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  const updateLastAssistant = React.useCallback((chunk: string) => {
    setMessages((prev) => {
      if (!prev.length || prev[prev.length - 1].role !== "assistant") {
        return [...prev, { role: "assistant", content: chunk }];
      }
      const copy = prev.slice();
      copy[copy.length - 1] = {
        role: "assistant",
        content: copy[copy.length - 1].content + chunk,
      };
      return copy;
    });
  }, []);

  const onStop = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  }, []);

  const reloadHeadlines = React.useCallback(async (sym?: string) => {
    const symbol = (sym || instrument || "").trim();
    if (!symbol) {
      setLocalHeadlines([]);
      return;
    }
    // abort any in-flight news request
    newsAbortRef.current?.abort();
    const controller = new AbortController();
    newsAbortRef.current = controller;

    try {
      setNewsLoading(true);
      const rsp = await fetch(`/api/news?symbol=${encodeURIComponent(symbol)}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!rsp.ok) throw new Error(`news ${rsp.status}`);
      const json = await rsp.json().catch(() => ({} as any));
      // expect { headlines: [...] } or array
      const items = Array.isArray(json) ? json : json?.headlines || [];
      setLocalHeadlines(items || []);
    } catch {
      // keep previous headlines if fetch fails
    } finally {
      setNewsLoading(false);
      newsAbortRef.current = null;
    }
  }, [instrument]);

  // seed local headlines from props on mount/prop-change
  React.useEffect(() => {
    setLocalHeadlines(headlines || []);
  }, [headlines]);

  // Hard reset context on instrument change
  React.useEffect(() => {
    if (instrument === lastInstrumentRef.current) return;
    // 1) stop any active generation
    onStop();
    // 2) clear chat state
    setMessages([]);
    setInput("");
    // 3) refresh headlines for the new instrument
    reloadHeadlines(instrument);
    lastInstrumentRef.current = instrument;
  }, [instrument, onStop, reloadHeadlines]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    addMsg({ role: "user", content: question });
    setInput("");
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const rsp = await fetch("/api/ask?stream=1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          question,
          instrument,
          planText,
          headlines: localHeadlines, // use fresh headlines tied to instrument
          calendar,
          stream: true,
        }),
        signal: controller.signal,
      });

      const ctype = rsp.headers.get("content-type") || "";

      if (ctype.includes("text/event-stream") && rsp.body) {
        const reader = rsp.body.getReader();
        const decoder = new TextDecoder();

        // seed assistant message
        updateLastAssistant("");

        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          const events = buf.split("\n\n");
          buf = events.pop() || "";
          for (const ev of events) {
            const lines = ev.split("\n");
            const first = (lines[0] || "").trim();

            if (first.startsWith("event: error")) {
              const dataLine = lines.find((l) => l.startsWith("data:"));
              if (dataLine) {
                try {
                  const payload = JSON.parse(dataLine.slice(5).trim());
                  const msg = payload?.error
                    ? `[error] ${payload.error}${payload.body ? ` — ${payload.body}` : ""}`
                    : "[error] stream error";
                  updateLastAssistant(`\n${msg}`);
                } catch {
                  updateLastAssistant(`\n[error] stream error`);
                }
              }
              continue;
            }

            if (!first.startsWith("data:")) continue;
            const data = first.slice(5).trim();
            if (data === "[DONE]") continue;
            updateLastAssistant(data);
          }
        }

        setLoading(false);
        abortRef.current = null;
        return;
      }

      // JSON fallback
      const json = await rsp.json().catch(() => ({} as any));
      const answer =
        json?.answer ||
        json?.text ||
        json?.message ||
        (json?.error ? `[error] ${json.error}${json?.detail ? ` — ${json.detail}` : ""}` : "");
      addMsg({ role: "assistant", content: String(answer || "(no answer)") });
    } catch (err: any) {
      addMsg({ role: "assistant", content: `[error] ${err?.message || "request failed"}` });
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  const onReset = React.useCallback(() => {
    // Abort any active generation and clear UI state (keep current instrument)
    onStop();
    setMessages([]);
    setInput("");
    reloadHeadlines(instrument);
  }, [instrument, onStop, reloadHeadlines]);

  return (
    <div className="w-full max-w-2xl mx-auto border rounded-xl p-3 flex flex-col gap-3 bg-white">
      {/* Top bar: instrument + actions */}
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">
          {instrument ? (
            <span className="inline-flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-black text-white text-xs">
                {instrument}
              </span>
              {newsLoading ? (
                <span className="text-xs opacity-60">refreshing headlines…</span>
              ) : null}
            </span>
          ) : (
            <span className="opacity-60 text-xs">No instrument selected</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg border text-sm disabled:opacity-50"
            onClick={onReset}
            disabled={loading}
            title="Clear chat"
          >
            Reset
          </button>
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg border text-sm disabled:opacity-50"
            onClick={onStop}
            disabled={!loading}
            title="Stop generating"
          >
            Stop
          </button>
        </div>
      </div>

      <div className="h-72 overflow-auto rounded border p-3 bg-slate-50">
        {messages.length === 0 ? (
            <div className="opacity-60 text-sm">
              Ask about the current trade plan, risk, or execution. Switching instruments will clear this chat and pull fresh headlines automatically.
            </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`mb-3 ${m.role === "user" ? "text-right" : "text-left"}`}>
              <div
                className={`inline-block whitespace-pre-wrap rounded-xl px-3 py-2 border ${
                  m.role === "user"
                    ? "bg-blue-600 text-white border-blue-700"
                    : "bg-emerald-50 text-emerald-900 border-emerald-200"
                }`}
              >
                {m.content}
              </div>
            </div>
          ))
        )}
      </div>

      <form onSubmit={send} className="flex gap-2">
        <input
          className="flex-1 border rounded-lg px-3 py-2"
          placeholder="Ask anything about the plan…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
        />
        <button
          type="submit"
          className="px-3 py-2 rounded-lg bg-black text-white disabled:opacity-50"
          disabled={loading || !input.trim()}
        >
          Send
        </button>
      </form>
    </div>
  );
}
