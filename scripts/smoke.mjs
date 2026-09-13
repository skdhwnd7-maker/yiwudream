import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(`JS: ${e.message}`))
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`) })

async function shot(name) {
  await page.waitForTimeout(600)
  await page.screenshot({ path: `/tmp/shots/${name}.png`, fullPage: true })
  console.log(`  촬영: ${name}`)
}

console.log('로그인')
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await shot('01-login')
await page.fill('#loginId', 'admin')
await page.fill('#password', 'yiwudream1234')
await page.click('button[type=submit]')
await page.waitForURL(`${BASE}/`, { timeout: 15000 })
console.log('  → 대시보드 진입')
await shot('02-dashboard')

for (const [path, name] of [
  ['/partners', '03-partners'],
  ['/partners/new', '04-partner-new'],
  ['/settings/accounts', '05-accounts'],
  ['/settings/categories', '06-categories'],
  ['/settings/deal-types', '07-deal-types'],
  ['/settings/users', '08-users'],
  ['/settings/global', '09-global'],
  ['/audit', '10-audit'],
]) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await shot(name)
}

console.log('\n거래처 등록 (아르미르샵133 → 꼬리번호 분리 확인)')
await page.goto(`${BASE}/partners/new`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)              // 하이드레이션 대기
await page.fill('#name', '아르미르샵133')
await page.selectOption('#defaultRoute', 'BANK_CORP')
await page.getByRole('button', { name: '등록', exact: true }).click()
await page.waitForTimeout(2500)
await page.waitForTimeout(1500)
const okMsg = await page.locator('form > div.border-jade, form > div.border-clay').first().textContent().catch(() => null)
console.log(`  결과: ${okMsg?.trim() ?? '(메시지 없음)'}`)

console.log('\n거래유형 부가세 미리보기')
await page.goto(`${BASE}/settings/deal-types`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.getByRole('button', { name: '수정' }).first().click()
await page.waitForTimeout(600)
await shot('11-dealtype-edit')

console.log('\n변경이력 확인')
await page.goto(`${BASE}/audit`, { waitUntil: 'domcontentloaded' })
const rows = await page.locator('tbody tr').count()
console.log(`  이력 ${rows}행`)
await shot('12-audit-after')

await browser.close()
console.log(errors.length ? `\n⚠ 오류 ${errors.length}건:\n${errors.join('\n')}` : '\n✓ 콘솔 오류 없음')
