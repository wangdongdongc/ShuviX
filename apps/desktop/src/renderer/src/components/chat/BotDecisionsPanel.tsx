/**
 * 「Bot 决策」子视图（A4，设计 §9）：这个会话里每条消息、每个成员各自经历了什么 ——
 * 「为什么没说话」的用户侧出口。数据来自 decisions.jsonl（bot:decisions 跨目录过滤合并），
 * 按消息分组（messageSeq），成员一行一记。
 *
 * kind 是与决策记录同源的**开放集**（自定义管线会带来新值），故不逐值翻译 —— 以等宽
 * 原文呈现 + 按大类上色（沉默提示对 members[].outcome 也是同一立场）。detail 收进
 * title 悬浮，正文只留一眼能读完的部分。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { BotAvatar, useChatStore } from '@shuvix/chat-ui'

/** kind → 语义色（前缀归类；未知值落中性） */
function toneOf(kind: string): string {
  if (kind === 'claim_won' || kind === 'claim_solo') return 'text-success bg-success/10'
  if (kind === 'run_end') return 'text-text-secondary bg-bg-hover/60'
  if (
    kind.endsWith('_timeout') ||
    kind.endsWith('_error') ||
    kind === 'gate_broken' ||
    kind === 'pipeline_not_found' ||
    kind === 'pipeline_invalid_input' ||
    kind === 'arbitration_bypassed' ||
    kind === 'say_blocked'
  )
    return 'text-error bg-error/10'
  if (kind === 'cohort_silent' || kind === 'gate_fallback' || kind === 'degraded_reply')
    return 'text-warning bg-warning/10'
  return 'text-text-tertiary bg-bg-hover/40'
}

export function BotDecisionsPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [records, setRecords] = useState<BotDecisionEntry[] | null>(null)
  // 在飞活动收摊（ended/silent 删键）时自动刷新 —— 一轮结束恰是记录长出来的时刻
  const activities = useChatStore((s) => s.sessionBotActivities[sessionId])

  const load = useCallback(() => {
    void window.api.bot.decisions({ sessionId }).then(setRecords)
  }, [sessionId])

  useEffect(() => {
    load()
  }, [load, activities])

  // 按消息分组（messageSeq 缺省的记录归入 seq -1 的「会话级」组），组间新在上
  const groups = useMemo(() => {
    const bySeq = new Map<number, BotDecisionEntry[]>()
    for (const r of records ?? []) {
      const seq = r.messageSeq ?? -1
      const list = bySeq.get(seq) ?? []
      list.push(r)
      bySeq.set(seq, list)
    }
    return [...bySeq.entries()].sort((a, b) => b[0] - a[0])
  }, [records])

  return (
    <div className="h-full overflow-y-auto" data-bot-decisions>
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <span className="text-[11px] uppercase tracking-wide text-text-tertiary">
          {t('panel.botDecisions')}
        </span>
        <button
          onClick={load}
          title={t('common.refresh')}
          className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/60 transition-colors"
        >
          <RefreshCw size={11} />
        </button>
      </div>
      {records !== null && groups.length === 0 && (
        <div className="px-3 py-6 text-center text-xs text-text-tertiary">—</div>
      )}
      {groups.map(([seq, list]) => (
        <div
          key={seq}
          className="mx-2 mb-2 rounded-lg border border-border-secondary/50 bg-bg-primary/60 px-2.5 py-1.5"
          data-bot-decision-group={seq}
        >
          <div className="text-[10px] text-text-tertiary mb-1 tabular-nums">
            {seq >= 0 ? `#${seq}` : '·'} ·{' '}
            {new Date(list[list.length - 1]!.ts).toLocaleTimeString()}
          </div>
          {list.map((r, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 py-0.5 min-w-0"
              title={r.detail ? JSON.stringify(r.detail) : undefined}
              data-bot-decision-kind={r.kind}
            >
              <BotAvatar name={r.botName} displayName={r.botName} size={13} />
              <span className="text-[11px] text-text-secondary truncate max-w-[72px]">
                {r.botName}
              </span>
              <span
                className={`ml-auto shrink-0 rounded px-1.5 py-px font-mono text-[9.5px] ${toneOf(r.kind)}`}
              >
                {r.kind}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
