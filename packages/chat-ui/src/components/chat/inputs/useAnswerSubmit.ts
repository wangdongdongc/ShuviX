/**
 * 发送一张询问卡片的答复：发送中不重复发，被拒时留下错误给卡片显示。成功后询问从视图消失，卡片随之卸载。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { connectionFailureOf } from '@shuvix/chat-protocol/connectionErrors'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

/** 答卡片失败时说什么：断线是一句固定的话，其余报原文 */
export function answerErrorText(err: unknown, t: (key: string) => string): string {
  if (connectionFailureOf(err) !== null) return t('input.connectionLost')
  return err instanceof Error ? err.message : String(err)
}

export interface AnswerSubmit {
  send: (response: InputResponse) => void
  sending: boolean
  error: string | null
  clearError: () => void
}

export function useAnswerSubmit(
  onSubmit: (response: InputResponse) => void | Promise<void>
): AnswerSubmit {
  const { t } = useTranslation()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = (response: InputResponse): void => {
    if (sending) return
    setSending(true)
    setError(null)
    // 当场调用；同步抛出也落进 catch
    new Promise<void>((resolve) => resolve(onSubmit(response)))
      .catch((err: unknown) => setError(answerErrorText(err, t)))
      .finally(() => setSending(false))
  }

  return { send, sending, error, clearError: () => setError(null) }
}
