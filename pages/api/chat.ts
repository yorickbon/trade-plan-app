// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";

// --- ENV ---
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
// Prefer the alternate model (e.g., gpt-4o). Fall back to OPENAI_MODEL.
const MODEL_PRIMARY =
  process.env.OPENAI_MODEL_ALT || process.env.OPENAI_MODEL || "gpt-4o";
const OPENAI_API_BASE =
  process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// --- small utils ---
function asString(x: any) {
  return typeof x === "string" ? x : x == null ? "" : JSON.stringify(x);
}
const isGpt5 = (m: string) => /^gpt-5/i.test(m);

// ---------- fresh, instrument-aligned headlines (6 bullets) ----------
function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host =
    (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  return host.startsWith("http") ? host : `${proto}://${host}`;
}

function bulletsFromItems(items: any[], max = 6): string {
  const rows: string[] = [];
  for (const it of (items || []).slice(0, max)) {
    const t = String(it?.title ?? it?.text ?? "").trim();
    if (!t) continue;
    const src = String(it?.source ?? "").trim();
    const when = String(it?.ago ?? "").trim();
    const s =
      typeof it?.sentiment?.score === "number" ? it.sentiment.score : null;
    const lab = s == null ? "neu" : s > 0.05 ? "pos" : s < -0.05 ? "neg" : "neu";
    rows.push(`• ${t}${src ? ` — ${src}` : ""}${when ? `, ${when}` : ""} — ${lab}`);
  }
  return rows.join("\n");
}

async function fetchInstrumentHeadlines(
  req: NextApiRequest,
  instrument: string,
  max = 6
) {
  try {
    const base = originFromReq(req);
    // fetch up to 12, embed 6
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

// ---------- prompt & extraction ----------
function buildMessages(system: string, userContent: string) {
  return [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];
}

// Robust extractor for Chat Completions (covers string/array shapes)
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
        else if (
          typeof part?.type === "string" &&
          typeof part?.text === "string"
        )
          pieces.push(part.text);
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

// ---------- OpenAI (non-stream) ----------
async function chatCompletions(model: string, messages: any[]) {
  // Use GPT-5 param only if model starts with gpt-5; else use classic max_tokens
  const body: any = { model, messages };
  if (isGpt5(model)) {
    body.max_completion_tokens = 800;
  } else {
    body.max_tokens = 800;
  }

  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const text = await rsp.text().catch(() => "");
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { ok: rsp.ok, status: rsp.status, json, text };
}

// ---------- handler ----------
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });
    if (!OPENAI_API_KEY)
      return res.status(400).json({ error: "Missing OPENAI_API_KEY" });

    const {
      question = "",
      planText = "",
      headlines = [], // kept for compatibility; server fetch takes priority
      calendar = [],
      instrument = "",
    } = (req.body || {}) as {
      question?: string;
      planText?: string;
      headlines?: any[];
      calendar?: any[];
      instrument?: string;
    };

    const q = String(question || "").trim();
    if (!q) return res.status(200).json({ answer: "(empty question)" });

    // Always align headlines to the active instrument (server-side), embed 6
    let headlinesText = "";
    if (instrument) {
      headlinesText = await fetchInstrumentHeadlines(
        req,
        String(instrument).toUpperCase(),
        6
      );
    }
    if (!headlinesText && Array.isArray(headlines) && headlines.length) {
      headlinesText = bulletsFromItems(headlines, 6);
    }

    const contextParts: string[] = [];
    if (instrument)
      contextParts.push(`Instrument: ${String(instrument).toUpperCase()}`);
    if (planText) contextParts.push(`Current Trade Plan:\n${asString(planText)}`);
    if (headlinesText)
      contextParts.push(`Recent headlines snapshot:\n${headlinesText}`);
    if (Array.isArray(calendar) && calendar.length) {
      contextParts.push(`Calendar notes (raw):\n${asString(calendar)}`);
    }

    const system =
      "You are a helpful trading assistant. Discuss trades thoughtfully, but you can also teach with examples when asked. Keep answers concise and practical.";

    const userContent = [contextParts.join("\n\n"), "", `User question: ${q}`]
      .filter(Boolean)
      .join("\n");

    const messages = buildMessages(system, userContent);

    // ALWAYS NON-STREAM and ALWAYS use the ALT model first
    const model = MODEL_PRIMARY;
    const cc = await chatCompletions(model, messages);

    if (!cc.ok) {
      return res.status(200).json({
        error: `OpenAI error ${cc.status}`,
        detail: cc?.json?.error?.message || cc.text || "unknown",
      });
    }

    const answer = extractTextFromChat(cc.json) || "(no answer)";
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ answer });
  } catch (err: any) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ error: err?.message || "chat failed" });
  }
}
