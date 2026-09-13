import { chromium } from 'playwright'
const BASE = 'http://localhost:3000'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const errors = []
page.on('pageerror', e => errors.push(`JS: ${e.message}`))
page.on('response', r => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`) })
const shot = async n => { await page.waitForTimeout(700); await page.screenshot({ path: `/tmp/shots/${n}.png`, fullPage: true }); console.log(`  촬영: ${n}`) }

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.fill('#loginId', 'admin'); await page.fill('#password', 'yiwudream1234')
await Promise.all([page.waitForURL(`${BASE}/`), page.click('button[type=submit]')])

for (const [path, name] of [
  ['/funds', '30-funds'],
  ['/remittances', '31-remittances'],
  ['/remittances/new', '32-remit-new'],
  ['/transfers', '33-transfers'],
  ['/orders', '34-orders'],
]) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await shot(name)
}

console.log('\n송금 등록 (선택 → 합계 채우기 → 저장)')
await page.goto(`${BASE}/remittances/new`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)
const boxes = await page.locator('tbody input[type=checkbox]').count()
console.log(`  송금대기 ${boxes}건`)
if (boxes > 0) {
  await page.locator('tbody input[type=checkbox]').first().check()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: '선택 합계를 송금액으로' }).click()
  await page.waitForTimeout(400)
  await page.fill('input[name=cnyArrivalAmount]', '4587.15')
  await page.fill('input[name=bankFeeKrw]', '15000')
  await shot('35-remit-filled')
  await page.getByRole('button', { name: '송금 등록' }).click()
  await page.waitForTimeout(3000)
  console.log(`  → ${page.url()}`)
  await shot('36-remit-done')
  await page.goto(`${BASE}/funds`, { waitUntil: 'domcontentloaded' })
  await shot('37-funds-after')
}

await browser.close()
console.log(errors.length ? `\n⚠ 오류 ${errors.length}건:\n${errors.join('\n')}` : '\n✓ 콘솔 오류 없음')
