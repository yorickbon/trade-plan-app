// pages/api/openai-ping.ts
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const key = (process.env.OPENAI_API_KEY || "").trim();

  if (!key) {
    return res.status(500).json({ error: "❌ OPENAI_API_KEY missing in Vercel Environment Variables" });
  }

  try {
    const rsp = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });

    if (!rsp.ok) {
      const text = await rsp.text();
      return res.status(rsp.status).json({
        error: `Auth failed: HTTP ${rsp.status}`,
        details: text.slice(0, 200),
      });
    }

    const data = await rsp.json();
    return res.status(200).json({ ok: true, modelCount: data?.data?.length || 0 });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Ping failed" });
  }
}
