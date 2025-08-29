// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle } from "../../lib/prices";

type PlanOk = { ok: true; text: string; conviction?: number; meta?: any };
type PlanFail = { ok: false; reason: string };
type PlanResp = PlanOk | PlanFail;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// --- helpers ---
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const nowIso = () => new Date().toISOString();
const toJSON = (x: any) => {
  try { return JSON.stringify(x); } catch { return "{}"; }
};
const parseMaybeJSON = (s: string) => {
  try { return JSON.parse(s); } catch { return null; }
};

function tickSizeFor(sym: string): number {
  const s = sym.toUpperCase();
  if (s.includes("XAU")) return 0.1;
  if (s.includes("XAG")) return 0.01;
  if (s.endsWith("JPY")) return 0.01;
  if (s.includes("BTC") || s.includes("ETH")) return 1;
  if (/^(US30|DJI|US100|NAS100|NDX|US500|SPX|GER40|DE40|UK100|FTSE|DAX|CAC40|EU50|HK50|JP225)/.test(s)) return 1;
  // default FX
  return 0.0001;
}
const roundToTick = (n: number, tick: number) => Math.round(n / tick) * tick;

function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  // If VERCEL_URL lacks protocol, prepend proto
  if (host.startsWith("http")) return host;
  return `${proto}://${host}`;
}

async function safeGET<T = any>(url: string, opts?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { ...(opts || {}), method: "GET", headers: { "content-type": "application/json", ...(opts?.headers || {}) } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function compressCandles(series: Candle[], every = 1, max = 240) {
  // Downsample to reduce tokens, keep OHLC + iso time, rounded to sensible precision
  const take = Math.min(series.length, max);
  const sliced = series.slice(series.length - take);
  const step = Math.max(1, every);
  return sliced.filter((_, i) => i % step === 0).map(c => ({
    t: new Date(c.t).toISOString(),
    o: c.o, h: c.h, l: c.l, c: c.c,
  }));
}

function buildLLMSystem(instrument: string, tick: number) {
  return [
    "You are Trade Plan Assistant.",
    "Task: Produce a DAILY TRADE PLAN using ONLY the data provided (candles, headlines, calendar).",
    "Rules:",
    "- No invention. Never fabricate prices, events, or levels.",
    "- Derive Entry/SL/TP from real structure: swings, order blocks (OB), fair value gaps (FVG), BOS/retest, fib confluence, S/R flips, liquidity sweeps.",
    "- 15m = execution chart; 1H & 4H = context. Prefer entries at zones (pullback) or validated breakouts (close-based BOS).",
    "- SL must be at a logical invalidation: below/above swing/OB/FVG edge (+ small buffer), not arbitrary.",
    "- TP1/TP2 should be realistic: next structure(s) or ≥1R if structure is far; never a few ticks from entry.",
    `- Round all prices to tick size = ${tick}.`,
    "- Fundamentals: read headlines & calendar to form bias. Include Headline & Geopolitical Snapshot.",
    "- If a high-impact event is imminent (< 90 min), warn explicitly in Event Watch and keep conviction modest.",
    "- ALWAYS output the full card in the exact template sections.",
    "- If setup quality is weak, still propose a trade (low conviction) and state why.",
    "",
    "Template sections (exact order & headings):",
    "Quick Plan (Actionable)",
    "Full Breakdown",
    "Advanced Reasoning (Pro-Level Context)",
    "News / Event Watch",
    "Notes",
    "",
    "In Quick Plan include:",
    "- Direction, Order Type (Buy/Sell Limit/Stop/Market), Trigger, Entry, Stop Loss, Take Profit(s) TP1/TP2, Conviction %, Setup, Short Reasoning.",
    "",
    "In Full Breakdown include:",
    "- Technical View (HTF + Intraday): 4H, 1H, 15m trends/structure.",
    "- Signals Triggered (BOS/OB/FVG/SR flip/liquidity sweep/fibs/etc).",
    "- Fundamental View (Calendar + Sentiment).",
    "- Tech vs Fundy Alignment (Match/Mixed/Conflict).",
    "- Conditional Scenarios, Surprise Risk, Invalidation.",
    "",
    "In Advanced Reasoning include:",
    "- Priority Bias (fundamentals).",
    "- Structure Context (zones & reasons for Entry/SL/TP).",
    "- Confirmation Logic (what must print on 15m before entry).",
    "- How fundamentals strengthen/weakens the setup.",
    "- Scenario Planning (pre/post-event).",
    "",
    "Finally, output as JSON inside a fenced code block:",
    "```json",
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
    '  "scenarios": ["..."],',
    '  "invalidation": "string",',
    '  "card_text": "Full multiline card exactly in the template sections above"',
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
  // Keep payload compact but informative
  const payload = {
    instrument,
    generated_at: nowIso(),
    candles: {
      m15: compressCandles(m15, 1, 240),
      h1: compressCandles(h1, 1, 240),
      h4: compressCandles(h4, 1, 240),
    },
    headlines: (Array.isArray(headlines) ? headlines : []).slice(0, 25).map((h: any) => ({
      title: String(h?.title || "").slice(0, 220),
      source: h?.source || h?.provider || "",
      published_at: h?.published_at || h?.pubDate || h?.date || null,
      url: h?.url || h?.link || "",
      sentiment: typeof h?.sentiment?.score === "number" ? h.sentiment.score : null,
    })),
    calendar: {
      ok: !!calendar?.ok,
      bias: calendar?.bias || null,
      items: Array.isArray(calendar?.items)
        ? calendar.items.slice(0, 30).map((e: any) => ({
            time: e?.time || e?.date || null,
            impact: e?.impact || e?.importance || null,
            title: e?.title || e?.event || "",
            currency: e?.currency || e?.country || "",
            isBlackout: !!e?.isBlackout,
          }))
        : [],
    },
  };
  return payload;
}

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
      temperature: 0.2,
      response_format: { type: "text" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: "Here is the real market context (JSON):" },
        { role: "user", content: "```json\n" + toJSON(user) + "\n```" },
        { role: "user", content: "Generate the plan now. Follow the template strictly and return a JSON object inside a single ```json fenced block as specified." },
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
  // Find the last ```json ... ``` block
  const re = /```json\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  let last: string | null = null;
  while ((match = re.exec(text)) !== null) last = match[1];
  if (!last) return null;
  return parseMaybeJSON(last.trim());
}

// --- API handler ---
export default async function handler(req: NextApiRequest, res: NextApiResponse<PlanResp>) {
  try {
    // 1) Inputs
    const body = typeof req.body === "string" ? parseMaybeJSON(req.body) || {} : (req.body || {});
    const instrument = String(body.instrument || body.code || req.query.instrument || req.query.code || "EURUSD")
      .toUpperCase()
      .replace(/\s+/g, "");
    const passHeadlines = Array.isArray(body.headlines) ? body.headlines : null;
    const passCalendar = body.calendar ?? null;

    // 2) Candles (real)
    const [m15, h1, h4] = await Promise.all([
      getCandles(instrument, "15m", 360),
      getCandles(instrument, "1h",  360),
      getCandles(instrument, "4h",  360),
    ]);
    if (!Array.isArray(m15) || m15.length < 60) {
      return res.status(200).json({ ok: false, reason: "Missing 15m candles" });
    }
    // 3) Headlines + Calendar (use provided or fetch from local endpoints)
    let headlines = passHeadlines;
    let calendar = passCalendar;
    const base = originFromReq(req);

    if (!headlines) {
      // try multiple param names for your existing endpoint shape
      const url1 = `${base}/api/news?instrument=${encodeURIComponent(instrument)}&hours=48`;
      const url2 = `${base}/api/news?symbol=${encodeURIComponent(instrument)}&hours=48`;
      headlines = (await safeGET<any>(url1)) || (await safeGET<any>(url2)) || [];
      // Try shape normalization if endpoint returns {ok, items}
      if (headlines && headlines.ok && Array.isArray(headlines.items)) headlines = headlines.items;
    }

    if (!calendar) {
      const url1 = `${base}/api/calendar?instrument=${encodeURIComponent(instrument)}&hours=48`;
      const url2 = `${base}/api/calendar?symbol=${encodeURIComponent(instrument)}&windowHours=48`;
      calendar = (await safeGET<any>(url1)) || (await safeGET<any>(url2)) || { ok: false, items: [] };
    }

    // 4) Build LLM prompt
    const tick = tickSizeFor(instrument);
    const system = buildLLMSystem(instrument, tick);
    const userPayload = buildLLMUserPayload({ instrument, m15, h1, h4, headlines: headlines || [], calendar: calendar || {} });

    // 5) Call OpenAI
    let llmContent = "";
    try {
      llmContent = await callOpenAI(system, userPayload);
    } catch (e: any) {
      // Continue to fallback
      console.error("OpenAI call failed:", e?.message || e);
    }

    // 6) Parse LLM JSON and build final text
    let cardText = "";
    let conviction: number | undefined = undefined;
    let meta: any = undefined;

    const parsed = llmContent ? extractJSONFromFenced(llmContent) : null;
    if (parsed && typeof parsed === "object") {
      // basic sanity & rounding
      const tickDec = (tick.toString().split(".")[1]?.length || 0);
      const round = (n: any) => {
        const x = Number(n);
        return Number.isFinite(x) ? Number(roundToTick(x, tick).toFixed(tickDec)) : x;
      };
      if (typeof parsed.entry === "number") parsed.entry = round(parsed.entry);
      if (typeof parsed.stop_loss === "number") parsed.stop_loss = round(parsed.stop_loss);
      if (typeof parsed.take_profit_1 === "number") parsed.take_profit_1 = round(parsed.take_profit_1);
      if (typeof parsed.take_profit_2 === "number") parsed.take_profit_2 = round(parsed.take_profit_2);

      conviction = typeof parsed.conviction === "number" ? clamp(Math.round(parsed.conviction), 25, 95) : undefined;
      cardText = String(parsed.card_text || "").trim();
      meta = parsed;
    }

    // 7) Fallback if LLM didn’t return card_text
    if (!cardText) {
      // Conservative structure-only fallback (clearly labeled)
      const last = m15[m15.length - 1]?.c ?? 0;
      const fallback = [
        "Quick Plan (Actionable)",
        "",
        `• Direction: Flat (LLM unavailable)`,
        `• Order Type: —`,
        `• Trigger: —`,
        `• Entry: ${last || "—"}`,
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
