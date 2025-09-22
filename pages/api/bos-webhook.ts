import type { NextApiRequest, NextApiResponse } from "next";

// Store multiple BOS events per timeframe (with history)
type BOSEvent = {
  bos: "UP" | "DOWN";
  price: string;
  time: string;
  timestamp: number;
};

const BOS_CACHE = new Map<string, BOSEvent[]>();

type WebhookPayload = {
  pair: string;
  timeframe: string;
  bos: "UP" | "DOWN";
  price: string;
  time: string;
};

export default async function handler(
  req: NextApiRequest, 
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { pair, timeframe, bos, price, time }: WebhookPayload = req.body;

    if (!pair || !timeframe || !bos || !price) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    const key = `${pair}_${timeframe}`;
    const existingEvents = BOS_CACHE.get(key) || [];
    
    // Add new event with 4 hour expiry
    existingEvents.push({
      bos,
      price,
      time,
      timestamp: Date.now() + 4 * 60 * 60 * 1000
    });
    
    // Keep only last 10 events
    if (existingEvents.length > 10) {
      existingEvents.shift();
    }
    
    BOS_CACHE.set(key, existingEvents);

    console.log(`[BOS] ${pair} ${timeframe}min: ${bos} at ${price} (stored, total: ${existingEvents.length})`);

    return res.status(200).json({ ok: true, cached: key, total: existingEvents.length });
  } catch (error: any) {
    console.error("[BOS Webhook Error]:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

// Get BOS history (last N events within 4 hours)
export function getBOSHistory(pair: string, timeframe: string, maxEvents: number = 5): BOSEvent[] {
  const key = `${pair}_${timeframe}`;
  const events = BOS_CACHE.get(key) || [];
  const now = Date.now();
  
  // Filter out expired events
  const validEvents = events.filter(e => now < e.timestamp);
  
  // Update cache to remove expired
  if (validEvents.length < events.length) {
    BOS_CACHE.set(key, validEvents);
  }
  
  // Return most recent N events
  return validEvents.slice(-maxEvents);
}

// Get most recent BOS status (for backward compatibility)
export function getBOSStatus(pair: string, timeframe: string): "UP" | "DOWN" | "NONE" {
  const history = getBOSHistory(pair, timeframe, 1);
  return history.length > 0 ? history[0].bos : "NONE";
}
