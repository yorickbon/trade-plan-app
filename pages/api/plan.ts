// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle } from "../../lib/prices";

type PlanOk = { ok: true; text: string; conviction?: number; meta?: any };
type PlanFail = { ok: false; reason: string };
type PlanResp = PlanOk | PlanFail;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/* --------------------------- small numeric utils --------------------------- */
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const nowIso = () => new Date().toISOString();
const toJSON = (x: any) => { try { return JSON.stringify(x); } catch { return "{}"; } };
const parseMaybeJSON = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

const H = (a: Candle[]) => a.map(c => c.h);
const L = (a: Candle[]) => a.map(c => c.l);
const C = (a: Candle[]) => a.map(c => c.c);

function atr(Hh: number[], Ll: number[], Cc: number[], period = 14) {
  if (Hh.length < period + 1) return 0;
  const tr: number[] = [];
  for (let i = 1; i < Hh.length; i++) {
    const a = Hh[i] - Ll[i];
    const b = Math.abs(Hh[i] - Cc[i - 1]);
    const c = Math.abs(Ll[i] - Cc[i - 1]);
    tr.push(Math.max(a, b, c));
  }
  const last = tr.slice(-period);
  return last.reduce((s, x) => s + x, 0) / last.length;
}

/* --------------------------- tick size per symbol -------------------------- */
function tickSizeFor(sym: string): number {
  const s = sym.toUpperCase();
  if (s.endsWith("JPY")) return 0.01;
  if (s.includes("XAU")) return 0.1;
  if (s.includes("XAG")) return 0.01;
  if (s.includes("BTC") || s.includes("ETH")) return 1;
  if (/^(US30|DJI|US100|NAS100|NDX|US500|SPX|GER40|DE40|UK100|FTSE|DAX|CAC40|EU50|HK50|JP225)/.test(s)) return 1;
  return 0.0001; // default FX
}
const roundToTick = (n: number, t: number) => Math.round(n / t) * t;

/* ------------------------------ HTTP helpers ------------------------------ */
function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  if (host.startsWith("http")) return host;
  return `${proto}://${host}`;
}
async function safeGET<T = any>(url: string, opts?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { ...(opts || {}), method: "GET", headers: { "content-type": "application/json", ...(opts?.headers || {}) } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

/* -------------------------- swing/structure utils ------------------------- */
// Simple fractal swing detection (pivot with k bars on each side)
function swings(series: Candle[], k = 2) {
  const out: { idx: number; type: "H" | "L"; price: number }[] = [];
  for (let i = k; i < series.length - k; i++) {
    const hi = series[i].h, lo = series[i].l;
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (!(hi > series[i - j].h && hi > series[i + j].h)) isH = false;
      if (!(lo < series[i - j].l && lo < series[i + j].l)) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) out.push({ idx: i, type: "H", price: hi });
    if (isL) out.push({ idx: i, type: "L", price: lo });
  }
  return out.sort((a,b)=>a.idx-b.idx);
}

function labelTrend(series: Candle[], k = 2) {
  const sw = swings(series, k);
  const last = sw.slice(-6);
  let upSeq = 0, dnSeq = 0;
  for (let i = 1; i < last.length; i++) {
    const prev = last[i-1], cur = last[i];
    if (prev.type === "H" && cur.type === "H" && cur.price > prev.price) upSeq++;
    if (prev.type === "L" && cur.type === "L" && cur.price < prev.price) dnSeq++;
  }
  const closes = C(series).slice(-20);
  const drift = closes[closes.length - 1] - closes[0];
  if (upSeq >= 2 && drift > 0) return "up";
  if (dnSeq >= 2 && drift < 0) return "down";
  return "range";
}

/* ------------------------- payload shaping functions ---------------------- */
function compressCandles(series: Candle[], step = 1, maxBars = 240) {
  const take = Math.min(series.length, maxBars);
  const sliced = series.slice(series.length - take);
  const s = Math.max(1, step);
  return sliced.filter((_, i) => i % s === 0).map(c => ({
    t: new Date(c.t).toISOString(),
    o: c.o, h: c.h, l: c.l, c: c.c,
  }));
}

function summarizeHeadlines(headlines: any[]) {
  const out = { pos: 0, neg: 0, neu: 0, examples: [] as string[] };
  for (const h of headlines || []) {
    const s = typeof h?.sentiment?.score === "number" ? h.sentiment.score : 0;
    if (s > 0.05) out.pos++;
    else if (s < -0.05) out.neg++;
    else out.neu++;
    if (out.examples.length < 6 && h?.title) out.examples.push(String(h.title).slice(0, 160));
  }
  let bias: "bullish"|"bearish"|"neutral" = "neutral";
  if (out.pos > out.neg + 1) bias = "bullish";
  else if (out.neg > out.pos + 1) bias = "bearish";
  return { ...out, bias };
}

function buildLLMSystem(instrument: string, tick: number) {
  return [
    "You are Trade Plan Assistant.",
    "Use ONLY the provided candles, strict timeframe structure summary, headlines, and calendar.",
    "Do NOT fabricate numbers, events, or levels.",
    "",
    "HARD RULES:",
    `- Tick size = ${tick}. Round all prices to this tick.`,
    "- Per-timeframe trend is independent: classify 4H, 1H, 15m strictly from their own structure.",
    "- If order_type = Market → entry MUST equal current_price (rounded).",
    "- Buy Limit → entry <= current_price. Sell Limit → entry >= current_price.",
    "- Buy Stop  → entry >= current_price. Sell Stop  → entry <= current_price.",
    "- SL MUST be beyond invalidation (swing/OB/FVG edge) by safety buffer: max(3 ticks, 0.2×ATR15). Never exactly on the level.",
    "- TP1/TP2: target structure or ≥1.0R for TP1 if structure is far; never a few ticks from entry.",
    "- 15m = execution; 1H & 4H = context. Entry must be at a zone (OB/FVG/Fib 0.5–0.618) or a confirmed BOS breakout.",
    "- Fundamentals: derive bias from headlines & calendar. Avoid 'neutral' unless pos≈neg or no meaningful headlines.",
    "- If high-impact event is within ~90 min, warn explicitly and moderate conviction.",
    "- If TFs conflict (e.g., 4H up, 1H/15m down), lower conviction and say so.",
    "",
    "OUTPUT: Return ONE JSON object in a single ```json fenced block:",
    "{",
    '  "direction": "Long|Short|Flat",',
    '  "order_type": "Buy Limit|Sell Limit|Buy Stop|Sell Stop|Market",',
    '  "entry": number, "stop_loss": number, "take_profit_1": number, "take_profit_2": number,',
    '  "conviction": number,',
    '  "setup": "string", "short_reason": "string",',
    '  "signals": ["..."],',
    '  "tview": { "h4": "string", "h1": "string", "m15": "string" },',
    '  "fundamentals": { "bias": "bullish|bearish|neutral", "headline_snapshot": ["..."], "calendar_watch": ["..."] },',
    '  "alignment": "Match|Mixed|Conflict",',
    '  "scenarios": ["..."] ,',
    '  "invalidation": "string",',
    '  "card_text": "Full multiline card in sections: Quick Plan (Actionable) → Full Breakdown → Advanced Reasoning (Pro-Level Context) → News / Event Watch → Notes"',
    "}",
    "```",
  ].join("\n");
}

function buildLLMUserPayload(params: {
  instrument: string;
  m15: Candle[];
  h1: Candle[];
  h4: Candle[];
  headlines: any[];
  calendar: any;
}) {
  const { instrument, m15, h1, h4, headlines, calendar } = params;

  const Hh15 = H(m15), Ll15 = L(m15), Cc15 = C(m15);
  const A15 = atr(Hh15, Ll15, Cc15, 14);
  const last = Cc15.at(-1) || 0;

  // strict TF labels from swings so LLM can't hand-wave
  const tf_summary = {
    h4: labelTrend(h4, 2),  // "up"|"down"|"range"
    h1: labelTrend(h1, 2),
    m15: labelTrend(m15, 2),
  };

  // headline sentiment & blackout watch
  const sentiment = summarizeHeadlines(headlines);
  const now = Date.now();
  const blackoutWatch: string[] = [];
  const calItems = Array.isArray(calendar?.items) ? calendar.items.slice(0, 30) : [];
  for (const e of calItems) {
    const t = e?.time || e?.date;
    const imp = (e?.impact || e?.importance || "").toString().toLowerCase();
    if (!t) continue;
    const ts = Date.parse(t);
    if (!Number.isFinite(ts)) continue;
    const mins = Math.abs(ts - now) / 60000;
    if (mins <= 90 && (imp.includes("high") || imp.includes("red") || e?.isBlackout)) {
      blackoutWatch.push(`${e?.title || "Event"} (${e?.currency || ""}) @ ${t}`);
    }
  }

  return {
    instrument,
    generated_at: nowIso(),
    current_price: last,
    atr15: A15,
    tick_size: tickSizeFor(instrument),
    tf_summary,                   // enforced structure summary
    sentiment_summary: sentiment, // avoids constant "neutral"
    candles: {
      m15: compressCandles(m15, 1, 240),
      h1:  compressCandles(h1, 1, 240),
      h4:  compressCandles(h4, 1, 240),
    },
    headlines: (Array.isArray(headlines) ? headlines : []).slice(0, 24).map((h: any) => ({
      title: String(h?.title || "").slice(0, 220),
      source: h?.source || h?.provider || "",
      published_at: h?.published_at || h?.pubDate || h?.date || null,
      url: h?.url || h?.link || "",
      sentiment: typeof h?.sentiment?.score === "number" ? h.sentiment.score : null,
    })),
    calendar: {
      ok: !!calendar?.ok,
      bias: calendar?.bias || null,
      blackoutWithin90m: blackoutWatch,
      items: calItems.map((e: any) => ({
        time: e?.time || e?.date || null,
        impact: e?.impact || e?.importance || null,
        title: e?.title || e?.event || "",
        currency: e?.currency || e?.country || "",
        isBlackout: !!e?.isBlackout,
      })),
    },
  };
}

/* ------------------------------- OpenAI call ------------------------------- */
async function callOpenAI(system: string, user: any) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.15,
      messages: [
        { role: "system", content: system },
        { role: "user", content: "Here is the real market context (JSON):" },
        { role: "user", content: "```json\n" + toJSON(user) + "\n```" },
        { role: "user", content: "Generate the plan now. Obey all hard rules. Return a single ```json block as specified." },
      ],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenAI error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const content: string = data?.choices?.[0]?.message?.content || "";
  return content;
}
function extractJSONFromFenced(text: string): any | null {
  const re = /```json\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null = null;
  let last: string | null = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (!last) return null;
  return parseMaybeJSON(last.trim());
}

/* --------------------------------- handler -------------------------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse<PlanResp>) {
  try {
    // Inputs
    const body = typeof req.body === "string" ? parseMaybeJSON(req.body) || {} : (req.body || {});
    const instrument = String(body.instrument || body.code || req.query.instrument || req.query.code || "EURUSD")
      .toUpperCase().replace(/\s+/g, "");
    const passHeadlines = Array.isArray(body.headlines) ? body.headlines : null;
    const passCalendar = body.calendar ?? null;

    // Candles (real)
    const [m15, h1, h4] = await Promise.all([
      getCandles(instrument, "15m", 360),
      getCandles(instrument, "1h",  360),
      getCandles(instrument, "4h",  360),
    ]);
    if (!Array.isArray(m15) || m15.length < 60) {
      return res.status(200).json({ ok: false, reason: "Missing 15m candles" });
    }

    // Headlines + Calendar
    let headlines = passHeadlines;
    let calendar = passCalendar;
    const base = originFromReq(req);
    if (!headlines) {
      const u1 = `${base}/api/news?instrument=${encodeURIComponent(instrument)}&hours=48`;
      const u2 = `${base}/api/news?symbol=${encodeURIComponent(instrument)}&hours=48`;
      headlines = (await safeGET<any>(u1)) || (await safeGET<any>(u2)) || [];
      if (headlines && headlines.ok && Array.isArray(headlines.items)) headlines = headlines.items;
    }
    if (!calendar) {
      const u1 = `${base}/api/calendar?instrument=${encodeURIComponent(instrument)}&hours=48`;
      const u2 = `${base}/api/calendar?symbol=${encodeURIComponent(instrument)}&windowHours=48`;
      calendar = (await safeGET<any>(u1)) || (await safeGET<any>(u2)) || { ok: false, items: [] };
    }

    // Prompt + call
    const tick = tickSizeFor(instrument);
    const system = buildLLMSystem(instrument, tick);
    const userPayload = buildLLMUserPayload({ instrument, m15, h1, h4, headlines: headlines || [], calendar: calendar || {} });

    let content = "";
    try { content = await callOpenAI(system, userPayload); }
    catch (e: any) { console.error("OpenAI error:", e?.message || e); }

    // Parse + enforce rules
    const parsed = content ? extractJSONFromFenced(content) : null;

    const last = C(m15).at(-1) || 0;
    const A15 = atr(H(m15), L(m15), C(m15), 14);
    const tickDec = (tick.toString().split(".")[1]?.length || 0);
    const round = (n: any) => Number.isFinite(Number(n)) ? Number(roundToTick(Number(n), tick).toFixed(tickDec)) : n;
    const slBuf = Math.max(3 * tick, 0.2 * A15);
    const minTPDist = (risk: number) => Math.max(1.0 * risk, 0.3 * A15);

    let cardText = "";
    let conviction: number | undefined;
    let meta: any;

    if (parsed && typeof parsed === "object") {
      let { direction, order_type, entry, stop_loss, take_profit_1, take_profit_2 } = parsed;

      entry = round(entry);
      stop_loss = round(stop_loss);
      take_profit_1 = round(take_profit_1);
      take_profit_2 = round(take_profit_2);

      // Entry consistency with current price & order type
      if (order_type === "Market") entry = round(last);
      else if (order_type === "Buy Limit" && entry > last) entry = round(last);
      else if (order_type === "Sell Limit" && entry < last) entry = round(last);
      else if (order_type === "Buy Stop" && entry < last) entry = round(last);
      else if (order_type === "Sell Stop" && entry > last) entry = round(last);

      // SL safety buffer beyond invalidation
      if (typeof stop_loss === "number" && typeof entry === "number") {
        const dist = Math.abs(entry - stop_loss);
        if (dist < slBuf) {
          const isLong = (direction || "").toLowerCase() === "long" || order_type?.startsWith("Buy");
          stop_loss = isLong ? round(entry - slBuf) : round(entry + slBuf);
        }
      }

      // TP1 minimum distance (avoid micro TP)
      const risk = (typeof entry === "number" && typeof stop_loss === "number") ? Math.abs(entry - stop_loss) : 0;
      const needTP1 = minTPDist(risk);
      if (typeof take_profit_1 === "number" && typeof entry === "number" && needTP1 > 0) {
        const d = Math.abs(take_profit_1 - entry);
        if (d < needTP1) {
          const isLong = (direction || "").toLowerCase() === "long";
          take_profit_1 = isLong ? round(entry + needTP1) : round(entry - needTP1);
        }
      }

      parsed.entry = entry;
      parsed.stop_loss = stop_loss;
      parsed.take_profit_1 = take_profit_1;
      parsed.take_profit_2 = take_profit_2;

      // Penalize conviction if TFs don’t align (strict, like manual)
      const tf = userPayload.tf_summary;
      let misalignPenalty = 0;
      if (tf.h4 === "up" && (tf.h1 !== "up" || tf.m15 !== "up")) misalignPenalty += 12;
      if (tf.h4 === "down" && (tf.h1 !== "down" || tf.m15 !== "down")) misalignPenalty += 12;
      if (tf.h1 !== tf.m15) misalignPenalty += 6;

      const rawConv = typeof parsed.conviction === "number" ? parsed.conviction : 55;
      conviction = clamp(Math.round(rawConv - misalignPenalty), 25, 95);

      cardText = String(parsed.card_text || "").trim();
      meta = { ...parsed, enforced: { sl_buffer: slBuf, min_tp1: needTP1, current_price: round(last), tf_summary: tf } };
    }

    // Safe fallback if LLM didn’t return card_text
    if (!cardText) {
      const fallback = [
        "Quick Plan (Actionable)",
        "",
        `• Direction: Flat (LLM unavailable)`,
        `• Order Type: —`,
        `• Trigger: —`,
        `• Entry: ${round(last)}`,
        `• Stop Loss: —`,
        `• Take Profit(s): TP1 — / TP2 —`,
        `• Conviction: 30%`,
        `• Setup: Conservative Hold`,
        `• Short Reasoning: LLM reasoning temporarily unavailable. Using latest price as reference only.`,
        "",
        "Full Breakdown",
        "",
        "• Technical View (HTF + Intraday): Using raw candles; no AI narrative.",
        "• Signals Triggered: —",
        "• Fundamental View (Calendar + Sentiment): Headlines/Calendar loaded; no AI synthesis.",
        "• Tech vs Fundy Alignment: Mixed",
        "• Conditional Scenarios:",
        "  - Wait for clear 15m structure (BOS + pullback into OB/FVG) before considering entry.",
        "• Surprise Risk: Unscheduled headlines.",
        "• Invalidation: —",
        "",
        "Advanced Reasoning (Pro-Level Context)",
        "",
        "• Priority Bias (fundamentals): —",
        "• Structure Context: —",
        "• Confirmation Logic: Wait for 15m confirmation.",
        "• Fundamentals vs Technicals: —",
        "• Scenario Planning: —",
        "",
        "News / Event Watch",
        ...(Array.isArray(calendar?.items) && calendar.items.length
          ? calendar.items.slice(0, 6).map((e: any) => `• ${e?.impact || ""} ${e?.title || ""} (${e?.currency || ""}) @ ${e?.time || ""}`)
          : ["• No calendar connected or no events in window."]),
        "",
        "Notes",
        "",
        `• Symbol: ${instrument}`,
      ].join("\n");
      return res.status(200).json({ ok: true, text: fallback, conviction: 30, meta: { fallback: true } });
    }

    return res.status(200).json({ ok: true, text: cardText, conviction, meta });
  } catch (err: any) {
    console.error("Plan generation error", err);
    return res.status(200).json({ ok: false, reason: err?.message || "Plan generation failed" });
  }
}
