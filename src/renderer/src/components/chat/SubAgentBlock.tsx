import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Bot, Check, X, Loader2, ChevronDown, ChevronRight, Wrench } from 'lucide-react'
import {
  useChatStore,
  type SubAgentExecution,
  type SubAgentToolExecution,
  type SubAgentUsage,
  type SubAgentTimelineEntry
} from '../../stores/chatStore'
import type { ToolResultDetails, SubAgentToolDetails } from '../../../../shared/types/chatMessage'

interface SubAgentBlockProps {
  toolCallId?: string
  toolName?: string
  args?: Record<string, unknown>
  result?: string
  status: 'running' | 'done' | 'error'
  details?: ToolResultDetails
}

/** 子智能体内部工具统一图标 */
function innerToolIcon(): React.ReactNode {
  return <Wrench size={11} className="text-text-tertiary flex-shrink-0" />
}

/** 内部工具状态图标 */
function innerToolStatusIcon(status: SubAgentToolExecution['status']): React.ReactNode {
  switch (status) {
    case 'running':
      return <Loader2 size={10} className="animate-spin text-accent" />
    case 'done':
      return <Check size={10} className="text-success" />
    case 'error':
      return <X size={10} className="text-error" />
  }
}

/** 渲染单条时间线条目 */
function TimelineEntry({
  entry,
  index
}: {
  entry: SubAgentTimelineEntry
  index: number
}): React.JSX.Element {
  switch (entry.type) {
    case 'tool':
      return (
        <div
          key={entry.tool.toolCallId}
          className="flex items-center gap-1.5 py-px text-[11px] text-text-tertiary"
        >
          {innerToolIcon()}
          <span className="font-medium text-text-secondary flex-shrink-0">
            {entry.tool.toolName}
          </span>
          <span className="flex-1 truncate font-mono opacity-70">{entry.tool.summary || ''}</span>
          <span className="flex-shrink-0">{innerToolStatusIcon(entry.tool.status)}</span>
        </div>
      )
    case 'thinking':
      return (
        <div key={`thinking-${index}`}>
          <pre className="text-[11px] text-text-tertiary italic whitespace-pre-wrap break-words overflow-hidden leading-relaxed">
            {entry.content.slice(-500)}
          </pre>
        </div>
      )
    case 'text':
      return (
        <div key={`text-${index}`} className="markdown-body text-[12px]">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {entry.content}
          </ReactMarkdown>
        </div>
      )
  }
}

/**
 * 子智能体块 — 与 ToolCallBlock 相同的单行展开/折叠样式
 * 内部 tool / text / thinking 按时间顺序混排显示，文本使用 Markdown 渲染
 */
/** 判断 details 是否为子智能体详情类型 */
function isSubAgentDetails(d?: ToolResultDetails): d is SubAgentToolDetails {
  return d?.type === 'sub-agent'
}

/** 将持久化时间线转换为 store 中的 SubAgentTimelineEntry 格式 */
function toStoreTimeline(details: SubAgentToolDetails): SubAgentTimelineEntry[] {
  if (!details.timeline) return []
  return details.timeline.map((entry) => {
    if (entry.type === 'tool') {
      return {
        type: 'tool' as const,
        tool: {
          toolCallId: '',
          toolName: entry.tool.toolName,
          status: entry.tool.status,
          summary: entry.tool.summary
        }
      }
    }
    return entry
  })
}

export const SubAgentBlock = memo(function SubAgentBlock({
  toolCallId,
  toolName,
  args,
  result,
  status: propStatus,
  details
}: SubAgentBlockProps): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const timelineRef = useRef<HTMLDivElement>(null)

  // 从 store 中查找关联的子智能体（实时流式数据）
  const subAgent = useChatStore((s): SubAgentExecution | undefined => {
    if (!toolCallId || !s.activeSessionId) return undefined
    const execs = s.sessionSubAgentExecutions[s.activeSessionId]
    return execs?.find((sa) => sa.parentToolCallId === toolCallId)
  })
  const isStreaming = useChatStore((s) =>
    s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.isStreaming || false : false
  )

  // 持久化详情（从 DB 恢复时使用）
  const persistedDetails = isSubAgentDetails(details) ? details : undefined

  // 状态优先级：subAgent 终态 > propStatus > 流式结束但无终态（中断）视为 error
  const status =
    subAgent?.status === 'done' || subAgent?.status === 'error'
      ? subAgent.status
      : propStatus === 'running' && !isStreaming
        ? 'error'
        : propStatus

  const description =
    (args?.description as string) || subAgent?.description || persistedDetails?.description || ''

  // 实时时间线优先；无实时数据时使用持久化时间线
  const timeline: SubAgentTimelineEntry[] =
    subAgent && subAgent.timeline.length > 0
      ? subAgent.timeline
      : persistedDetails
        ? toStoreTimeline(persistedDetails)
        : []

  const prompt = (args?.prompt as string) || persistedDetails?.prompt || ''
  const finalResult = result || subAgent?.result
  const usage: SubAgentUsage | undefined =
    subAgent?.usage || (persistedDetails?.usage as SubAgentUsage | undefined)

  // 时间线有内容时自动展开
  useEffect(() => {
    if (timeline.length > 0 && status === 'running') {
      setExpanded(true) // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [timeline.length, status])

  // 完成后自动折叠
  useEffect(() => {
    if (status === 'done' || status === 'error') {
      setExpanded(false) // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [status])

  // 新条目出现时自动滚到底部
  useEffect(() => {
    if (timelineRef.current && expanded) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight
    }
  }, [timeline.length, timeline[timeline.length - 1], expanded]) // eslint-disable-line react-hooks/exhaustive-deps

  const statusIcon =
    status === 'running' ? (
      <Loader2 size={12} className="animate-spin text-accent" />
    ) : status === 'done' ? (
      <Check size={12} className="text-success" />
    ) : (
      <X size={12} className="text-error" />
    )

  const statusLabel =
    status === 'running'
      ? t('subAgent.running')
      : status === 'done'
        ? t('subAgent.done')
        : t('subAgent.error')

  return (
    <div className="my-0.5">
      {/* 单行摘要 — 与 ToolCallBlock 相同结构 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 py-0.5 text-left text-[11px] text-text-tertiary hover:text-text-secondary transition-colors group"
      >
        {expanded ? (
          <ChevronDown size={10} className="flex-shrink-0 opacity-50" />
        ) : (
          <ChevronRight size={10} className="flex-shrink-0 opacity-50" />
        )}
        <Bot size={12} className="text-text-tertiary flex-shrink-0" />
        <span className="font-medium text-text-secondary flex-shrink-0">
          {subAgent?.subAgentType || persistedDetails?.subAgentType || toolName || 'explore'}
        </span>
        {description && <span className="flex-1 truncate font-mono opacity-70">{description}</span>}
        {!description && <span className="flex-1" />}
        <span className="flex items-center gap-1 flex-shrink-0 opacity-80">
          {statusIcon}
          <span className="text-[10px]">{statusLabel}</span>
        </span>
      </button>

      {/* 展开详情 — prompt + 时间线 + 结果 + 用量 */}
      {expanded && (
        <div className="mt-0.5 mb-1 ml-3 pl-2 border-l border-border-secondary/50 space-y-1">
          {/* prompt */}
          {prompt && (
            <pre className="text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 overflow-y-auto overflow-x-hidden max-h-32 whitespace-pre-wrap break-words">
              {prompt}
            </pre>
          )}

          {/* 时间线 — tool / text / thinking 按时间顺序 */}
          {timeline.length > 0 && (
            <div
              ref={timelineRef}
              className="max-h-[300px] overflow-y-auto overflow-x-hidden space-y-1"
            >
              {timeline.map((entry, i) => (
                <TimelineEntry key={i} entry={entry} index={i} />
              ))}
            </div>
          )}

          {/* 结果 */}
          {finalResult && (
            <div>
              <div className="text-[10px] text-text-tertiary mb-0.5">{t('subAgent.result')}</div>
              <pre className="text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 overflow-y-auto overflow-x-hidden max-h-32 whitespace-pre-wrap break-words">
                {finalResult}
              </pre>
            </div>
          )}

          {/* token 用量 */}
          {usage && usage.total > 0 && (
            <div className="text-[10px] text-text-tertiary">
              {usage.details && usage.details.length > 1 ? (
                <details>
                  <summary className="cursor-pointer select-none hover:text-text-secondary">
                    tokens: {usage.input} in / {usage.output} out
                    {usage.total ? ` · ${usage.total} total` : ''}
                    {usage.cacheRead ? ` · ${usage.cacheRead} ${t('message.cacheRead')}` : ''}
                    {usage.cacheWrite ? ` · ${usage.cacheWrite} ${t('message.cacheWrite')}` : ''}
                    {` · ${usage.details.length} ${t('message.nCalls')}`}
                  </summary>
                  <div className="mt-1 ml-2 space-y-0.5">
                    {usage.details.map((d, i) => (
                      <div key={i}>
                        #{i + 1} {d.input} in / {d.output} out
                        {d.total ? ` · ${d.total}` : ''}
                        {d.cacheRead ? ` · ${d.cacheRead} ${t('message.cacheRead')}` : ''}
                        {d.cacheWrite ? ` · ${d.cacheWrite} ${t('message.cacheWrite')}` : ''}
                        {d.stopReason ? ` (${d.stopReason})` : ''}
                      </div>
                    ))}
                  </div>
                </details>
              ) : (
                <span>
                  tokens: {usage.input} in / {usage.output} out
                  {usage.total ? ` · ${usage.total} total` : ''}
                  {usage.cacheRead ? ` · ${usage.cacheRead} ${t('message.cacheRead')}` : ''}
                  {usage.cacheWrite ? ` · ${usage.cacheWrite} ${t('message.cacheWrite')}` : ''}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
