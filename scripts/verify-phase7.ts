/**
 * Phase 7 검증 — 권한
 *
 * 대표님 지시: 「대표는 모든 것을 보고, 직원들은 입력할 수 있게만,
 *             수정하면 기록이 남게, 권한은 아이디 만들 때 내가 부여하게」
 *
 * 권한은 코드 한 줄 바뀌면 조용히 넓어진다. 넓어지면 아무도 모른다.
 * 그래서 「누가 무엇을 할 수 있는가」 를 표로 박아 두고 어긋나면 실패시킨다.
 */
import { PrismaClient, Role } from '@prisma/client'
import { can, atLeast, ROLE_SUMMARY, ROLE_LABEL, type Permission } from '../src/lib/permissions'

const prisma = new PrismaClient()
let pass = 0, fail = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = String(actual), e = String(expected)
  if (a === e) { pass++; console.log(`  ✓ ${label} = ${a}`) }
  else { fail++; console.log(`  ✗ ${label} — 기대 ${e}, 실제 ${a}`) }
}

/** 이 표가 곧 명세다. 바꾸려면 여기를 먼저 바꿔야 한다 */
const MATRIX: Record<Permission, Role[]> = {
  'dashboard.view': [Role.OWNER, Role.MANAGER, Role.STAFF, Role.VIEWER],
  'transaction.write': [Role.OWNER, Role.MANAGER, Role.STAFF],
  'profit.view': [Role.OWNER, Role.MANAGER],
  'transaction.void': [Role.OWNER, Role.MANAGER],
  'remittance.execute': [Role.OWNER, Role.MANAGER],
  'invoice.confirm': [Role.OWNER, Role.MANAGER],
  'payroll.view': [Role.OWNER, Role.MANAGER],
  'audit.view': [Role.OWNER, Role.MANAGER],
  'settings.manage': [Role.OWNER],
}

const ROLES: Role[] = [Role.OWNER, Role.MANAGER, Role.STAFF, Role.VIEWER]

async function main() {
  console.log('\n━━ 1. 권한표 ━━')
  for (const [perm, allowed] of Object.entries(MATRIX) as [Permission, Role[]][]) {
    for (const r of ROLES) {
      check(`${ROLE_LABEL[r]} → ${perm}`, can(r, perm), allowed.includes(r))
    }
  }

  console.log('\n━━ 2. 대표는 모든 것을 본다 ━━')
  const perms = Object.keys(MATRIX) as Permission[]
  check('대표가 못 하는 것', perms.filter((p) => !can(Role.OWNER, p)).length, 0)

  console.log('\n━━ 3. 직원은 입력만 ━━')
  check('직원 — 거래 등록·수정', can(Role.STAFF, 'transaction.write'), true)
  check('직원 — 회사 손익·자금현황', can(Role.STAFF, 'profit.view'), false)
  check('직원 — 거래 취소', can(Role.STAFF, 'transaction.void'), false)
  check('직원 — 해외송금 실행', can(Role.STAFF, 'remittance.execute'), false)
  check('직원 — 급여', can(Role.STAFF, 'payroll.view'), false)
  check('직원 — 설정·사용자관리', can(Role.STAFF, 'settings.manage'), false)

  console.log('\n━━ 4. 조회 권한은 아무것도 못 넣는다 ━━')
  check('조회 — 거래 등록', can(Role.VIEWER, 'transaction.write'), false)
  check('조회 — 회사 손익', can(Role.VIEWER, 'profit.view'), false)

  console.log('\n━━ 5. 등급은 아래를 포함한다 ━━')
  for (const p of perms) {
    const ok = ROLES.every((r) =>
      ROLES.every((r2) => (atLeast(r2, r) && can(r, p) ? can(r2, p) : true)))
    check(`${p} — 상위 등급이 하위를 포함`, ok, true)
  }

  console.log('\n━━ 6. 화면에 보여줄 설명이 실제 권한과 맞는가 ━━')
  // 설명은 아이디 만들 때 대표님이 읽는 글이다. 실제 권한과 어긋나면 거짓말이 된다
  check('직원 설명에 손익이 「못 함」 으로', ROLE_SUMMARY.STAFF.cannot.some((x) => x.includes('손익')), true)
  check('직원 설명에 입력이 「할 수 있음」 으로',
    ROLE_SUMMARY.STAFF.can.some((x) => x.includes('거래 등록')), true)
  check('대표는 못 하는 것이 없다고 적혀 있다', ROLE_SUMMARY.OWNER.cannot.length, 0)
  for (const r of ROLES) {
    check(`${ROLE_LABEL[r]} 설명이 비어 있지 않다`, ROLE_SUMMARY[r].can.length > 0, true)
  }

  console.log('\n━━ 6-1. 직원 화면에 무엇이 보이나 ━━')
  // 화면 목록과 권한이 따로 놀면 「보이는데 눌러도 안 되는」 메뉴가 생긴다
  const NAV: { label: string; perm: Permission | null }[] = [
    { label: '대시보드', perm: null },
    { label: '자금현황', perm: 'profit.view' },
    { label: '거래 목록', perm: null },
    { label: '거래처 관리', perm: null },
    { label: '해외송금', perm: 'remittance.execute' },
    { label: '내부 자금이동', perm: 'profit.view' },
    { label: '세금계산서', perm: 'invoice.confirm' },
    { label: '직원 급여', perm: 'payroll.view' },
    { label: '임시공 비용', perm: null },
    { label: '중국 운영비', perm: null },
    { label: '엑셀 가져오기', perm: 'settings.manage' },
    { label: '설정', perm: 'settings.manage' },
    { label: '변경이력', perm: 'audit.view' },
  ]
  const visibleTo = (r: Role) =>
    NAV.filter((n) => !n.perm || can(r, n.perm)).map((n) => n.label)
  check('대표에게 보이는 메뉴 수', visibleTo(Role.OWNER).length, NAV.length)
  check('직원에게 보이는 메뉴',
    visibleTo(Role.STAFF).join(' · '),
    '대시보드 · 거래 목록 · 거래처 관리 · 임시공 비용 · 중국 운영비')

  console.log('\n━━ 7. 수정하면 기록이 남는가 ━━')
  const owner = await prisma.user.findFirstOrThrow({ where: { loginId: 'admin' } })
  const stamp = Date.now() % 1e6
  const partner = await prisma.partner.create({
    data: { code: `Q${stamp}`, name: `권한검증${stamp}`, nameNormalized: `q${stamp}`, createdBy: owner.id },
  })
  const { logUpdate } = await import('../src/lib/audit')
  await logUpdate(prisma, 'partners', partner.id,
    { name: partner.name }, { name: `${partner.name}-변경` },
    { user: { id: owner.id.toString(), name: owner.name }, reason: '검증' })
  const log = await prisma.auditLog.findFirst({
    where: { tableName: 'partners', recordId: partner.id },
    orderBy: { id: 'desc' },
  })
  check('변경이력이 남는다', log !== null, true)
  check('바뀐 항목', log?.fieldName, 'name')
  check('기존 값', log?.oldValue, partner.name)
  check('바뀐 값', log?.newValue, `${partner.name}-변경`)
  check('누가', log?.changedBy?.toString(), owner.id.toString())
  check('언제', log?.changedAt !== null, true)

  await prisma.partner.delete({ where: { id: partner.id } })

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`통과 ${pass} / 실패 ${fail}`)
  if (fail > 0) process.exitCode = 1
}

main().finally(() => prisma.$disconnect())
