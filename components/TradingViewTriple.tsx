"use client";

import React, { useEffect, useRef } from "react";

type Props = { symbol: string };

declare global {
  interface Window {
    TradingView?: any;
  }
}

/** Load tv.js once; never throw if it fails */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve();
    if (window.TradingView) return resolve();

    const id = "tv-script";
    const exist = document.getElementById(id) as HTMLScriptElement | null;
    if (exist) {
      exist.addEventListener("load", () => resolve(), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.id = id;
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => resolve(); // don’t crash render
    document.head.appendChild(s);
  });
}

function tvSymbol(sym: string) {
  const s = sym.toUpperCase();
  if (s === "SPX500") return "TVC:SPX";
  if (s === "NAS100") return "NASDAQ:NDX";
  if (s === "US30") return "TVC:DJI";
  if (s === "GER40") return "XETR:DAX";
  if (s === "BTCUSD") return "CRYPTO:BTCUSD";
  if (s === "ETHUSD") return "CRYPTO:ETHUSD";
  if (s === "XAUUSD") return "OANDA:XAUUSD";
  return `OANDA:${s}`;
}

export default function TradingViewTriple({ symbol }: Props) {
  const ref4h = useRef<HTMLDivElement>(null);
  const ref1h = useRef<HTMLDivElement>(null);
  const ref15 = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;

    async function init() {
      if (typeof window === "undefined") return;

      await loadScript("https://s3.tradingview.com/tv.js");
      if (!mounted || !window.TradingView) return;

      const common: any = {
        symbol: tvSymbol(symbol),
        width: "100%",
        height: 400,
        theme: "dark",
        style: "1",
        locale: "en",
        timezone: "Etc/UTC",
        toolbar_bg: "#0B1220",
        hide_legend: false,
        enable_publishing: false,
        hide_top_toolbar: false,
        hide_side_toolbar: false,
        allow_symbol_change: false,
        container_id: "",
      };

      // Clear any previous content
      [ref4h, ref1h, ref15].forEach((r) => r.current && (r.current.innerHTML = ""));

      if (ref4h.current) {
        new window.TradingView.widget({
          ...common,
          interval: "240",
          container_id: ref4h.current.id,
        });
      }
      if (ref1h.current) {
        new window.TradingView.widget({
          ...common,
          interval: "60",
          container_id: ref1h.current.id,
        });
      }
      if (ref15.current) {
        new window.TradingView.widget({
          ...common,
          interval: "15",
          container_id: ref15.current.id,
        });
      }
    }

    init();
    return () => {
      mounted = false;
    };
  }, [symbol]);

  // Side-by-side layout with inline styles (no external CSS needed)
  const rowStyle: React.CSSProperties = { display: "flex", gap: 12 };
  const cardStyle: React.CSSProperties = { flex: "1 1 0%", minWidth: 0 };
  const boxStyle: React.CSSProperties = {
    height: 400,
    border: "1px solid #232323",
    borderRadius: 6,
  };

  return (
    <div style={rowStyle}>
      <div style={cardStyle}><div id="tv-4h" ref={ref4h} style={boxStyle} /></div>
      <div style={cardStyle}><div id="tv-1h" ref={ref1h} style={boxStyle} /></div>
      <div style={cardStyle}><div id="tv-15m" ref={ref15} style={boxStyle} /></div>
    </div>
  );
}
