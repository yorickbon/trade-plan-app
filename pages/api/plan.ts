// /pages/api/plan.ts
import type { NextApiRequest, NextApiResponse } from "next";

type Resp = { ok: false; reason: string };

export default function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  res.setHeader("Cache-Control", "no-store");
  // Numeric planner intentionally disabled per project direction.
  // Use /api/vision-plan (images only: m15, h1, h4, optional calendar).
  return res.status(200).json({
    ok: false,
    reason:
      "Numeric planner disabled. Use /api/vision-plan (images only: m15,h1,h4[,calendar]).",
  });
}
