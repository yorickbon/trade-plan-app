export type Instrument = {
  code: string;
  label: string;
  currencies: string[]; // must be mutable for useState
};

export const INSTRUMENTS: Instrument[] = [
  // ─── Forex
  { code: "AUDUSD", label: "AUDUSD", currencies: ["AUD", "USD"] },
  { code: "EURGBP", label: "EURGBP", currencies: ["EUR", "GBP"] },
  { code: "EURJPY", label: "EURJPY", currencies: ["EUR", "JPY"] },
  { code: "EURAUD", label: "EURAUD", currencies: ["EUR", "AUD"] },
  { code: "EURUSD", label: "EURUSD", currencies: ["EUR", "USD"] },
  { code: "GBPJPY", label: "GBPJPY", currencies: ["GBP", "JPY"] },
  { code: "GBPUSD", label: "GBPUSD", currencies: ["GBP", "USD"] },
  { code: "NZDUSD", label: "NZDUSD", currencies: ["NZD", "USD"] },
  { code: "USDCAD", label: "USDCAD", currencies: ["USD", "CAD"] },
  { code: "USDJPY", label: "USDJPY", currencies: ["USD", "JPY"] },

  // ─── Indices
  { code: "GER40", label: "GER40 (DAX)", currencies: ["Germany", "Euro Area"] },
  { code: "NAS100", label: "NAS100 (NASDAQ 100)", currencies: ["United States"] },
  { code: "US30",  label: "US30 (Dow Jones)", currencies: ["United States"] },
  { code: "SPX500", label: "SPX500 (S&P 500)", currencies: ["United States"] },

  // ─── Metals / Crypto
  { code: "XAUUSD", label: "Gold", currencies: ["United States", "Global"] },
  { code: "BTCUSD", label: "Bitcoin", currencies: ["United States", "Global"] },
  { code: "ETHUSD", label: "Ethereum", currencies: ["United States", "Global"] },
];

export function findInstrument(code: string): Instrument | undefined {
  const k = (code || "").toUpperCase();
  return INSTRUMENTS.find((i) => i.code === k);
}
