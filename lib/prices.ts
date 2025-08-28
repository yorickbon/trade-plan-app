// lib/prices.ts

export type Candle = {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
};

export type TF = "15m" | "1h" | "4h";

/**
 * getCandles
 * Same signature as before, but now it calls our multi-provider
 * server endpoint at /api/candles (which has the provider failovers).
 *
 * Always returns newest -> oldest as { t,o,h,l,c } in unix seconds.
 */
export async function getCandles(
  instrument: string | { code: string },
  tf: TF,
  n: number
): Promise<Candle[]> {
  const symbol = typeof instrument === "string" ? instrument : instrument.code;

  // Build the base URL correctly for both server and browser
  const explicit = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  const root =
    explicit ||
    (typeof window === "undefined"
      ? // Server side: use Vercel URL if present
        (process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000")
      : // Browser: relative
        "");

  const url =
    `${root}/api/candles` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(tf)}` +
    `&limit=${encodeURIComponent(String(n))}`;

  // Per-call timeout (milliseconds)
  const perCallMs =
    Number(process.env.PLAN_PER_CALL_TIMEOUT_MS ?? "") || 8000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), perCallMs);

  try {
    const rsp = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!rsp.ok) return [];

    const j = await rsp.json();

    // Expecting { candles: Candle[] } from our /api/candles
    const arr: any[] = Array.isArray(j?.candles) ? j.candles : [];
    return normalizeCandles(arr);
  } catch {
    clearTimeout(timer);
    return [];
  }
}

/**
 * Normalize and sanity-check the array, keeping newest -> oldest,
 * t in seconds, and finite OHLC values.
 */
function normalizeCandles(input: any[]): Candle[] {
  const out: Candle[] = [];
  for (const v of input) {
    const tRaw = v?.t ?? v?.time ?? v?.timestamp ?? v?.datetime;
    const t =
      typeof tRaw === "number"
        ? // assume provider seconds; if it looks like ms, convert
          (tRaw > 1e12 ? Math.floor(tRaw / 1000) : tRaw)
        : typeof tRaw === "string"
        ? Math.floor(Date.parse(tRaw) / 1000)
        : NaN;

    const o = Number(v?.o ?? v?.open);
    const h = Number(v?.h ?? v?.high);
    const l = Number(v?.l ?? v?.low);
    const c = Number(v?.c ?? v?.close);

    if (
      Number.isFinite(t) &&
      Number.isFinite(o) &&
      Number.isFinite(h) &&
      Number.isFinite(l) &&
      Number.isFinite(c)
    ) {
      out.push({ t, o, h, l, c });
    }
  }
  return out;
}
