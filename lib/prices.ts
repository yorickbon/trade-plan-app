// lib/prices.ts
// Unified candle fetcher using TwelveData. Returns normalized candles and exports are NAMED.

export type TF = "4h" | "1h" | "15m";

export type Candle = {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
};

function tfToInterval(tf: TF): string {
  switch (tf) {
    case "4h":
      return "4h";
    case "1h":
      return "1h";
    case "15m":
      return "15min";
  }
}

function symbolMap(code: string): string {
  // Map internal codes to provider symbols
  // EURUSD -> EUR/USD, XAUUSD -> XAU/USD, etc.
  if (/^[A-Z]{6}$/.test(code)) {
    const base = code.slice(0, 3);
    const quote = code.slice(3);
    return `${base}/${quote}`;
  }
  return code;
}

export async function getCandles(
  instr: { code: string },
  tf: TF,
  limit = 200
): Promise<Candle[]> {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error("TWELVEDATA_API_KEY missing");

  const interval = tfToInterval(tf);
  const symbol = symbolMap(instr.code);

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(limit));
  url.searchParams.set("format", "JSON");
  url.searchParams.set("apikey", key);

  const rsp = await fetch(url.toString(), { cache: "no-store" });
  if (!rsp.ok) throw new Error(`TwelveData ${rsp.status}`);

  const json = await rsp.json();
  const arr: Candle[] = (json?.values ?? [])
    .map((v: any) => ({
      t: new Date(v.datetime).getTime(),
      o: Number(v.open),
      h: Number(v.high),
      l: Number(v.low),
      c: Number(v.close),
    }))
    .filter((x: Candle) => Number.isFinite(x.t) && Number.isFinite(x.c))
    .reverse(); // chronological

  return arr;
}
