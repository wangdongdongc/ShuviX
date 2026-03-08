import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  Check,
  X,
  Loader2,
  ChevronDown,
  ChevronRight,
  Terminal,
  FileText,
  Search,
  FileSearch2,
  FolderTree,
  Wrench
} from 'lucide-react'
import {
  useChatStore,
  type SubAgentExecution,
  type SubAgentToolExecution,
  type SubAgentUsage
} from '../../stores/chatStore'

interface SubAgentBlockProps {
  toolCallId?: string
  args?: Record<string, unknown>
  result?: string
  status: 'running' | 'done' | 'error'
}

/** 内部工具图标 */
function innerToolIcon(name: string): React.ReactNode {
  const cls = 'text-text-tertiary flex-shrink-0'
  switch (name) {
    case 'read':
      return <FileText size={11} className={cls} />
    case 'ls':
      return <FolderTree size={11} className={cls} />
    case 'grep':
      return <Search size={11} className={cls} />
    case 'glob':
      return <FileSearch2 size={11} className={cls} />
    case 'bash':
      return <Terminal size={11} className={cls} />
    default:
      return <Wrench size={11} className={cls} />
  }
}

/** 工具参数摘要 */
function innerToolSummary(tool: SubAgentToolExecution): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (tool.toolName) {
    case 'read':
      return str(tool.args?.path)
    case 'ls':
      return str(tool.args?.path) || '.'
    case 'grep':
      return str(tool.args?.pattern)
    case 'glob':
      return str(tool.args?.pattern)
    case 'bash':
      return str(tool.args?.command).split('\n')[0].slice(0, 60)
    default:
      return ''
  }
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

/**
 * 子智能体块 — 与 ToolCallBlock 相同的单行展开/折叠样式
 * 内部工具开始执行时自动展开，完成后自动折叠
 */
export const SubAgentBlock = memo(function SubAgentBlock({
  toolCallId,
  args,
  result,
  status: propStatus
}: SubAgentBlockProps): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const toolsRef = useRef<HTMLDivElement>(null)

  // 从 store 中查找关联的子智能体
  const subAgent = useChatStore((s): SubAgentExecution | undefined => {
    if (!toolCallId || !s.activeSessionId) return undefined
    const execs = s.sessionSubAgentExecutions[s.activeSessionId]
    return execs?.find((sa) => sa.parentToolCallId === toolCallId)
  })

  const status =
    subAgent?.status === 'done' || subAgent?.status === 'error' ? subAgent.status : propStatus

  const description = (args?.description as string) || subAgent?.description || ''
  const tools = subAgent?.tools || []
  const finalResult = result || subAgent?.result
  const usage: SubAgentUsage | undefined = subAgent?.usage

  // 内部工具开始执行时自动展开
  useEffect(() => {
    if (tools.length > 0 && status === 'running') {
      setExpanded(true)
    }
  }, [tools.length, status])

  // 完成后自动折叠
  useEffect(() => {
    if (status === 'done' || status === 'error') {
      setExpanded(false)
    }
  }, [status])

  // 新工具出现时自动滚到底部
  useEffect(() => {
    if (toolsRef.current && expanded) {
      toolsRef.current.scrollTop = toolsRef.current.scrollHeight
    }
  }, [tools.length, expanded])

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
        <span className="font-medium text-text-secondary flex-shrink-0">explore</span>
        {description && <span className="flex-1 truncate font-mono opacity-70">{description}</span>}
        {!description && <span className="flex-1" />}
        <span className="flex items-center gap-1 flex-shrink-0 opacity-80">
          {statusIcon}
          <span className="text-[10px]">{statusLabel}</span>
        </span>
      </button>

      {/* 展开详情 — 参数 + 内部工具列表 + 结果 + 用量 */}
      {expanded && (
        <div className="mt-0.5 mb-1 ml-3 pl-2 border-l border-border-secondary/50 space-y-1.5">
          {/* 参数 */}
          {args && Object.keys(args).length > 0 && (
            <div>
              <div className="text-[10px] text-text-tertiary mb-0.5">{t('subAgent.params')}</div>
              <pre className="text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 overflow-auto max-h-32 whitespace-pre-wrap break-words">
                {typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}

          {/* 内部工具 */}
          {tools.length > 0 && (
            <div ref={toolsRef} className="max-h-[200px] overflow-y-auto">
              {tools.map((tool) => (
                <div
                  key={tool.toolCallId}
                  className="flex items-center gap-1.5 py-px text-[11px] text-text-tertiary"
                >
                  {innerToolIcon(tool.toolName)}
                  <span className="font-medium text-text-secondary flex-shrink-0">
                    {tool.toolName}
                  </span>
                  <span className="flex-1 truncate font-mono opacity-70">
                    {innerToolSummary(tool)}
                  </span>
                  <span className="flex-shrink-0">{innerToolStatusIcon(tool.status)}</span>
                </div>
              ))}
            </div>
          )}

          {/* 结果 */}
          {finalResult && (
            <div>
              <div className="text-[10px] text-text-tertiary mb-0.5">{t('subAgent.result')}</div>
              <pre className="text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 overflow-auto max-h-32 whitespace-pre-wrap break-words">
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
