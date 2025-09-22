import type { NextApiRequest, NextApiResponse } from "next";

// In-memory cache for BOS events (15 min TTL)
const BOS_CACHE = new Map<string, {
  timeframe: string;
  bos: "UP" | "DOWN";
  price: string;
  timestamp: number;
}>();

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
  // Only accept POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { pair, timeframe, bos, price, time }: WebhookPayload = req.body;

    if (!pair || !timeframe || !bos || !price) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    // Create cache key: EURUSD_15 or EURUSD_60, etc.
    const key = `${pair}_${timeframe}`;
    
    // Store with 15 minute expiry
    BOS_CACHE.set(key, {
      timeframe,
      bos,
      price,
      timestamp: Date.now() + 15 * 60 * 1000
    });

    console.log(`[BOS] ${pair} ${timeframe}min: ${bos} at ${price} (time: ${time})`);

    return res.status(200).json({ ok: true, cached: key });
  } catch (error: any) {
    console.error("[BOS Webhook Error]:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

// Helper function to get BOS status (export this to use in vision-plan)
export function getBOSStatus(pair: string, timeframe: string): "UP" | "DOWN" | "NONE" {
  const key = `${pair}_${timeframe}`;
  const cached = BOS_CACHE.get(key);
  
  // Return NONE if expired or not found
  if (!cached || Date.now() > cached.timestamp) {
    return "NONE";
  }
  
  return cached.bos;
}
