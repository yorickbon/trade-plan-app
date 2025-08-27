// lib/symbols.ts

export type Instrument = {
  code: string;        // e.g. "EURUSD"
  currencies: string[]; // e.g. ["EUR","USD"]
  label?: string;       // optional UI label, e.g. "EUR/USD"
};

export const INSTRUMENTS: Instrument[] = [
  // --- Majors / crosses ---
  { code: "EURUSD", currencies: ["EUR","USD"], label: "EUR/USD" },
  { code: "GBPUSD", currencies: ["GBP","USD"], label: "GBP/USD" },
  { code: "USDJPY", currencies: ["USD","JPY"], label: "USD/JPY" },
  { code: "USDCAD", currencies: ["USD","CAD"], label: "USD/CAD" },
  { code: "AUDUSD", currencies: ["AUD","USD"], label: "AUD/USD" },
  { code: "NZDUSD", currencies: ["NZD","USD"], label: "NZD/USD" },
  { code: "EURGBP", currencies: ["EUR","GBP"], label: "EUR/GBP" },
  { code: "EURJPY", currencies: ["EUR","JPY"], label: "EUR/JPY" },
  { code: "EURAUD", currencies: ["EUR","AUD"], label: "EUR/AUD" },

  // --- Metals / Crypto ---
  { code: "XAUUSD", currencies: ["USD"], label: "Gold (XAUUSD)" },
  { code: "BTCUSD", currencies: ["USD"], label: "Bitcoin (BTCUSD)" },
  { code: "ETHUSD", currencies: ["USD"], label: "Ethereum (ETHUSD)" },

  // --- Indices (need vendor mapping in /api/candles) ---
  { code: "NAS100", currencies: ["USD"], label: "Nasdaq 100 (NAS100)" },
  { code: "SPX500", currencies: ["USD"], label: "S&P 500 (SPX500)" },
  { code: "US30",  currencies: ["USD"], label: "Dow 30 (US30)" },
  { code: "GER40", currencies: ["EUR"], label: "Germany 40 (GER40)" },
];
