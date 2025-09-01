// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

function asString(x: any) {
  return typeof x === "string" ? x : x == null ? "" : JSON.stringify(x);
}

/* ---------- Fresh, instrument-aligned headlines (6 bullets max) ---------- */
function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}
function bulletsFromItems(items: any[], max = 6): string {
  const rows: string[] = [];
  for (const it of (items || []).slice(0, max)) {
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
async function fetchInstrumentHeadlines(req: NextApiRequest, instrument: string, max = 6) {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(
      instrument
    )}&hours=48&max=12&_t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    const items = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
    return bulletsFromItems(items, max);
  } catch {
    return "";
  }
}

/* --------------------------- Prompt helpers --------------------------- */
function buildMessages(system: string, userContent: string) {
  return [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];
}

/* ------------------------ Chat output extraction ---------------------- */
// GPT-5 sometimes returns array content. Handle all shapes safely.
function extractTextFromChat(json: any): string {
  try {
    const msg = json?.choices?.[0]?.message;

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

/* ------------------------- OpenAI call helpers ------------------------ */
// Try streaming first, but don’t switch the response to SSE until we know it’s allowed.
// If streaming isn’t allowed (400 param=stream), we fall back to non-stream JSON.
async function tryStreamChatCompletions(
  req: NextApiRequest,
  res: NextApiResponse,
  messages: any[]
): Promise<"streamed" | "fallback-json" | { error: { status: number; body: string } }> {
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      stream: true,
      messages,
      // GPT-5: use max_completion_tokens, no temperature
      max_completion_tokens: 800,
    }),
    signal: controller.signal,
  });

  if (!rsp.ok) {
    const bodyText = await rsp.text().catch(() => "");
    try {
      const j = JSON.parse(bodyText);
      if (rsp.status === 400 && j?.error?.param === "stream" && j?.error?.code === "unsupported_value") {
        return "fallback-json";
      }
    } catch {}
    return { error: { status: rsp.status, body: bodyText } };
  }

  // Streaming confirmed — send SSE headers now and pipe chunks.
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

async function nonStreamChatCompletions(messages: any[]) {
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
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

/* ------------------------------- Handler ------------------------------ */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ error: "Missing OPENAI_API_KEY" });

    const {
      question = "",
      planText = "",
      headlines = [], // kept for compatibility; server fetch takes priority
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

    // Always align headlines to the active instrument (server-side), embed 6.
    let headlinesText = "";
    if (instrument) {
      headlinesText = await fetchInstrumentHeadlines(req, String(instrument).toUpperCase(), 6);
    }
    if (!headlinesText && Array.isArray(headlines) && headlines.length) {
      headlinesText = bulletsFromItems(headlines, 6);
    }

    const contextParts: string[] = [];
    if (instrument) contextParts.push(`Instrument: ${String(instrument).toUpperCase()}`);
    if (planText) contextParts.push(`Current Trade Plan:\n${asString(planText)}`);
    if (headlinesText) contextParts.push(`Recent headlines snapshot:\n${headlinesText}`);
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

      // If streaming not allowed, degrade to JSON via Chat Completions:
      if (r === "fallback-json") {
        const cc = await nonStreamChatCompletions(messages);
        if (cc.ok) {
          const answer = extractTextFromChat(cc.json) || "(no answer)";
          res.setHeader("Cache-Control", "no-store");
          return res.status(200).json({ answer });
        }
        return res
          .status(200)
          .json({
            error: `OpenAI error ${cc.status}`,
            detail: cc.text || cc.json?.error?.message || "unknown",
          });
      }

      // Other streaming error -> return JSON error (never raw JSON)
      return res
        .status(200)
        .json({
          error: `OpenAI error ${r.error.status}`,
          detail: r.error.body || "unknown",
        });
    }

    // Non-stream path (client didn’t request SSE)
    const cc = await nonStreamChatCompletions(messages);
    if (cc.ok) {
      const answer = extractTextFromChat(cc.json) || "(no answer)";
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ answer });
    }
    return res
      .status(200)
      .json({
        error: `OpenAI error ${cc.status}`,
        detail: cc.text || cc.json?.error?.message || "unknown",
      });
  } catch (err: any) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ error: err?.message || "chat failed" });
  }
}
