"use client";

import React, { useEffect } from "react";

/** Map your app symbols to TradingView symbols */
function tvSymbol(sym: string) {
  const s = sym.toUpperCase();
  // Indices
  if (s === "SPX500") return "TVC:SPX";
  if (s === "NAS100") return "NASDAQ:NDX";
  if (s === "US30") return "TVC:DJI";
  if (s === "GER40") return "XETR:DAX";
  // Crypto
  if (s === "BTCUSD") return "CRYPTO:BTCUSD";
  if (s === "ETHUSD") return "CRYPTO:ETHUSD";
  // Metals
  if (s === "XAUUSD") return "OANDA:XAUUSD";
  // FX (OANDA default)
  return `OANDA:${s}`;
}

/** Load TV script once, without crashing render */
function loadTvScript(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve();
    // already there?
    if ((window as any).TradingView) return resolve();

    const id = "tv-script";
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.id = id;
    s.src = "https://s3.tradingview.com/tv.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => resolve(); // never throw -> never crash
    document.head.appendChild(s);
  });
}

export default function TradingViewTriple({ symbol }: { symbol: string }) {
  useEffect(() => {
    let mounted = true;

    const run = async () => {
      if (typeof window === "undefined") return;
      await loadTvScript();
      if (!mounted) return;

      const TV = (window as any).TradingView;
      if (!TV) return; // script blocked? just skip silently

      const tvSym = tvSymbol(symbol);

      // clear any previous widgets
      ["tv-4h", "tv-1h", "tv-15m"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = "";
      });

      const base = {
        symbol: tvSym,
        timezone: "Etc/UTC",
        theme: "dark",
        style: "1",
        locale: "en",
        hide_side_toolbar: false,
        allow_symbol_change: false,
        autosize: true,
      };

      new TV.widget({ ...base, container_id: "tv-4h", interval: "240" });
      new TV.widget({ ...base, container_id: "tv-1h", interval: "60" });
      new TV.widget({ ...base, container_id: "tv-15m", interval: "15" });
    };

    run();
    return () => {
      mounted = false;
    };
  }, [symbol]);

  // Always side-by-side (3 columns). If you want wrap on tiny screens,
  // replace `flex` with `grid grid-cols-1 md:grid-cols-3`.
  return (
    <div className="flex gap-3">
      <div id="tv-4h" className="flex-1 min-w-0 h-[400px] rounded border border-neutral-800" />
      <div id="tv-1h" className="flex-1 min-w-0 h-[400px] rounded border border-neutral-800" />
      <div id="tv-15m" className="flex-1 min-w-0 h-[400px] rounded border border-neutral-800" />
    </div>
  );
}
