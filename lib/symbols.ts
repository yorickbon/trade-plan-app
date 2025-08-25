export type Instrument = { code: string, display: string, tv: string, currencies: string[] }

export const INSTRUMENTS: Instrument[] = [
  { code: 'EURUSD', display: 'EURUSD', tv: 'FX:EURUSD', currencies: ['EUR','USD'] },
  { code: 'GBPJPY', display: 'GBPJPY', tv: 'FX:GBPJPY', currencies: ['GBP','JPY'] },
  { code: 'XAUUSD', display: 'XAUUSD (Gold)', tv: 'FX_IDC:XAUUSD', currencies: ['USD'] },
  { code: 'NAS100', display: 'NAS100 (Nasdaq 100)', tv: 'NASDAQ:NDX', currencies: ['USD'] },
]
