// pages/api/ask.ts
import type { NextApiRequest, NextApiResponse } from "next";
import chatHandler from "./chat";

// Delegate to /api/chat (streams and JSON fallback both work through this).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  return chatHandler(req, res);
}
