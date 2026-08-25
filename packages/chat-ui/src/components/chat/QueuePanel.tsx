/**
 * QueuePanel — 输入框卡片里的「待投递队列」回执区
 *
 * 只读。pi 的三条用户消息队列对外只有入队和 `abort()` 全量清空 —— 没有出队 / 改序 /
 * 改档 / 改内容，所以这里刻意不提供任何行内操作：它回答的是「我刚排的东西还在不在、
 * 排在哪一档」，决策发生在输入框的发送控件上，一旦按下就不可撤回。
 *
 * 形态与 PendingInputsPanel 同源（渲染进输入框卡片内部，自身无边框/圆角/阴影，
 * 只用一条 border-b 与下方分隔），但更安静：连底色都不要，因为它可能与
 * PendingInputsPanel 同时在场，而后者的语义优先级更高（Agent 正等你回答）。
 *
 * 默认折叠成一条计数细条；展开才逐条铺开。队列平时不该占输入框的高度。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, CornerDownLeft, CornerRightDown, Layers, Zap } from 'lucide-react'
import type { ChatQueuedMessage } from '@shuvix/chat-protocol/events'
import { useChatStore, selectSessionQueue } from '../../stores/chatStore'

type Tier = 'steer' | 'followUp' | 'nextTurn'

/** 三档急迫度：立即 > 追加 > 下轮。顺序即渲染顺序。 */
const TIERS: ReadonlyArray<{
  tier: Tier
  icon: typeof Zap
  /** 徽章配色（底色 + 文字） */
  tone: string
}> = [
  { tier: 'steer', icon: Zap, tone: 'bg-warning/12 text-warning' },
  { tier: 'followUp', icon: CornerDownLeft, tone: 'bg-accent/12 text-accent' },
  { tier: 'nextTurn', icon: CornerRightDown, tone: 'bg-bg-hover text-text-tertiary' }
]

export function QueuePanel(): React.JSX.Element | null {
  const { t } = useTranslation()
  const queue = useChatStore(selectSessionQueue)
  const [expanded, setExpanded] = useState(false)

  const total = queue.steer.length + queue.followUp.length + queue.nextTurn.length
  if (total === 0) return null

  const rows: Array<{ tier: Tier; msg: ChatQueuedMessage; key: string }> = []
  for (const { tier } of TIERS) {
    queue[tier].forEach((msg, i) => rows.push({ tier, msg, key: `${tier}-${i}` }))
  }

  return (
    <div className="border-b border-border-secondary/40 px-3.5 py-1.5">
      {/* 细条：总数 + 各档计数；点任意处展开 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
        title={expanded ? t('queue.collapse') : t('queue.expand')}
      >
        <Layers size={12} className="flex-shrink-0" />
        <span>{t('queue.title', { count: total })}</span>
        {TIERS.map(({ tier }) =>
          queue[tier].length > 0 ? (
            <span key={tier} className="tabular-nums">
              {t(`queue.${tier}`)} {queue[tier].length}
            </span>
          ) : null
        )}
        <span className="flex-1" />
        {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
      </button>

      {/* 展开：逐条铺开（长队列自身封顶滚动，不把输入区顶出屏幕） */}
      {expanded && (
        <div className="mt-1 space-y-0.5 max-h-[30vh] overflow-y-auto thin-scrollbar">
          {rows.map(({ tier, msg, key }) => {
            const spec = TIERS.find((s) => s.tier === tier)!
            const Icon = spec.icon
            return (
              <div key={key} className="flex items-center gap-2 py-0.5">
                <span
                  className={`flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${spec.tone}`}
                  title={t(`queue.${tier}Hint`)}
                >
                  <Icon size={10} />
                  {t(`queue.${tier}`)}
                </span>
                <span className="flex-1 min-w-0 truncate text-[12px] text-text-secondary">
                  {msg.text || t('queue.emptyText')}
                </span>
                {msg.imageCount > 0 && (
                  <span className="flex-shrink-0 text-[10px] text-text-tertiary tabular-nums">
                    {t('queue.images', { count: msg.imageCount })}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
