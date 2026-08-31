/**
 * 全体沉默的一次性提示（设计 §9 可见结局不变式，A2）—— 输入卡内、待处理面板之下。
 *
 * 只在多 bot 会话出现（单 bot 的沉默由可见失败消息留痕，事件根本不发）。三种定性文案
 * 按 reason 走；逐成员结局收进 title 悬浮 —— 提示要一眼读完，尸检细节属于决策子视图（A4）。
 * 胜者半路失败时无处可挂的救济名单也在这里给出（`suppressed`）。
 *
 * 「一次性」的三个出口：手动 ✕、下一轮活动开始（handleBotActivity started 顺带清）、
 * 回退/清空（messages_reloaded 清）。
 */
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useChatStore, selectBotSilence } from '../../stores/chatStore'
import { BotRescueChips } from './BotRescueChips'

export function BotSilenceNotice(): React.JSX.Element | null {
  const { t } = useTranslation()
  const sessionId = useChatStore((s) => s.activeSessionId)
  const notice = useChatStore(selectBotSilence)
  const setBotSilence = useChatStore((s) => s.setBotSilence)
  if (!sessionId || !notice) return null

  const text =
    notice.reason === 'all_ignored'
      ? t('bot.silenceAllIgnored', { count: notice.members.length })
      : notice.reason === 'all_failed'
        ? t('bot.silenceAllFailed')
        : t('bot.silenceMixed')
  const detail = notice.members.map((m) => `${m.displayName}: ${m.outcome}`).join(' · ')

  return (
    <div
      className="border-b border-border-secondary/40 border-l-2 border-l-warning/70 px-3.5 py-2"
      data-bot-silence={notice.reason}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-text-secondary" title={detail}>
          {text}
        </p>
        <button
          onClick={() => setBotSilence(sessionId, null)}
          className="flex-shrink-0 rounded p-0.5 text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
          data-bot-silence-dismiss
        >
          <X size={12} />
        </button>
      </div>
      {notice.suppressed && notice.suppressed.length > 0 && (
        <div className="mt-1.5">
          <BotRescueChips
            sessionId={sessionId}
            suppressed={notice.suppressed}
            origin={{ userMessageId: notice.messageId }}
          />
        </div>
      )}
    </div>
  )
}
