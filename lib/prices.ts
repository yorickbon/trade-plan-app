// ADD (below your yahooSymbol function)
function yahooAlternates(symbol: string): string[] {
  const base = yahooSymbol(symbol);
  const alts: string[] = [];
  // Metals
  if (symbol.startsWith("XAU/") || symbol === "XAUUSD" || symbol === "XAU/USD") {
    alts.push("XAUUSD=X", "GC=F"); // spot, then gold futures
  }
  // Crypto
  if (symbol.startsWith("BTC/") || symbol === "BTCUSD" || symbol === "BTC/USD") alts.push("BTC-USD");
  if (symbol.startsWith("ETH/") || symbol === "ETHUSD" || symbol === "ETH/USD") alts.push("ETH-USD");

  // Indices
  if (symbol === "SPX500") alts.push("^GSPC", "ES=F");      // S&P 500, S&P futures
  if (symbol === "NAS100") alts.push("^NDX", "NQ=F");       // NASDAQ 100, futures
  if (symbol === "US30")  alts.push("^DJI", "YM=F");        // Dow, futures
  if (symbol === "GER40") alts.push("^GDAXI", "FDAX.DE");   // DAX, fallback XETRA symbol

  // FX (shouldn’t be needed, but harmless)
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol)) alts.push(symbol.replace("/", "") + "=X");

  const uniq = Array.from(new Set([...(base ? [base] : []), ...alts]));
  return uniq;
}

// REPLACE your yahooFetch with this version
async function yahooFetch(symbol: string, tf: TF, n: number, ms: number): Promise<Candle[]> {
  const tries = yahooAlternates(symbol);
  if (!tries.length) return [];
  const interval = tf === "15m" ? "15m" : "60m"; // 60m; 4h is built from 60m
  const range = tf === "15m" ? "30d" : "60d";

  for (const y of tries) {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}`);
    url.searchParams.set("interval", interval);
    url.searchParams.set("range", range);
    url.searchParams.set("events", "history");
    try {
      const rsp = await withTimeout(fetch(url.toString(), { cache: "no-store" }), ms);
      if (!rsp.ok) continue;
      const j: any = await rsp.json();
      const r = j?.chart?.result?.[0];
      const ts: number[] = Array.isArray(r?.timestamp) ? r.timestamp : [];
      const q = r?.indicators?.quote?.[0] || {};
      const opens: number[] = q?.open || [], highs: number[] = q?.high || [], lows: number[] = q?.low || [], closes: number[] = q?.close || [];
      let bars: Candle[] = [];
      for (let i = ts.length - 1; i >= 0; i--) {
        const t = Number(ts[i]), o = Number(opens[i]), h = Number(highs[i]), l = Number(lows[i]), c = Number(closes[i]);
        if ([t, o, h, l, c].every(Number.isFinite)) bars.push({ t, o, h, l, c });
        if (bars.length >= (tf === "4h" ? n * 4 : n)) break;
      }
      if (!bars.length) continue;
      if (tf === "4h") bars = aggregate(bars, 4);
      return bars.slice(0, n);
    } catch { /* try next alt */ }
  }
  return [];
}
