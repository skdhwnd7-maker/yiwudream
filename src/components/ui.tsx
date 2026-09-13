'use client'

import { useFormStatus } from 'react-dom'

/** 저장 중에는 눌리지 않게. 돈 넣는 화면에서 중복 제출은 사고다. */
export function SubmitButton({
  children,
  className = 'btn-primary',
  pendingLabel = '저장 중…',
}: {
  children: React.ReactNode
  className?: string
  pendingLabel?: string
}) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? pendingLabel : children}
    </button>
  )
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null
  return (
    <div className="rounded-sm border border-clay bg-clay-soft px-3.5 py-2.5 text-sm text-clay">
      {message}
    </div>
  )
}

export function FormOk({ message }: { message?: string | null }) {
  if (!message) return null
  return (
    <div className="rounded-sm border border-jade bg-jade-soft px-3.5 py-2.5 text-sm text-jade">
      {message}
    </div>
  )
}

export function EmptyRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="py-10 text-center text-sm text-ink-muted">
        {label}
      </td>
    </tr>
  )
}
