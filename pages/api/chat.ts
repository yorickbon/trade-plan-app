// pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import {
  getCurrencyStrengthIntraday,
  getCotBiasBrief,
  formatStrengthLine,
  formatCotLine,
  parseInstrumentCurrencies,
} from "../../lib/sentiment-lite";

// --- ENV ---
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
// Prefer the alternate model (e.g., gpt-4o). Fall back to OPENAI_MODEL.
const MODEL_PRIMARY =
  process.env.OPENAI_MODEL_ALT || process.env.OPENAI_MODEL || "gpt-4o";
const OPENAI_API_BASE =
  process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// --- utils ---
function asString(x: any) {
  return typeof x === "string" ? x : x == null ? "" : JSON.stringify(x);
}
const isGpt5 = (m: string) => /^gpt-5/i.test(m);
const toUpper = (s: any) => String(s || "").toUpperCase().trim();

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

/* ---------------- Calendar tightening (Option A: no external fetch) ---------------- */

type CalNorm = {
  ts: number; // ms epoch
  ccy: string; // currency code like USD/JPY
  title: string;
  impact: "high" | "medium" | "low" | "unknown";
  expected?: string;
  prior?: string;
};

function toImpact(v: any): CalNorm["impact"] {
  const s = String(v || "").toLowerCase();
  if (/(high|red|3)/.test(s)) return "high";
  if (/(medium|med|orange|2)/.test(s)) return "medium";
  if (/(low|yellow|1)/.test(s)) return "low";
  return "unknown";
}

function parseTimestamp(vDate: any, vTime?: any): number | null {
  if (vDate == null && vTime == null) return null;
  const tryNum = Number(vDate);
  if (isFinite(tryNum) && tryNum > 0) {
    return tryNum < 10_000_000_000 ? tryNum * 1000 : tryNum;
  }
  const dateStr = String(vDate || "").trim();
  const timeStr = String(vTime || "").trim();
  const guess = dateStr && timeStr ? `${dateStr} ${timeStr}` : dateStr || timeStr;
  const d = new Date(guess);
  return isFinite(d.getTime()) ? d.getTime() : null;
}

function normalizeCalendarArray(calendar: any[]): CalNorm[] {
  const out: CalNorm[] = [];
  for (const it of Array.isArray(calendar) ? calendar : []) {
    const title = String(it?.event ?? it?.title ?? it?.name ?? "").trim();
    if (!title) continue;

    const ccy =
      toUpper(it?.currency ?? it?.ccy ?? it?.country ?? it?.fx ?? "");

    let ts =
      parseTimestamp(it?.timestamp) ??
      parseTimestamp(it?.time) ??
      parseTimestamp(it?.date, it?.time) ??
      parseTimestamp(it?.datetime) ??
      null;

    if (ts == null && it?.when) {
      const d = new Date(String(it.when));
      if (isFinite(d.getTime())) ts = d.getTime();
    }
    if (ts == null) continue;

    const impact = toImpact(it?.impact ?? it?.importance ?? it?.priority);
    const expected = String(it?.expected ?? it?.forecast ?? it?.consensus ?? "").trim() || undefined;
    const prior = String(it?.previous ?? it?.prior ?? "").trim() || undefined;

    out.push({ ts, ccy, title, impact, expected, prior });
  }
  return out;
}

function tightenCalendarForInstrument(
  calendar: any[],
  instrument: string,
  nowMs: number,
  horizonHours = 48,
  maxBullets = 5
) {
  const { base, quote } = parseInstrumentCurrencies(instrument);
  const whitelist = new Set([toUpper(base), toUpper(quote)].filter(Boolean));
  const minTs = nowMs;
  const maxTs = nowMs + horizonHours * 3600 * 1000;

  const norm = normalizeCalendarArray(calendar);
  const filtered = norm.filter((e) => {
    if (!(e.ts >= minTs && e.ts <= maxTs)) return false;
    if (!(e.impact === "high" || e.impact === "medium")) return false;
    if (whitelist.size > 0 && e.ccy) return whitelist.has(e.ccy);
    return true;
  });

  const map = new Map<string, CalNorm>();
  for (const e of filtered) {
    const key = `${e.title}|${e.ts}`;
    if (!map.has(key)) map.set(key, e);
  }

  const arr = Array.from(map.values()).sort((a, b) => a.ts - b.ts);
  const top = arr.slice(0, maxBullets);

  const bullets: string[] = [];
  const hiTimes: string[] = [];

  for (const e of top) {
    const dt = new Date(e.ts);
    const hh = String(dt.getUTCHours()).padStart(2, "0");
    const mm = String(dt.getUTCMinutes()).padStart(2, "0");
    const timeUTC = `${hh}:${mm} UTC`;

    if (e.impact === "high") hiTimes.push(`${timeUTC} ${e.ccy || ""}`.trim());

    const exp = e.expected ? ` — exp ${e.expected}` : "";
    const prior = e.prior ? ` (prior ${e.prior})` : "";
    const imp = e.impact !== "unknown" ? ` — ${e.impact}` : "";
    const ccy = e.ccy ? ` — ${e.ccy}` : "";

    bullets.push(`• ${timeUTC} — ${e.title}${ccy}${exp}${prior}${imp}`);
  }

  const risk =
    hiTimes.length > 0
      ? `Risk windows (high impact): ${hiTimes.join(" · ")}`
      : "";

  return { bullets: bullets.join("\n"), risk };
}

// ---------- prompt & extraction ----------
function buildMessages(system: string, userContent: string) {
  return [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];
}

function extractTextFromChat(json: any): string {
  try {
    const msg = json?.choices?.[0]?.message;

    if (typeof msg?.content === "string") return msg.content.trim();

    if (Array.isArray(msg?.content)) {
      const pieces: string[] = [];
      for (const part of msg.content) {
        if (typeof part === "string") pieces.push(part);
        else if (typeof (part as any)?.text === "string") pieces.push((part as any).text);
        else if (typeof (part as any)?.content === "string") pieces.push((part as any).content);
        else if (
          typeof (part as any)?.type === "string" &&
          typeof (part as any)?.text === "string"
        ) {
          pieces.push((part as any).text);
        }
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
  const body: any = { model, messages };
  if (isGpt5(model)) body.max_completion_tokens = 800;
  else body.max_tokens = 800;

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
  try { json = JSON.parse(text); } catch {}
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
      calendar = [],  // optional
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

    // Tighten calendar (Option A) if provided
    let calendarBlock = "";
    if (Array.isArray(calendar) && calendar.length) {
      const nowMs = Date.now();
      const tight = tightenCalendarForInstrument(calendar, String(instrument || ""), nowMs, 48, 5);
      if (tight.bullets) {
        calendarBlock = `Calendar (next 48h):\n${tight.bullets}`;
        if (tight.risk) calendarBlock += `\n${tight.risk}`;
      }
    }

    // Sentiment (intraday CSM + COT) with short timeouts and cache
    let sentimentLine = "";
    try {
      const [csm, cot] = await Promise.all([
        getCurrencyStrengthIntraday({ range: "1d", interval: "15m", ttlSec: 120, timeoutMs: 1200 }),
        getCotBiasBrief({ ttlSec: 86400, timeoutMs: 1200 }),
      ]);
      const csmLine = formatStrengthLine(csm);
      const { base, quote } = parseInstrumentCurrencies(String(instrument || ""));
      const cotLine = formatCotLine(cot, [base || "", quote || ""].filter(Boolean));
      const parts = [csmLine, cotLine].filter(Boolean);
      if (parts.length) sentimentLine = `Sentiment (intraday): ${parts.join(" | ")}`;
    } catch {
      // swallow sentiment failures
      sentimentLine = "";
    }

    const contextParts: string[] = [];
    if (instrument) contextParts.push(`Instrument: ${toUpper(instrument)}`);
    if (planText) contextParts.push(`Current Trade Plan:\n${asString(planText)}`);
    if (headlinesText) contextParts.push(`Recent headlines snapshot:\n${headlinesText}`);
    if (calendarBlock) contextParts.push(calendarBlock);
    if (sentimentLine) contextParts.push(sentimentLine);

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
