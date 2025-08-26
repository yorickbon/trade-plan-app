// lib/symbols.ts

export type Instrument = {
  code: string;          // e.g. "EURUSD"
  currencies: string[];  // e.g. ["EUR","USD"]
  label?: string;        // optional UI label, e.g. "EUR/USD"
};

export const INSTRUMENTS: Instrument[] = [
  { code: "EURUSD", currencies: ["EUR", "USD"], label: "EUR/USD" },
  { code: "GBPJPY", currencies: ["GBP", "JPY"], label: "GBP/JPY" },
  { code: "XAUUSD", currencies: ["USD"], label: "Gold (XAUUSD)" },
  { code: "NDX", currencies: ["USD"], label: "Nasdaq 100 (NDX)" }, // your NAS100 fallback
];
