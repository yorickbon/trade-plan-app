// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

function asString(x: any) {
  return typeof x === "string" ? x : x == null ? "" : JSON.stringify(x);
}

function headlinesToBullets(headlines: any[]): string {
  if (!Array.isArray(headlines)) return "";
  const rows: string[] = [];
  for (const it of headlines.slice(0, 12)) {
    const t = String(it?.title ?? it?.text ?? "").trim();
    if (!t) continue;
    const src = String(it?.source ?? "").trim();
    const when = String(it?.ago ?? "").trim();
    const s = typeof it?.sentiment?.score === "number" ? it.sentiment.score : null;
    const lab = s == null ? "neu" : s > 0.05 ? "pos" : s < -0.05 ? "neg" : "neu";
    rows.push(`• ${t}${src ? ` — ${src}` : ""}${when ? `, ${when}` : ""} — ${lab}`);
  }
  return rows.join("\n");
}

function buildMessages(system: string, userContent: string) {
  return [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];
}

function buildResponsesInput(system: string, userContent: string) {
  return `${system}\n\n${userContent}`;
}

/** Robust extractor for Chat Completions (GPT-5 tolerant) */
function extractTextFromChat(json: any): string {
  try {
    const choice = json?.choices?.[0];
    const msg = choice?.message;

    if (typeof msg?.content === "string") return msg.content.trim();

    if (Array.isArray(msg?.content)) {
      const pieces: string[] = [];
      for (const part of msg.content) {
        if (typeof part === "string") pieces.push(part);
        else if (typeof part?.text === "string") pieces.push(part.text);
        else if (typeof part?.content === "string") pieces.push(part.content);
        else if (typeof part?.type === "string" && typeof part?.text === "string") pieces.push(part.text);
      }
      return pieces.join("").trim();
    }

    const alt = msg?.content?.[0]?.text;
    if (typeof alt === "string") return alt.trim();

    return "";
  } catch {
    return "";
  }
}

/** Robust extractor for Responses API (GPT-5 tolerant) */
function extractTextFromResponses(json: any, rawText: string): string {
  try {
    if (typeof json?.output_text === "string" && json.output_text.trim()) {
      return json.output_text.trim();
    }
    const out = Array.isArray(json?.output) ? json.output : [];
    const pieces: string[] = [];
    for (const item of out) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        if (typeof c?.text === "string") pieces.push(c.text);
        else if (typeof c?.content === "string") pieces.push(c.content);
      }
    }
    if (pieces.length) return pieces.join("").trim();
    return (rawText || "").trim();
  } catch {
    return (rawText || "").trim();
  }
}

// ---- Try streaming first, but only send SSE headers if allowed ----
async function tryStreamChatCompletions(
  req: NextApiRequest,
  res: NextApiResponse,
  messages: any[]
): Promise<"streamed" | "fallback-json" | { error: { status: number; body: string } }> {
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      stream: true,
      messages,
      // GPT-5 param (no temperature)
      max_completion_tokens: 800,
    }),
    signal: controller.signal,
  });

  if (!rsp.ok) {
    const bodyText = await rsp.text().catch(() => "");
    // If streaming isn’t allowed, degrade to JSON
    try {
      const j = JSON.parse(bodyText);
      if (rsp.status === 400 && j?.error?.param === "stream" && j?.error?.code === "unsupported_value") {
        return "fallback-json";
      }
    } catch {}
    return { error: { status: rsp.status, body: bodyText } };
  }

  // Streaming confirmed; switch to SSE headers and pipe
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const reader = rsp.body!.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const flush = (text: string) => {
    if (!text) return;
    res.write(`data: ${text}\n\n`);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          res.write("event: done\ndata: [DONE]\n\n");
          res.end();
          return "streamed";
        }
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta;
          const piece =
            typeof delta?.content === "string"
              ? delta.content
              : Array.isArray(delta?.content)
              ? delta.content.map((c: any) => c?.text || c?.content || "").join("")
              : "";
          if (piece) flush(piece);
        } catch {
          flush(payload);
        }
      }
    }
  } catch (e: any) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e?.message || "stream failed" })}\n\n`);
  } finally {
    res.end();
  }
  return "streamed";
}

// ---- Non-stream Chat Completions ----
async function nonStreamChatCompletions(messages: any[]) {
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      max_completion_tokens: 800, // GPT-5 param
    }),
  });
  const text = await rsp.text().catch(() => "");
  let json: any = {};
  try { json = JSON.parse(text); } catch {}
  return { ok: rsp.ok, status: rsp.status, json, text };
}

// ---- Non-stream Responses API fallback ----
async function nonStreamResponses(input: string) {
  const rsp = await fetch(`${OPENAI_API_BASE}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      max_output_tokens: 800, // GPT-5 param
    }),
  });
  const text = await rsp.text().catch(() => "");
  let json: any = {};
  try { json = JSON.parse(text); } catch {}
  return { ok: rsp.ok, status: rsp.status, json, text };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ error: "Missing OPENAI_API_KEY" });

    const {
      question = "",
      planText = "",
      headlines = [],
      calendar = [],
      instrument = "",
      stream = false,
    } = (req.body || {}) as {
      question?: string;
      planText?: string;
      headlines?: any[];
      calendar?: any[];
      instrument?: string;
      stream?: boolean;
    };

    const q = String(question || "").trim();
    if (!q) return res.status(200).json({ answer: "(empty question)" });

    const contextParts: string[] = [];
    if (instrument) contextParts.push(`Instrument: ${String(instrument).toUpperCase()}`);
    if (planText) contextParts.push(`Current Trade Plan:\n${asString(planText)}`);
    const hl = headlinesToBullets(headlines);
    if (hl) contextParts.push(`Recent headlines snapshot:\n${hl}`);
    if (Array.isArray(calendar) && calendar.length) {
      contextParts.push(`Calendar notes (raw):\n${asString(calendar)}`);
    }

    const system =
      "You are a helpful trading assistant. Discuss trades thoughtfully, but you can also teach with examples when asked. Keep answers concise and practical.";
    const userContent = [contextParts.join("\n\n"), "", `User question: ${q}`]
      .filter(Boolean)
      .join("\n");

    const messages = buildMessages(system, userContent);
    const wantsSSE =
      stream === true || String(req.headers.accept || "").includes("text/event-stream");

    if (wantsSSE) {
      const r = await tryStreamChatCompletions(req, res, messages);
      if (r === "streamed") return;

      if (r === "fallback-json") {
        const cc = await nonStreamChatCompletions(messages);
        if (cc.ok) {
          let answer = extractTextFromChat(cc.json);
          // NEW: if chat returns empty, try Responses
          if (!answer) {
            const rr = await nonStreamResponses(buildResponsesInput(system, userContent));
            if (rr.ok) answer = extractTextFromResponses(rr.json, rr.text);
          }
          res.setHeader("Cache-Control", "no-store");
          return res.status(200).json({ answer: answer || "(no answer)" });
        }
        if (cc.status === 400) {
          const rr = await nonStreamResponses(buildResponsesInput(system, userContent));
          if (rr.ok) {
            const out = extractTextFromResponses(rr.json, rr.text);
            res.setHeader("Cache-Control", "no-store");
            return res.status(200).json({ answer: out || "(no answer)" });
          }
          return res.status(200).json({
            error: `OpenAI error ${rr.status}`,
            detail: rr.text || rr.json?.error?.message || "unknown",
          });
        }
        return res.status(200).json({
          error: `OpenAI error ${cc.status}`,
          detail: cc.text || cc.json?.error?.message || "unknown",
        });
      }

      return res.status(200).json({
        error: `OpenAI error ${r.error.status}`,
        detail: r.error.body || "unknown",
      });
    }

    // Non-stream path
    const cc = await nonStreamChatCompletions(messages);
    if (cc.ok) {
      let answer = extractTextFromChat(cc.json);
      if (!answer) {
        const rr = await nonStreamResponses(buildResponsesInput(system, userContent));
        if (rr.ok) answer = extractTextFromResponses(rr.json, rr.text);
      }
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ answer: answer || "(no answer)" });
    }

    if (cc.status === 400) {
      const rr = await nonStreamResponses(buildResponsesInput(system, userContent));
      if (rr.ok) {
        const out = extractTextFromResponses(rr.json, rr.text);
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json({ answer: out || "(no answer)" });
      }
      return res.status(200).json({
        error: `OpenAI error ${rr.status}`,
        detail: rr.text || rr.json?.error?.message || "unknown",
      });
    }

    return res.status(200).json({
      error: `OpenAI error ${cc.status}`,
      detail: cc.text || cc.json?.error?.message || "unknown",
    });
  } catch (err: any) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ error: err?.message || "chat failed" });
  }
}
