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
  FolderTree,
  Search,
  FileSearch2,
  Container,
  Copy,
  Package,
  Clock,
  Database,
  Palette,
  Globe,
  Code,
  type LucideIcon
} from 'lucide-react'
import hljs from 'highlight.js/lib/core'
import hljsPython from 'highlight.js/lib/languages/python'
import hljsSql from 'highlight.js/lib/languages/sql'
import {
  useChatStore,
  type ToolResultDetails,
  type ToolPresentation,
  type FormItemRenderer
} from '../../stores/chatStore'
import { copyToClipboard } from '../../utils/clipboard'

/** lucide 图标名 → 组件映射（按需扩展） */
const ICON_MAP: Record<string, LucideIcon> = {
  Terminal,
  FileText,
  FilePen,
  FileOutput,
  Wrench,
  Check,
  X,
  MessageCircleQuestion,
  BookOpen,
  FolderTree,
  Search,
  FileSearch2,
  Container,
  Copy,
  Package,
  Clock,
  Database,
  Palette,
  Globe,
  Code
}

/** 根据图标名查找 lucide 组件，找不到时返回 Wrench */
function resolveLucideIcon(name?: string): LucideIcon {
  if (!name) return Wrench
  return ICON_MAP[name] ?? Wrench
}

// 静态注册已知语言，新语言在此添加
hljs.registerLanguage('python', hljsPython)
hljs.registerLanguage('sql', hljsSql)

/** 检查 hljs 是否支持指定语言 */
function isHljsLanguageRegistered(lang: string): boolean {
  return hljs.getLanguage(lang) != null
}

interface ToolCallBlockProps {
  toolName: string
  toolCallId?: string
  args?: Record<string, unknown>
  result?: string
  /** 工具特定的结构化详情（持久化消息传入） */
  details?: ToolResultDetails
  /** 流式生成中的原始参数文本（generating 状态下使用） */
  streamingArgsText?: string
  status:
    | 'generating'
    | 'pending'
    | 'running'
    | 'done'
    | 'error'
    | 'pending_approval'
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
  streamingArgsText,
  status: propStatus
}: ToolCallBlockProps): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const presentation = useChatStore((s) => s.toolPresentations[toolName])

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
      case 'read': {
        const readPath = str(args?.path)
        const isUrlPath = /^https?:\/\//i.test(readPath)
        return {
          icon: isUrlPath ? (
            <Globe size={12} className={ic} />
          ) : (
            <FileText size={12} className={ic} />
          ),
          detail: isUrlPath
            ? readPath.length > 60
              ? readPath.slice(0, 57) + '...'
              : readPath
            : truncatePath(readPath)
        }
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
          detail: str(args?.name)
        }
      default: {
        // 插件工具：使用 presentation 配置生成摘要
        if (presentation) {
          return buildPresentationSummary(presentation, args)
        }
        return { icon: <Wrench size={12} className={ic} />, detail: '' }
      }
    }
  })()

  const statusConfig: Record<
    string,
    { icon: React.ReactNode; label: string; borderColor: string }
  > = {
    generating: {
      icon: <Loader2 size={12} className="animate-spin text-text-tertiary" />,
      label: t('toolCall.generating'),
      borderColor: 'border-border-secondary/40'
    },
    pending: {
      icon: null,
      label: '',
      borderColor: ''
    },
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
        {(args || result || hasEditDiff || streamingArgsText) &&
          (expanded || streamingArgsText ? (
            <ChevronDown size={10} className="flex-shrink-0 opacity-50" />
          ) : (
            <ChevronRight size={10} className="flex-shrink-0 opacity-50" />
          ))}
        {icon}
        <span className="font-medium text-text-secondary flex-shrink-0">{toolName}</span>
        {detail && <span className="flex-1 truncate font-mono opacity-70">{detail}</span>}
        {!detail && <span className="flex-1" />}
        {(config.icon || config.label) && (
          <span className="flex items-center gap-1 flex-shrink-0 opacity-80">
            {config.icon}
            <span className="text-[10px]">{config.label}</span>
          </span>
        )}
      </button>

      {/* 编辑成功时展示 DiffViewer */}
      {expanded && hasEditDiff && details?.type === 'edit' && (
        <div className="mt-0.5 mb-1 ml-3 pl-2 border-l border-border-secondary/50">
          <DiffViewer diff={details.diff!} />
        </div>
      )}

      {/* 流式生成中的参数文本（自动展开） */}
      {streamingArgsText && (
        <div className="mt-0.5 mb-1 ml-3 pl-2 border-l border-border-secondary/50">
          <pre className="text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 overflow-auto max-h-40 whitespace-pre-wrap break-words">
            {streamingArgsText}
          </pre>
        </div>
      )}

      {/* 展开详情 */}
      {expanded && !streamingArgsText && !hasEditDiff && status !== 'pending_approval' && (
        <div className="mt-0.5 mb-1 ml-3 pl-2 border-l border-border-secondary/50 space-y-1.5">
          {presentation && args ? (
            <PluginToolDetail presentation={presentation} args={args} result={result} />
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

// ─── 插件工具摘要生成 ──────────────────────────────────

/** 根据 presentation 配置生成折叠态图标 + 摘要文本 */
function buildPresentationSummary(
  pres: ToolPresentation,
  args?: Record<string, unknown>
): { icon: React.ReactNode; detail: string } {
  const Icon = resolveLucideIcon(pres.icon)
  const iconColor = pres.iconColor

  // 摘要文本：取 summaryField 的首行
  let summary = ''
  if (pres.summaryField && args) {
    const raw = args[pres.summaryField]
    if (typeof raw === 'string') {
      const firstLine = raw.split('\n')[0]
      summary = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine
    }
  }

  return {
    icon: (
      <Icon
        size={12}
        className="flex-shrink-0"
        style={iconColor ? { color: iconColor } : undefined}
      />
    ),
    detail: summary
  }
}

// ─── 插件工具通用展开详情 ──────────────────────────────

/** 根据 formItems 配置渲染展开态表单详情 */
function PluginToolDetail({
  presentation: pres,
  args,
  result
}: {
  presentation: ToolPresentation
  args: Record<string, unknown>
  result?: string
}): React.JSX.Element {
  const { t } = useTranslation()

  const items = pres.formItems ?? []
  const declaredFields = new Set(items.map((fi) => fi.field))
  const undeclaredFields = Object.keys(args).filter((k) => !declaredFields.has(k))

  return (
    <>
      {/* 声明的表单项，按声明顺序 */}
      {items.map((fi) => {
        const val = args[fi.field]
        if (val == null) return null
        return (
          <FormItem
            key={fi.field}
            label={fi.label}
            renderer={fi.renderer ?? { type: 'text' }}
            value={val}
          />
        )
      })}

      {/* 未声明的 args 字段，以 text 形式追加 */}
      {undeclaredFields.map((field) => {
        const val = args[field]
        if (val == null) return null
        return <FormItem key={field} label={field} renderer={{ type: 'text' }} value={val} />
      })}

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

// ─── 表单项渲染器 ──────────────────────────────────────

/** 单个表单项 — 按 renderer.type 分发渲染 */
function FormItem({
  label,
  renderer,
  value
}: {
  label?: string
  renderer: NonNullable<FormItemRenderer>
  value: unknown
}): React.JSX.Element | null {
  switch (renderer.type) {
    case 'code':
      return <CodeFormItem label={label} code={String(value)} language={renderer.language} />
    case 'text':
    default:
      return <TextFormItem label={label} value={value} />
  }
}

/** code 渲染器 — 语法高亮代码块 + 复制按钮 */
function CodeFormItem({
  label,
  code,
  language
}: {
  label?: string
  code: string
  language?: string
}): React.JSX.Element | null {
  const [copied, setCopied] = useState(false)

  const highlighted = useMemo(() => {
    if (!code || !language || !isHljsLanguageRegistered(language)) return ''
    try {
      return hljs.highlight(code, { language }).value
    } catch {
      return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  }, [code, language])

  if (!code) return null

  const handleCopy = (): void => {
    copyToClipboard(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative group/code">
      <div
        className="flex items-center justify-between px-2 py-0.5 text-[10px] text-text-tertiary rounded-t"
        style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
      >
        <span className="font-medium uppercase tracking-wider">{language || label || 'code'}</span>
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
        {highlighted ? (
          <code
            className={`hljs language-${language}`}
            style={{ fontSize: 'inherit' }}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <code style={{ fontSize: 'inherit' }}>{code}</code>
        )}
      </pre>
    </div>
  )
}

/** text 渲染器 — 带标签的纯文本 */
function TextFormItem({ label, value }: { label?: string; value: unknown }): React.JSX.Element {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <div>
      {label && <div className="text-[10px] text-text-tertiary mb-0.5">{label}</div>}
      <pre className="text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 overflow-auto max-h-32 whitespace-pre-wrap break-words">
        {text}
      </pre>
    </div>
  )
}
