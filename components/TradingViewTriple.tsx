"use client";

import React, { useEffect } from "react";

type Props = {
  symbol: string; // e.g. "EURUSD", "XAUUSD", "SPX500"
};

// Map your app symbols to TradingView symbols.
// Adjust as you prefer (FXCM/OANDA/CME etc.)
function tvSymbol(sym: string) {
  const s = sym.toUpperCase();
  // Indices
  if (s === "SPX500") return "TVC:SPX";
  if (s === "NAS100") return "NASDAQ:NDX";
  if (s === "US30") return "TVC:DJI";
  if (s === "GER40") return "XETR:DAX";
  // Crypto (common default)
  if (s === "BTCUSD") return "CRYPTO:BTCUSD";
  if (s === "ETHUSD") return "CRYPTO:ETHUSD";
  // Metals
  if (s === "XAUUSD") return "OANDA:XAUUSD";
  // FX default to OANDA; change to FXCM if you prefer
  return `OANDA:${s}`;
}

function injectTradingView(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return resolve();
    // If already present, resolve
    if ((window as any).TradingView) return resolve();
    const id = "tv-script";
    if (document.getElementById(id)) {
      (document.getElementById(id) as HTMLScriptElement).addEventListener(
        "load",
        () => resolve()
      );
      return;
    }
    const s = document.createElement("script");
    s.id = id;
    s.src = "https://s3.tradingview.com/tv.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load TradingView script"));
    document.head.appendChild(s);
  });
}

export default function TradingViewTriple({ symbol }: Props) {
  useEffect(() => {
    let mounted = true;

    const load = async () => {
      if (typeof window === "undefined") return;
      try {
        await injectTradingView();
        if (!mounted) return;

        const tv = (window as any).TradingView;
        const s = tvSymbol(symbol);

        // Clean previous widgets if any
        ["tv-4h", "tv-1h", "tv-15m"].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.innerHTML = ""; // remove old widget
        });

        // create three widgets (4h, 1h, 15m). Use "advanced-chart" widget.
        new tv.widget({
          container_id: "tv-4h",
          symbol: s,
          interval: "240",
          timezone: "Etc/UTC",
          theme: "dark",
          style: "1",
          locale: "en",
          hide_side_toolbar: false,
          allow_symbol_change: false,
          autosize: true,
        });

        new tv.widget({
          container_id: "tv-1h",
          symbol: s,
          interval: "60",
          timezone: "Etc/UTC",
          theme: "dark",
          style: "1",
          locale: "en",
          hide_side_toolbar: false,
          allow_symbol_change: false,
          autosize: true,
        });

        new tv.widget({
          container_id: "tv-15m",
          symbol: s,
          interval: "15",
          timezone: "Etc/UTC",
          theme: "dark",
          style: "1",
          locale: "en",
          hide_side_toolbar: false,
          allow_symbol_change: false,
          autosize: true,
        });
      } catch (e) {
        // Keep UI alive even if TradingView fails to load
        // (no throw -> no client-side fatal)
        console.warn("TradingView load error:", e);
      }
    };

    load();
    return () => {
      mounted = false;
    };
  }, [symbol]);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
      <div id="tv-4h" className="h-[340px] min-h-[280px] rounded border border-neutral-800" />
      <div id="tv-1h" className="h-[340px] min-h-[280px] rounded border border-neutral-800" />
      <div id="tv-15m" className="h-[340px] min-h-[280px] rounded border border-neutral-800" />
    </div>
  );
}
