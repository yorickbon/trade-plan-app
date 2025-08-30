// pages/api/ask.ts
import type { NextApiRequest, NextApiResponse } from "next";
import chatHandler from "./chat";

// Delegates straight to the chat API so there is no proxy/fetch or origin guessing.
// ChatDock already sends: { question, planText, headlines, calendar }.
// chat.ts anchors on planText and answers open-ended questions.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  return chatHandler(req, res);
}
