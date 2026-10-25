import { createContext, useContext, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Lightbulb, Loader2 } from 'lucide-react'
import {
  suggestionGroupKey,
  suggestionsOf,
  type AcceptSuggestionResult,
  type SuggestionGroupState
} from '@shuvix/chat-protocol/suggestions'
import type { InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import { getHostApi } from '../../api/chatApi'
import type { AssistantBlock } from '../../stores/chatStore'

/**
 * 这条会话里每组提议的状态（`suggestionStatesOf` 的结果，Conversation 按整条消息列表算好往下给）。没有 Provider =
 * 不知道会话（比如别处借用这张卡）：卡片只读
 */
export const SuggestionContext = createContext<{
  sessionId: string
  states: ReadonlyMap<string, SuggestionGroupState>
} | null>(null)

/** 采纳被拒的原因 → 给人读的一句 */
function failureText(
  result: Extract<AcceptSuggestionResult, { success: false }>,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  if (result.reason === 'closed') return t('suggestion.errorClosed')
  if (result.reason === 'not-found') return t('suggestion.errorNotFound')
  return t('suggestion.errorFailed', { error: result.error ?? '' })
}

/**
 * 一次 `suggest` 调用的提议卡片（画在助手卡片底部，不进步骤组）：每条是标题、理由、采纳后要发的那句话（全文）和一个
 * 「采纳」按钮。点了 → 主进程核对后把那句话作为用户回复发进会话（会话在跑就是 steer）。之后用户说了别的话，这组就关了。
 *
 * 状态全从会话本身读（见 chat-protocol `suggestions.ts`）；这里只多一个「刚点过、会话里还没出现那条消息」的本地态。
 */
export function SuggestionCards({
  messageId,
  block
}: {
  messageId: string
  block: Extract<AssistantBlock, { type: 'tool' }>
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const ctx = useContext(SuggestionContext)
  const [sending, setSending] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const items = suggestionsOf(block.args)
  if (!items.some(Boolean)) return null

  const state: SuggestionGroupState = ctx?.states.get(
    suggestionGroupKey(messageId, block.toolCallId)
  ) ?? { status: 'closed' }
  // 宿主面（`getHostApi`）：Chrome 侧边栏只注入了会话通道，这里取到 null → 卡片只读（getChatApi 在那里会抛）
  const accept = getHostApi()?.suggestion?.accept
  const canAccept = !!ctx && !!accept && state.status === 'open' && sending === null

  const onAccept = async (index: number): Promise<void> => {
    if (!ctx || !accept || !canAccept) return
    setSending(index)
    setError(null)
    try {
      const result = await accept({
        sessionId: ctx.sessionId,
        messageId,
        toolCallId: block.toolCallId,
        index
      })
      if (!result.success) {
        setSending(null)
        setError(failureText(result, t))
      }
      // 成功：那条消息随会话视图到达，这组随之变成「已采纳」；在那之前按钮保持忙碌，免得再点一次
    } catch (e) {
      setSending(null)
      setError(t('suggestion.errorFailed', { error: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <div data-suggestions data-suggestion-state={state.status} className="mt-2 space-y-1.5">
      <div className="flex items-center gap-1 text-[11px] text-text-tertiary">
        <Lightbulb size={12} className="text-warning flex-shrink-0" />
        <span>{t('suggestion.header')}</span>
      </div>
      {items.map((item, index) => {
        if (!item) return null
        const accepted = state.status === 'accepted' && state.index === index
        const dimmed = state.status !== 'open' && !accepted
        return (
          <div
            key={index}
            data-suggestion-index={index}
            data-suggestion-accepted={accepted || undefined}
            className={`rounded-lg border px-3 py-2 transition-opacity ${
              accepted ? 'border-accent/40 bg-accent/[0.04]' : 'border-border-primary'
            } ${dimmed ? 'opacity-50' : ''}`}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-primary break-words">
                  {item.title}
                </div>
                {item.detail && (
                  <div className="mt-0.5 text-xs text-text-secondary break-words">
                    {item.detail}
                  </div>
                )}
              </div>
              {accepted ? (
                <span className="flex flex-shrink-0 items-center gap-1 text-[11px] text-accent">
                  <Check size={12} />
                  {t('suggestion.accepted')}
                </span>
              ) : state.status === 'open' && ctx && accept ? (
                <button
                  type="button"
                  data-suggestion-accept
                  disabled={!canAccept}
                  onClick={() => void onAccept(index)}
                  className="flex flex-shrink-0 items-center gap-1 rounded-md border border-accent/40 px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/10 disabled:opacity-60 disabled:cursor-default transition-colors"
                >
                  {sending === index && <Loader2 size={11} className="animate-spin" />}
                  {t('suggestion.accept')}
                </button>
              ) : null}
            </div>
            {/* 采纳时发出去的就是这句话：全文显示，用户点之前看得见自己在同意什么 */}
            <div className="mt-1.5 text-xs text-text-tertiary">
              <span>{t('suggestion.willSend')}</span>
              <span className="mx-1">·</span>
              <span
                data-suggestion-message
                className="whitespace-pre-wrap break-words text-text-secondary"
              >
                {item.message}
              </span>
            </div>
          </div>
        )
      })}
      {/* 没有 Provider（别处借用这张卡）时不知道会话往下走了没有，不说「已继续」 */}
      {state.status === 'closed' && ctx && (
        <div className="text-[11px] text-text-tertiary">{t('suggestion.closed')}</div>
      )}
      {error && (
        <div data-suggestion-error className="text-[11px] text-error">
          {error}
        </div>
      )}
    </div>
  )
}

/** 用户气泡下的「采纳的提议」小标签：这句话是点提议发出的，文字由 agent 写（本机窗口发的也标） */
export function SuggestionOriginTag({
  origin
}: {
  origin: InputOrigin | undefined
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!origin || !('suggestion' in origin) || !origin.suggestion) return null
  return (
    <span
      data-origin-suggestion
      title={t('message.originSuggestionHint')}
      className="mr-1 inline-flex items-center gap-0.5 rounded bg-bg-tertiary px-1.5 py-px text-[10px] font-medium text-text-secondary"
    >
      <Lightbulb size={10} />
      {t('message.originSuggestion')}
    </span>
  )
}
