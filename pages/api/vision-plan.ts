function tournamentMessages(params: {
  instrument: string;
  dataUrls: { m15: string; h1: string; h4: string; cal?: string | null };
  headlinesText: string | null;
}) {
  const { instrument, dataUrls, headlinesText } = params;

  const systemText = [
    "You are a professional discretionary trader. Produce educational market analysis (NOT financial advice).",
    "Inputs are ONLY chart images for technicals + optional calendar image + a brief headlines snapshot.",
    "No numeric OHLC; infer structure visually (trend, BOS/CHOCH, OB/FVG, S/R, sweeps, range bounds, etc.).",
    "",
    "TOURNAMENT MODE:",
    "Consider multiple strategy candidates (both directions when valid):",
    "- Pullback to OB/FVG/SR, Liquidity sweep reclaim, Breakout+Retest, SFP/liquidity grab+reclaim, Range reversion, trendline/channel retest, or Double-tap.",
    "Score each candidate 0..100 via: HTF alignment(30), Execution clarity(15), Confluence quality(15), Clean path to target(10), Stop validity(10), Fundamentals tilt(10), 'no FOMO' penalty(10).",
    "Pick the top candidate and produce ONE trade card.",
    "",
    "RULES:",
    "• MARKET only if you can explicitly prove breakout: BODY CLOSE beyond the level AND a successful RETEST that HOLDS (or SFP reclaim). Otherwise convert to Pending Limit zone.",
    "• Pending limits must be sided correctly: SELL above current price / BUY below current price.",
    "• If a candidate says 'Breakout + Retest' but proof is weak, normalize to Pullback (OB/FVG/SR) and keep conservative risk.",
    "• Stops: structure-based (beyond invalidation swing/zone) with buffer; escalate if too tight.",
    "• TP: nearest liquidity/swing/imbalance; provide TP1 and TP2.",
    "• If calendar implies elevated risk near 90m, WARN in 'News Event Watch' (do not blackout).",
    "",
    "OUTPUT (exact order):",
    "Quick Plan (Actionable)",
    "• Direction: Long / Short / Stay flat",
    "• Order Type: Buy Limit | Sell Limit | Buy Stop | Sell Stop | Market",
    "• Trigger: Reason/zone touch",
    "• Entry: <min> – <max> (or Market only if proof shown)",
    "• Stop Loss: <beyond which structure>",
    "• Take Profit(s): TP1 <..> / TP2 <..>",
    "• Conviction: <percent>",
    "• Setup: <Chosen Strategy>",
    "• Short Reasoning: ...",
    "",
    "Full Breakdown",
    "• Technical View (HTF + Intraday):",
    "• Fundamental View (Calendar + Sentiment):",
    "• Tech vs Fundy Alignment: Match / Mismatch (+ why)",
    "• Conditional Scenarios:",
    "• Surprise Risk:",
    "• Invalidation:",
    "• One-liner Summary:",
    "",
    "Detected Structures (X-ray):",
    "• 4H: ...",
    "• 1H: ...",
    "• 15m: ...",
    "",
    "Candidate Scores (tournament): one-liners with name + score.",
    "",
    "Final Table Summary:",
    `| Instrument | Bias | Entry Zone | SL | TP1 | TP2 | Conviction % |`,
    `| ${instrument} | ... | ... | ... | ... | ... | ... |`,
    "",
    "At the very end, append a fenced JSON block labeled ai_meta with:",
    "```ai_meta",
    "{",
    `  \"selectedStrategy\": string,`,
    `  \"entryType\": \"Pending\" | \"Market\",`,
    `  \"entryOrder\": \"Buy Limit\" | \"Sell Limit\" | \"Buy Stop\" | \"Sell Stop\" | \"Market\",`,
    `  \"direction\": \"Long\" | \"Short\" | \"Flat\",`,
    `  \"currentPrice\": number | null,`,
    `  \"zone\": { \"min\": number, \"max\": number, \"tf\": \"15m\" | \"1H\" | \"4H\", \"type\": \"OB\" | \"FVG\" | \"SR\" | \"Other\" },`,
    `  \"stop\": number | null,`,
    `  \"tp1\": number | null,`,
    `  \"tp2\": number | null,`,
    `  \"breakoutProof\": { \"bodyCloseBeyond\": boolean, \"retestHolds\": boolean, \"sfpReclaim\": boolean }`,
    "}",
    "```",
  ].join("\n");

  const msgs: any[] = [
    { role: "system", content: systemText },
    {
      role: "user",
      content: [
        { type: "text", text: `Instrument: ${instrument}` },
        { type: "text", text: "4H Chart:" },
        { type: "image_url", image_url: { url: dataUrls.h4 } },
        { type: "text", text: "1H Chart:" },
        { type: "image_url", image_url: { url: dataUrls.h1 } },
        { type: "text", text: "15m Chart (execution):" },
        { type: "image_url", image_url: { url: dataUrls.m15 } },
      ],
    },
  ];

  if (dataUrls.cal) {
    msgs.push({
      role: "user",
      content: [
        { type: "text", text: "Economic Calendar Image (optional):" },
        { type: "image_url", image_url: { url: dataUrls.cal } },
      ],
    });
  }

  if (headlinesText && headlinesText.trim()) {
    msgs.push({
      role: "user",
      content: [{ type: "text", text: "Recent macro headlines (24–48h):\n" + headlinesText }],
    });
  }

  return msgs;
}
