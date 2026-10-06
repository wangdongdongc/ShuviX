/**
 * QueuePanel — 输入框卡片里的「待投递队列」（P3-11）
 *
 * 读视图的 `queue`（`selectSessionQueueItems`）：两档 —— 立即（steer）在前、追加（followUp）在后，档内按
 * 收件箱次序（PIN-11）。每行可以**撤回**（`agent.withdrawQueued`）：撤回从不乐观移除 —— 那一行跟着下一帧
 * 视图走（撤回了 / 已经放下了，视图里都不再有它）。在途时按钮禁用，连点只发一次。已经放下（撤不回）与
 * 出错时在面板里就地给一句、约 3 秒后消失（PIN-10）；`settled` / `not_found` 不出声（那一行反正要没了）。
 * 渠道端（Chrome 侧边栏，没有 HostApi）同样有撤回。
 *
 * 形态与 PendingInputsPanel 同源（渲染进输入框卡片内部，自身无边框/圆角/阴影，
 * 只用一条 border-b 与下方分隔），但更安静：连底色都不要，因为它可能与
 * PendingInputsPanel 同时在场，而后者的语义优先级更高（Agent 正等你回答）。
 *
 * 默认折叠成一条计数细条；展开才逐条铺开。队列平时不该占输入框的高度。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, CornerDownLeft, Layers, X, Zap } from 'lucide-react'
import type { QueuedInputView } from '@shuvix/chat-protocol/types/sessionView'
import { getSessionChannelApi } from '@shuvix/chat-ui'
import { useChatStore, selectSessionQueueItems } from '../../stores/chatStore'

type Tier = QueuedInputView['mode']

/** 两档急迫度：立即 > 追加。顺序即渲染顺序 */
const TIERS: ReadonlyArray<{
  tier: Tier
  icon: typeof Zap
  /** 徽章配色（底色 + 文字） */
  tone: string
}> = [
  { tier: 'steer', icon: Zap, tone: 'bg-warning/12 text-warning' },
  { tier: 'followUp', icon: CornerDownLeft, tone: 'bg-accent/12 text-accent' }
]

/** 就地提示停留多久（PIN-10） */
export const QUEUE_NOTICE_MS = 3000

export function QueuePanel(): React.JSX.Element | null {
  const { t } = useTranslation()
  const items = useChatStore(selectSessionQueueItems)
  const sessionId = useChatStore((s) => s.activeSessionId)
  const [expanded, setExpanded] = useState(false)
  // 在途的撤回：ref 同步拦连点，state 驱动禁用
  const inFlight = useRef(new Set<number>())
  const [pending, setPending] = useState<ReadonlySet<number>>(() => new Set())
  const [notice, setNotice] = useState<{ sessionId: string; text: string } | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), QUEUE_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const shownNotice = notice && notice.sessionId === sessionId ? notice.text : null
  // 撤不回的那一行已经被放下、离开了队列：面板为那句提示留着
  if (items.length === 0 && !shownNotice) return null

  const steer = items.filter((item) => item.mode === 'steer')
  const followUp = items.filter((item) => item.mode === 'followUp')
  const byTier: Record<Tier, QueuedInputView[]> = { steer, followUp }
  const rows = [...steer, ...followUp]

  const withdraw = async (submissionId: number): Promise<void> => {
    if (!sessionId || inFlight.current.has(submissionId)) return
    inFlight.current.add(submissionId)
    setPending(new Set(inFlight.current))
    try {
      const { result } = await getSessionChannelApi().agent.withdrawQueued({
        sessionId,
        submissionId
      })
      if (result === 'already_placed') setNotice({ sessionId, text: t('queue.alreadyPlaced') })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      setNotice({ sessionId, text: t('queue.withdrawFailed', { error }) })
    } finally {
      inFlight.current.delete(submissionId)
      setPending(new Set(inFlight.current))
    }
  }

  return (
    <div className="border-b border-border-secondary/40 px-3.5 py-1.5" data-queue-panel="">
      {/* 细条：总数 + 各档计数；点任意处展开 */}
      {items.length > 0 && (
        <button
          type="button"
          data-queue-toggle=""
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-2 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
          title={expanded ? t('queue.collapse') : t('queue.expand')}
        >
          <Layers size={12} className="flex-shrink-0" />
          <span>{t('queue.title', { count: items.length })}</span>
          {TIERS.map(({ tier }) =>
            byTier[tier].length > 0 ? (
              <span key={tier} className="tabular-nums" data-queue-count={tier}>
                {t(`queue.${tier}`)} {byTier[tier].length}
              </span>
            ) : null
          )}
          <span className="flex-1" />
          {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </button>
      )}

      {/* 展开：逐条铺开（长队列自身封顶滚动，不把输入区顶出屏幕）；按 submissionId 作 key */}
      {expanded && rows.length > 0 && (
        <div className="mt-1 space-y-0.5 max-h-[30vh] overflow-y-auto thin-scrollbar">
          {rows.map((item) => {
            const spec = TIERS.find((s) => s.tier === item.mode)!
            const Icon = spec.icon
            const busy = pending.has(item.submissionId)
            return (
              <div
                key={item.submissionId}
                className="group/qrow flex items-center gap-2 py-0.5"
                data-queue-row={item.submissionId}
                data-queue-mode={item.mode}
              >
                <span
                  className={`flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${spec.tone}`}
                  title={t(`queue.${item.mode}Hint`)}
                >
                  <Icon size={10} />
                  {t(`queue.${item.mode}`)}
                </span>
                <span className="flex-1 min-w-0 truncate text-[12px] text-text-secondary">
                  {item.text || t('queue.emptyText')}
                </span>
                {item.imageCount > 0 && (
                  <span className="flex-shrink-0 text-[10px] text-text-tertiary tabular-nums">
                    {t('queue.images', { count: item.imageCount })}
                  </span>
                )}
                <button
                  type="button"
                  data-queue-withdraw={item.submissionId}
                  disabled={busy}
                  onClick={() => void withdraw(item.submissionId)}
                  aria-label={t('queue.withdraw')}
                  title={t('queue.withdrawHint')}
                  className={`flex-shrink-0 p-0.5 rounded transition-colors ${
                    busy
                      ? 'text-text-tertiary cursor-not-allowed'
                      : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover'
                  }`}
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* 就地提示（撤不回 / 出错），约 3 秒后消失 */}
      {shownNotice && (
        <div className="mt-1 text-[11px] text-warning" role="status" data-queue-notice="">
          {shownNotice}
        </div>
      )}
    </div>
  )
}
