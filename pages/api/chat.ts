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

// Stream OpenAI Chat Completions → client as SSE "data: <chunk>"
async function streamOpenAI(req: NextApiRequest, res: NextApiResponse, messages: any[]) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // avoid proxy buffering
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
    const body = await rsp.text().catch(() => "");
    res.write(`event: error\ndata: ${JSON.stringify({ error: `OpenAI error ${rsp.status}`, body })}\n\n`);
    res.end();
    return;
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

      // OpenAI stream lines like: "data: {json}\n\n"
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim(); // after "data:"
        if (payload === "[DONE]") {
          res.write("event: done\ndata: [DONE]\n\n");
          res.end();
          return;
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
          // Forward raw for debugging if not JSON
          flush(payload);
        }
      }
    }
  } catch (e: any) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e?.message || "stream failed" })}\n\n`);
  } finally {
    res.end();
  }
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

    const messages = [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ];

    // Stream if the client asks OR Accept: text/event-stream is present
    const wantsSSE =
      stream === true || String(req.headers.accept || "").includes("text/event-stream");

    if (wantsSSE) {
      return await streamOpenAI(req, res, messages);
    }

    // Non-stream fallback (JSON)
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

    const json = await rsp.json().catch(() => ({} as any));
    if (!rsp.ok) {
      const reason = json?.error?.message || `OpenAI error ${rsp.status}`;
      return res.status(200).json({ error: reason });
    }

    const answer =
      json?.choices?.[0]?.message?.content?.trim?.() ||
      (Array.isArray(json?.choices?.[0]?.message?.content)
        ? json.choices[0].message.content.map((c: any) => c?.text || "").join("\n").trim()
        : "") ||
      "";

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ answer: answer || "(no answer)" });
  } catch (err: any) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ error: err?.message || "chat failed" });
  }
}
