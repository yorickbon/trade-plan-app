// /lib/sentiment.ts
// ultra-light lexicon scorer for headlines (no dependencies)

const POS = [
  "beat","beats","beats estimates","strong","surge","surges","soar","soars","soared",
  "expand","expands","expansion","growth","improve","improves","improved","bullish",
  "optimism","optimistic","hawkish","tighten","tightening","raise","raises","hike","hikes",
];

const NEG = [
  "miss","misses","weak","plunge","plunges","fall","falls","fell","drop","drops","dropped",
  "contract","contracts","contraction","slow","slows","slowed","bearish","pessimism","dovish",
  "cut","cuts","cutting","slash","slashed","recession","deflation",
];

export type SentimentResult = {
  bias: "Buy" | "Sell" | "Neutral";
  score: number; // -1..+1
};

/**
 * Score combined headlines text and return a tiny sentiment summary.
 * Kept async to match server call sites.
 */
export async function scoreSentiment(text: string): Promise<SentimentResult> {
  const t = (text || "").toLowerCase();
  if (!t) return { bias: "Neutral", score: 0 };

  let pos = 0, neg = 0;
  for (const w of POS) if (t.includes(w)) pos++;
  for (const w of NEG) if (t.includes(w)) neg++;

  if (pos === 0 && neg === 0) return { bias: "Neutral", score: 0 };

  const raw = (pos - neg) / Math.max(1, pos + neg); // -1..+1
  const score = Math.max(-1, Math.min(1, raw));

  const bias: SentimentResult["bias"] =
    score > 0.1 ? "Buy" : score < -0.1 ? "Sell" : "Neutral";

  return { bias, score };
}
