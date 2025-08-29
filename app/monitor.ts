// pages/api/monitor.ts
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, reason: "Method not allowed" });
    }
    const { action, instrument, date } = req.body || {};
    if (!action || !["start", "stop"].includes(action)) {
      return res.status(400).json({ ok: false, reason: "Invalid action" });
    }
    // TODO: hook Telegram here later
    console.log(`[monitor] ${action}`, { instrument, date, at: new Date().toISOString() });
    return res.status(200).json({ ok: true, action, instrument, date });
  } catch (e: any) {
    return res.status(200).json({ ok: false, reason: e?.message || "Unknown error" });
  }
}
