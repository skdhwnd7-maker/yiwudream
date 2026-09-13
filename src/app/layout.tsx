import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '이우드림무역 자금관리',
  description: '매입·매출·해외송금·마진 관리 시스템',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  )
}
