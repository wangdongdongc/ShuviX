/**
 * TaskListPanel — 输入框卡片里的任务列表（内置能力服务器 `plan`，docs/task-list-design.md §3.4，实验）
 *
 * 读的是投影出来的消息（`taskListOfMessages`）：当前请求里成功的 `mcp__plan__update` 调用按顺序折叠出来的
 * 列表，不存任何状态。三种样子：
 *  - **进行中**（会话在跑）：默认展开，逐行列出步骤；
 *  - **已完成**（会话空闲，请求以一条最终回复收尾）：剩下的步骤一律算完成 —— 收尾归宿主，模型不用发收尾调用；
 *  - **已停止**（会话空闲，但请求没有最终回复：中止、出错、中途退出）：未完成的步骤保持原样。
 * 后两种默认折叠成一行。下一条「用户发起一轮」的消息出现（含乐观占位）时整块消失；插话不算新请求。
 *
 * 形态与 QueuePanel 同源：渲染进输入框卡片内部，自身无边框 / 圆角 / 阴影，只用一条 border-b 与下方分隔。
 * 排在待处理输入（审批 / 提问）之上 —— 那些更急，要紧挨着输入框。
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronUp,
  Circle,
  CircleCheck,
  CirclePause,
  ListChecks,
  Loader2
} from 'lucide-react'
import { taskListOfMessages, type TaskListItem } from '@shuvix/chat-protocol/taskList'
import { useChatStore, selectPendingPrompt, selectSessionRun } from '../../stores/chatStore'
import { useChatDensity } from '../../host/chatHostContext'

type Phase = 'running' | 'done' | 'stopped'

/** 一行步骤的图标：进行中转圈；已停止时进行中那一步换成暂停 */
function StepIcon({ item, phase }: { item: TaskListItem; phase: Phase }): React.JSX.Element {
  if (item.status === 'completed') {
    return <CircleCheck size={13} className="flex-shrink-0 text-success" />
  }
  if (item.status === 'in_progress') {
    return phase === 'running' ? (
      <Loader2 size={13} className="flex-shrink-0 text-accent animate-spin" />
    ) : (
      <CirclePause size={13} className="flex-shrink-0 text-warning" />
    )
  }
  return <Circle size={13} className="flex-shrink-0 text-text-tertiary" />
}

export function TaskListPanel(): React.JSX.Element | null {
  const { t } = useTranslation()
  const messages = useChatStore((s) => s.messages)
  const sessionId = useChatStore((s) => s.activeSessionId)
  const run = useChatStore(selectSessionRun)
  const pendingPrompt = useChatStore(selectPendingPrompt)
  const touch = useChatDensity() === 'touch'
  const snapshot = useMemo(() => taskListOfMessages(messages), [messages])
  // 用户点过的展开 / 折叠，按「会话 + 请求 + 样子」记（进行中展开、收尾后自动折叠；点过的按用户的来，
  // 下一个请求重新按缺省）
  const [toggled, setToggled] = useState<Record<string, boolean>>({})

  // 一条新的请求正在发出：旧请求的列表让位
  if (!snapshot || pendingPrompt) return null

  const phase: Phase =
    run.state === 'busy' ? 'running' : snapshot.endedWithAnswer ? 'done' : 'stopped'
  const items =
    phase === 'done'
      ? snapshot.items.map((item) => ({ ...item, status: 'completed' as const }))
      : snapshot.items
  const total = items.length
  const done = items.filter((item) => item.status === 'completed').length
  const current = items.find((item) => item.status === 'in_progress')

  const key = `${sessionId ?? ''}:${snapshot.requestId}:${phase}`
  const expanded = toggled[key] ?? (phase === 'running' && !touch)
  const summary =
    phase === 'done'
      ? t('taskList.done')
      : phase === 'stopped'
        ? t('taskList.stopped')
        : (current?.content ?? '')

  return (
    <div
      className="border-b border-border-secondary/40 px-3.5 py-1.5"
      data-task-list=""
      data-task-list-phase={phase}
    >
      <button
        type="button"
        data-task-list-toggle=""
        aria-expanded={expanded}
        onClick={() => setToggled((prev) => ({ ...prev, [key]: !expanded }))}
        className={`w-full flex items-center gap-2 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors ${
          touch ? 'min-h-[36px]' : ''
        }`}
        title={expanded ? t('taskList.collapse') : t('taskList.expand')}
      >
        <ListChecks size={12} className="flex-shrink-0" />
        <span className="flex-shrink-0">{t('taskList.title')}</span>
        <span className="flex-shrink-0 tabular-nums" data-task-list-count="">
          {done}/{total}
        </span>
        {summary && (
          <span className="flex-1 min-w-0 truncate text-left text-text-secondary">{summary}</span>
        )}
        {!summary && <span className="flex-1" />}
        {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
      </button>

      {/* 展开：逐行铺开（自身封顶滚动，不把输入区顶出屏幕） */}
      {expanded && (
        <ol className="mt-1 space-y-0.5 max-h-[30vh] overflow-y-auto thin-scrollbar">
          {items.map((item, i) => (
            <li
              key={i}
              className={`flex items-center gap-2 ${touch ? 'py-1.5' : 'py-0.5'}`}
              data-task-step={i + 1}
              data-status={item.status}
            >
              <StepIcon item={item} phase={phase} />
              <span
                className={`flex-1 min-w-0 truncate ${touch ? 'text-[14px]' : 'text-[12px]'} ${
                  item.status === 'completed'
                    ? 'text-text-tertiary line-through'
                    : item.status === 'in_progress'
                      ? 'text-text-primary'
                      : 'text-text-secondary'
                }`}
              >
                {item.content}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
