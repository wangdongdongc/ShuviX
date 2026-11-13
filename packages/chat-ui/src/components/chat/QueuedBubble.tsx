/**
 * QueuedBubble — 运行中发出、还排着等边界的一条输入，画成对话流末尾的一条占位气泡。
 *
 * 样子与「发送后、受理前」的乐观占位同源（UserBubble 压淡一档）：它还不是会话里的条目，放下之后视图
 * 带来真实的用户消息，同一句话在原地换成真的那条。气泡右上方标档位（立即 / 追加），下方操作行常驻一个
 * **撤回**（`agent.withdrawQueued`）：撤回从不乐观移除 —— 气泡跟着下一帧视图走（撤回了 / 已经放下了，
 * 视图的 `queue` 里都不再有它）。在途时按钮禁用，连点只发一次。已经放下（撤不回）与出错时在气泡下
 * 就地给一句、约 3 秒后消失；`settled` / `not_found` 不出声（那条气泡反正要没了）。渠道端（Chrome
 * 侧边栏，没有 HostApi）同样有撤回。
 *
 * 数据只读视图的 `queue`（服务端的），所以别的窗口、手机上看到的是同一组气泡。视图只带显示文本与图片
 * 张数：内联 Token 已是芯片文字，图片只标张数。
 */
import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CornerDownLeft, X, Zap } from 'lucide-react'
import type { QueuedInputView } from '@shuvix/chat-protocol/types/sessionView'
import { getSessionChannelApi } from '../../api/chatApi'
import { useChatStore, type UserTextMessage } from '../../stores/chatStore'
import { useChatDensity } from '../../host/chatHostContext'
import { UserBubble } from './UserBubble'

/** 两档急迫度的徽章：图标 + 配色 */
const TIERS: Record<QueuedInputView['mode'], { icon: typeof Zap; tone: string }> = {
  steer: { icon: Zap, tone: 'bg-warning/12 text-warning' },
  followUp: { icon: CornerDownLeft, tone: 'bg-accent/12 text-accent' }
}

/** 就地提示停留多久（PIN-10） */
export const QUEUE_NOTICE_MS = 3000

interface QueuedBubbleProps {
  /** 为这条排队输入造的占位用户消息（见 buildVisibleItems） */
  msg: UserTextMessage
  entry: QueuedInputView
}

export const QueuedBubble = memo(function QueuedBubble({
  msg,
  entry
}: QueuedBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  const touch = useChatDensity() === 'touch'
  // 队列属于当前会话的视图（与 selectSessionQueueItems 同口径）
  const sessionId = useChatStore((s) => s.activeSessionId)
  // 在途的撤回：ref 同步拦连点，state 驱动禁用
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), QUEUE_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const withdraw = async (): Promise<void> => {
    if (!sessionId || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      const { result } = await getSessionChannelApi().agent.withdrawQueued({
        sessionId,
        submissionId: entry.submissionId
      })
      if (result === 'already_placed') setNotice(t('queue.alreadyPlaced'))
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      setNotice(t('queue.withdrawFailed', { error }))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const { icon: Icon, tone } = TIERS[entry.mode]
  const meta = (
    <>
      {entry.imageCount > 0 && (
        <span data-queue-images="" className="text-[10px] text-text-tertiary tabular-nums">
          {t('queue.images', { count: entry.imageCount })}
        </span>
      )}
      <span
        data-queue-tier-badge={entry.mode}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${tone}`}
        title={t(`queue.${entry.mode}Hint`)}
      >
        <Icon size={10} />
        {t(`queue.${entry.mode}`)}
      </span>
    </>
  )
  const actions = (
    <button
      type="button"
      data-queue-withdraw={entry.submissionId}
      disabled={busy}
      onClick={() => void withdraw()}
      title={t('queue.withdrawHint')}
      className={`flex items-center gap-0.5 rounded text-xs transition-colors ${
        touch ? 'h-8 px-2' : 'px-1 py-0.5'
      } ${
        busy
          ? 'text-text-tertiary cursor-not-allowed'
          : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover'
      }`}
    >
      <X size={touch ? 14 : 11} />
      {t('queue.withdraw')}
    </button>
  )

  return (
    <>
      <UserBubble
        msg={msg}
        pending
        metaSlot={meta}
        actionSlot={actions}
        emptyText={t('queue.emptyText')}
      />
      {/* 就地提示（撤不回 / 出错），约 3 秒后消失 */}
      {notice && (
        <div
          className="px-4 -mt-1 pb-1 text-right text-[11px] text-warning"
          role="status"
          data-queue-notice=""
        >
          {notice}
        </div>
      )}
    </>
  )
})
