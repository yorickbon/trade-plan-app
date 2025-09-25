// Enhanced BOS webhook cache with persistence
type BOSRecord = {
  instrument: string;
  timeframe: string;
  direction: "UP" | "DOWN";
  timestamp: number;
  price?: number;
  replaced?: boolean; // Mark when superseded by newer BOS
};

// Persistent BOS storage (survives until new BOS replaces it)
const BOS_HISTORY = new Map<string, BOSRecord[]>(); // key: instrument
const BOS_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days (keep for reference)

export function recordBOS(instrument: string, timeframe: string, direction: "UP" | "DOWN", price?: number) {
  const key = instrument.toUpperCase();
  const existing = BOS_HISTORY.get(key) || [];
  
  // Mark previous BOS on same timeframe as replaced (superseded)
  existing.forEach(record => {
    if (record.timeframe === timeframe && !record.replaced) {
      record.replaced = true;
    }
  });
  
  // Add new BOS record
  const newRecord: BOSRecord = {
    instrument: key,
    timeframe,
    direction,
    timestamp: Date.now(),
    price,
    replaced: false
  };
  
  existing.push(newRecord);
  
  // Clean old records (keep last 50 per instrument, remove expired)
  const cleaned = existing
    .filter(r => Date.now() - r.timestamp < BOS_TTL)
    .slice(-50);
    
  BOS_HISTORY.set(key, cleaned);
  console.log(`[BOS] Recorded ${direction} on ${timeframe} for ${instrument} at ${price || 'unknown'}`);
}

export function getBOSStatus(instrument: string, timeframe: string): string {
  const records = BOS_HISTORY.get(instrument.toUpperCase()) || [];
  
  // Get most recent non-replaced BOS for this timeframe
  const latest = records
    .filter(r => r.timeframe === timeframe && !r.replaced)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
    
  if (!latest) return "NONE";
  
  const hoursAgo = (Date.now() - latest.timestamp) / (1000 * 60 * 60);
  const priceStr = latest.price ? ` @${latest.price}` : "";
  
  // Return more detailed status
  if (hoursAgo < 1) {
    return `${latest.direction} (${Math.round(hoursAgo * 60)}m ago${priceStr})`;
  } else if (hoursAgo < 24) {
    return `${latest.direction} (${hoursAgo.toFixed(1)}h ago${priceStr})`;
  } else {
    return `${latest.direction} (${Math.round(hoursAgo / 24)}d ago${priceStr})`;
  }
}

export function initializeBOSCache() {
  // Optional: Load from persistent storage if needed
  console.log('[BOS] Cache initialized - tracking structure breaks until superseded');
}

// Webhook endpoint to receive BOS alerts from TradingView
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // TradingView sends: pair, timeframe, bos, price, time
    const { pair, timeframe, bos, price, time } = req.body;
    
    if (!pair || !timeframe || !bos) {
      console.log('[BOS Webhook] Missing fields - pair:', pair, 'timeframe:', timeframe, 'bos:', bos);
      return res.status(400).json({ error: 'Missing required fields: pair, timeframe, bos' });
    }
    
    // Convert to our format and record
    recordBOS(pair, timeframe, bos.toUpperCase(), parseFloat(price));
    
    return res.status(200).json({ 
      success: true, 
      message: `BOS ${bos} recorded for ${pair} ${timeframe}`,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[BOS Webhook] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
