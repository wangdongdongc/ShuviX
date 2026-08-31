/**
 * 误压制救济 chip（设计 §7）：「XX 也想回答」，点击 = **定向重发**原用户消息给该成员。
 *
 * 两个挂点共用：胜者回复卡底部（数据在 `AssistantMeta.suppressed`，随消息持久化，
 * 重开会话仍在）与全体沉默提示（胜者半路失败、名单无消息可挂时）。
 *
 * 定向的机制是**提及**：重发文本带 `@displayName ` 前缀，走 L0 的裸文本降级匹配
 * （botGate.mentionsFromText —— A3 的胶囊 token 落地前它就是正路）。原文用
 * `resolveTokensForCopy` 展开成可读文本 —— 直接转发裸 marker 会变成无字典的死 token。
 * 图片不随行：救济针对的是「这个问题该由谁答」，不是逐字节重放。
 */
import { useTranslation } from 'react-i18next'
import { CornerUpRight } from 'lucide-react'
import type { SuppressedCandidate, UserTextMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { resolveTokensForCopy } from '@shuvix/chat-protocol/utils/inlineTokens'
import { getSessionChannelApi } from '../../api/chatApi'
import { useChatStore } from '../../stores/chatStore'
import { BotAvatar } from '../common/BotAvatar'

export interface BotRescueChipsProps {
  sessionId: string
  suppressed: SuppressedCandidate[]
  /**
   * 原用户消息的定位：给 userMessageId 直接命中（沉默提示场合）；
   * 给 beforeAssistantId 则从该 assistant 消息向前找最近的用户消息（胜者卡场合）。
   */
  origin: { userMessageId: string } | { beforeAssistantId: string }
}

export function BotRescueChips({
  sessionId,
  suppressed,
  origin
}: BotRescueChipsProps): React.JSX.Element | null {
  const { t } = useTranslation()
  if (suppressed.length === 0) return null

  const resend = (candidate: SuppressedCandidate): void => {
    const messages = useChatStore.getState().messages
    let originMsg: UserTextMessage | null = null
    if ('userMessageId' in origin) {
      const m = messages.find((x) => x.id === origin.userMessageId)
      if (m && m.role === 'user') originMsg = m
    } else {
      const at = messages.findIndex((x) => x.id === origin.beforeAssistantId)
      for (let i = (at < 0 ? messages.length : at) - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role === 'user') {
          originMsg = m
          break
        }
      }
    }
    if (!originMsg) return
    const text = resolveTokensForCopy(originMsg.content, originMsg.metadata?.inlineTokens)
    void getSessionChannelApi().agent.prompt({
      sessionId,
      text: `@${candidate.displayName} ${text}`
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-bot-rescue>
      <span className="text-[11px] text-text-tertiary">{t('bot.rescueLabel')}</span>
      {suppressed.map((c) => (
        <button
          key={c.name}
          onClick={() => resend(c)}
          title={c.reason || undefined}
          className="inline-flex items-center gap-1.5 rounded-full border border-border-primary bg-bg-secondary px-2.5 py-0.5 text-[11.5px] text-text-secondary hover:text-text-primary hover:border-border-primary/80 transition-colors"
          data-bot-rescue-chip={c.name}
        >
          <BotAvatar name={c.name} displayName={c.displayName} size={14} />
          {c.displayName}
          <CornerUpRight size={10} className="text-text-tertiary" />
        </button>
      ))}
    </div>
  )
}
