/**
 * 运行状态行（P3-12）—— 视图 `run.retry` / `run.compacting` 的呈现，占的是 StreamingFooter 那一格：
 * 退避期间投影给的是 `live: null`（P3-02-21），没有实时卡可挂，倒计时只能站在列表末尾。
 *
 *  - 重试倒计时：`run.retry.attempt` 是**失败的那一次**（durable 语义，P3-03 结转），下一次 = attempt + 1；
 *    `at` 是主进程的毫秒时间戳（同一台机器，PIN-22），每秒一跳、钳到 0，到点了显示「正在重试」，绝不出负数；
 *    原因只显示第一行（截断），全文在 `title` 里。
 *  - 压缩通知：按 `reason` 给文案（不认识的原因走通用文案），`blocking:false` 是后台变体；`attempt > 1`
 *    带上第几次，`retryAt` 带倒计时。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw } from 'lucide-react'
import type { RunCompactingView, RunRetryView } from '@shuvix/chat-protocol/types/sessionView'
import { clipLine } from '../../utils/clipLine'

/** 原因行最多这么多字（再长的交给 CSS 截断 + title 全文） */
const REASON_MAX = 200

/** 此刻的毫秒时间，每秒刷新一次（卸载即停表） */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** 距 `at` 还有几秒（向上取整，钳到 0） */
function secondsUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000))
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? ''
  return clipLine(line.trim(), REASON_MAX)
}

export function RunRetryRow({ retry }: { retry: RunRetryView }): React.JSX.Element {
  const { t } = useTranslation()
  const now = useNow()
  const seconds = secondsUntil(retry.at, now)
  const attempt = retry.attempt + 1
  const reason = firstLine(retry.error)
  return (
    <div
      data-run-retry=""
      className="flex items-center gap-1.5 min-w-0 text-[11px] text-text-tertiary"
    >
      <RefreshCw size={12} className="flex-shrink-0 animate-spin" />
      <span className="shrink-0 tabular-nums">
        {seconds > 0 ? t('run.retrying', { attempt, seconds }) : t('run.retryingNow', { attempt })}
      </span>
      {reason && (
        <span
          data-run-retry-reason=""
          className="min-w-0 truncate text-error/80"
          title={retry.error}
        >
          {reason}
        </span>
      )}
    </div>
  )
}

const COMPACTING_REASON_KEYS: Record<string, string> = {
  threshold: 'run.compactingReasonThreshold',
  overflow: 'run.compactingReasonOverflow',
  manual: 'run.compactingReasonManual'
}

export function RunCompactingRow({
  compacting
}: {
  compacting: RunCompactingView
}): React.JSX.Element {
  const { t } = useTranslation()
  const now = useNow()
  const reason = t(COMPACTING_REASON_KEYS[compacting.reason] ?? 'run.compactingReasonUnknown')
  const parts = [
    t(compacting.blocking ? 'run.compactingBlocking' : 'run.compactingBackground', { reason })
  ]
  if (compacting.attempt > 1)
    parts.push(t('run.compactingAttempt', { attempt: compacting.attempt }))
  if (compacting.retryAt !== undefined) {
    parts.push(t('run.compactingRetry', { seconds: secondsUntil(compacting.retryAt, now) }))
  }
  return (
    <div
      data-run-compacting={compacting.blocking ? 'blocking' : 'background'}
      className="flex items-center gap-1.5 min-w-0 text-[11px] text-text-tertiary"
    >
      <Loader2 size={12} className="flex-shrink-0 animate-spin" />
      <span className="truncate tabular-nums">{parts.join(' · ')}</span>
    </div>
  )
}
