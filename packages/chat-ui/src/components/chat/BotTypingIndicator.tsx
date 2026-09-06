/**
 * 「正在输入」—— 渲染在对话滚动区尾部（Footer）：会话绑定的 bot 在飞时的一行。
 *
 * 形态是聊天里最自然的那一个：头像 + 名字 + 三点，与它随后要落下的气泡同列对齐，
 * 回复到达时视觉上就是原位替换。会话是一对一的，所以至多一行。
 *
 * 相位差异只剩两处仍然要说出口：排队（这条消息还没轮到它，停止无意义，所以不给停止钮）
 * 和意图判断（最长 60s，完全无反馈是死气）。其余一律只显示三点。
 * 按消息停止（`agent.abortBot`，渠道端可选）就在这一行上。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Square } from 'lucide-react'
import { useChatStore, selectBotActivity, type BotActivitySnapshot } from '../../stores/chatStore'
import { getSessionChannelApi } from '../../api/chatApi'
import { BotAvatar } from '../common/BotAvatar'

/** 只有这两个相位还需要文案；其余（started 之外的 working）三点自己会说话 */
const PHASE_KEY: Partial<Record<BotActivitySnapshot['phase'], string>> = {
  started: 'bot.activityIntent',
  queued: 'bot.activityQueued'
}

/** 秒级计时（挂载期间每秒 tick 一次；只有存在活动时本组件才被渲染） */
function useElapsedSec(from: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return Math.max(0, Math.floor((now - from) / 1000))
}

function TypingDots(): React.JSX.Element {
  return (
    <span className="flex gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1 w-1 animate-bounce rounded-full bg-text-tertiary/70"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  )
}

function TypingRow({
  sessionId,
  act
}: {
  sessionId: string
  act: BotActivitySnapshot
}): React.JSX.Element {
  const { t } = useTranslation()
  const elapsed = useElapsedSec(act.at)
  const abortBot = getSessionChannelApi().agent.abortBot
  // 排队的那条消息还没开始做，「停止」无处可停
  const stoppable = act.phase !== 'queued' && !!abortBot && !!act.messageId
  const hint = PHASE_KEY[act.phase]

  return (
    <div
      className="flex items-center gap-1.5 px-4 py-0.5"
      data-bot-activity={act.botName}
      data-bot-activity-phase={act.phase}
    >
      <BotAvatar name={act.botName} displayName={act.displayName} size={18} />
      <span className="truncate text-xs font-medium text-text-primary">{act.displayName}</span>
      <TypingDots />
      {hint && <span className="min-w-0 truncate text-xs text-text-tertiary">{t(hint)}</span>}
      <span className="text-[11px] tabular-nums text-text-tertiary/70">{elapsed}s</span>
      {stoppable && (
        <button
          onClick={() => void abortBot({ sessionId, messageId: act.messageId! })}
          title={t('bot.stop')}
          // 恒可见（只是压低对比度），不做悬停才显形：伸手按停止的人正处在「它跑偏了」
          // 的当口，让他先找到该往哪儿悬停是最坏的时机。复制钮可以藏，这个不行
          className="flex-shrink-0 rounded p-0.5 text-text-tertiary/60 transition-colors hover:text-error"
          data-bot-stop={act.botName}
        >
          <Square size={10} fill="currentColor" />
        </button>
      )}
    </div>
  )
}

export function BotTypingIndicator(): React.JSX.Element | null {
  const sessionId = useChatStore((s) => s.activeSessionId)
  const act = useChatStore(selectBotActivity)

  if (!sessionId || !act) return null

  return (
    <div className="mx-auto flex w-full max-w-[784px] flex-col py-1" data-bot-activities>
      <TypingRow sessionId={sessionId} act={act} />
    </div>
  )
}
