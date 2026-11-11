import { getHostApi } from '@shuvix/chat-ui'
import {
  Eye,
  EyeOff,
  FileOutput,
  FilePen,
  FileText,
  FolderInput,
  FolderOpen,
  MessagesSquare,
  Settings,
  Shield,
  ShieldAlert,
  Puzzle,
  Wrench
} from 'lucide-react'
import { Fragment, useId, useMemo, useRef, useState } from 'react'
import { BackgroundBadge, FullAccessBadge } from '../BgTaskTag'
import { ReviewOpinion, ReviewRiskBadge } from '../ReviewTag'
import { renderToolIcon } from '../ToolCallBlock'
import { useChatStore } from '../../../stores/chatStore'
import { useChatDensity } from '../../../host/chatHostContext'
import { useTranslation } from 'react-i18next'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import powershell from 'highlight.js/lib/languages/powershell'
import type {
  AskExtensionPreview,
  AskField,
  AskInputRequest,
  AskPolicyPrompt,
  AskSessionMovePreview,
  AskSessionTarget,
  AskSettingsPreview,
  AskWidgetTarget
} from '@shuvix/chat-protocol/types/inputRequest'
import { builtinMcpCopy, sameAsIdentifier } from '@shuvix/chat-protocol/builtinExtensionCopy'
import { fallbackToolPresentation } from '@shuvix/chat-protocol/builtinMcpPresentations'
import type { InputFormProps } from './types'
import { otherResponseOf, type AskDraft } from './drafts'
import { DiffViewer } from '../DiffViewer'
import { ASK_PREVIEW_MAX_H } from '../detailViewport'
import { OptionRow, useOptionHotkeys } from './OptionRows'
import { OtherAnswerRow } from './OtherAnswerRow'
import { useAnswerSubmit } from './useAnswerSubmit'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('powershell', powershell)

/** 命令询问按发起它的工具着色：Windows 上的 powershell 工具写的是 PowerShell，其余都按 shell 读 */
function CommandPreview({
  command,
  language
}: {
  command: string
  language: 'bash' | 'powershell'
}): React.JSX.Element {
  const highlighted = useMemo(() => {
    if (!command) return ''
    try {
      return hljs.highlight(command, { language }).value
    } catch {
      return command.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  }, [command, language])

  return (
    <pre className="text-[12px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 overflow-auto max-h-28 whitespace-pre-wrap break-words !m-0">
      <code
        className={`hljs language-${language}`}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </pre>
  )
}

/**
 * 请求时的写法 —— 仅当它与真实去处不同（中间隔着符号链接或 `..`）时，挂在主路径下面。
 * 主路径是真实去处：用户批准、「允许并记住」记下的都是它；这一行让卡片对得上上方那次调用。
 */
function RequestedAs({ path }: { path: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="mt-0.5 text-[11px] leading-snug break-all font-mono text-text-tertiary">
      <span className="font-sans">{t('toolCall.requestedAs')}</span> {path}
    </div>
  )
}

/** 路径询问预览：待放行的那条路径（真实去处） */
function PathPreview({
  path,
  requestedPath
}: {
  path: string
  requestedPath?: string
}): React.JSX.Element {
  return (
    <div className="text-[12px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 break-all font-mono text-text-primary">
      {path}
      {requestedPath && <RequestedAs path={requestedPath} />}
    </div>
  )
}

/**
 * 预览询问：路径一行 + 即将发生的改动。
 *
 * 这里的 diff 与工具执行后步骤块里那份是同一个字符串（后端算一次两处共用），
 * 所以用的也必须是同一个 DiffViewer —— 换渲染器就等于给"所见即所批"开了个口子。
 */
function DiffPreview({
  path,
  requestedPath,
  diff
}: {
  path: string
  requestedPath?: string
  diff: string
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="text-[12px] leading-snug break-all font-mono text-text-secondary px-0.5">
        {path}
        {requestedPath && <RequestedAs path={requestedPath} />}
      </div>
      <DiffViewer diff={diff} maxHeight={ASK_PREVIEW_MAX_H} />
    </div>
  )
}

/**
 * 搬会话的询问预览（`session` 工具的 `move-session`）：搬进哪个项目、这次要搬的每一条会话（标题、原来的项目、
 * 跟着走的子会话数）。有会话来自别的目录时多一行：它们之后在新目录里工作 —— 用户批准的是这一整批。
 */
function SessionMovePreview({ move }: { move: AskSessionMovePreview }): React.JSX.Element {
  const { t } = useTranslation()
  const relocates = move.sessions.some((s) => s.fromPath !== move.project.path)
  return (
    <div className="space-y-1" data-ask-session-move={move.sessions.length}>
      <div className="px-0.5 text-[11px] text-text-tertiary" data-ask-session-move-project="">
        {t('toolCall.sessionAskMoveInto', { project: move.project.name })}
      </div>
      <ul
        className="text-[12px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 min-w-0 space-y-1 overflow-y-auto overscroll-contain thin-scrollbar !m-0 list-none"
        style={{ maxHeight: ASK_PREVIEW_MAX_H }}
      >
        {move.sessions.map((s) => (
          <li key={s.id} className="min-w-0" data-ask-session-move-row={s.id}>
            <div className="truncate text-text-primary">
              {s.title || t('toolCall.sessionAskUntitled')}
            </div>
            <div className="truncate text-[11px] text-text-tertiary">
              {t('toolCall.sessionAskMoveFrom', { project: s.fromProject })}
              {s.subSessions > 0 &&
                ` · ${t('toolCall.sessionAskMoveSubs', { count: s.subSessions })}`}
            </div>
          </li>
        ))}
      </ul>
      {relocates && (
        <div className="px-0.5 text-[11px] text-text-tertiary" data-ask-session-move-folder="">
          {t('toolCall.sessionAskMoveFolder', { path: move.project.path })}
        </div>
      )}
    </div>
  )
}

/**
 * 会话询问预览：要查看 / 对话的那条会话（标题 + id），对话类再摊开要发进去的那段话 —— 用户批准的就是它落进那条会话
 */
function SessionPreview({
  session,
  message
}: {
  session: AskSessionTarget
  message?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-1" data-ask-session={session.sessionId}>
      <div className="text-[12px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 min-w-0">
        <div className="truncate text-text-primary">
          {session.title || t('toolCall.sessionAskUntitled')}
        </div>
        <div className="truncate font-mono text-[11px] text-text-tertiary">{session.sessionId}</div>
      </div>
      {message && (
        <div>
          <div className="px-0.5 text-[11px] text-text-tertiary">
            {t('toolCall.sessionAskMessage')}
          </div>
          <pre
            className="text-[12px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 overflow-auto whitespace-pre-wrap break-words !m-0 text-text-primary"
            style={{ maxHeight: ASK_PREVIEW_MAX_H }}
          >
            {message}
          </pre>
        </div>
      )}
    </div>
  )
}

/**
 * 组件询问预览：要用的那个组件（名字 + id）与这次的操作 —— 用户批准的是这条会话用这个组件
 */
function WidgetPreview({ widget }: { widget: AskWidgetTarget }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-1" data-ask-widget={widget.widgetId}>
      <div className="text-[12px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 min-w-0">
        <div className="truncate text-text-primary">
          {widget.name || t('toolCall.widgetAskUnnamed')}
        </div>
        <div className="truncate font-mono text-[11px] text-text-tertiary">{widget.widgetId}</div>
      </div>
      {widget.operation && (
        <div className="px-0.5 text-[11px] text-text-tertiary">
          {t('toolCall.widgetAskOperation')}{' '}
          <span className="font-mono text-text-secondary" data-ask-widget-op="">
            {widget.operation}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * 开启扩展询问预览：要开启哪台服务器、它从哪来（第三方的会当场启动 / 连接）、会不会丢提示词缓存。
 */
function ExtensionPreview({ extension }: { extension: AskExtensionPreview }): React.JSX.Element {
  const { t } = useTranslation()
  const { server, source, cacheLoss } = extension
  const name =
    source.type === 'builtin'
      ? (builtinMcpCopy(server, t)?.label ?? server)
      : source.type === 'widget'
        ? source.name
        : server
  const where =
    source.type === 'command'
      ? { label: t('toolCall.extensionAskCommand'), value: source.command }
      : source.type === 'url'
        ? { label: t('toolCall.extensionAskUrl'), value: source.host }
        : null
  return (
    <div className="space-y-1" data-ask-extension={server}>
      <div className="text-[12px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 min-w-0">
        <div className="truncate text-text-primary">{name}</div>
        {!sameAsIdentifier(name, server) && (
          <div className="truncate font-mono text-[11px] text-text-tertiary">{server}</div>
        )}
      </div>
      {where && (
        <div className="px-0.5 text-[11px] text-text-tertiary" data-ask-extension-source="">
          {where.label}{' '}
          <span className="font-mono break-all text-text-secondary">{where.value}</span>
        </div>
      )}
      {source.type === 'widget' && (
        <div className="px-0.5 text-[11px] text-text-tertiary" data-ask-extension-widget="">
          {t('toolCall.extensionAskWidget')}
        </div>
      )}
      {cacheLoss && (
        <div className="px-0.5 text-[11px] text-text-tertiary" data-ask-extension-cache="">
          {cacheLoss.promptTokens > 0
            ? t('toolCall.extensionAskCacheTokens', { tokens: cacheLoss.promptTokens })
            : t('toolCall.extensionAskCache')}
        </div>
      )}
    </div>
  )
}

/**
 * 改设置询问预览（`shuvix` 工具调一条设置通道）：宿主写的一句话 + 逐行的标签与值，下面小字注上通道名 ——
 * 用户写策略认的是通道名。卡片不认识具体通道，行怎么写全由宿主定（界面语言、秘密值换成「已填」），这里原样摆。
 * 单个值可能很长（整条命令行、一串参数）：每个值限高自己滚，别的行照样看得见。
 */
function SettingsPreview({ settings }: { settings: AskSettingsPreview }): React.JSX.Element {
  const { t } = useTranslation()
  const { channel, title, rows } = settings
  return (
    <div className="space-y-1" data-ask-settings={channel}>
      <div className="text-[12px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 min-w-0">
        <div className="break-words text-text-primary" data-ask-settings-title="">
          {title}
        </div>
        {rows.length > 0 && (
          // 标签列按内容收窄、最多占四成：值（路径、命令）才是该看全的那一列
          <dl className="mt-1 grid grid-cols-[fit-content(40%)_minmax(0,1fr)] gap-x-2.5 gap-y-0.5">
            {rows.map((row, i) => (
              <Fragment key={i}>
                <dt className="break-words text-text-tertiary" data-ask-settings-label="">
                  {row.label}
                </dt>
                <dd
                  className="max-h-24 overflow-y-auto overscroll-contain thin-scrollbar whitespace-pre-wrap break-all font-mono text-[11.5px] text-text-secondary"
                  data-ask-settings-value=""
                >
                  {row.value}
                </dd>
              </Fragment>
            ))}
          </dl>
        )}
      </div>
      <div className="px-0.5 text-[11px] text-text-tertiary" data-ask-settings-channel="">
        {t('toolCall.settingsAskChannel')}{' '}
        <span className="font-mono break-all text-text-secondary">{channel}</span>
      </div>
    </div>
  )
}

/**
 * 卡上要用户自己填的一项（agent 留空的 API key、token …）。
 *
 * 输入框刻意不受控：受控的 input 会被 React 同步进 `value` 属性，值就跟着 DOM 的序列化（innerHTML、页面快照、
 * 复制出去的 HTML）走了；不受控时值只在元素的 value 里。手机上关掉自动大写与纠错 —— 首字母被改成大写的 token
 * 就是另一个 token。
 */
function AskFieldRow({
  field,
  touch,
  last,
  onChange,
  onEnter,
  inputRef
}: {
  field: AskField
  touch: boolean
  /** 最后一个输入框：手机键盘上回车键写「完成」，其余写「下一项」 */
  last: boolean
  onChange: (value: string) => void
  onEnter: () => void
  inputRef: (el: HTMLInputElement | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const [shown, setShown] = useState(false)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // 229：Safari 上确认输入法候选的那个回车 isComposing 已是 false。长按连发不算第二次
    if (e.key !== 'Enter' || e.repeat) return
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    onEnter()
  }
  return (
    <div data-ask-field={field.key}>
      <label
        htmlFor={id}
        className={`flex flex-wrap items-baseline gap-x-1.5 leading-snug ${
          touch ? 'text-[12px]' : 'text-[11px]'
        }`}
      >
        {/* 环境变量名、请求头名：要认全，宁可折行也不截断 */}
        <span className="min-w-0 break-all font-mono text-text-secondary">{field.label}</span>
        {!field.required && (
          <span className="text-text-tertiary" data-ask-field-optional="">
            {t('toolCall.askFieldOptional')}
          </span>
        )}
      </label>
      <div
        className={`mt-1 flex items-center rounded-md border border-border-secondary bg-bg-primary focus-within:border-accent transition-colors ${
          touch ? 'h-11' : 'h-7'
        }`}
      >
        <input
          id={id}
          ref={inputRef}
          type={field.secret && !shown ? 'password' : 'text'}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-required={field.required}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint={last ? 'done' : 'next'}
          data-ask-field-input=""
          // 手机上小于 16px 时 iOS 一聚焦就放大页面
          className={`min-w-0 flex-1 bg-transparent px-2 font-mono text-text-primary outline-none ${
            touch ? 'text-base' : 'text-[12.5px]'
          }`}
        />
        {field.secret && (
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? t('input.secretHide') : t('input.secretShow')}
            title={shown ? t('input.secretHide') : t('input.secretShow')}
            data-ask-field-reveal=""
            className={`flex-shrink-0 flex items-center justify-center text-text-tertiary hover:text-text-secondary ${
              touch ? 'h-11 w-11' : 'h-7 w-7'
            }`}
          >
            {shown ? <EyeOff size={touch ? 18 : 13} /> : <Eye size={touch ? 18 : 13} />}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * 命中策略的提示语 —— 收成操作栏左端的一枚角标：平时只留策略名，点开才铺出整句。
 *
 * 内置策略那几句每次询问都一字不差地重复（「放行后命令以你的完整系统权限运行…」），
 * 常驻展开等于每张卡都付两行；而"是哪份策略在拦你"才是当场要认的东西 ——
 * 故默认只署名，原文留在 hover 的 title 与点开的那一段里。
 * 代价是用户自己写的提示语也一起收了起来：等 AskPolicyPrompt 带上来源，再把用户策略那句摊开。
 */
function PolicyPromptChip({
  prompt,
  open,
  onToggle
}: {
  prompt: AskPolicyPrompt
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const attribution =
    prompt.policies.length > 0
      ? t('toolCall.policyPromptFrom', { policies: prompt.policies.join(' · ') })
      : ''
  // 没有署名（策略未命名）时退回原文，角标至少说明这是一条策略提示
  const label = prompt.policies.length > 0 ? prompt.policies.join(' · ') : prompt.text
  return (
    <button
      type="button"
      onClick={onToggle}
      data-ask-policy=""
      title={attribution ? `${prompt.text}\n${attribution}` : prompt.text}
      className={`flex items-center gap-1 min-w-0 max-w-full text-[11px] transition-colors ${
        open ? 'text-text-secondary' : 'text-text-tertiary hover:text-text-secondary'
      }`}
    >
      <Shield size={11} className="flex-shrink-0" />
      <span className="truncate border-b border-dotted border-current/50">{label}</span>
    </button>
  )
}

/** 一张审批卡上的一个选项（一行） */
interface AskOption {
  /** `data-ask-option` 的值，页面对象与测试按它认行 */
  id:
    | 'allow'
    | 'remember-path'
    | 'remember-folder'
    | 'remember-session'
    | 'remember-widget'
    | 'remember-widget-write'
    | 'deny'
  label: string
  detail?: string
  detailIsPath?: boolean
  primary?: boolean
  /** 卡上要填的值还没填完：允许那一行点不了，数字键也不算 */
  disabled?: boolean
  onPick: () => void
  data?: Record<string, string>
}

export function AskForm({
  request,
  draft,
  onDraftChange,
  onSubmit,
  titleAccessory
}: InputFormProps<AskInputRequest, AskDraft>): React.JSX.Element {
  const { t } = useTranslation()
  const touch = useChatDensity() === 'touch'
  const [policyOpen, setPolicyOpen] = useState(false)
  const submit = useAnswerSubmit(onSubmit)
  const {
    command,
    requestedPath,
    description,
    pathIsDirectory,
    policyPrompt,
    preview,
    toolName,
    background,
    unsandboxed,
    review,
    session,
    widget
  } = request
  const fields = request.fields ?? []
  const hasFields = fields.length > 0
  // 卡上填的值只放在这张卡的组件状态里，不进草稿：草稿在共享的 store 里、比卡片活得久。代价是步进到别的询问、
  // 切走会话再回来，填过的要重填 —— 宁可重填，也不让秘密值多留一处
  const [values, setValues] = useState<Record<string, string>>({})
  const fieldInputs = useRef(new Map<string, HTMLInputElement>())
  const missingFields = fields.filter((f) => f.required && !(values[f.key] ?? '').trim())
  const missingField = missingFields[0]
  const hostPresentation = useChatStore((s) => s.toolPresentations[toolName])
  // 内置 MCP 能力服务器发起的询问（browser 打开一个地址、读一个本地文件；ssh 执行一条命令）
  // 也要有工具名与图标 —— 宿主下发的表里没有它们
  const presentation = hostPresentation ?? fallbackToolPresentation(toolName, t)
  const diffPreview = preview?.kind === 'diff' ? preview : null
  const messagePreview = preview?.kind === 'message' ? preview.text : undefined
  const extensionPreview = preview?.kind === 'extension' ? preview : null
  const settingsPreview = preview?.kind === 'settings' ? preview : null
  const movePreview = preview?.kind === 'session-move' ? preview : null

  // 路径类(read/write/edit/...):command 形如 Read(path)/Write(path),可"允许并记住"这条路径(或它所在的
  // 文件夹),记进会话权限表。会话类(request.session)可"允许并记住"那条会话。命令类(bash/ssh)与简单类(浏览器
  // 操作等)没有可记住的条目 —— 命令逐条询问。
  const pathAsk: { mode: 'read' | 'write'; path: string } | null = useMemo(() => {
    const m = command.match(/^(Read|Write)\((.+)\)$/)
    if (!m) return null
    return { mode: m[1] === 'Read' ? 'read' : 'write', path: m[2] }
  }, [command])

  // 「允许并记住」写进会话权限表（宿主能力）：路径类与会话类,且需宿主提供 HostApi。
  // 卡上要填值的询问不给记住：记下的只是这一次的放行，下回的值还得有人填
  const canRemember = pathAsk !== null && getHostApi() !== null && !hasFields
  // 搬会话（access `move`）没有记住：权限表里的会话行说的是查看 / 对话，搬走一条会话每次都由人点头
  const canRememberSession =
    !!session && session.access !== 'move' && getHostApi() !== null && !hasFields
  const canRememberWidget = !!widget && getHostApi() !== null && !hasFields
  // 文件还可以记下它所在的文件夹（太浅的不给，见 rememberFolderOf）
  const rememberFolder =
    canRemember && pathAsk && !pathIsDirectory ? rememberFolderOf(pathAsk.path) : null

  // 批准：卡上要填的值随答复一起交（键恰是 fields 的键，没填的可选项是空串）。前后空白去掉 —— 粘贴来的 token
  // 常带一个换行。必填的没填完时什么都不交（行是灰的，数字键、回车也走到这里）
  const allow = (): void => {
    if (missingField) return
    if (!hasFields) {
      onSubmit({ kind: 'ask', allowed: true })
      return
    }
    const filled = Object.fromEntries(fields.map((f) => [f.key, (values[f.key] ?? '').trim()]))
    onSubmit({ kind: 'ask', allowed: true, values: filled })
  }

  // 输入框里的回车：还有必填的空着就跳过去；都填了，桌面上等于批准，触屏上去下一个输入框或收起键盘 ——
  // 与写一句话那一行同一条规矩，手机上的回车不发东西，批准走选项行
  const handleFieldEnter = (index: number): void => {
    if (missingField) {
      fieldInputs.current.get(missingField.key)?.focus()
      return
    }
    if (!touch) {
      allow()
      return
    }
    const next = fields[index + 1]
    if (next) fieldInputs.current.get(next.key)?.focus()
    else fieldInputs.current.get(fields[index].key)?.blur()
  }

  // 选项自上而下：允许这一次 → 各种「允许并记住」→ 拒绝。目录路径没有单次放行（目录授权天然持久）；
  // 记住所在文件夹那一行把文件夹整条摆出来 —— 授予的范围比这个文件大，得看得见
  const options: AskOption[] = []
  if (!(pathAsk && pathIsDirectory) || hasFields) {
    options.push({
      id: 'allow',
      label: t('toolCall.askAllowOnce'),
      // 灰着的时候说一句为什么
      detail: missingField
        ? t('toolCall.askFieldsMissing', { count: missingFields.length })
        : undefined,
      primary: true,
      disabled: !!missingField,
      onPick: allow
    })
  }
  if (canRememberSession) {
    options.push({
      id: 'remember-session',
      label: t('toolCall.askRememberSession'),
      // 后端按 extra.remember 把这条会话（查看 / 对话）写进会话权限表
      onPick: () => onSubmit({ kind: 'ask', allowed: true, extra: { remember: true } }),
      data: { 'data-remember-session': '' }
    })
  }
  if (canRememberWidget && widget) {
    // 读操作的卡片多一行「记成可读写」：造组件、或接着要写的时候不必再问一次；写的卡片只有可读写这一行
    options.push({
      id: 'remember-widget',
      label:
        widget.access === 'write'
          ? t('toolCall.askRememberWidgetWrite')
          : t('toolCall.askRememberWidgetRead'),
      onPick: () => onSubmit({ kind: 'ask', allowed: true, extra: { remember: true } }),
      data: { 'data-remember-widget': widget.access }
    })
    if (widget.access === 'read') {
      options.push({
        id: 'remember-widget-write',
        label: t('toolCall.askRememberWidgetWrite'),
        onPick: () =>
          onSubmit({
            kind: 'ask',
            allowed: true,
            extra: { remember: true, rememberAccess: 'write' }
          }),
        data: { 'data-remember-widget': 'write' }
      })
    }
  }
  if (canRemember) {
    options.push({
      id: 'remember-path',
      label: pathIsDirectory ? t('toolCall.askRememberDirectory') : t('toolCall.askRememberFile'),
      primary: !!pathIsDirectory,
      // 后端按 extra.rememberPath 写进会话权限表
      onPick: () => onSubmit({ kind: 'ask', allowed: true, extra: { rememberPath: true } })
    })
  }
  if (rememberFolder) {
    options.push({
      id: 'remember-folder',
      label: t('toolCall.askRememberFolder'),
      detail: rememberFolder,
      detailIsPath: true,
      onPick: () =>
        onSubmit({ kind: 'ask', allowed: true, extra: { rememberPath: rememberFolder } }),
      data: { 'data-remember-folder': rememberFolder }
    })
  }
  options.push({
    id: 'deny',
    label: t('toolCall.deny'),
    onPick: () => onSubmit({ kind: 'ask', allowed: false })
  })
  useOptionHotkeys(options.length, (i) => {
    const opt = options[i]
    if (opt && !opt.disabled) opt.onPick()
  })

  // 顶行的动作名：非路径类直接取工具自己的显示名，与上方步骤行共用一套词表
  const iconSize = touch ? 14 : 12
  const iconClass = 'flex-shrink-0'
  // 改设置与开启扩展：顶行是卡片自己的动作名，不看发起它的工具
  const previewHead = settingsPreview
    ? {
        icon: <Settings size={iconSize} className={iconClass} />,
        title: t('toolCall.settingsAskChange')
      }
    : extensionPreview
      ? {
          icon: <Puzzle size={iconSize} className={iconClass} />,
          title: t('toolCall.extensionAskEnable')
        }
      : movePreview
        ? {
            icon: <FolderInput size={iconSize} className={iconClass} />,
            title: t('toolCall.sessionAskMove')
          }
        : null
  const { icon, title } = previewHead
    ? previewHead
    : widget
      ? {
          icon: <Wrench size={iconSize} className={iconClass} />,
          title:
            widget.access === 'write' ? t('toolCall.widgetAskWrite') : t('toolCall.widgetAskRead')
        }
      : session
        ? session.access === 'write'
          ? {
              icon: <MessagesSquare size={iconSize} className={iconClass} />,
              title: t('toolCall.sessionAskWrite')
            }
          : {
              icon: <Eye size={iconSize} className={iconClass} />,
              title: t('toolCall.sessionAskRead')
            }
        : diffPreview
          ? diffPreview.isNewFile
            ? {
                icon: <FileOutput size={iconSize} className={iconClass} />,
                title: t('toolCall.pendingCreatePreview')
              }
            : toolName === 'edit'
              ? {
                  icon: <FilePen size={iconSize} className={iconClass} />,
                  title: t('toolCall.pendingEditPreview')
                }
              : {
                  icon: <FileOutput size={iconSize} className={iconClass} />,
                  title: t('toolCall.pendingWritePreview')
                }
          : pathAsk
            ? pathAsk.mode === 'write'
              ? {
                  icon: <FileOutput size={iconSize} className={iconClass} />,
                  title: t('toolCall.pendingPathWrite')
                }
              : pathIsDirectory
                ? {
                    icon: <FolderOpen size={iconSize} className={iconClass} />,
                    title: t('toolCall.pendingPathReadDir')
                  }
                : {
                    icon: <FileText size={iconSize} className={iconClass} />,
                    title: t('toolCall.pendingPathRead')
                  }
            : {
                icon: presentation ? (
                  <span className={`${iconClass} flex items-center`}>
                    {renderToolIcon(presentation)}
                  </span>
                ) : (
                  <ShieldAlert size={iconSize} className={iconClass} />
                ),
                title: presentation?.label ?? t('toolCall.pendingAsk')
              }

  // 标题：审查员那句大白话 > 工具自己的说明（agent 写的这一步要做什么）> 动作名本身。
  // 有审查意见时不再摆说明 —— 审查员只看人写的话与操作本身，说明是 agent 的说法
  const headline = review ? '' : (description?.trim() ?? '')
  const titleIsHeadline = !review && !headline
  const headlineClass = `break-words font-medium text-text-primary leading-snug ${
    touch ? 'text-sm' : 'text-[13px]'
  }`

  return (
    <div className="flex flex-col min-h-0" data-ask-card="">
      {/* 上半：顶行 + 标题 + 预览，长了自己滚；下面的选项行始终看得见 */}
      <div
        className={`min-h-0 overflow-y-auto thin-scrollbar ${
          touch ? 'px-4 pt-3.5 pb-3 space-y-2.5' : 'px-3.5 pt-3 pb-2.5 space-y-2'
        }`}
      >
        {/* 顶行：动作名 + 标签，右端风险等级与多条询问的步进器 */}
        <div
          className={`flex items-center gap-1.5 min-w-0 ${
            titleIsHeadline ? 'text-text-primary' : 'text-text-tertiary'
          }`}
        >
          {icon}
          <p
            className={
              titleIsHeadline
                ? `${headlineClass} min-w-0`
                : `min-w-0 truncate ${touch ? 'text-[12px]' : 'text-[11.5px]'}`
            }
            data-ask-title=""
          >
            {title}
          </p>
          {/* 后台任务标签 —— 与「跑完就完的命令」在视觉上分开：这条批准之后进程会一直活着 */}
          {background && <BackgroundBadge />}
          {unsandboxed && <FullAccessBadge />}
          <span className="flex-1" />
          {review && <ReviewRiskBadge risk={review.risk} />}
          {titleAccessory}
        </div>

        {/* 审查员看过、交给你的：它那句大白话就是标题 —— 读懂一条命令要懂 shell，读懂它不用 */}
        {review ? (
          <ReviewOpinion review={review} touch={touch} />
        ) : headline ? (
          <p className={headlineClass} data-ask-description="">
            {headline}
          </p>
        ) : null}

        <div data-ask-preview="">
          {settingsPreview ? (
            <SettingsPreview settings={settingsPreview} />
          ) : extensionPreview ? (
            <ExtensionPreview extension={extensionPreview} />
          ) : widget ? (
            <WidgetPreview widget={widget} />
          ) : movePreview ? (
            <SessionMovePreview move={movePreview} />
          ) : session ? (
            <SessionPreview session={session} message={messagePreview} />
          ) : diffPreview ? (
            // 平常 diff 头上是模型写的路径；写入被链接带去别处时，改为真实去处领头、原写法注在下面
            <DiffPreview
              path={requestedPath && pathAsk ? pathAsk.path : diffPreview.path}
              requestedPath={pathAsk ? requestedPath : undefined}
              diff={diffPreview.diff}
            />
          ) : pathAsk ? (
            <PathPreview path={pathAsk.path} requestedPath={requestedPath} />
          ) : (
            <CommandPreview
              command={command}
              language={toolName === 'powershell' ? 'powershell' : 'bash'}
            />
          )}
        </div>

        {/* 命中的策略：一枚角标，点开才铺出整句 */}
        {policyPrompt && (
          <div className="space-y-1">
            <PolicyPromptChip
              prompt={policyPrompt}
              open={policyOpen}
              onToggle={() => setPolicyOpen(!policyOpen)}
            />
            {policyOpen && (
              <p className="text-[11.5px] leading-snug text-text-secondary whitespace-pre-wrap break-words">
                {policyPrompt.text}
              </p>
            )}
          </div>
        )}
      </div>

      {/* 选项行：允许这一次 / 记住… / 拒绝 —— 也可以不选，在最后一行告诉 AI 换个做法 */}
      <div className="flex-shrink-0">
        {/* 要填的值紧贴在允许那一行上面、不随上半滚走：允许灰着时，原因就在眼前 */}
        {hasFields && (
          <div
            className={`border-t border-border-secondary/40 ${
              touch ? 'px-4 py-2.5 space-y-2.5' : 'px-3.5 py-2 space-y-2'
            }`}
            data-ask-fields=""
          >
            <p
              className={`leading-snug text-text-tertiary ${touch ? 'text-[12px]' : 'text-[11px]'}`}
            >
              {t('toolCall.askFieldsNote')}
            </p>
            {fields.map((field, i) => (
              <AskFieldRow
                key={field.key}
                field={field}
                touch={touch}
                last={i === fields.length - 1}
                onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
                onEnter={() => handleFieldEnter(i)}
                inputRef={(el) => {
                  if (el) fieldInputs.current.set(field.key, el)
                  else fieldInputs.current.delete(field.key)
                }}
              />
            ))}
          </div>
        )}
        <div role="group" aria-label={title}>
          {options.map((opt, i) => (
            <OptionRow
              key={opt.id}
              index={i}
              label={opt.label}
              detail={opt.detail}
              detailIsPath={opt.detailIsPath}
              primary={opt.primary}
              disabled={opt.disabled}
              onPick={opt.onPick}
              data={{ 'data-ask-option': opt.id, ...opt.data }}
            />
          ))}
        </div>
        <OtherAnswerRow
          placeholder={t('pendingInputs.otherPlaceholderAsk')}
          value={draft.otherText ?? ''}
          onChange={(otherText) => onDraftChange({ ...draft, otherText })}
          response={otherResponseOf(draft.otherText)}
          submit={submit}
          sendButton
        />
      </div>
    </div>
  )
}

/**
 * 「允许整个文件夹」记哪个文件夹：这个文件所在的那一级。太浅的不给（`/`、`/Users`、家目录这一层 —— 少于三段，
 * Windows 不数盘符）：一次点击把整个家目录记进会话权限表太容易点错（安全模块那边也挡，见 rememberTargetOf）
 */
export function rememberFolderOf(path: string): string | null {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut <= 0) return null
  const parent = path.slice(0, cut)
  const segments = parent.split(/[\\/]/).filter((s) => s !== '' && !/^[A-Za-z]:$/.test(s))
  return segments.length >= 3 ? parent : null
}
