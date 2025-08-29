// pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getCandles, type Candle } from "../../lib/prices";

type PlanOk = { ok: true; text: string; conviction?: number; meta?: any };
type PlanFail = { ok: false; reason: string };
type PlanResp = PlanOk | PlanFail;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/* ---------------------------- numeric helpers ----------------------------- */
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const nowIso = () => new Date().toISOString();
const toJSON = (x: any) => { try { return JSON.stringify(x); } catch { return "{}"; } };
const parseMaybeJSON = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

const H = (a: Candle[]) => a.map(c => c.h);
const L = (a: Candle[]) => a.map(c => c.l);
const C = (a: Candle[]) => a.map(c => c.c);

/* -------------------------------- ATR(14) --------------------------------- */
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
  return 0.0001; // FX default
}
const roundToTick = (n: number, t: number) => Math.round(n / t) * t;

/* ------------------------------- HTTP utils -------------------------------- */
function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || process.env.VERCEL_URL || "localhost:3000";
  if (host.startsWith("http")) return host;
  return `${proto}://${host}`;
}
async function safeGET<T = any>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { method: "GET", headers: { "content-type": "application/json" } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

/* -------------------------- swing/structure helpers ------------------------ */
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
  const drift = closes.length ? (closes[closes.length-1] - closes[0]) : 0;
  if (upSeq >= 2 && drift > 0) return "up";
  if (dnSeq >= 2 && drift < 0) return "down";
  return "range";
}

function lastSupportResistance(m15: Candle[]) {
  const sw = swings(m15, 2);
  const lastH = [...sw].reverse().find(s => s.type === "H");
  const lastL = [...sw].reverse().find(s => s.type === "L");
  return { lastHigh: lastH?.price ?? null, lastLow: lastL?.price ?? null };
}

/* ------------------------- headline sentiment quick ------------------------ */
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

/* -------------------------- deterministic plan core ------------------------ */
type PlanCore = {
  direction: "Long" | "Short" | "Flat",
  order_type: "Buy Limit" | "Sell Limit" | "Buy Stop" | "Sell Stop" | "Market",
  entry: number, stop: number, tp1: number, tp2: number,
  setup: string, short_reason: string,
  signals: string[], tview: { h4:string, h1:string, m15:string },
  alignment: "Match"|"Mixed"|"Conflict",
  fundamentals: { bias: "bullish"|"bearish"|"neutral", headline_snapshot: string[], calendar_watch: string[] },
  scenarios: string[], invalidation: string, conviction: number
};

function tickRounder(instrument: string) {
  const tick = tickSizeFor(instrument);
  const dec = (tick.toString().split(".")[1]?.length || 0);
  return { tick, dec, rnd: (n: number) => Number(roundToTick(n, tick).toFixed(dec)) };
}

function buildDeterministicPlan(params: {
  instrument: string,
  m15: Candle[], h1: Candle[], h4: Candle[],
  headlines: any[], calendar: any
}) {
  const { instrument, m15, h1, h4, headlines, calendar } = params;

  const { tick, rnd } = tickRounder(instrument);
  const last = C(m15).at(-1) || 0;
  const A15 = atr(H(m15), L(m15), C(m15), 14);
  const slBuf = Math.max(3*tick, 0.2*A15);
  const minTPFromRisk = (risk: number) => Math.max(1.0*risk, 0.3*A15);

  const tview = {
    h4: labelTrend(h4, 2),
    h1: labelTrend(h1, 2),
    m15: labelTrend(m15, 2),
  };
  const { lastHigh, lastLow } = lastSupportResistance(m15);

  const sent = summarizeHeadlines(headlines);
  const calWatch: string[] = [];
  const now = Date.now();
  for (const e of (calendar?.items || [])) {
    const t = e?.time || e?.date;
    const imp = (e?.impact || e?.importance || "").toString().toLowerCase();
    if (!t) continue;
    const ts = Date.parse(t);
    if (!Number.isFinite(ts)) continue;
    const mins = Math.abs(ts - now) / 60000;
    if (mins <= 90 && (imp.includes("high") || imp.includes("red") || e?.isBlackout)) {
      calWatch.push(`${e?.title || "Event"} (${e?.currency || ""}) @ ${t}`);
    }
  }

  // Choose direction
  let dir: PlanCore["direction"] = "Flat";
  if (tview.h4 === "up" && (tview.h1 === "up" || tview.m15 === "up")) dir = "Long";
  else if (tview.h4 === "down" && (tview.h1 === "down" || tview.m15 === "down")) dir = "Short";
  else if (tview.m15 === "up" && sent.bias === "bullish") dir = "Long";
  else if (tview.m15 === "down" && sent.bias === "bearish") dir = "Short";
  if (dir === "Flat") {
    // range mean-reversion toward nearest structure
    if (lastLow && last < (lastLow + ((lastHigh ?? lastLow) - lastLow) * 0.35)) dir = "Long";
    else if (lastHigh && last > (lastHigh - ((lastHigh - (lastLow ?? lastHigh)) * 0.35))) dir = "Short";
  }

  // Initial numbers (pullback)
  let order: PlanCore["order_type"] = "Buy Limit";
  let entry = last, stop = last, tp1 = last, tp2 = last;
  const signals: string[] = [];
  let setup = "", short_reason = "";

  if (dir === "Long") {
    order = "Buy Limit";
    const support = lastLow ?? (last - A15*0.8);
    const pullbackMid = support + Math.max(0, (last - support)) * 0.5;
    entry = rnd(pullbackMid);
    stop = rnd(entry - slBuf);
    const risk = Math.abs(entry - stop);
    tp1 = rnd(Math.max(entry + minTPFromRisk(risk), (lastHigh ?? entry + 1.5*risk)));
    tp2 = rnd(Math.max(tp1 + 0.5*risk, tp1 + minTPFromRisk(risk)*0.6));
    setup = "Pullback (OB/FVG + Fib 0.5) Long";
    short_reason = "Buy the dip toward 15m support; SL beyond swing w/ ATR buffer.";
    signals.push("OB","FVG","Fib0.5");
  } else if (dir === "Short") {
    order = "Sell Limit";
    const resistance = lastHigh ?? (last + A15*0.8);
    const pullbackMid = resistance - Math.max(0, (resistance - last)) * 0.5;
    entry = rnd(pullbackMid);
    stop = rnd(entry + slBuf);
    const risk = Math.abs(entry - stop);
    tp1 = rnd(Math.min(entry - minTPFromRisk(risk), (lastLow ?? entry - 1.5*risk)));
    tp2 = rnd(Math.min(tp1 - 0.5*risk, tp1 - minTPFromRisk(risk)*0.6));
    setup = "Pullback (OB/FVG + Fib 0.5) Short";
    short_reason = "Sell the rally toward 15m resistance; SL beyond swing w/ ATR buffer.";
    signals.push("OB","FVG","Fib0.5");
  } else {
    order = "Market";
    entry = rnd(last);
    stop = rnd(entry - slBuf);
    const risk = Math.abs(entry - stop);
    tp1 = rnd(entry + minTPFromRisk(risk));
    tp2 = rnd(tp1 + 0.5*risk);
    setup = "Sideways: conservative reference only.";
    short_reason = "Wait for 15m BOS + pullback with HTF confluence.";
  }

  // Final consistency gate (fixes 'sell limit below market' etc.)
  const fixes: string[] = [];
  const risk0 = Math.abs(entry - stop);
  const needTP1 = Math.max(1.0*risk0, 0.3*A15);

  if (order === "Market") {
    if (entry !== last) { entry = rnd(last); fixes.push("market=last"); }
  } else if (order === "Buy Limit") {
    if (entry >= last) { entry = rnd(last - 0.25*A15); fixes.push("buyLimitBelowLast"); }
  } else if (order === "Sell Limit") {
    if (entry <= last) { entry = rnd(last + 0.25*A15); fixes.push("sellLimitAboveLast"); }
  } else if (order === "Buy Stop") {
    if (entry <= last) { entry = rnd(last + 0.05*A15); fixes.push("buyStopAboveLast"); }
  } else if (order === "Sell Stop") {
    if (entry >= last) { entry = rnd(last - 0.05*A15); fixes.push("sellStopBelowLast"); }
  }

  // Rebuild SL/TP after any entry correction
  if (fixes.length) {
    if (dir === "Long" || order.startsWith("Buy")) {
      stop = rnd(entry - Math.max(3*tick, 0.2*A15));
      const r = Math.abs(entry - stop);
      tp1 = rnd(entry + Math.max(1.0*r, 0.3*A15));
      tp2 = rnd(tp1 + 0.5*r);
    } else if (dir === "Short" || order.startsWith("Sell")) {
      stop = rnd(entry + Math.max(3*tick, 0.2*A15));
      const r = Math.abs(entry - stop);
      tp1 = rnd(entry - Math.max(1.0*r, 0.3*A15));
      tp2 = rnd(tp1 - 0.5*r);
    }
  } else {
    // even if no entry fix, enforce sensible TP spacing
    const r = Math.abs(entry - stop);
    const min1 = Math.max(1.0*r, 0.3*A15);
    if (dir === "Long") {
      if (tp1 <= entry + min1) tp1 = rnd(entry + min1);
      if (tp2 <= tp1 + 0.5*r) tp2 = rnd(tp1 + 0.5*r);
    } else if (dir === "Short") {
      if (tp1 >= entry - min1) tp1 = rnd(entry - min1);
      if (tp2 >= tp1 - 0.5*r) tp2 = rnd(tp1 - 0.5*r);
    }
  }

  // Alignment → conviction
  let alignment: PlanCore["alignment"] = "Mixed";
  const tfAgree = (tview.h4 === tview.h1) && (tview.h1 === tview.m15) && tview.h1 !== "range";
  if (tfAgree) alignment = "Match";
  else if (tview.h1 === tview.m15) alignment = "Mixed";
  else alignment = "Conflict";

  let conviction = 55;
  if (alignment === "Match") conviction += 10;
  if (alignment === "Conflict") conviction -= 15;
  if (sent.bias === "bullish" && (dir === "Long")) conviction += 6;
  if (sent.bias === "bearish" && (dir === "Short")) conviction += 6;
  if (sent.bias === "bullish" && (dir === "Short")) conviction -= 6;
  if (sent.bias === "bearish" && (dir === "Long")) conviction -= 6;
  if ((calendar?.blackoutWithin90m || []).length) conviction = Math.max(35, conviction - 10);
  conviction = clamp(Math.round(conviction), 25, 92);

  const fundamentals = {
    bias: sent.bias,
    headline_snapshot: sent.examples,
    calendar_watch: (calendar?.blackoutWithin90m || []) as string[],
  };

  const scenarios = dir === "Long"
    ? [
        "If pullback holds at 15m support, continuation to TP1 then trail toward TP2.",
        "Break of swing low (below SL) = invalidate; wait for new 15m BOS up."
      ]
    : dir === "Short"
    ? [
        "If rally rejects at 15m resistance, continuation to TP1 then trail toward TP2.",
        "Break above swing high (above SL) = invalidate; wait for new 15m BOS down."
      ]
    : [
        "Wait for 15m BOS + pullback into OB/FVG with HTF confluence.",
        "Avoid entries ahead of high-impact releases."
      ];

  const invalidation = dir === "Long"
    ? "Clean 15m close below protective swing/zone."
    : dir === "Short"
    ? "Clean 15m close above protective swing/zone."
    : "No active setup – wait for BOS + pullback.";

  return {
    core: {
      direction: dir, order_type: order,
      entry, stop, tp1, tp2,
      setup, short_reason, signals,
      tview, alignment, fundamentals, scenarios, invalidation,
      conviction
    },
    debug: { last, atr15: A15, fixes }
  };
}

/* ------------------------- LLM (reasoning only, optional) ------------------ */
async function llmReasoning(instrument: string, userPayload: any) {
  if (!OPENAI_API_KEY) return null;
  const system =
    "You are a trading assistant. Provide only short reasoning text (6–10 lines). Do NOT output numbers or levels. Do NOT change direction or plan.";
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Instrument: ${instrument}. Inputs:\n\`\`\`json\n${toJSON(userPayload)}\n\`\`\`\nWrite a concise rationale (no numbers) that explains HTF context, execution logic, and how headlines/calendar affect conviction.` }
      ]
    })
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return (data?.choices?.[0]?.message?.content || "").trim();
}

/* ------------------------------ card formatter ----------------------------- */
function buildCard(instrument: string, core: PlanCore, reasoning?: string, debug?: any, showDebug=false) {
  const lines: string[] = [];
  lines.push("Quick Plan (Actionable)", "");
  lines.push(`• Direction: ${core.direction}`);
  lines.push(`• Order Type: ${core.order_type}`);
  lines.push(`• Trigger: ${core.order_type === "Market" ? "—" : "Limit pullback / zone touch"}`);
  lines.push(`• Entry: ${core.entry}`);
  lines.push(`• Stop Loss: ${core.stop}`);
  lines.push(`• Take Profit(s): TP1 ${core.tp1} / TP2 ${core.tp2}`);
  lines.push(`• Conviction: ${core.conviction}%`);
  lines.push(`• Setup: ${core.setup}`);
  lines.push(`• Short Reasoning: ${core.short_reason}`);
  lines.push("");
  lines.push("Full Breakdown", "");
  lines.push(`• Technical View (HTF + Intraday): 4H=${core.tview.h4} / 1H=${core.tview.h1} / 15m=${core.tview.m15}`);
  lines.push(core.signals.length ? `• Signals Triggered: ${core.signals.join(" • ")}` : "• Signals Triggered: —");
  lines.push(`• Fundamental View (Calendar + Sentiment): ${core.fundamentals.bias} bias.`);
  if (core.fundamentals.headline_snapshot.length) {
    lines.push("• Headline Snapshot:");
    for (const h of core.fundamentals.headline_snapshot) lines.push(`  - ${h}`);
  }
  lines.push(`• Tech vs Fundy Alignment: ${core.alignment}`);
  lines.push("• Conditional Scenarios:");
  for (const s of core.scenarios) lines.push(`  - ${s}`);
  lines.push(`• Invalidation: ${core.invalidation}`);
  if (reasoning) {
    lines.push("");
    lines.push("Advanced Reasoning (Pro-Level Context)");
    lines.push("");
    lines.push(reasoning);
  }
  lines.push("");
  lines.push("News / Event Watch");
  if (core.fundamentals.calendar_watch.length) {
    for (const w of core.fundamentals.calendar_watch) lines.push(`• ${w}`);
  } else {
    lines.push("• No high-impact events in the ±90m window or calendar unavailable.");
  }
  lines.push("");
  lines.push("Notes", "");
  lines.push(`• Symbol: ${instrument}`);

  if (showDebug) {
    lines.push("");
    lines.push("Debug (server)");
    lines.push(`• last: ${debug?.last}`);
    lines.push(`• atr15: ${debug?.atr15}`);
    if (debug?.fixes?.length) lines.push(`• fixes: ${debug.fixes.join(", ")}`);
  }
  return lines.join("\n");
}

/* --------------------------------- handler -------------------------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse<PlanResp>) {
  try {
    const body = typeof req.body === "string" ? parseMaybeJSON(req.body) || {} : (req.body || {});
    const instrument = String(body.instrument || body.code || req.query.instrument || req.query.code || "EURUSD")
      .toUpperCase().replace(/\s+/g, "");
    const showDebug = String(req.query.debug || body.debug || "") === "1";

    // Candles
    const [m15, h1, h4] = await Promise.all([
      getCandles(instrument, "15m", 360),
      getCandles(instrument, "1h",  360),
      getCandles(instrument, "4h",  360),
    ]);
    if (!m15?.length || !h1?.length || !h4?.length) {
      return res.status(200).json({ ok: false, reason: "Missing candles for one or more timeframes" });
    }

    // Headlines + Calendar
    const base = originFromReq(req);
    let headlines: any[] = [];
    let calendar: any = { ok: false, items: [], blackoutWithin90m: [] };

    const n1 = await safeGET<any>(`${base}/api/news?instrument=${encodeURIComponent(instrument)}&hours=48`);
    if (n1?.ok && Array.isArray(n1.items)) headlines = n1.items;
    else if (Array.isArray(n1)) headlines = n1;

    const c1 = await safeGET<any>(`${base}/api/calendar?instrument=${encodeURIComponent(instrument)}&hours=48`);
    if (c1?.ok) calendar = c1;
    else if (c1) calendar = c1;

    // Deterministic plan (levels from real data only)
    const { core, debug } = buildDeterministicPlan({ instrument, m15, h1, h4, headlines, calendar });

    // Optional short reasoning (no numbers)
    let reasoning: string | undefined;
    try {
      const payload = {
        instrument,
        generated_at: nowIso(),
        current_price: C(m15).at(-1) || 0,
        tf_summary: core.tview,
        sentiment: summarizeHeadlines(headlines),
        calendar,
        headlines: headlines.slice(0, 10).map((h: any) => ({ title: h?.title, source: h?.source, sentiment: h?.sentiment?.score ?? null })),
      };
      reasoning = await llmReasoning(instrument, payload) || undefined;
    } catch {}

    const card = buildCard(instrument, core, reasoning, debug, showDebug);

    return res.status(200).json({
      ok: true,
      text: card,
      conviction: core.conviction,
      meta: { core, debug, usedLLM: !!reasoning }
    });
  } catch (err: any) {
    console.error("plan.ts error:", err?.message || err);
    return res.status(200).json({ ok: false, reason: err?.message || "Plan generation failed" });
  }
}
