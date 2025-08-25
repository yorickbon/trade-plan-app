import type { NextApiRequest, NextApiResponse } from 'next'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { date = '', currencies = '' } = req.query as { date?: string, currencies?: string }
  const rss = process.env.CALENDAR_RSS_URL
  let items:any[] = []
  if (rss) {
    try {
      const r = await fetch(rss, { cache: 'no-store' })
      const text = await r.text()
      const parts = text.split('<item>').slice(1)
      for (const p of parts) {
        const title = (p.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || p.match(/<title>(.*?)<\/title>/))?.[1] || ''
        const pubDate = (p.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]) || ''
        const cur = (title.match(/\b([A-Z]{3})\b/)?.[1]) || ''
        const time = (p.match(/\b\d{1,2}:\d{2}\b/)?.[0]) || ''
        items.push({ time: time || pubDate, currency: cur, title })
      }
    } catch (e:any) { console.error(e) }
  }
  const curList = currencies ? currencies.split(',').map(s=>s.trim().toUpperCase()) : []
  if (curList.length) items = items.filter(i => curList.includes(i.currency))
  res.status(200).json({ items, note: rss ? 'Fetched' : 'Set CALENDAR_RSS_URL to enable auto-fetch' })
}
