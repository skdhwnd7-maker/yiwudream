/**
 * 기준정보 초기 데이터.
 *
 * 거래유형의 세무 규칙은 전부 엑셀 분석과 대표님 확인으로 확정된 값이다.
 * 근거: docs/01-엑셀분석.md, docs/03-데이터베이스설계.md 2-6
 */
import { PrismaClient, Role, Entity, Route, Currency, CostType, RevenueBasis, InvoiceBase, VatMode, Rounding } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { normalizeName } from '../src/lib/normalize'

const prisma = new PrismaClient()

/** 개발·검증용 기본 비밀번호. 운영에서는 절대 쓰지 않는다 */
const DEV_ADMIN_PASSWORD = 'yiwudream1234'

function resolveAdminPassword(): string {
  const given = process.env.SEED_ADMIN_PASSWORD?.trim()
  if (given) {
    if (given.length < 8) {
      throw new Error('SEED_ADMIN_PASSWORD 가 너무 짧습니다. 8자 이상으로 넣어 주세요.')
    }
    return given
  }

  // 운영으로 보이면 기본 비밀번호를 쓰지 않고 멈춘다
  const isProduction = process.env.NODE_ENV === 'production'
    || process.env.YD_ENV === 'production'
  if (isProduction) {
    throw new Error(
      '운영 환경에서는 SEED_ADMIN_PASSWORD 없이 설치할 수 없습니다.\n'
      + '  관리자 비밀번호를 정해 넣어 주세요. 8자 이상입니다.\n'
      + '  예) SEED_ADMIN_PASSWORD="..." npm run db:seed',
    )
  }

  console.warn(
    '⚠ SEED_ADMIN_PASSWORD 가 없어 개발용 기본 비밀번호로 만듭니다.\n'
    + '  운영에 올리기 전에 반드시 바꾸세요.',
  )
  return DEV_ADMIN_PASSWORD
}

async function main() {
  // ── 사용자 ──────────────────────────────────────────────
  //
  // 운영에서는 아는 비밀번호로 계정이 만들어지면 안 된다.
  // SEED_ADMIN_PASSWORD 가 없으면 설치를 중단한다 — 「나중에 바꾸겠지」 는 안 바꾼다.
  const adminPw = resolveAdminPassword()
  const admin = await prisma.user.upsert({
    where: { loginId: 'admin' },
    update: {},
    create: {
      loginId: 'admin',
      passwordHash: await bcrypt.hash(adminPw, 10),
      name: '대표',
      role: Role.OWNER,
    },
  })
  // 비밀번호는 찍지 않는다. 터미널 기록과 로그에 그대로 남는다.
  console.log('사용자: admin (비밀번호는 SEED_ADMIN_PASSWORD 로 넣은 값입니다)')

  const by = admin.id

  // ── 비용분류 ────────────────────────────────────────────
  // 엑셀 확인: 비용 열 3개(대행통관·인건비·기타비)는 전부 CNY였다.
  const categories: Array<[string, string, CostType, Entity, Currency, number]> = [
    ['GOODS', '중국 상품대금', CostType.ORDER_COST, Entity.CN, Currency.CNY, 10],
    ['CUSTOMS', '대행통관비', CostType.ORDER_COST, Entity.CN, Currency.CNY, 20],
    ['LABOR_CN', '중국 인건비·작업비', CostType.BOTH, Entity.CN, Currency.CNY, 30],
    ['INSPECT', '검품비', CostType.ORDER_COST, Entity.CN, Currency.CNY, 40],
    ['PACKING', '포장비', CostType.ORDER_COST, Entity.CN, Currency.CNY, 50],
    ['SHIPPING', '운송비', CostType.ORDER_COST, Entity.CN, Currency.CNY, 60],
    ['TEMP_LABOR', '임시공 인건비', CostType.BOTH, Entity.CN, Currency.CNY, 70],
    ['ETC_ORDER', '기타비용', CostType.BOTH, Entity.CN, Currency.CNY, 80],
    ['SALARY', '중국 직원 급여', CostType.OPERATING, Entity.CN, Currency.CNY, 90],
    ['INSURANCE', '사회보험(社保)', CostType.OPERATING, Entity.CN, Currency.CNY, 100],
    ['OFFICE', '사무실 운영비', CostType.OPERATING, Entity.CN, Currency.CNY, 110],
    ['BANK_FEE', '송금·은행 수수료', CostType.BOTH, Entity.KR, Currency.KRW, 120],
  ]
  for (const [code, name, costType, defaultEntity, defaultCurrency, sortOrder] of categories) {
    await prisma.expenseCategory.upsert({
      where: { code },
      update: { name, costType, defaultEntity, defaultCurrency, sortOrder },
      create: { code, name, costType, defaultEntity, defaultCurrency, sortOrder },
    })
  }
  console.log(`비용분류 ${categories.length}건`)

  // ── 거래유형 ────────────────────────────────────────────
  // vatMode 근거:
  //   CORP_FULL / CORP_NOBILL — 엑셀 M = C × 1.1 (부가세 별도). 미발행 369건도 부가세를 받으심.
  //   SITE_AGENCY            — 대표님 확인: 수수료는 부가세 포함.
  //   GEN_DEPOSIT            — 대표님 확인: 일반통장은 부가세와 무관.
  const dealTypes: Array<{
    code: string; name: string; revenueBasis: RevenueBasis; invoiceBase: InvoiceBase
    invoiceDefault: boolean; vatMode: VatMode; accountingClass: string; defaultRoute: Route
    sortOrder: number; memo: string
  }> = [
    {
      code: 'OVERSEAS_DIRECT', name: '해외송금 직접거래',
      revenueBasis: RevenueBasis.GROSS, invoiceBase: InvoiceBase.NONE, invoiceDefault: false,
      vatMode: VatMode.EXEMPT, accountingClass: '해외매출', defaultRoute: Route.OVERSEAS, sortOrder: 10,
      memo: '중국법인 계좌 직수취. 마진은 CNY 도착금액 기준. USD 인보이스는 참고값.',
    },
    {
      code: 'GEN_DEPOSIT', name: '일반통장 정산',
      revenueBasis: RevenueBasis.GROSS, invoiceBase: InvoiceBase.NONE, invoiceDefault: false,
      vatMode: VatMode.NONE, accountingClass: '용역매출', defaultRoute: Route.BANK_GEN, sortOrder: 20,
      memo: '부가세와 무관. 입금액이 곧 매출이며 VAT 분해가 생기지 않는다.',
    },
    {
      code: 'CORP_FULL', name: '법인통장 전액발행',
      revenueBasis: RevenueBasis.GROSS, invoiceBase: InvoiceBase.TOTAL_RECEIPT, invoiceDefault: true,
      vatMode: VatMode.EXCLUDED, accountingClass: '상품매출', defaultRoute: Route.BANK_CORP, sortOrder: 30,
      memo: '입금액 = 공급가액 × 1.1. 세금계산서 발행. 엑셀 114건이 여기 해당.',
    },
    {
      code: 'CORP_NOBILL', name: '법인통장 미발행',
      revenueBasis: RevenueBasis.GROSS, invoiceBase: InvoiceBase.NONE, invoiceDefault: false,
      vatMode: VatMode.EXCLUDED, accountingClass: '상품매출', defaultRoute: Route.BANK_CORP, sortOrder: 40,
      memo: '부가세는 받되 세금계산서만 미발행. 엑셀 369건이 여기 해당. 미발행·부가세수취 목록에 잡힌다.',
    },
    {
      code: 'CORP_CUSTOMS', name: '대행통관 용역',
      revenueBasis: RevenueBasis.GROSS, invoiceBase: InvoiceBase.CUSTOMS_ONLY, invoiceDefault: true,
      vatMode: VatMode.EXCLUDED, accountingClass: '용역매출', defaultRoute: Route.BANK_CORP, sortOrder: 50,
      memo: '대행통관비만 세금계산서 대상.',
    },
    {
      code: 'SITE_AGENCY', name: '사이트 구매대행',
      revenueBasis: RevenueBasis.NET, invoiceBase: InvoiceBase.FEE_ONLY, invoiceDefault: true,
      vatMode: VatMode.INCLUDED, accountingClass: '중개수수료', defaultRoute: Route.SITE, sortOrder: 60,
      memo: '입금 = 상품예치금 + 수수료(부가세 포함). 수수료 공급가액만 매출로 인식한다.',
    },
  ]
  for (const dt of dealTypes) {
    await prisma.dealType.upsert({
      where: { code: dt.code },
      update: { ...dt, rounding: Rounding.FLOOR },
      create: { ...dt, rounding: Rounding.FLOOR },
    })
  }
  console.log(`거래유형 ${dealTypes.length}건`)

  // ── 계좌 ────────────────────────────────────────────────
  const accounts: Array<[string, Entity, Route, Currency]> = [
    ['한국 법인통장', Entity.KR, Route.BANK_CORP, Currency.KRW],
    ['한국 일반통장', Entity.KR, Route.BANK_GEN, Currency.KRW],
    ['사이트 결제계좌', Entity.KR, Route.SITE, Currency.KRW],
    ['중국법인 계좌', Entity.CN, Route.OVERSEAS, Currency.CNY],
  ]
  for (const [name, entity, route, currency] of accounts) {
    const exists = await prisma.account.findFirst({ where: { name } })
    if (!exists) {
      await prisma.account.create({
        data: { name, entity, route, currency, openingBalance: 0, createdBy: by },
      })
    }
  }
  console.log(`계좌 ${accounts.length}건`)

  // ── 이우드림 내부 계정 ──────────────────────────────────
  // 엑셀 해외송금 시트의 자체 송금 16건(USD 1,110,000)이 매출로 잡히던 것을 막는다.
  const internalExists = await prisma.partner.findFirst({ where: { isInternal: true } })
  if (!internalExists) {
    await prisma.partner.create({
      data: {
        code: 'P0000',
        name: '이우드림(자사)',
        nameNormalized: normalizeName('이우드림'),
        isInternal: true,
        memo: '한국법인 → 중국법인 자체 자금이동용. 매출·마진 집계에서 제외된다.',
        createdBy: by,
        aliases: {
          create: [
            { alias: '이우드림', aliasNormalized: normalizeName('이우드림'), source: 'IMPORT' },
          ],
        },
      },
    })
    console.log('내부 계정 생성: 이우드림(자사)')
  }

  // ── 전역 설정 ───────────────────────────────────────────
  const settings: Array<[string, string, string, string]> = [
    ['base_currency', 'KRW', 'string', '기준통화'],
    ['order_no_prefix', 'ORDER', 'string', '주문번호 접두사'],
    ['krw_rounding', 'FLOOR', 'string', '원 단위 처리 (ROUND/FLOOR/CEIL)'],
    ['margin_rate_basis', 'REVENUE', 'string', '마진율 분모 — REVENUE(매출 대비, 기본) / COST(원가 대비)'],
    ['margin_vat_basis', 'SUPPLY', 'string', '마진 기준 — SUPPLY(공급가액, 기본) / GROSS(부가세 포함 총액)'],
    ['receivable_warn_days', '30', 'number', '미수금 주황 경고 기준일'],
    ['receivable_alert_days', '90', 'number', '미수금 빨강 경고 기준일'],
    ['fx_deviation_percent', '10', 'number', '환율 이탈 경고 기준(%)'],
  ]
  for (const [key, value, valueType, description] of settings) {
    await prisma.setting.upsert({
      where: { key },
      update: { description },
      create: { key, value, valueType, description },
    })
  }
  console.log(`전역설정 ${settings.length}건`)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
