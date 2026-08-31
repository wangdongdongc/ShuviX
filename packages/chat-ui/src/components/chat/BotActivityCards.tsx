/**
 * 聊天会话的在飞活动展示（设计 §5.4 的占位卡，A2）—— 渲染在对话滚动区尾部（Footer）。
 *
 * 两级展示：
 *  - `started`（意图段判断中）合并为**一条轻量指示行**（头像列 + 三点）：设计只要求
 *    「task 判定通过即落占位卡」，但意图段最长 60s，完全无反馈是死气；N 个成员同时
 *    started 时逐个铺卡又会闪出一排 —— 一行是两者间的落点。
 *  - `claimed` / `queued` / `working` 每成员一张占位卡：署名 + 相位文案 + 计时,
 *    claimed/working 带 **per-bot 停止**（`agent.abortBot`,可选成员 —— 渠道端没有就不渲染;
 *    排队卡不给停止钮：排队是 mailbox 的事,「停止」停的是正在做的事）。
 *
 *  回复到达即由 assistant_message 落卡、activity `ended` 删本条 —— 视觉上就是原位替换。
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Square } from 'lucide-react'
import { useChatStore, selectBotActivities, type BotActivitySnapshot } from '../../stores/chatStore'
import { getSessionChannelApi } from '../../api/chatApi'
import { BotAvatar } from '../common/BotAvatar'

const PHASE_KEY: Record<Exclude<BotActivitySnapshot['phase'], 'started'>, string> = {
  claimed: 'bot.activityClaimed',
  queued: 'bot.activityQueued',
  working: 'bot.activityWorking'
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

function ActivityCard({
  sessionId,
  act
}: {
  sessionId: string
  act: BotActivitySnapshot & { phase: Exclude<BotActivitySnapshot['phase'], 'started'> }
}): React.JSX.Element {
  const { t } = useTranslation()
  const elapsed = useElapsedSec(act.at)
  const abortBot = getSessionChannelApi().agent.abortBot
  const stoppable = act.phase !== 'queued' && !!abortBot && !!act.messageId
  return (
    <div
      className="flex items-center gap-2.5 rounded-xl border border-border-secondary bg-bg-secondary/60 px-3.5 py-2"
      data-bot-activity={act.botName}
      data-bot-activity-phase={act.phase}
    >
      <BotAvatar name={act.botName} displayName={act.displayName} size={18} />
      <span className="text-xs font-medium text-text-primary">{act.displayName}</span>
      {act.phase !== 'queued' && (
        <span className="h-3 w-3 flex-shrink-0 animate-spin rounded-full border-[1.5px] border-border-primary border-t-accent" />
      )}
      <span className="min-w-0 truncate text-xs text-text-secondary">
        {t(PHASE_KEY[act.phase])}
      </span>
      <span className="ml-auto text-[11px] tabular-nums text-text-tertiary">{elapsed}s</span>
      {stoppable && (
        <button
          onClick={() =>
            void abortBot({ sessionId, botName: act.botName, messageId: act.messageId! })
          }
          title={t('bot.stop')}
          className="flex-shrink-0 rounded-md border border-border-primary p-1 text-text-tertiary hover:border-error hover:text-error transition-colors"
          data-bot-stop={act.botName}
        >
          <Square size={10} fill="currentColor" />
        </button>
      )}
    </div>
  )
}

export function BotActivityCards(): React.JSX.Element | null {
  const { t } = useTranslation()
  const sessionId = useChatStore((s) => s.activeSessionId)
  const activities = useChatStore(selectBotActivities)

  const { deciding, cards } = useMemo(() => {
    const list = Object.values(activities)
    return {
      deciding: list.filter((a) => a.phase === 'started'),
      cards: list.filter(
        (a): a is BotActivitySnapshot & { phase: 'claimed' | 'queued' | 'working' } =>
          a.phase !== 'started'
      )
    }
  }, [activities])

  if (!sessionId || (deciding.length === 0 && cards.length === 0)) return null

  return (
    <div className="mx-auto flex w-full max-w-[784px] flex-col gap-2 px-4 py-2" data-bot-activities>
      {cards.map((a) => (
        <ActivityCard key={a.botName} sessionId={sessionId} act={a} />
      ))}
      {deciding.length > 0 && (
        <div
          className="flex items-center gap-2 px-1 text-xs text-text-tertiary"
          data-bot-deciding={deciding.length}
        >
          <span className="flex -space-x-1">
            {deciding.map((a) => (
              <BotAvatar key={a.botName} name={a.botName} displayName={a.displayName} size={14} />
            ))}
          </span>
          <span>{t('bot.activityIntent')}</span>
          <span className="flex gap-0.5">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1 w-1 animate-bounce rounded-full bg-text-tertiary/60"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
        </div>
      )}
    </div>
  )
}
