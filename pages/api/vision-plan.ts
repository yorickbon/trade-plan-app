// /pages/api/vision-plan.ts
// Images-only planner: pick the best idea by scoring multiple strategies.
// Upload: m15 (execution), h1 (context), h4 (HTF), optional calendar.
// Keeps your existing style and headings. Small, targeted fixes only.

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs/promises";

export const config = {
  api: { bodyParser: false, sizeLimit: "25mb" },
};

type Ok = { ok: true; text: string; meta?: any };
type Err = { ok: false; reason: string };

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-2025-08-07";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// ---------- helpers ----------

async function getFormidable() {
  const mod: any = await import("formidable");
  return mod.default || mod;
}

function isMultipart(req: NextApiRequest) {
  const t = String(req.headers["content-type"] || "");
  return t.includes("multipart/form-data");
}

async function parseMultipart(req: NextApiRequest) {
  const formidable = await getFormidable();
  const form = formidable({
    multiples: false,
    maxFiles: 25,
    maxFileSize: 25 * 1024 * 1024,
  });
  return new Promise<{ fields: Record<string, any>; files: Record<string, any> }>(
    (resolve, reject) => {
      form.parse(req as any, (err: any, fields: any, files: any) => {
        if (err) return reject(err);
        resolve({ fields, files });
      });
    }
  );
}

function pickFirst<T = any>(x: T | T[] | undefined | null): T | null {
  if (!x) return null;
  return Array.isArray(x) ? (x[0] ?? null) : (x as any);
}

async function fileToDataUrl(file: any): Promise<string | null> {
  if (!file) return null;
  const p =
    file.filepath || file.path || file._writeStream?.path || file.originalFilepath;
  if (!p) return null;
  const buf = await fs.readFile(p);
  const mime = file.mimetype || "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function originFromReq(req: NextApiRequest) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers.host as string) || (process.env.VERCEL_URL || "localhost:3000");
  return host.startsWith("http") ? host : `${proto}://${host}`;
}

async function fetchedHeadlines(req: NextApiRequest, instrument: string) {
  try {
    const base = originFromReq(req);
    const url = `${base}/api/news?instrument=${encodeURIComponent(
      instrument
    )}&hours=48&max=12`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return "";
    const data = (await r.json().catch(() => ({}))) as any;
    const items: any[] = Array.isArray(data?.items) ? data.items : [];
    return items
      .map((x) => `• ${x.title || x.headline || ""}`.trim())
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

function refusalLike(s: string) {
  const t = (s || "").toLowerCase();
  if (!t) return false;
  return /\b(can'?t|cannot)\s+assist\b|\bnot able to comply\b|\brefuse/i.test(t);
}

// fenced JSON extractor for trailing ai_meta
function extractAiMeta(text: string) {
  if (!text) return null;
  // look for ```ai_meta ...``` or ```json ...```
  const fences = [/```ai_meta\s*({[\s\S]*?})\s*```/i, /```json\s*({[\s\S]*?})\s*```/i];
  for (const re of fences) {
    const m = text.match(re);
    if (m && m[1]) {
      try {
        return JSON.parse(m[1]);
      } catch {}
    }
  }
  return null;
}

// Market entry allowed only if proof of breakout+retest (or SFP reclaim)
function hasBreakoutProof(aiMeta: any): boolean {
  const bp = aiMeta?.breakoutProof || {};
  return !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
}
function needsPendingLimit(aiMeta: any): boolean {
  const et = String(aiMeta?.entryType || "").toLowerCase(); // "market" | "pending"
  if (et !== "market") return false;
  return !hasBreakoutProof(aiMeta); // if not proven, require Pending
}

// invalid Buy/Sell Limit vs current price and zone
function invalidOrderRelativeToPrice(aiMeta: any): string | null {
  const o = String(aiMeta?.entryOrder || "").toLowerCase(); // buy limit / sell limit
  const dir = String(aiMeta?.direction || "").toLowerCase(); // long / short / flat
  const z = aiMeta?.zone || {};
  const p = Number(aiMeta?.currentPrice);
  const zmin = Number(z?.min);
  const zmax = Number(z?.max);
  if (!Number.isFinite(p) || !Number.isFinite(zmin) || !Number.isFinite(zmax)) return null;

  if (o.includes("sell") && o.includes("limit")) {
    if (!(zmin > p && zmax > p)) return "Sell Limit must be above current price.";
  }
  if (o.includes("buy") && o.includes("limit")) {
    if (!(zmin < p && zmax < p)) return "Buy Limit must be below current price.";
  }
  if (dir === "long" && o.includes("sell")) return "Long setups cannot use Sell Limit.";
  if (dir === "short" && o.includes("buy")) return "Short setups cannot use Buy Limit.";
  return null;
}

// Replace / append fenced ai_meta with updated one
function upsertAiMetaFence(text: string, aiMeta: any) {
  const block = "```ai_meta\n" + JSON.stringify(aiMeta, null, 2) + "\n```";
  if (!text) return block;
  if (/```ai_meta[\s\S]*?```/i.test(text)) {
    return text.replace(/```ai_meta[\s\S]*?```/i, block);
  }
  return [text.trim(), "", block].join("\n");
}

// Does the text have a human-readable card (not only code fences)?
function hasReadableCard(text: string) {
  if (!text) return false;
  const noFences = text.replace(/```[\s\S]*?```/g, "").trim();
  return /Quick Plan|Full Breakdown|Final Table Summary|•/.test(noFences);
}

// Parse "Conviction: 62%" from the card
function parseConvictionPercent(text: string): number | null {
  const m = text.match(/Conviction:\s*~?\s*(\d{1,3})\s*%/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// Inject a one-line reason why Market is withheld
function addMarketWithheldReason(text: string, reason: string) {
  const anchor = /(^|\n)Full Breakdown/i;
  const line = `\n*Market withheld:* ${reason}\n`;
  if (anchor.test(text)) {
    return text.replace(anchor, `${line}$&`);
  }
  return text + line;
}

// Inject "Option 2 — Market" when breakout proof exists
function injectMarketOption(text: string, aiMeta: any) {
  const cp = Number(aiMeta?.currentPrice);
  const stop = aiMeta?.stop ?? "Same as Option 1";
  const tp1 = aiMeta?.tp1 ?? "Same as Option 1";
  const tp2 = aiMeta?.tp2 ?? "Same as Option 1";

  let conv = parseConvictionPercent(text);
  let conv2: string;
  if (conv === null) conv2 = "~5% lower than Option 1";
  else conv2 = String(Math.max(0, conv - 5)) + "%";

  const option = [
    "",
    "Option 2 — Market (only with breakout proof)",
    `• Order Type: Market`,
    `• Entry: ${Number.isFinite(cp) ? cp : "current price"}`,
    `• Stop Loss: ${typeof stop === "number" ? stop : String(stop)}`,
    `• Take Profit(s): TP1 ${typeof tp1 === "number" ? tp1 : String(tp1)} / TP2 ${typeof tp2 === "number" ? tp2 : String(tp2)}`,
    `• Conviction: ${conv2}`,
  ].join("\n");

  // Place just before "Full Breakdown"
  const idx = text.search(/(^|\n)Full Breakdown/i);
  if (idx !== -1) {
    return text.slice(0, idx) + "\n" + option + "\n" + text.slice(idx);
  }
  return text + "\n" + option;
}

// tiny vision call to backfill current price from the 15m image only
async function backfillCurrentPriceFromM15(m15: string): Promise<number | null> {
  try {
    const messages: any[] = [
      {
        role: "system",
        content:
          "You read prices from a single chart image. Reply with ONLY a number (no units, no words). If unclear, reply null.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Return only the latest traded price visible on this 15m chart. If unreadable, reply null." },
          { type: "image_url", image_url: { url: m15 } as any },
        ],
      },
    ];
    const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        // fast + cheap; small completion
        max_completion_tokens: 64,
      }),
    });
    const json = await rsp.json().catch(() => ({} as any));
    if (!rsp.ok) return null;
    const out =
      json?.choices?.[0]?.message?.content ??
      (Array.isArray(json?.choices?.[0]?.message?.content)
        ? json.choices[0].message.content.map((c: any) => c?.text || "").join("\n")
        : "");
    const s = String(out || "").trim();
    if (!s) return null;
    if (/^null$/i.test(s)) return null;
    const num = Number(s.replace(/[^\d.\-]/g, ""));
    return Number.isFinite(num) ? num : null;
  } catch {
    return null;
  }
}

// Create a readable card from ai_meta if model returned JSON-only
function synthesizeCardFromMeta(instrument: string, aiMeta: any) {
  const dir = aiMeta?.direction ?? "Flat";
  const entryOrder = aiMeta?.entryOrder ?? "Pending";
  const zone = aiMeta?.zone
    ? typeof aiMeta.zone === "object"
      ? `${aiMeta.zone.min ?? "…"} – ${aiMeta.zone.max ?? "…"}`
      : String(aiMeta.zone)
    : "—";
  const stop = aiMeta?.stop ?? "—";
  const tp1 = aiMeta?.tp1 ?? "—";
  const tp2 = aiMeta?.tp2 ?? "—";

  const lines: string[] = [
    "Quick Plan (Actionable)",
    "",
    `• Direction: ${dir}`,
    `• Order Type: ${entryOrder}`,
    `• Trigger: Structure-based limit pullback or breakout with proof`,
    `• Entry: ${zone}`,
    `• Stop Loss: ${stop}`,
    `• Take Profit(s): TP1 ${tp1} / TP2 ${tp2}`,
    `• Conviction: 50%`,
    `• Setup: ${aiMeta?.selectedStrategy || "Images-driven setup"}`,
    "",
    "Full Breakdown",
    "• Technical View (HTF + Intraday): Based on uploaded 4H/1H/15m images.",
    "• Fundamental View (Calendar + Sentiment): Based on headlines/calendar image.",
    "• Tech vs Fundy Alignment: —",
    "• Conditional Scenarios: —",
    "• Surprise Risk: —",
    "• Invalidation: —",
    "• One-liner Summary: —",
    "",
    "Detected Structures (X-ray):",
    "• 4H: —",
    "• 1H: —",
    "• 15m: —",
    "",
    "Candidate Scores (tournament):",
    "—",
    "",
    "Final Table Summary:",
    "| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |",
    `| ${instrument} | ${dir} | ${zone} | ${stop} | ${tp1} | ${tp2} | 50% |`,
  ];
  return lines.join("\n");
}

// ---------- OpenAI caller ----------

async function callOpenAI(messages: any[]) {
  const rsp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      // Important for GPT-5: use max_completion_tokens, leave temperature default
      max_completion_tokens: 1600,
    }),
  });
  const json = await rsp.json().catch(() => ({} as any));
  if (!rsp.ok) {
    throw new Error(
      `OpenAI vision request failed: ${rsp.status} ${JSON.stringify(json)}`
    );
  }
  const out =
    json?.choices?.[0]?.message?.content ??
    (Array.isArray(json?.choices?.[0]?.message?.content)
      ? json.choices[0].message.content.map((c: any) => c?.text || "").join("\n")
      : "");
  return String(out || "");
}

// ---------- prompt builders ----------

function tournamentMessages(params: {
  instrument: string;
  dateStr: string;
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
  m15: string;
  h1: string;
  h4: string;
}) {
  const {
    instrument,
    dateStr,
    calendarDataUrl,
    headlinesText,
    m15,
    h1,
    h4,
  } = params;

  const system = [
    "You are a professional discretionary trader.",
    "Perform **visual** analysis only (no fetched data).",
    "Return a **readable markdown trade card** with the exact headings used below.",
    "At the very end, append a fenced JSON block labeled ai_meta with:",
    "{ selectedStrategy, entryType, entryOrder, direction, currentPrice, zone, stop, tp1, tp2, breakoutProof }.",
  ].join("\n");

  const userParts: any[] = [
    { type: "text", text: `Instrument: ${instrument}\nDate: ${dateStr}\n\nPick the best idea by scoring multiple strategies (tournament). Always output the card below, then the ai_meta fence.` },
    { type: "image_url", image_url: { url: h4 } as any },
    { type: "image_url", image_url: { url: h1 } as any },
    { type: "image_url", image_url: { url: m15 } as any },
  ];
  if (calendarDataUrl) {
    userParts.unshift({
      type: "text",
      text: "Calendar image (consider only if relevant):",
    });
    userParts.splice(1, 0, { type: "image_url", image_url: { url: calendarDataUrl } as any });
  }
  if (headlinesText) {
    userParts.push({
      type: "text",
      text: `Recent headlines snapshot:\n${headlinesText}`,
    });
  }

  const template = [
    "Quick Plan (Actionable)",
    "",
    "• Direction: <Long | Short | Flat>",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger: (ex: Limit pullback / zone touch)",
    "• Entry: <min–max> or specific level",
    "• Stop Loss: <level>",
    "• Take Profit(s): TP1 <level> / TP2 <level>",
    "• Conviction: <0–100>%",
    "• Setup: <Chosen Strategy>",
    "• Short Reasoning: <1–2 lines>",
    "",
    "Full Breakdown",
    "• Technical View (HTF + Intraday): 4H/1H/15m structure",
    "• Fundamental View (Calendar + Sentiment):",
    "• Tech vs Fundy Alignment: Match | Mismatch (+why)",
    "• Conditional Scenarios:",
    "• Surprise Risk:",
    "• Invalidation:",
    "• One-liner Summary:",
    "",
    "Detected Structures (X-ray):",
    "• 4H:",
    "• 1H:",
    "• 15m:",
    "",
    "Candidate Scores (tournament):",
    "- name — score — reason",
    "",
    "Final Table Summary:",
    "| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |",
    `| ${instrument} | ... | ... | ... | ... | ... | ... |`,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: [ { type: "text", text: template }, ...userParts ] },
  ];
}

async function askTournament(args: {
  instrument: string;
  dateStr: string;
  calendarDataUrl?: string | null;
  headlinesText?: string | null;
  m15: string;
  h1: string;
  h4: string;
}) {
  const messages = tournamentMessages(args);
  const text = await callOpenAI(messages);
  const aiMeta = extractAiMeta(text);
  return { text, aiMeta };
}

// rewrite card -> Pending limit (no Market) when proof missing
async function rewriteAsPending(instrument: string, text: string) {
  const messages = [
    {
      role: "system",
      content:
        "Rewrite the trade card as PENDING (no Market) into a clean Buy/Sell LIMIT plan, because breakout proof is missing. Keep tournament section and X-ray.",
    },
    {
      role: "user",
      content: `Instrument: ${instrument}\n\n${text}\n\nRewrite strictly to Pending.`,
    },
  ];
  return callOpenAI(messages);
}

// If 'Breakout + Retest' is claimed but proof isn't shown, normalize label
async function normalizeBreakoutLabel(text: string) {
  const messages = [
    {
      role: "system",
      content:
        "If 'Breakout + Retest' is claimed but proof is not shown, rename setup to 'Pullback (OB/FVG/SR)' and leave rest unchanged.",
    },
    { role: "user", content: text },
  ];
  return callOpenAI(messages);
}

// fix Buy/Sell Limit level direction vs current price
async function fixOrderVsPrice(instrument: string, text: string, aiMeta: any) {
  const reason = invalidOrderRelativeToPrice(aiMeta);
  if (!reason) return text;

  const messages = [
    {
      role: "system",
      content:
        "Adjust the LIMIT zone so that: Sell Limit is an ABOVE-price pullback into supply; Buy Limit is a BELOW-price pullback into demand. Keep all other content & sections.",
    },
    {
      role: "user",
      content: `Instrument: ${instrument}\n\nCurrent Price: ${aiMeta?.currentPrice}\nProvided Zone: ${JSON.stringify(
        aiMeta?.zone
      )}\n\nCard:\n${text}\n\nFix only the LIMIT zone side and entry, keep format.`,
    },
  ];
  return callOpenAI(messages);
}

// ---------- handler ----------

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Ok | Err>
) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });
    if (!isMultipart(req)) {
      return res.status(400).json({
        ok: false,
        reason:
          "Use multipart/form-data with files: m15, h1, h4 (and optional calendar).",
      });
    }

    const { fields, files } = await parseMultipart(req);
    const instrument = String(pickFirst(fields.instrument) || "").trim();
    const dateStr = String(pickFirst(fields.dateStr) || "").trim() || new Date().toISOString();
    const m15Url = await fileToDataUrl(pickFirst(files.m15));
    const h1Url = await fileToDataUrl(pickFirst(files.h1));
    const h4Url = await fileToDataUrl(pickFirst(files.h4));
    const calUrl = await fileToDataUrl(pickFirst(files.calendar));
    if (!m15Url || !h1Url || !h4Url) {
      return res.status(400).json({
        ok: false,
        reason: "Missing required images m15, h1, h4.",
      });
    }

    // 0) Headlines (no-store) — used for sentiment bias, optional
    const headlinesText = await fetchedHeadlines(req, instrument);

    // 1) Ask the vision tournament
    let { text, aiMeta } = await askTournament({
      instrument,
      dateStr,
      calendarDataUrl: calUrl || undefined,
      headlinesText: headlinesText || undefined,
      m15: m15Url,
      h1: h1Url,
      h4: h4Url,
    });

    // 1.a) If model returned only JSON or no readable card, synthesize from ai_meta
    if ((!hasReadableCard(text) || /^```(?:ai_meta|json)/i.test(text.trim())) && aiMeta) {
      const synthesized = synthesizeCardFromMeta(instrument, aiMeta);
      text = [synthesized, "", "```ai_meta", JSON.stringify(aiMeta, null, 2), "```"].join("\n");
    }

    // 1.b) Backfill currentPrice if missing with a tiny vision call on the 15m image
    if (aiMeta && !(Number.isFinite(Number(aiMeta.currentPrice)))) {
      const backfilled = await backfillCurrentPriceFromM15(m15Url);
      if (backfilled != null) {
        aiMeta.currentPrice = backfilled;
        text = upsertAiMetaFence(text, aiMeta);
      }
    }

    // 2) Force Pending if Market without proof, and add withheld reason
    if (aiMeta) {
      if (needsPendingLimit(aiMeta)) {
        text = await rewriteAsPending(instrument, text);
        aiMeta = extractAiMeta(text) || aiMeta;
        text = addMarketWithheldReason(
          text,
          "Missing breakout proof (require body close beyond + retest holds or SFP reclaim)."
        );
        aiMeta = extractAiMeta(text) || aiMeta;
      } else if (hasBreakoutProof(aiMeta)) {
        // 2.b) Add Option 2 (Market) section (~5% lower conviction)
        text = injectMarketOption(text, aiMeta);
      } else {
        // Not market, but still no proof: add reason to explain why Market is withheld
        text = addMarketWithheldReason(
          text,
          "Missing breakout proof (require body close beyond + retest holds or SFP reclaim)."
        );
      }
    }

    // 3) Normalize mislabeled Breakout+Retest if no proof
    if (aiMeta) {
      const hasProof = hasBreakoutProof(aiMeta);
      if (String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout") && !hasProof) {
        text = await normalizeBreakoutLabel(text);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // 4) Enforce order vs current price (Sell Limit above / Buy Limit below)
    if (aiMeta) {
      const bad = invalidOrderRelativeToPrice(aiMeta);
      if (bad) {
        text = await fixOrderVsPrice(instrument, text, aiMeta);
        aiMeta = extractAiMeta(text) || aiMeta;
      }
    }

    // 5) If blank or refusal -> skeleton fallback (still append ai_meta)
    if (!text || refusalLike(text)) {
      const fallback =
        [
          "Quick Plan (Actionable)",
          "",
          "• Direction: Stay Flat (low conviction).",
          "• Order Type: Pending",
          "• Trigger: Confluence (OB/FVG/SR) after a clean trigger.",
          "• Entry: zone below/above current (structure based).",
          "• Stop Loss: beyond invalidation with small buffer.",
          "• Take Profit(s): Prior swing/liquidity; then trail.",
          "• Conviction: 30%",
          "• Setup: Await valid trigger (images inconclusive).",
          "",
          "Full Breakdown",
          "• Technical View: Indecisive; likely range.",
          "• Fundamental View: Mixed; keep size conservative.",
          "• Tech vs Fundy Alignment: Mixed.",
          "• Conditional Scenarios: Break+retest for continuation; SFP & reclaim for reversal.",
          "• Surprise Risk: Headlines; CB speakers.",
          "• Invalidation: Opposite-side body close beyond range edge.",
          "• One-liner Summary: Stand by for a clean trigger.",
          "",
          "Detected Structures (X-ray):",
          "• 4H: –",
          "• 1H: –",
          "• 15m: –",
          "",
          "Candidate Scores (tournament):",
          "–",
          "",
          "Final Table Summary:",
          `| Instrument | Bias   | Entry Zone | SL  | TP1 | TP2 | Conviction % |`,
          `| ${instrument} | Neutral | Wait for trigger | Structure-based | Prior swing | Next liquidity | 30% |`,
        ].join("\n");

      const fallbackMeta = {
        selectedStrategy: "Await valid trigger",
        entryType: "Pending",
        entryOrder: "Pending",
        direction: "Flat",
        currentPrice: aiMeta?.currentPrice ?? null,
        zone: null,
        stop: null,
        tp1: null,
        tp2: null,
        breakoutProof: {
          bodyCloseBeyond: false,
          retestHolds: false,
          sfpReclaim: false,
        },
      };

      return res.status(200).json({
        ok: true,
        text: [fallback, "", "```ai_meta", JSON.stringify(fallbackMeta, null, 2), "```"].join("\n"),
        meta: {
          instrument,
          headlinesCount: headlinesText ? headlinesText.length : 0,
          strategySelection: false,
          rewritten: false,
          fallbackUsed: true,
          aiMeta: fallbackMeta,
        },
      });
    }

    // Ensure we always return a readable card + ai_meta fence
    if (!hasReadableCard(text) && aiMeta) {
      const synth = synthesizeCardFromMeta(instrument, aiMeta);
      text = [synth, "", "```ai_meta", JSON.stringify(aiMeta, null, 2), "```"].join("\n");
    } else if (aiMeta) {
      text = upsertAiMetaFence(text, aiMeta);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text,
      meta: {
        instrument,
        headlinesCount: headlinesText ? headlinesText.length : 0,
        strategySelection: true,
        rewritten: false,
        fallbackUsed: false,
        aiMeta,
      },
    });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      reason: err?.message || "vision-plan failed",
    });
  }
}
