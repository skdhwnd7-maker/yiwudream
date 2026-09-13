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
  ['/invoices', '40-invoices'],
  ['/invoices?tab=unbilled', '41-unbilled'],
  ['/invoices/new', '42-invoice-new'],
  ['/payroll', '43-payroll'],
  ['/temp-labor', '44-temp-labor'],
  ['/office', '45-office'],
]) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await shot(name)
}

console.log('\n직원 등록 → 급여 입력')
await page.goto(`${BASE}/payroll`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1800)
await page.getByRole('button', { name: '+ 직원 추가' }).click()
await page.waitForTimeout(400)
await page.fill('input[name=name]', '검증직원')
await page.fill('input[name=nameCn]', '沈丹凤')
await page.fill('input[name=baseSalary]', '9500')
await page.getByRole('button', { name: '등록', exact: true }).click()
await page.waitForTimeout(2500)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1800)
const inputBtn = page.getByRole('button', { name: '입력' }).first()
if (await inputBtn.count() > 0) {
  await inputBtn.click()
  await page.waitForTimeout(500)
  await page.fill('input[name=actualPaid]', '9500')
  await page.fill('input[name=insuranceCompany]', '1416')
  await page.fill('input[name=fxRate]', '218')
  await page.getByRole('button', { name: '저장' }).first().click()
  await page.waitForTimeout(2500)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await shot('46-payroll-entered')
  await page.goto(`${BASE}/office`, { waitUntil: 'domcontentloaded' })
  await shot('47-office-after')
}

await browser.close()
console.log(errors.length ? `\n⚠ 오류 ${errors.length}건:\n${errors.join('\n')}` : '\n✓ 콘솔 오류 없음')
