// lib/prices.ts
export type Candle = { t: string; o: number; h: number; l: number; c: number };

function tdInterval(tf: "4h" | "1h" | "15m") {
  return tf === "15m" ? "15min" : tf;
}

export async function getCandles(
  symbol: string,
  tf: "4h" | "1h" | "15m",
  limit = 200
): Promise<Candle[]> {
  const key = process.env.TWELVEDATA_API_KEY!;
  if (!key) throw new Error("Missing TWELVEDATA_API_KEY");

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", tdInterval(tf));
  url.searchParams.set("outputsize", String(limit));
  url.searchParams.set("apikey", key);
  url.searchParams.set("format", "JSON");

  const rsp = await fetch(url.toString(), { cache: "no-store" as any });
  if (!rsp.ok) throw new Error(`twelvedata ${rsp.status}`);
  const json = await rsp.json();
  const arr = (json?.values || json?.data || []) as any[];

  // Convert to ascending time & numeric OHLC
  return arr
    .map((d) => ({
      t: d.datetime || d.time || d.t || "",
      o: Number(d.open ?? d.o),
      h: Number(d.high ?? d.h),
      l: Number(d.low ?? d.l),
      c: Number(d.close ?? d.c),
    }))
    .filter((c) => Number.isFinite(c.c))
    .reverse();
}
