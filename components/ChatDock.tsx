// components/ChatDock.tsx
"use client";

import React from "react";

type ChatDockProps = {
  instrument?: string;
  planText?: string;
  headlines?: any[]; // initial headlines (optional)
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

  // Headlines state is owned here to avoid stale carryover
  const [localHeadlines, setLocalHeadlines] = React.useState<any[]>(headlines || []);
  const [newsLoading, setNewsLoading] = React.useState(false);

  const abortRef = React.useRef<AbortController | null>(null);
  const newsAbortRef = React.useRef<AbortController | null>(null);
  const lastInstrumentRef = React.useRef<string | undefined>(instrument);
  const seededPropsHeadlinesRef = React.useRef(false);
  const newsReqIdRef = React.useRef(0);

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

  // One-time seed from props on mount
  React.useEffect(() => {
    if (!seededPropsHeadlinesRef.current && headlines && headlines.length) {
      setLocalHeadlines(headlines);
    }
    seededPropsHeadlinesRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === OPTION A: USE symbols= (not instrument= or symbol=) ===
  const reloadHeadlines = React.useCallback(
    async (sym?: string) => {
      const symbol = (sym || instrument || "").trim();
      if (!symbol) {
        setLocalHeadlines([]);
        return;
      }

      // Cancel any in-flight request
      newsAbortRef.current?.abort();
      const controller = new AbortController();
      newsAbortRef.current = controller;

      setNewsLoading(true);
      const myReqId = ++newsReqIdRef.current;

      try {
        // Primary GET with cache-bust, using symbols=
        const url = `/api/news?symbols=${encodeURIComponent(symbol)}&t=${Date.now()}`;
        const rsp = await fetch(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "cache-control": "no-store, no-cache, must-revalidate",
            pragma: "no-cache",
          },
          signal: controller.signal,
        });

        let items: any[] | null = null;

        if (rsp.ok) {
          const json = await rsp.json().catch(() => ({} as any));
          items = Array.isArray(json) ? json : json?.items || json?.headlines || null;
        }

        // POST fallback (also with symbols in body)
        if (!items) {
          const rsp2 = await fetch(`/api/news`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              "cache-control": "no-store",
            },
            body: JSON.stringify({ symbols: [symbol] }),
            signal: controller.signal,
          });
          if (rsp2.ok) {
            const json2 = await rsp2.json().catch(() => ({} as any));
            items = Array.isArray(json2) ? json2 : json2?.items || json2?.headlines || [];
          } else {
            items = [];
          }
        }

        if (newsReqIdRef.current === myReqId) {
          setLocalHeadlines(items || []);
        }
      } catch {
        // keep previous headlines on failure
      } finally {
        if (newsReqIdRef.current === myReqId) {
          setNewsLoading(false);
          newsAbortRef.current = null;
        }
      }
    },
    [instrument]
  );

  // Hard reset context on instrument change
  React.useEffect(() => {
    if (instrument === lastInstrumentRef.current) return;
    onStop();                 // stop generation
    setMessages([]);          // clear chat
    setInput("");             // clear input
    reloadHeadlines(instrument); // fetch fresh headlines with symbols=
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
          headlines: localHeadlines, // always current instrument headlines
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
    onStop();
    setMessages([]);
    setInput("");
    reloadHeadlines(instrument);
  }, [instrument, onStop, reloadHeadlines]);

  return (
    <div className="w-full max-w-2xl mx-auto border rounded-xl p-3 flex flex-col gap-3 bg-white">
      {/* Top bar */}
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

      {/* Messages */}
      <div className="h-72 overflow-auto rounded border p-3 bg-slate-50">
        {messages.length === 0 ? (
          <div className="opacity-60 text-sm">
            Ask about the current trade plan, risk, or execution. Switching instruments clears this chat and pulls fresh (symbols-based) headlines automatically.
          </div>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={`mb-3 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              data-role={m.role}
            >
              <div className="max-w-[90%]">
                <div
                  className={`text-[10px] mb-1 ${
                    m.role === "user" ? "text-blue-700 text-right" : "text-emerald-700 text-left"
                  }`}
                >
                  {m.role === "user" ? "You" : "Assistant"}
                </div>
                <div
                  className={`inline-block whitespace-pre-wrap rounded-2xl px-3 py-2 border shadow-sm ${
                    m.role === "user"
                      ? "bg-blue-600 text-white border-blue-700"
                      : "bg-emerald-50 text-emerald-900 border-emerald-300"
                  }`}
                  style={{
                    color: m.role === "user" ? "#ffffff" : "#064e3b",
                    background: m.role === "user" ? "#2563eb" : "#ecfdf5",
                    borderColor: m.role === "user" ? "#1d4ed8" : "#86efac",
                  }}
                >
                  {m.content}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Composer */}
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
