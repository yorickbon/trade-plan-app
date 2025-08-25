'use client'
import { useEffect, useRef } from 'react'

type Props = { symbol: string }

declare global { interface Window { TradingView?: any } }

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject()
    document.head.appendChild(s)
  })
}

export default function TradingViewTriple({ symbol }: Props) {
  const ref15 = useRef<HTMLDivElement>(null)
  const ref1H = useRef<HTMLDivElement>(null)
  const ref4H = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let mounted = true
    async function init() {
      if (!window.TradingView) {
        await loadScript('https://s3.tradingview.com/tv.js')
      }
      if (!mounted) return
      const common:any = {
        symbol,
        width: "100%",
        height: 420,
        theme: "dark",
        style: "1",
        locale: "en",
        toolbar_bg: "#0b1220",
        hide_legend: false,
        enable_publishing: false,
        hide_top_toolbar: false,
        hide_side_toolbar: false,
        allow_symbol_change: false,
        container_id: ""
      }
      if (ref4H.current) {
        new window.TradingView.widget({ ...common, interval: "240", container_id: ref4H.current.id })
      }
      if (ref1H.current) {
        new window.TradingView.widget({ ...common, interval: "60", container_id: ref1H.current.id })
      }
      if (ref15.current) {
        new window.TradingView.widget({ ...common, interval: "15", container_id: ref15.current.id })
      }
    }
    init()
    return () => { mounted = false }
  }, [symbol])

  return (
    <div className="row">
      <div className="card"><div className="label">4H</div><div id="tv-4h" ref={ref4H} /></div>
      <div className="card"><div className="label">1H</div><div id="tv-1h" ref={ref1H} /></div>
      <div className="card"><div className="label">15m</div><div id="tv-15m" ref={ref15} /></div>
    </div>
  )
}
