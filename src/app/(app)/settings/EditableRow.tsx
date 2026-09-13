'use client'

import { useActionState, useState } from 'react'
import { SubmitButton, FormError, FormOk } from '@/components/ui'
import type { ActionState } from './actions'

/**
 * 목록 안에서 바로 펼쳐 고치는 행.
 * 설정 화면은 항목 수가 적어 별도 페이지로 나눌 필요가 없다.
 */
export function InlineEditor({
  action,
  summary,
  children,
  openLabel = '수정',
  defaultOpen = false,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>
  summary: React.ReactNode
  children: React.ReactNode
  openLabel?: string
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [state, formAction] = useActionState<ActionState, FormData>(action, {})

  return (
    <>
      <tr className={open ? 'bg-sunken' : ''}>
        {summary}
        <td className="w-20">
          <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen((v) => !v)}>
            {open ? '닫기' : openLabel}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={99} className="bg-sunken/60 p-0">
            <form action={formAction} className="space-y-3 px-5 py-4">
              <FormError message={state.error} />
              <FormOk message={state.ok} />
              {children}
              <div className="flex gap-2 pt-1">
                <SubmitButton>저장</SubmitButton>
                <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>취소</button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  )
}

/** 새 항목 추가 패널 — 목록 위에 접혀 있다가 펼쳐진다. */
export function AddPanel({
  action,
  title,
  children,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>
  title: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [state, formAction] = useActionState<ActionState, FormData>(action, {})

  if (!open) {
    return (
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        + {title}
      </button>
    )
  }

  return (
    <form action={formAction} className="card">
      <div className="card-head"><h2 className="text-sm font-semibold">{title}</h2></div>
      <div className="card-body space-y-3">
        <FormError message={state.error} />
        <FormOk message={state.ok} />
        {children}
        <div className="flex gap-2 pt-1">
          <SubmitButton>등록</SubmitButton>
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>취소</button>
        </div>
      </div>
    </form>
  )
}

/** 토글 버튼 (활성/비활성) */
export function ToggleButton({
  action,
  id,
  isActive,
  activeLabel = '사용',
  inactiveLabel = '중지',
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>
  id: string
  isActive: boolean
  activeLabel?: string
  inactiveLabel?: string
}) {
  const [, formAction] = useActionState<ActionState, FormData>(action, {})
  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      <SubmitButton className="btn-ghost btn-sm" pendingLabel="…">
        {isActive ? inactiveLabel : activeLabel}
      </SubmitButton>
    </form>
  )
}
