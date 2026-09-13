import type { Metadata } from 'next'
import { IBM_Plex_Sans_KR, IBM_Plex_Mono, Noto_Serif_KR } from 'next/font/google'
import './globals.css'

// 사내망 PC에서 인터넷 없이도 돌아가야 한다.
// next/font 는 빌드할 때 폰트 파일을 받아 같이 배포하므로 실행 중 외부 요청이 없다.
const sans = IBM_Plex_Sans_KR({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
})
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
})
const serif = Noto_Serif_KR({
  subsets: ['latin'],
  weight: ['600'],
  variable: '--font-serif',
  display: 'swap',
})

export const metadata: Metadata = {
  title: '이우드림무역 자금관리',
  description: '매입·매출·해외송금·마진 관리 시스템',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={`${sans.variable} ${mono.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  )
}
