import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Trade Plan Assistant',
  description: 'Daily trade plans with charts, calendar, and AI-generated trade card.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
