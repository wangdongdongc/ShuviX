import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { DiffViewer } from './DiffViewer'
import {
  Terminal,
  FileText,
  FilePen,
  FileOutput,
  Wrench,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Loader2,
  ShieldAlert,
  MessageCircleQuestion,
  BookOpen,
  Bot,
  FolderTree,
  Search,
  FileSearch2,
  Container,
  Copy,
  Package,
  Clock,
  Database
} from 'lucide-react'
import hljs from 'highlight.js/lib/core'
import python from 'highlight.js/lib/languages/python'
import sqlLang from 'highlight.js/lib/languages/sql'
import { useChatStore, type ToolResultDetails } from '../../stores/chatStore'
import { copyToClipboard } from '../../utils/clipboard'

// 注册语言高亮
hljs.registerLanguage('python', python)
hljs.registerLanguage('sql', sqlLang)

interface ToolCallBlockProps {
  toolName: string
  toolCallId?: string
  args?: Record<string, unknown>
  result?: string
  /** 工具特定的结构化详情（持久化消息传入） */
  details?: ToolResultDetails
  status:
    | 'running'
    | 'done'
    | 'error'
    | 'pending_approval'
    | 'pending_user_input'
    | 'pending_ssh_credentials'
}

/**
 * 工具调用块 — 在对话流中内联展示工具调用过程
 * 折叠/展开显示参数和结果；沙箱模式下 bash 审批内联卡片
 */
export function ToolCallBlock({
  toolName,
  toolCallId,
  args,
  result,
  details: propDetails,
  status: propStatus
}: ToolCallBlockProps): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  // 从 store 读取实时工具执行状态，确保审批状态变更时组件能独立重渲染
  const liveExec = useChatStore((s) => {
    if (!toolCallId || !s.activeSessionId) return undefined
    const execs = s.sessionToolExecutions[s.activeSessionId]
    return execs?.find((te) => te.toolCallId === toolCallId)
  })
  const status = liveExec?.status || propStatus
  const details = liveExec?.details || propDetails

  // 编辑成功且有 diff
  const hasEditDiff = details?.type === 'edit' && !!details.diff && status === 'done'

  // 截断文件路径，优先展示末尾文件名
  const truncatePath = (p: string, max = 60): string => {
    if (p.length <= max) return p
    const sep = p.lastIndexOf('/')
    if (sep === -1) return p.slice(-max)
    const name = p.slice(sep) // /filename.ts
    if (name.length >= max) return '...' + name.slice(-(max - 3))
    const remaining = max - name.length - 3 // 3 for "..."
    return remaining > 0 ? '...' + p.slice(sep - remaining, sep) + name : '...' + name
  }

  // 根据工具类型生成摘要
  const { icon, detail } = (() => {
    const ic = 'text-text-tertiary flex-shrink-0'
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    switch (toolName) {
      case 'bash': {
        const line = str(args?.command).split('\n')[0]
        const isDocker = details?.type === 'bash' && details.docker
        return {
          icon: isDocker ? (
            <Container size={12} className="text-emerald-500 flex-shrink-0" />
          ) : (
            <Terminal size={12} className={ic} />
          ),
          detail: line.length > 80 ? line.slice(0, 77) + '...' : line
        }
      }
      case 'read':
        return {
          icon: <FileText size={12} className={ic} />,
          detail: truncatePath(str(args?.path))
        }
      case 'write':
        return {
          icon: <FileOutput size={12} className={ic} />,
          detail: truncatePath(str(args?.path))
        }
      case 'edit':
        return { icon: <FilePen size={12} className={ic} />, detail: truncatePath(str(args?.path)) }
      case 'ask': {
        const q = str(args?.question).slice(0, 60)
        return {
          icon: <MessageCircleQuestion size={12} className={ic} />,
          detail: q + (str(args?.question).length > 60 ? '...' : '')
        }
      }
      case 'ls':
        return { icon: <FolderTree size={12} className={ic} />, detail: str(args?.path) || '.' }
      case 'grep': {
        const pat = str(args?.pattern)
        const inc = args?.include ? ` (${args.include})` : ''
        return { icon: <Search size={12} className={ic} />, detail: pat + inc }
      }
      case 'glob':
        return { icon: <FileSearch2 size={12} className={ic} />, detail: str(args?.pattern) }
      case 'ssh': {
        const action = str(args?.action)
        const cmd = args?.command ? `: ${str(args.command).split('\n')[0].slice(0, 60)}` : ''
        return {
          icon: <Terminal size={12} className="text-sky-500 flex-shrink-0" />,
          detail: `${action}${cmd}`
        }
      }
      case 'skill':
        return {
          icon: <BookOpen size={12} className="text-emerald-400 flex-shrink-0" />,
          detail: str(args?.command)
        }
      case 'explore':
        return {
          icon: <Bot size={12} className="text-amber-500 flex-shrink-0" />,
          detail: str(args?.description)
        }
      case 'python': {
        const code = str(args?.code)
        const lineCount = code.split('\n').length
        const firstLine = code.split('\n')[0]
        const summary = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine
        const pyDetails = details?.type === 'python' ? details : null
        const meta: string[] = []
        if (lineCount > 1) meta.push(`${lineCount} lines`)
        if (pyDetails?.executionTime) meta.push(`${(pyDetails.executionTime / 1000).toFixed(1)}s`)
        if (pyDetails?.packages?.length) meta.push(pyDetails.packages.join(', '))
        const metaSuffix = meta.length > 0 ? ` (${meta.join(' · ')})` : ''
        return {
          icon: <Terminal size={12} className="text-yellow-500 flex-shrink-0" />,
          detail: summary + metaSuffix
        }
      }
      case 'sql': {
        const query = str(args?.sql)
        const firstLine = query.split('\n')[0]
        const sqlSummary = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine
        const sqlDetails = details?.type === 'sql' ? details : null
        const sqlMeta: string[] = []
        if (sqlDetails?.rowCount != null) sqlMeta.push(`${sqlDetails.rowCount} rows`)
        if (sqlDetails?.executionTime)
          sqlMeta.push(`${(sqlDetails.executionTime / 1000).toFixed(1)}s`)
        if (sqlDetails?.extensions?.length) sqlMeta.push(sqlDetails.extensions.join(', '))
        const sqlMetaSuffix = sqlMeta.length > 0 ? ` (${sqlMeta.join(' · ')})` : ''
        return {
          icon: <Database size={12} className="text-blue-400 flex-shrink-0" />,
          detail: sqlSummary + sqlMetaSuffix
        }
      }
      default:
        return { icon: <Wrench size={12} className={ic} />, detail: '' }
    }
  })()

  const statusConfig: Record<
    string,
    { icon: React.ReactNode; label: string; borderColor: string }
  > = {
    running: {
      icon: <Loader2 size={12} className="animate-spin text-accent" />,
      label: t('toolCall.running'),
      borderColor: 'border-accent/40'
    },
    done: {
      icon: <Check size={12} className="text-success" />,
      label: t('toolCall.done'),
      borderColor: 'border-success/40'
    },
    error: {
      icon: <X size={12} className="text-error" />,
      label: t('toolCall.error'),
      borderColor: 'border-error/40'
    },
    pending_approval: {
      icon: <ShieldAlert size={12} className="text-warning" />,
      label: t('toolCall.pendingApproval'),
      borderColor: 'border-warning/40'
    },
    pending_user_input: {
      icon: <MessageCircleQuestion size={12} className="text-accent" />,
      label: t('toolCall.pendingUserInput'),
      borderColor: 'border-accent/40'
    },
    pending_ssh_credentials: {
      icon: <Terminal size={12} className="text-accent" />,
      label: t('toolCall.pendingSshCredentials'),
      borderColor: 'border-accent/40'
    }
  }

  const config = statusConfig[status]

  return (
    <div className="my-0.5">
      {/* 单行摘要 — 可点击展开详情 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 py-0.5 text-left text-[11px] text-text-tertiary hover:text-text-secondary transition-colors group"
      >
        {(args || result || hasEditDiff) &&
          (expanded ? (
            <ChevronDown size={10} className="flex-shrink-0 opacity-50" />
          ) : (
            <ChevronRight size={10} className="flex-shrink-0 opacity-50" />
          ))}
        {icon}
        <span className="font-medium text-text-secondary flex-shrink-0">{toolName}</span>
        {detail && <span className="flex-1 truncate font-mono opacity-70">{detail}</span>}
        {!detail && <span className="flex-1" />}
        <span className="flex items-center gap-1 flex-shrink-0 opacity-80">
          {config.icon}
          <span className="text-[10px]">{config.label}</span>
        </span>
      </button>

      {/* 编辑成功时展示 DiffViewer */}
      {expanded && hasEditDiff && details?.type === 'edit' && (
        <div className="mt-0.5 mb-1 ml-3 pl-2 border-l border-border-secondary/50">
          <DiffViewer diff={details.diff!} />
        </div>
      )}

      {/* 展开详情 */}
      {expanded &&
        !hasEditDiff &&
        status !== 'pending_approval' &&
        status !== 'pending_user_input' && (
          <div className="mt-0.5 mb-1 ml-3 pl-2 border-l border-border-secondary/50 space-y-1.5">
            {toolName === 'python' && args ? (
              <PythonToolDetail args={args} result={result} />
            ) : toolName === 'sql' && args ? (
              <SqlToolDetail args={args} result={result} />
            ) : (
              <>
                {args && Object.keys(args).length > 0 && (
                  <div>
                    <div className="text-[10px] text-text-tertiary mb-0.5">
                      {t('toolCall.params')}
                    </div>
                    <pre className="text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 overflow-auto max-h-32 whitespace-pre-wrap break-words">
                      {typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
                    </pre>
                  </div>
                )}
                {result && (
                  <div>
                    <div className="text-[10px] text-text-tertiary mb-0.5">
                      {t('toolCall.result')}
                    </div>
                    <pre className="text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 overflow-auto max-h-32 whitespace-pre-wrap break-words">
                      {result}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        )}
    </div>
  )
}

/** Python 工具展开详情 — 结构化参数展示 + 语法高亮代码块 */
function PythonToolDetail({
  args,
  result
}: {
  args: Record<string, unknown>
  result?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const code = typeof args.code === 'string' ? args.code : ''
  const packages = Array.isArray(args.packages) ? (args.packages as string[]) : undefined
  const timeout = typeof args.timeout === 'number' ? args.timeout : undefined

  const highlighted = useMemo(() => {
    if (!code) return ''
    try {
      return hljs.highlight(code, { language: 'python' }).value
    } catch {
      return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  }, [code])

  const handleCopy = (): void => {
    copyToClipboard(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      {/* 元信息标签（packages / timeout） */}
      {(packages || timeout) && (
        <div className="flex items-center gap-2 flex-wrap">
          {packages && packages.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] text-text-tertiary bg-bg-tertiary/50 rounded px-1.5 py-0.5">
              <Package size={10} />
              {packages.join(', ')}
            </span>
          )}
          {timeout && (
            <span className="inline-flex items-center gap-1 text-[10px] text-text-tertiary bg-bg-tertiary/50 rounded px-1.5 py-0.5">
              <Clock size={10} />
              {timeout}s
            </span>
          )}
        </div>
      )}

      {/* 代码块 — 语法高亮，字体与工具 step 一致 */}
      {code && (
        <div className="relative group/code">
          <div
            className="flex items-center justify-between px-2 py-0.5 text-[10px] text-text-tertiary rounded-t"
            style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
          >
            <span className="font-medium uppercase tracking-wider">python</span>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 hover:text-text-secondary transition-colors"
            >
              {copied ? <Check size={9} className="text-success" /> : <Copy size={9} />}
            </button>
          </div>
          <pre
            className="text-[11px] leading-relaxed rounded-b px-2 py-1.5 overflow-auto max-h-48 !m-0"
            style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
          >
            <code
              className="hljs language-python"
              style={{ fontSize: 'inherit' }}
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          </pre>
        </div>
      )}

      {/* 执行结果 */}
      {result && (
        <div>
          <div className="text-[10px] text-text-tertiary mb-0.5">{t('toolCall.result')}</div>
          <pre className="text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 overflow-auto max-h-48 whitespace-pre-wrap break-words">
            {result}
          </pre>
        </div>
      )}
    </>
  )
}

/** SQL 工具展开详情 — 语法高亮 SQL + 执行结果 */
function SqlToolDetail({
  args,
  result
}: {
  args: Record<string, unknown>
  result?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const sql = typeof args.sql === 'string' ? args.sql : ''
  const extensions = Array.isArray(args.extensions) ? (args.extensions as string[]) : undefined
  const timeout = typeof args.timeout === 'number' ? args.timeout : undefined

  const highlighted = useMemo(() => {
    if (!sql) return ''
    try {
      return hljs.highlight(sql, { language: 'sql' }).value
    } catch {
      return sql.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  }, [sql])

  const handleCopy = (): void => {
    copyToClipboard(sql)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      {(extensions || timeout) && (
        <div className="flex items-center gap-2 flex-wrap">
          {extensions && extensions.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] text-text-tertiary bg-bg-tertiary/50 rounded px-1.5 py-0.5">
              <Package size={10} />
              {extensions.join(', ')}
            </span>
          )}
          {timeout && (
            <span className="inline-flex items-center gap-1 text-[10px] text-text-tertiary bg-bg-tertiary/50 rounded px-1.5 py-0.5">
              <Clock size={10} />
              {timeout}s
            </span>
          )}
        </div>
      )}

      {sql && (
        <div className="relative group/code">
          <div
            className="flex items-center justify-between px-2 py-0.5 text-[10px] text-text-tertiary rounded-t"
            style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
          >
            <span className="font-medium uppercase tracking-wider">sql</span>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 hover:text-text-secondary transition-colors"
            >
              {copied ? <Check size={9} className="text-success" /> : <Copy size={9} />}
            </button>
          </div>
          <pre
            className="text-[11px] leading-relaxed rounded-b px-2 py-1.5 overflow-auto max-h-48 !m-0"
            style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
          >
            <code
              className="hljs language-sql"
              style={{ fontSize: 'inherit' }}
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          </pre>
        </div>
      )}

      {result && (
        <div>
          <div className="text-[10px] text-text-tertiary mb-0.5">{t('toolCall.result')}</div>
          <pre className="text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 overflow-auto max-h-48 whitespace-pre-wrap break-words">
            {result}
          </pre>
        </div>
      )}
    </>
  )
}
