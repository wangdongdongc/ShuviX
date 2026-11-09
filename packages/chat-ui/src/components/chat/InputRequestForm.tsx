/**
 * InputRequestForm —— 一条询问（审批 / 选择题）的表单，不依赖「当前打开的会话」：收件箱不打开会话就地回答用。
 *
 * 与对话流末尾那张卡片是**同一个表单**（AskForm / ChoiceForm：同样的命令预览、diff、要填的值、「允许并记住」各行、
 * 数字键、「其它」那一行），草稿也是同一份（chatStore 的 `sessionInputDrafts`，按会话 + 请求 id）—— 在收件箱里
 * 写了一半，打开那条会话还在。外框与语义色由放它的地方给。
 */
import { useEffect } from 'react'
import { useChatStore } from '../../stores/chatStore'
import type {
  AskInputRequest,
  ChoiceInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import { AskForm } from './inputs/AskForm'
import { ChoiceForm } from './inputs/ChoiceForm'
import { emptyAskDraft, emptyChoiceDraft, type AskDraft, type ChoiceDraft } from './inputs/drafts'

export interface InputRequestFormProps {
  /** 询问挂在哪条会话上（草稿按它存） */
  sessionId: string
  request: InputRequest
  /** 发送答复；返回 Promise 时表单接住失败、把错误显示在卡片上 */
  onResponse: (response: InputResponse) => void | Promise<void>
  /** 标题行右端插槽 */
  titleAccessory?: React.ReactNode
}

export function InputRequestForm({
  sessionId,
  request,
  onResponse,
  titleAccessory
}: InputRequestFormProps): React.JSX.Element | null {
  const draft = useChatStore((s) => s.sessionInputDrafts[sessionId]?.[request.id])
  const setInputDraft = useChatStore((s) => s.setInputDraft)

  // 草稿惰性建：第一次摆这张卡时写进 store（之后对话里那张卡读的也是它）
  useEffect(() => {
    if (draft !== undefined) return
    setInputDraft(
      sessionId,
      request.id,
      request.kind === 'ask' ? emptyAskDraft() : emptyChoiceDraft()
    )
  }, [draft, request.id, request.kind, sessionId, setInputDraft])

  if (draft === undefined) return null
  const onDraftChange = (next: unknown): void => setInputDraft(sessionId, request.id, next)

  return (
    <div className="flex flex-col min-h-0 max-h-[60vh]" data-pending-inputs={request.kind}>
      {request.kind === 'ask' ? (
        <AskForm
          key={request.id}
          request={request as AskInputRequest}
          draft={draft as AskDraft}
          onDraftChange={onDraftChange}
          onSubmit={onResponse}
          titleAccessory={titleAccessory}
        />
      ) : (
        <ChoiceForm
          key={request.id}
          request={request as ChoiceInputRequest}
          draft={draft as ChoiceDraft}
          onDraftChange={onDraftChange}
          onSubmit={onResponse}
          titleAccessory={titleAccessory}
        />
      )}
    </div>
  )
}
