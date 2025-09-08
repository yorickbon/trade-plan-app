// ---------- Enforcement helpers (Option 1 / Quick Plan / Option 2) ----------
function hasCompliantOption2(text: string): boolean {
  const re = /Option\s*2/i; if (!re.test(text || "")) return false;
  const block = (text.match(/Option\s*2[\s\S]{0,800}/i)?.[0] || "").toLowerCase();
  const must = ["direction", "trigger", "entry", "stop", "tp", "conviction"];
  return must.every(k => block.includes(k));
}
async function enforceOption2(model: string, instrument: string, text: string) {
  if (hasCompliantOption2(text)) return text;
  const messages = [
    { role: "system", content: "Add a compliant **Option 2 (Alternative)**. Keep everything else unchanged. Include Direction, Order Type, explicit Trigger, Entry, SL, TP1/TP2, Conviction %." },
    { role: "user", content: `Instrument: ${instrument}\n\n${text}\n\nAdd Option 2 (Alternative) below Option 1.` },
  ];
  return callOpenAI(model, messages);
}

function hasOption1(text: string): boolean {
  return /Option\s*1\s*\(?(Primary)?\)?/i.test(text || "");
}
async function enforceOption1(model: string, instrument: string, text: string) {
  if (hasOption1(text)) return text;
  const messages = [
    { role: "system", content: "Insert a labeled 'Option 1 (Primary)' block BEFORE 'Option 2'. Use the primary trade details already present (from Quick Plan or the first described setup). Include Direction, Order Type, Trigger, Entry, SL, TP1/TP2, Conviction %. Keep other content unchanged." },
    { role: "user", content: `Instrument: ${instrument}\n\n${text}\n\nAdd/normalize 'Option 1 (Primary)' as specified.` },
  ];
  return callOpenAI(model, messages);
}

function hasQuickPlan(text: string): boolean {
  return /Quick\s*Plan\s*\(Actionable\)/i.test(text || "");
}
async function enforceQuickPlan(model: string, instrument: string, text: string) {
  if (hasQuickPlan(text)) return text;
  const messages = [
    { role: "system", content: "Add a 'Quick Plan (Actionable)' section at the very top, before Option 1 and Option 2. Copy the primary trade details (Direction, Order Type, Trigger, Entry, SL, TP1/TP2, Conviction %, Setup, Short Reasoning). Keep all other existing sections unchanged and in their order." },
    { role: "user", content: `Instrument: ${instrument}\n\n${text}\n\nAdd the Quick Plan section as specified above without altering other content.` },
  ];
  return callOpenAI(model, messages);
}

// ---------- Breakout+Retest proof (keep name; add checklist; market→pending if missing proof) ----------
async function enforceBreakoutProofChecklist(model: string, instrument: string, text: string) {
  const sys = [
    "If the plan claims **Breakout + Retest** but lacks explicit proof, DO NOT rename it to Pullback.",
    "Keep the setup label as 'Breakout + Retest' and ADD a **Proof Checklist** with:",
    "- Required body close beyond the key level with explicit timeframe (e.g., 1H close).",
    "- Retest hold confirmation (e.g., 15m close or wick rejection at the reclaimed level/zone).",
    "- Optional SFP reclaim if applicable.",
    "- Invalidation line (precise level/condition that kills the idea).",
    "If Entry was Market but proof is not yet confirmed, CONVERT to Pending with exact trigger sequence:",
    "close beyond → retest hold → enter at X (state whether Limit at reclaimed level/zone or Stop above/below).",
    "Preserve all other sections (Quick Plan, Management, Full Breakdown, Candidate Scores, Final Table, ai_meta).",
  ].join("\n");
  const usr = `Instrument: ${instrument}\n\n${text}\n\nMake only the Proof Checklist + Pending conversion edits as required above.`;
  return callOpenAI(model, [{ role: "system", content: sys }, { role: "user", content: usr }]);
}
async function rewriteAsPendingBreakout(model: string, instrument: string, text: string) {
  const sys = [
    "Rewrite to EntryType: Pending **while keeping the setup name 'Breakout + Retest'**.",
    "Provide a clear LIMIT or STOP entry with exact trigger sequence: close beyond → retest hold → enter at X.",
    "Do not delete or rename sections. Keep tournament/X-ray content.",
  ].join("\n");
  const usr = `Instrument: ${instrument}\n\n${text}\n\nConvert to Pending with exact trigger sequence and keep 'Breakout + Retest' as the setup.`;
  return callOpenAI(model, [{ role: "system", content: sys }, { role: "user", content: usr }]);
}

// ---------- Live price ----------
async function fetchLivePrice(pair: string): Promise<number | null> {
  try {
    if (TD_KEY) {
      const sym = `${pair.slice(0, 3)}/${pair.slice(3)}`;
      const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&dp=5`;
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1800) });
      const j: any = await r.json().catch(() => ({}));
      const p = Number(j?.price);
      if (isFinite(p) && p > 0) return p;
    }
  } catch {}
  try {
    if (FH_KEY) {
      const sym = `OANDA:${pair.slice(0, 3)}_${pair.slice(3)}`;
      const to = Math.floor(Date.now() / 1000);
      const from = to - 60 * 60 * 3;
      const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(sym)}&resolution=15&from=${from}&to=${to}&token=${FH_KEY}`;
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1800) });
      const j: any = await r.json().catch(() => ({}));
      const c = Array.isArray(j?.c) ? j.c : [];
      const last = Number(c[c.length - 1]);
      if (isFinite(last) && last > 0) return last;
    }
  } catch {}
  try {
    if (POLY_KEY) {
      const ticker = `C:${pair}`;
      const to = new Date();
      const from = new Date(to.getTime() - 60 * 60 * 1000);
      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${fmt(from)}/${fmt(to)}?adjusted=true&sort=desc&limit=1&apiKey=${POLY_KEY}`;
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1500) });
      const j: any = await r.json().catch(() => ({}));
      const res = Array.isArray(j?.results) ? j.results[0] : null;
      const last = Number(res?.c);
      if (isFinite(last) && last > 0) return last;
    }
  } catch {}
  try {
    const S = await fetchSeries15(pair);
    const last = S?.c?.[S.c.length - 1];
    if (isFinite(Number(last)) && Number(last) > 0) return Number(last);
  } catch {}
  return null;
}

// ---------- Provenance footer ----------
function buildServerProvenanceFooter(args: {
  headlines_provider: string | null;
  calendar_status: "api" | "image-ocr" | "unavailable";
  calendar_provider: string | null;
  csm_time: string | null;
  extras?: Record<string, any>;
}) {
  const lines = [
    "\n---",
    "Data Provenance (server — authoritative):",
    `• Headlines: ${args.headlines_provider || "unknown"}`,
    `• Calendar: ${args.calendar_status}${args.calendar_provider ? ` (${args.calendar_provider})` : ""}`,
    `• Sentiment CSM timestamp: ${args.csm_time || "n/a"}`,
    args.extras ? `• Meta: ${JSON.stringify(args.extras)}` : undefined,
    "---\n",
  ].filter(Boolean);
  return lines.join("\n");
}

// ---------- Handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, reason: "Missing OPENAI_API_KEY" });

    const urlMode = String((req.query.mode as string) || "").toLowerCase();
    let mode: "full" | "fast" | "expand" = urlMode === "fast" ? "fast" : urlMode === "expand" ? "expand" : "full";

    // expand (no multipart)
    if (mode === "expand") {
      const modelExpand = pickModelFromFields(req);
      const cacheKey = String(req.query.cache || "").trim();
      const c = getCache(cacheKey);
      if (!c) return res.status(400).json({ ok: false, reason: "Expand failed: cache expired or not found." });

      const dateStr = new Date().toISOString().slice(0, 10);
      const calAdv = await fetchCalendarForAdvisory(req, c.instrument);

      const provHint = { headlines_present: !!c.headlinesText, calendar_status: c.calendar ? "image-ocr" : "api" };

      const messages = messagesFull({
        instrument: c.instrument, dateStr,
        m15: c.m15, h1: c.h1, h4: c.h4,
        calendarDataUrl: c.calendar || undefined,
        headlinesText: c.headlinesText || undefined,
        sentimentText: c.sentimentText || undefined,
        calendarAdvisory: { warningMinutes: calAdv.warningMinutes, biasNote: calAdv.biasNote, advisoryText: calAdv.advisoryText, evidence: calAdv.evidence || [] },
        provenance: provHint,
      });

      let text = await callOpenAI(modelExpand, messages);

      // enforce order & presence
      text = await enforceQuickPlan(modelExpand, c.instrument, text);
      text = await enforceOption1(modelExpand, c.instrument, text);
      text = await enforceOption2(modelExpand, c.instrument, text);

      const footer = buildServerProvenanceFooter({
        headlines_provider: "expand-uses-stage1",
        calendar_status: c.calendar ? "image-ocr" : "api",
        calendar_provider: c.calendar ? "image-ocr" : calAdv?.provider || null,
        csm_time: null,
        extras: { vp_version: VP_VERSION, model: modelExpand, mode: "expand" },
      });
      text = `${text}\n${footer}`;

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ok: true, text, meta: { instrument: c.instrument, cacheKey, model: modelExpand, vp_version: VP_VERSION } });
    }

    if (!isMultipart(req)) {
      return res.status(400).json({ ok: false, reason: "Use multipart/form-data with files: m15, h1, h4 (PNG/JPG/WEBP) and optional 'calendar'. Or pass m15Url/h1Url/h4Url (TradingView/Gyazo links). Also include 'instrument' field." });
    }

    const tParse = now();
    const { fields, files } = await parseMultipart(req);
    if (process.env.NODE_ENV !== "production") console.log(`[vision-plan] parsed in ${dt(tParse)}`);

    const MODEL = pickModelFromFields(req, fields);
    const instrument = String(fields.instrument || fields.code || "EURUSD").toUpperCase().replace(/\s+/g, "");
    const requestedMode = String(fields.mode || "").toLowerCase();
    if (requestedMode === "fast") mode = "fast";

    const m15f = pickFirst(files.m15);
    const h1f = pickFirst(files.h1);
    const h4f = pickFirst(files.h4);
    const calF = pickFirst(files.calendar);

    const m15Url = String(pickFirst(fields.m15Url) || "").trim();
    const h1Url = String(pickFirst(fields.h1Url) || "").trim();
    const h4Url = String(pickFirst(fields.h4Url) || "").trim();

    const tImg = now();
    const [m15FromFile, h1FromFile, h4FromFile, calUrl] = await Promise.all([
      fileToDataUrl(m15f), fileToDataUrl(h1f), fileToDataUrl(h4f),
      calF ? fileToDataUrl(calF) : Promise.resolve(null),
    ]);
    const [m15FromUrl, h1FromUrl, h4FromUrl] = await Promise.all([
      m15FromFile ? Promise.resolve(null) : linkToDataUrl(m15Url),
      h1FromFile ? Promise.resolve(null) : linkToDataUrl(h1Url),
      h4FromFile ? Promise.resolve(null) : linkToDataUrl(h4Url),
    ]);
    const m15 = m15FromFile || m15FromUrl;
    const h1 = h1FromFile || h1FromUrl;
    const h4 = h4FromFile || h4FromUrl;

    if (process.env.NODE_ENV !== "production") {
      console.log(`[vision-plan] images ready ${dt(tImg)} (m15=${dataUrlSizeBytes(m15)}B, h1=${dataUrlSizeBytes(h1)}B, h4=${dataUrlSizeBytes(h4)}B, cal=${dataUrlSizeBytes(calUrl)}B)`);
    }
    if (!m15 || !h1 || !h4) {
      return res.status(400).json({ ok: false, reason: "Provide all three charts: m15, h1, h4 — either as files or valid TradingView/Gyazo direct image links." });
    }

    // Headlines
    let headlineItems: AnyHeadline[] = [];
    let headlinesText: string | null = null;
    let headlinesProvider: string = "unknown";
    const rawHeadlines = pickFirst(fields.headlinesJson) as string | null;
    if (rawHeadlines) {
      try {
        const parsed = JSON.parse(String(rawHeadlines));
        if (Array.isArray(parsed)) {
          headlineItems = parsed.slice(0, 12);
          headlinesText = headlinesToPromptLines(headlineItems, 6);
          headlinesProvider = "client";
        }
      } catch {}
    }
    if (!headlinesText) {
      const viaServer = await fetchedHeadlinesViaServer(req, instrument);
      headlineItems = viaServer.items;
      headlinesText = viaServer.promptText;
      headlinesProvider = viaServer.provider || "unknown";
    }
    const hBias = computeHeadlinesBias(headlineItems);

    // Calendar (OCR-first)
    let calendarStatus: "image-ocr" | "api" | "unavailable" = "unavailable";
    let calendarProvider: string | null = null;
    let calendarText: string | null = null;
    let calendarEvidence: string[] = [];
    let warningMinutes: number | null = null;
    let biasNote: string | null = null;

    if (calUrl) {
      const ocr = await ocrCalendarFromImage(MODEL, calUrl).catch(() => null);
      if (ocr && Array.isArray(ocr.items)) {
        calendarStatus = "image-ocr";
        calendarProvider = "image-ocr";
        const analyzed = analyzeCalendarOCR(ocr, instrument);
        calendarText = analyzed.biasLine;
        calendarEvidence = analyzed.evidenceLines;
        warningMinutes = analyzed.warningMinutes;
        biasNote = analyzed.biasNote;
      } else {
        const calAdv = await fetchCalendarForAdvisory(req, instrument);
        calendarStatus = calAdv.status;
        calendarProvider = calAdv.provider;
        calendarText = calAdv.text;
        calendarEvidence = calAdv.evidence || [];
        warningMinutes = calAdv.warningMinutes;
        biasNote = calAdv.biasNote;
      }
    } else {
      const calAdv = await fetchCalendarForAdvisory(req, instrument);
      calendarStatus = calAdv.status;
      calendarProvider = calAdv.provider;
      calendarText = calAdv.text;
      calendarEvidence = calAdv.evidence || [];
      warningMinutes = calAdv.warningMinutes;
      biasNote = calAdv.biasNote;
    }

    // Sentiment + price
    let csm: CsmSnapshot;
    try { csm = await getCSM(); }
    catch (e: any) { return res.status(503).json({ ok: false, reason: `CSM unavailable: ${e?.message || "fetch failed"}.` }); }
    const cotCue = detectCotCueFromHeadlines(headlineItems);
    const { text: sentimentText } = sentimentSummary(csm, cotCue, hBias);
    const livePrice = await fetchLivePrice(instrument);
    const dateStr = new Date().toISOString().slice(0, 10);

    // ---- Stage selection ----
    let text = ""; let aiMeta: any = null;

    const provForModel = {
      headlines_present: !!headlinesText,
      calendar_status: calendarStatus, // "image-ocr" | "api" | "unavailable"
    };

    if (mode === "fast") {
      const messages = messagesFastStage1({
        instrument, dateStr, m15, h1, h4,
        calendarDataUrl: calUrl || undefined,
        calendarText: (!calUrl && calendarText) ? calendarText : undefined,
        headlinesText: headlinesText || undefined,
        sentimentText: sentimentText,
        calendarAdvisory: { warningMinutes, biasNote, advisoryText: biasNote || null, evidence: calendarEvidence || [] },
        provenance: provForModel,
      });
      if (livePrice) { (messages[0] as any).content = (messages[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice};`; }
      text = await callOpenAI(MODEL, messages);
      aiMeta = extractAiMeta(text) || {};
      if (livePrice && (aiMeta.currentPrice == null || !isFinite(Number(aiMeta.currentPrice)))) aiMeta.currentPrice = livePrice;

      // Breakout proof enforcement
      const isBreakout = String(aiMeta?.selectedStrategy || "").toLowerCase().includes("breakout");
      const bp = aiMeta?.breakoutProof || {};
      const hasProof = !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
      if (isBreakout && !hasProof) {
        text = await enforceBreakoutProofChecklist(MODEL, instrument, text);
        aiMeta = extractAiMeta(text) || aiMeta;
        if (String(aiMeta?.entryType || "").toLowerCase() === "market") {
          text = await rewriteAsPendingBreakout(MODEL, instrument, text);
          aiMeta = extractAiMeta(text) || aiMeta;
        }
      }

      // Order sanity
      if (aiMeta) {
        if (livePrice && aiMeta.currentPrice !== livePrice) aiMeta.currentPrice = livePrice;
        const bad = invalidOrderRelativeToPrice(aiMeta);
        if (bad) { text = await enforceOption1(MODEL, instrument, text); text = await enforceOption2(MODEL, instrument, text); }
      }

      // Guarantee section order/presence
      text = await enforceQuickPlan(MODEL, instrument, text);
      text = await enforceOption1(MODEL, instrument, text);
      text = await enforceOption2(MODEL, instrument, text);

      const cacheKey = setCache({ instrument, m15, h1, h4, calendar: calUrl || null, headlinesText: headlinesText || null, sentimentText });

      const footer = buildServerProvenanceFooter({
        headlines_provider: headlinesProvider || "unknown",
        calendar_status: calendarStatus,
        calendar_provider: calendarProvider,
        csm_time: csm.tsISO,
        extras: { vp_version: VP_VERSION, model: MODEL, mode },
      });
      text = `${text}\n${footer}`;

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        text,
        meta: {
          instrument, mode, cacheKey, vp_version: VP_VERSION, model: MODEL,
          sources: {
            headlines_used: Math.min(6, Array.isArray(headlineItems) ? headlineItems.length : 0),
            headlines_instrument: instrument,
            headlines_provider: headlinesProvider || "unknown",
            calendar_used: calendarStatus === "api" || calendarStatus === "image-ocr",
            calendar_status: calendarStatus,
            calendar_provider: calendarProvider,
            csm_used: true,
            csm_time: csm.tsISO,
            cot_used: !!cotCue,
            cot_report_date: null as string | null,
            cot_error: cotCue ? null : "no cot cues",
            cot_method: cotCue ? "headline_fallback" : null,
            calendar_warning_minutes: warningMinutes ?? null,
            calendar_bias_note: biasNote || null,
            calendar_evidence: calendarEvidence || [],
            headlines_bias_label: hBias.label,
            headlines_bias_score: hBias.avg,
            cot_bias_summary: cotCue ? cotCue.summary : null,
          },
          aiMeta,
        },
      });
    }

    // -------- FULL --------
    const messages = messagesFull({
      instrument, dateStr, m15, h1, h4,
      calendarDataUrl: calUrl || undefined,
      calendarText: (!calUrl && calendarText) ? calendarText : undefined,
      headlinesText: headlinesText || undefined,
      sentimentText,
      calendarAdvisory: { warningMinutes, biasNote, advisoryText: biasNote || null, evidence: calendarEvidence || [] },
      provenance: provForModel,
    });
    if (livePrice) { (messages[0] as any).content = (messages[0] as any).content + `\n\nNote: Current price hint ~ ${livePrice};`; }

    let textFull = await callOpenAI(MODEL, messages);
    let aiMetaFull = extractAiMeta(textFull) || {};
    if (livePrice && (aiMetaFull.currentPrice == null || !isFinite(Number(aiMetaFull.currentPrice)))) aiMetaFull.currentPrice = livePrice;

    // Breakout proof enforcement
    {
      const isBreakout = String(aiMetaFull?.selectedStrategy || "").toLowerCase().includes("breakout");
      const bp = aiMetaFull?.breakoutProof || {};
      const hasProof = !!(bp?.bodyCloseBeyond === true && (bp?.retestHolds === true || bp?.sfpReclaim === true));
      if (isBreakout && !hasProof) {
        textFull = await enforceBreakoutProofChecklist(MODEL, instrument, textFull);
        aiMetaFull = extractAiMeta(textFull) || aiMetaFull;
        if (String(aiMetaFull?.entryType || "").toLowerCase() === "market") {
          textFull = await rewriteAsPendingBreakout(MODEL, instrument, textFull);
          aiMetaFull = extractAiMeta(textFull) || aiMetaFull;
        }
      }
    }

    // Guarantee section order/presence
    textFull = await enforceQuickPlan(MODEL, instrument, textFull);
    textFull = await enforceOption1(MODEL, instrument, textFull);
    textFull = await enforceOption2(MODEL, instrument, textFull);

    const footer = buildServerProvenanceFooter({
      headlines_provider: headlinesProvider || "unknown",
      calendar_status: calendarStatus,
      calendar_provider: calendarProvider,
      csm_time: csm.tsISO,
      extras: { vp_version: VP_VERSION, model: MODEL, mode },
    });
    textFull = `${textFull}\n${footer}`;

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text: textFull,
      meta: {
        instrument, mode, vp_version: VP_VERSION, model: MODEL,
        sources: {
          headlines_used: Math.min(6, Array.isArray(headlineItems) ? headlineItems.length : 0),
          headlines_instrument: instrument,
          headlines_provider: headlinesProvider || "unknown",
          calendar_used: calendarStatus === "api" || calendarStatus === "image-ocr",
          calendar_status: calendarStatus,
          calendar_provider: calendarProvider,
          csm_used: true,
          csm_time: csm.tsISO,
          cot_used: !!cotCue,
          cot_report_date: null as string | null,
          cot_error: cotCue ? null : "no cot cues",
          cot_method: cotCue ? "headline_fallback" : null,
          calendar_warning_minutes: warningMinutes ?? null,
          calendar_bias_note: biasNote || null,
          calendar_evidence: calendarEvidence || [],
          headlines_bias_label: hBias.label,
          headlines_bias_score: hBias.avg,
          cot_bias_summary: cotCue ? cotCue.summary : null,
        },
        aiMeta: aiMetaFull,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, reason: err?.message || "vision-plan failed" });
  }
}
