'use client'

import { useActionState } from 'react'
import { loginAction, type LoginState } from './actions'
import { SubmitButton, FormError } from '@/components/ui'
import { Field } from '@/components/Field'

export default function LoginForm() {
  const [state, action] = useActionState<LoginState, FormData>(loginAction, {})

  return (
    <form action={action} className="space-y-4">
      <FormError message={state.error} />
      <Field label="아이디" name="loginId">
        <input id="loginId" name="loginId" autoComplete="username" autoFocus required />
      </Field>
      <Field label="비밀번호" name="password">
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <SubmitButton className="btn-primary w-full" pendingLabel="확인 중…">
        로그인
      </SubmitButton>
    </form>
  )
}
