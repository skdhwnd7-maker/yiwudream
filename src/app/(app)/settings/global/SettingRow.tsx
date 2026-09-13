'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/ui'
import type { ActionState } from '../actions'

export default function SettingRow({
  action,
  settingKey,
  value,
  description,
  options,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>
  settingKey: string
  value: string
  description: string
  options?: { value: string; label: string }[]
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {})

  return (
    <tr>
      <td className="num text-xs align-middle">{settingKey}</td>
      <td className="align-middle">
        <form action={formAction} id={`f-${settingKey}`} className="flex items-center gap-2">
          <input type="hidden" name="key" value={settingKey} />
          {options ? (
            <select name="value" defaultValue={value}>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input name="value" defaultValue={value} className="num" />
          )}
        </form>
      </td>
      <td className="align-middle text-xs text-ink-2">
        {description}
        {state.error && <span className="ml-2 text-clay">{state.error}</span>}
        {state.ok && <span className="ml-2 text-jade">{state.ok}</span>}
      </td>
      <td className="align-middle">
        <button type="submit" form={`f-${settingKey}`} className="btn-ghost btn-sm">저장</button>
      </td>
    </tr>
  )
}
