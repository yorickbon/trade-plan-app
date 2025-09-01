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
  // Simple, reliable input for /v1/responses
  return `${system}\n\n${userContent}`;
}

// ---- Streaming via Chat Completions ----
async function streamChatCompletions(
  req: NextApiRequest,
  res: NextApiResponse,
  messages: any[]
) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

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
      temperature: 0.2,
      max_tokens: 800,
    }),
    signal: controller.signal,
  });

  if (!rsp.ok || !rsp.body) {
    const bodyText = await rsp.text().catch(() => "");
    // send the detailed error to the client so you can see why
    res.write(
      `event: error\ndata: ${JSON.stringify({
        error: `OpenAI error ${rsp.status}`,
        body: bodyText,
      })}\n\n`
    );
    res.end();
    return { ok: false, status: rsp.status, body: bodyText };
  }

  const reader = rsp.body.getReader();
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
          return { ok: true };
        }
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta;
          const piece =
            typeof delta?.content === "string"
              ? delta.content
              : Array.isArray(delta?.content)
              ? delta.content.map((c: any) => c?.text || "").join("")
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
  return { ok: true };
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
      temperature: 0.2,
      max_tokens: 800,
    }),
  });
  const text = await rsp.text().catch(() => "");
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { ok: rsp.ok, status: rsp.status, json, text };
}

// ---- Non-stream Responses API fallback (for 400 from chat/completions) ----
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
      temperature: 0.2,
      max_output_tokens: 800,
    }),
  });
  const text = await rsp.text().catch(() => "");
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {}
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
      // try streaming chat/completions first
      const result = await streamChatCompletions(req, res, messages);
      // If streaming failed with a 400, the client already received the detailed error.
      // We end the response in streamChatCompletions.
      return;
    }

    // Non-stream path
    const cc = await nonStreamChatCompletions(messages);
    if (cc.ok) {
      const answer =
        cc.json?.choices?.[0]?.message?.content?.trim?.() ||
        (Array.isArray(cc.json?.choices?.[0]?.message?.content)
          ? cc.json.choices[0].message.content.map((c: any) => c?.text || "").join("\n").trim()
          : "") ||
        "";
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ answer: answer || "(no answer)" });
    }

    // If it's 400, auto-fallback to /responses for gpt-5 accounts that require it
    if (cc.status === 400) {
      const responsesInput = buildResponsesInput(system, userContent);
      const rr = await nonStreamResponses(responsesInput);
      if (rr.ok) {
        // Responses API can return different shapes; try to extract text safely.
        const out =
          rr.json?.output_text ??
          rr.json?.content?.map?.((c: any) => c?.text ?? c?.content ?? "").join("") ??
          rr.text;
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json({ answer: String(out || "").trim() || "(no answer)" });
      }
      // If fallback also failed, show detailed reason
      return res
        .status(200)
        .json({
          error: `OpenAI error ${rr.status}`,
          detail: rr.text || rr.json?.error?.message || "unknown",
        });
    }

    // Other errors: show detailed reason
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
