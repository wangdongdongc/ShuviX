import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DiffViewer } from './DiffViewer'
import { StepRow } from './StepRow'
import { TerminalView } from './TerminalView'
import {
  Terminal,
  FileText,
  FilePen,
  FileOutput,
  Wrench,
  Check,
  X,
  Loader2,
  ShieldAlert,
  MessageCircleQuestion,
  BookOpen,
  FolderTree,
  Search,
  FileSearch2,
  Monitor,
  Container,
  Copy,
  Package,
  Clock,
  Database,
  Palette,
  GitBranch,
  Globe,
  Code,
  SquareTerminal,
  Eye,
  Archive,
  type LucideIcon
} from 'lucide-react'
import {
  useChatStore,
  type ToolResultDetails,
  type ToolPresentation,
  type ToolUseMessage,
  type FormItemRenderer
} from '../../stores/chatStore'
import { buildToolSummary } from '@shuvix/chat-protocol/toolSummaries'
import { CodeView } from '../code/CodeView'
import { useSubSessionStore } from '../../stores/subSessionStore'
import { SubAgentInlineView } from './SubAgentInlineView'
import { copyToClipboard } from '../../utils/clipboard'
import { CODE_MAX_H, DETAIL_PRE_CLASS, STREAM_PRE_CLASS } from './detailViewport'

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
  Monitor,
  Container,
  Copy,
  Package,
  Clock,
  Database,
  Palette,
  GitBranch,
  Globe,
  Code,
  SquareTerminal,
  Eye,
  Archive
}

/** 根据图标名查找 lucide 组件，找不到时返回 Wrench */
function resolveLucideIcon(name?: string): LucideIcon {
  if (!name) return Wrench
  return ICON_MAP[name] ?? Wrench
}

/** 按 presentation 配置渲染工具图标（模块级普通函数：图标组件不在 render 内构造） */
function renderToolIcon(pres?: ToolPresentation): React.ReactNode {
  const Icon = resolveLucideIcon(pres?.icon)
  return (
    <Icon
      size={12}
      className="flex-shrink-0"
      style={pres?.iconColor ? { color: pres.iconColor } : undefined}
    />
  )
}

/** renderer.language → 文件扩展名（CodeView 的语言懒加载注册表以 ext 为键） */
const LANG_TO_EXT: Record<string, string> = {
  bash: '.sh',
  shell: '.sh',
  sh: '.sh',
  zsh: '.sh',
  python: '.py',
  sql: '.sql',
  typescript: '.ts',
  tsx: '.tsx',
  javascript: '.js',
  jsx: '.jsx',
  json: '.json',
  yaml: '.yaml',
  html: '.html',
  css: '.css',
  xml: '.xml',
  go: '.go',
  rust: '.rs',
  java: '.java',
  c: '.c',
  cpp: '.cpp',
  php: '.php',
  ruby: '.rb'
}

/** 从文件路径取扩展名（含点，小写）；非字符串或无扩展名返回 '' */
function extOfPath(p: unknown): string {
  if (typeof p !== 'string') return ''
  const base = p.split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i).toLowerCase() : ''
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
  status: 'generating' | 'pending' | 'running' | 'done' | 'error'
}

/**
 * 工具调用块 — 在对话流中内联展示工具调用过程
 * 折叠/展开显示参数和结果；需审批模式下 bash 审批内联卡片
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

  // 从 store 读取实时工具执行状态，确保状态变更时组件能独立重渲染
  const liveExec = useChatStore((s) => {
    if (!toolCallId || !s.activeSessionId) return undefined
    const execs = s.sessionToolExecutions[s.activeSessionId]
    return execs?.find((te) => te.toolCallId === toolCallId)
  })
  // 该工具是否有挂起的用户输入请求(命令审批 / SSH 凭证 / ...)
  const hasPendingInput = useChatStore((s) => {
    if (!toolCallId || !s.activeSessionId) return false
    return (s.sessionPendingInputs[s.activeSessionId] || []).some((r) => r.id === toolCallId)
  })
  const status = liveExec?.status || propStatus
  const details = liveExec?.details || propDetails

  // Agent 派发工具触发的子会话（按父 tool_call id 匹配）：展开卡片内联其转写。
  // 仅本次运行的内存态；刷新后子会话消失，回退为普通 result 文本展示。
  const subSession = useSubSessionStore((s) => {
    if (!toolCallId) return null
    return Object.values(s.subSessions).find((ss) => ss.parentToolCallId === toolCallId) ?? null
  })

  // 写入/编辑成功且有 diff（write 的 diff 与 edit 同款，新建文件即全增行）
  const editDiff =
    status === 'done' && (details?.type === 'edit' || details?.type === 'write')
      ? details.diff
      : undefined
  const hasEditDiff = !!editDiff

  // 根据工具 presentation 配置生成摘要（内置工具和插件工具统一走此路径）
  const { icon, detail } = (() => {
    const ic = 'text-text-tertiary flex-shrink-0'

    // 通用路径：使用 presentation 配置（内置 + 插件工具均一走此路径）
    if (presentation) {
      return buildPresentationSummary(toolName, presentation, args)
    }
    return { icon: <Wrench size={12} className={ic} />, detail: '' }
  })()

  // done 不出图标：成功是常态，一列绿勾只会盖过真正需要注意的行（运行中 / 出错 / 待审批）
  const statusConfig: Record<string, React.ReactNode> = {
    generating: <Loader2 size={10} className="animate-spin text-text-tertiary" />,
    pending: null,
    running: <Loader2 size={10} className="animate-spin text-accent" />,
    done: null,
    error: <X size={11} className="text-error" />
  }

  // 当存在挂起的用户输入时,覆盖状态展示为"等待用户响应"(优先级高于 running)
  const statusIcon = hasPendingInput ? (
    <ShieldAlert size={11} className="text-warning" />
  ) : (
    statusConfig[status]
  )

  const canExpand = !!(args || result || hasEditDiff || streamingArgsText || subSession)
  // 终端形态：presentation 声明 + 确有命令可渲染，否则降级回通用表单形态
  const isTerminalView =
    presentation?.detailView === 'terminal' && typeof args?.command === 'string'

  // 摘要行内容：图标槽为状态（无状态时落回工具图标），其后名称 + 摘要
  const rowProps = {
    lead: statusIcon ?? undefined,
    icon,
    label: presentation?.label || toolName,
    detail: detail ? <span className="font-mono">{detail}</span> : undefined
  }

  if (!expanded) {
    // 单行摘要 — hover 高亮，点击展开；不带外边距，块间距由消息流统一控制
    return (
      <StepRow
        {...rowProps}
        expandable={canExpand}
        onClick={() => canExpand && setExpanded(true)}
      />
    )
  }

  return (
    <div>
      {/* 展开态 — 摘要行原位不动，详情从下方长出（与思考 / 分组同一形态，避免展开时跳版） */}
      <StepRow {...rowProps} expandable onClick={() => setExpanded(false)} />
      <div className="mt-0.5 mb-1 ml-3 pl-2 border-l border-border-secondary/50">
        {subSession ? (
          /* Agent 派发的子会话：内联其转写（自带限高滚动容器） */
          <SubAgentInlineView sub={subSession} />
        ) : (
          /* 外层不限高：diff / 代码 / 裸文本各自是自己那块的唯一滚动主（见 detailViewport.ts） */
          <div className="py-1 space-y-1.5">
            {/* 流式生成中的参数文本 */}
            {streamingArgsText && <pre className={STREAM_PRE_CLASS}>{streamingArgsText}</pre>}

            {/* 写入/编辑成功时展示 DiffViewer */}
            {editDiff && <DiffViewer diff={editDiff} />}

            {/* 展开详情 */}
            {!hasEditDiff &&
              !hasPendingInput &&
              (isTerminalView ? (
                /* shell 类工具：命令 + 输出融成一段终端会话，不拆「参数 / 结果」两块 */
                <TerminalView
                  command={String(args?.command ?? '')}
                  output={result}
                  cwd={details?.type === 'bash' ? details.cwd : undefined}
                  host={details?.type === 'ssh' ? details.host : undefined}
                  exitCode={
                    details?.type === 'bash' || details?.type === 'ssh'
                      ? details.exitCode
                      : undefined
                  }
                  running={status === 'running'}
                />
              ) : presentation && args ? (
                <ToolFormDetail presentation={presentation} args={args} result={result} />
              ) : (
                <>
                  {args && Object.keys(args).length > 0 && (
                    <div>
                      <div className="text-[10px] text-text-tertiary mb-0.5">
                        {t('toolCall.params')}
                      </div>
                      <pre className={DETAIL_PRE_CLASS}>
                        {typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
                      </pre>
                    </div>
                  )}
                  {result && (
                    <div>
                      <div className="text-[10px] text-text-tertiary mb-0.5">
                        {t('toolCall.result')}
                      </div>
                      <pre className={DETAIL_PRE_CLASS}>{result}</pre>
                    </div>
                  )}
                </>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── 相邻同名工具调用的合并行 ──────────────────────────

/**
 * 工具调用分组块 — 一段相邻的同名成功调用折叠成单行（图标 + 名称 + 去重摘要 + 次数），
 * 展开后逐条列出原始 ToolCallBlock。避免「浏览器 evaluate」连刷五行的重复噪音。
 */
export function ToolCallGroup({
  toolName,
  msgs
}: {
  toolName: string
  msgs: ToolUseMessage[]
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const presentation = useChatStore((s) => s.toolPresentations[toolName])
  const icon = renderToolIcon(presentation)

  // 各次调用的摘要去重后拼接：同工具不同动作（evaluate / screenshot）仍能一眼看出
  const detail = useMemo(() => {
    const seen = new Set<string>()
    for (const m of msgs) {
      const first = buildToolSummary(toolName, m.metadata?.args)?.split('\n')[0]?.trim()
      if (first) seen.add(first)
    }
    const joined = [...seen].join(' · ')
    return joined.length > 60 ? joined.slice(0, 57) + '...' : joined
  }, [msgs, toolName])

  const rowProps = {
    icon,
    label: presentation?.label || toolName,
    detail: detail ? <span className="font-mono">{detail}</span> : undefined,
    trailing: (
      <span className="flex-shrink-0 rounded-full bg-bg-tertiary/70 px-1.5 text-[10px] leading-4 tabular-nums">
        {msgs.length}
      </span>
    )
  }

  if (!expanded) {
    return <StepRow {...rowProps} expandable onClick={() => setExpanded(true)} />
  }

  return (
    <div>
      <StepRow {...rowProps} expandable onClick={() => setExpanded(false)} />
      <div className="ml-3 pl-2 border-l border-border-secondary/50 space-y-0.5">
        {msgs.map((m) => (
          <ToolCallBlock
            key={m.id}
            toolName={m.metadata?.toolName || toolName}
            toolCallId={m.metadata?.toolCallId}
            args={m.metadata?.args}
            result={m.content || undefined}
            details={m.metadata?.details}
            status="done"
          />
        ))}
      </div>
    </div>
  )
}

// ─── 折叠态摘要生成（基于 presentation 配置） ─────────

/** 根据 presentation 配置生成折叠态图标 + 摘要文本 */
function buildPresentationSummary(
  toolName: string,
  pres: ToolPresentation,
  args?: Record<string, unknown>
): { icon: React.ReactNode; detail: string } {
  const Icon = resolveLucideIcon(pres.icon)
  const iconColor = pres.iconColor

  // 摘要文本：toolSummaries 注册的摘要函数生成，取首行并限长
  const raw = buildToolSummary(toolName, args)
  let summary = ''
  if (raw) {
    const firstLine = raw.split('\n')[0]
    summary = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine
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

// ─── 展开态详情渲染（基于 presentation.formItems） ────

/** 根据 formItems 配置渲染展开态表单详情 */
function ToolFormDetail({
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
  const undeclaredFields =
    pres.showUndeclaredFields === false
      ? []
      : Object.keys(args).filter((k) => !declaredFields.has(k))
  // code renderer 未指定 language 时，按 args.path 的扩展名推导语言（write/edit 等文件工具）
  const fallbackExt = extOfPath(args.path)

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
            fallbackExt={fallbackExt}
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
          <pre className={DETAIL_PRE_CLASS}>{result}</pre>
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
  value,
  fallbackExt
}: {
  label?: string
  renderer: NonNullable<FormItemRenderer>
  value: unknown
  /** code renderer 未指定 language 时的扩展名兜底（从 args.path 推导） */
  fallbackExt?: string
}): React.JSX.Element | null {
  switch (renderer.type) {
    case 'code': {
      const ext = renderer.language
        ? (LANG_TO_EXT[renderer.language.toLowerCase()] ?? '')
        : (fallbackExt ?? '')
      return (
        <CodeFormItem
          label={label}
          code={String(value)}
          language={renderer.language}
          ext={ext}
          // 对话流里的代码预览是「扫一眼」而非编辑：默认软换行，省掉一条横向滚动条
          wrap={renderer.wrap ?? true}
          lineNumbers={renderer.lineNumbers ?? String(value).includes('\n')}
        />
      )
    }
    case 'text':
    default:
      return <TextFormItem label={label} value={value} />
  }
}

/** code 渲染器 — CodeMirror 只读代码视图（与文件面板预览同款）+ 复制按钮 */
function CodeFormItem({
  label,
  code,
  language,
  ext,
  wrap,
  lineNumbers
}: {
  label?: string
  code: string
  language?: string
  ext: string
  wrap: boolean
  lineNumbers: boolean
}): React.JSX.Element | null {
  const [copied, setCopied] = useState(false)

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
        <span className="font-medium uppercase tracking-wider">
          {language || ext.replace('.', '') || label || 'code'}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-text-secondary transition-colors"
        >
          {copied ? <Check size={9} className="text-success" /> : <Copy size={9} />}
        </button>
      </div>
      {/* thin-scrollbar 一并作用于内部 .cm-scroller —— CodeMirror 自己是这块的唯一滚动主 */}
      <div className="rounded-b overflow-hidden border border-border-secondary/40 border-t-0 thin-scrollbar">
        <CodeView
          content={code}
          ext={ext}
          wrap={wrap}
          lineNumbers={lineNumbers}
          maxHeight={CODE_MAX_H}
        />
      </div>
    </div>
  )
}

/** text 渲染器 — 带标签的纯文本 */
function TextFormItem({ label, value }: { label?: string; value: unknown }): React.JSX.Element {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <div>
      {label && <div className="text-[10px] text-text-tertiary mb-0.5">{label}</div>}
      <pre className={DETAIL_PRE_CLASS}>{text}</pre>
    </div>
  )
}
