import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const errors = []
page.on('pageerror', (e) => errors.push(`JS: ${e.message}`))
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`) })

const shot = async (n) => { await page.waitForTimeout(700); await page.screenshot({ path: `/tmp/shots/${n}.png`, fullPage: true }); console.log(`  촬영: ${n}`) }
const hydrate = () => page.waitForTimeout(1800)

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.fill('#loginId', 'admin'); await page.fill('#password', 'yiwudream1234')
await Promise.all([page.waitForURL(`${BASE}/`), page.click('button[type=submit]')])
console.log('로그인 완료')

// 거래처 준비
await page.goto(`${BASE}/partners/new`, { waitUntil: 'domcontentloaded' }); await hydrate()
await page.fill('#name', '테스트상사')
await page.selectOption('#defaultRoute', 'SITE')
await page.getByRole('button', { name: '등록', exact: true }).click()
await page.waitForTimeout(2000)

console.log('\n사이트 결제 거래 등록 (1,100,000 → 예치금 + 수수료 + 부가세)')
await page.goto(`${BASE}/orders/new`, { waitUntil: 'domcontentloaded' }); await hydrate()
await page.selectOption('#partnerId', { index: 1 })
await page.waitForTimeout(500)
await shot('20-wizard-step2')
await page.getByRole('button', { name: /사이트 결제/ }).click()
await page.waitForTimeout(600)
await page.fill('#amount', '1100000')
await page.fill('#feeRatePct', '9.09')
await page.waitForTimeout(500)
await shot('21-wizard-preview')
await page.getByRole('button', { name: '거래 등록' }).click()
await page.waitForURL(/\/orders\/\d+/, { timeout: 15000 })
console.log(`  → ${page.url()}`)
await shot('22-order-detail')

console.log('\n지출 추가 (포장비 15,000)')
await hydrate()
await page.getByRole('button', { name: '+ 지출 추가' }).click()
await page.waitForTimeout(500)
await page.selectOption('select[name=categoryId]', { label: '포장비' })
await page.selectOption('select[name=currency]', 'KRW')
await page.fill('input[name=amount]', '15000')
await page.fill('input[name=vendorName]', '○○포장')
await page.getByRole('button', { name: '지출 저장' }).click()
await page.waitForTimeout(2500)
await page.reload({ waitUntil: 'domcontentloaded' })
await shot('23-order-with-expense')

const summary = await page.locator('table').first().innerText()
console.log('  요약:'); console.log(summary.split('\n').map(l => '    ' + l).join('\n'))

await page.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' })
await shot('24-orders-list')

await browser.close()
console.log(errors.length ? `\n⚠ 오류 ${errors.length}건:\n${errors.join('\n')}` : '\n✓ 콘솔 오류 없음')
