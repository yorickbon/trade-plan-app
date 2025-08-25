import type { NextApiRequest, NextApiResponse } from 'next'

const MODEL = process.env.MODEL_NAME || 'gpt-4o-mini'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!OPENAI_API_KEY) {
    return res.status(200).json({ plan: { text: `OpenAI API key missing. Add OPENAI_API_KEY in Vercel → Settings → Environment Variables.` } })
  }
  const { instrument = 'EURUSD', date = '', calendar = [] } = req.body || {}
  const calLines = (calendar || []).map((i:any) => `${i.time || ''} ${i.currency || ''} ${i.title || ''}`).join('\n')

  const system = `You are a trading assistant. Produce a concise Trade Card with:
- Type: Breakout or Pullback (pick best)
- Direction: Buy / Sell / Stay Flat
- Entry: precise condition or price (market or pending)
- Stop Loss: level with logic
- Take Profit 1 / 2: nearest liquidity and extension
- Conviction: 0-100%
- Technical Reasoning: one or two lines (levels, structure)
- Fundamental Context: one or two lines using calendar + sentiment
- Alignment: state if tech/fundy match, mismatch (pullback), or conflict
Format it clearly. Keep it short and punchy.`

  const user = `Instrument: ${instrument}
Date: ${date}
Calendar (bullets):
${calLines || 'No items'}
Return ONLY the trade card text.`

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0.3
      })
    })
    const j = await r.json()
    const text = j.choices?.[0]?.message?.content || 'No response'
    const m = text.match(/Conviction:\s*(\d+)%/i)
    const conviction = m ? parseInt(m[1],10) : null
    res.status(200).json({ plan: { text, conviction } })
  } catch (e:any) {
    res.status(200).json({ plan: { text: `Error calling OpenAI: ${e?.message || e}` } })
  }
}
