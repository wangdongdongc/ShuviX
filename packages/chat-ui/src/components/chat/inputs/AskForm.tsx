import { getHostApi } from '@shuvix/chat-ui'
import {
  Eye,
  FileOutput,
  FilePen,
  FileText,
  FolderOpen,
  MessagesSquare,
  Shield,
  ShieldAlert
} from 'lucide-react'
import { useMemo, useState } from 'react'
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
  AskInputRequest,
  AskPolicyPrompt,
  AskSessionTarget
} from '@shuvix/chat-protocol/types/inputRequest'
import { fallbackToolPresentation } from '@shuvix/chat-protocol/builtinMcpPresentations'
import type { InputFormProps } from './types'
import type { AskDraft } from './drafts'
import { DiffViewer } from '../DiffViewer'
import { ASK_PREVIEW_MAX_H } from '../detailViewport'
import { OptionRow, useOptionHotkeys } from './OptionRows'

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
  id: 'allow' | 'remember-path' | 'remember-folder' | 'remember-session' | 'deny'
  label: string
  detail?: string
  detailIsPath?: boolean
  primary?: boolean
  onPick: () => void
  data?: Record<string, string>
}

export function AskForm({
  request,
  draft: _draft,
  onDraftChange: _onDraftChange,
  onSubmit,
  titleAccessory
}: InputFormProps<AskInputRequest, AskDraft>): React.JSX.Element {
  const { t } = useTranslation()
  const touch = useChatDensity() === 'touch'
  const [policyOpen, setPolicyOpen] = useState(false)
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
    session
  } = request
  const hostPresentation = useChatStore((s) => s.toolPresentations[toolName])
  // 内置 MCP 能力服务器发起的询问（browser 打开一个地址、读一个本地文件；ssh 执行一条命令）
  // 也要有工具名与图标 —— 宿主下发的表里没有它们
  const presentation = hostPresentation ?? fallbackToolPresentation(toolName, t)
  const diffPreview = preview?.kind === 'diff' ? preview : null
  const messagePreview = preview?.kind === 'message' ? preview.text : undefined

  // 路径类(read/write/edit/...):command 形如 Read(path)/Write(path),可"允许并记住"这条路径(或它所在的
  // 文件夹),记进会话权限表。会话类(request.session)可"允许并记住"那条会话。命令类(bash/ssh)与简单类(浏览器
  // 操作等)没有可记住的条目 —— 命令逐条询问。
  const pathAsk: { mode: 'read' | 'write'; path: string } | null = useMemo(() => {
    const m = command.match(/^(Read|Write)\((.+)\)$/)
    if (!m) return null
    return { mode: m[1] === 'Read' ? 'read' : 'write', path: m[2] }
  }, [command])

  // 「允许并记住」写进会话权限表（宿主能力）：路径类与会话类,且需宿主提供 HostApi
  const canRemember = pathAsk !== null && getHostApi() !== null
  const canRememberSession = !!session && getHostApi() !== null
  // 文件还可以记下它所在的文件夹（太浅的不给，见 rememberFolderOf）
  const rememberFolder =
    canRemember && pathAsk && !pathIsDirectory ? rememberFolderOf(pathAsk.path) : null

  // 选项自上而下：允许这一次 → 各种「允许并记住」→ 拒绝。目录路径没有单次放行（目录授权天然持久）；
  // 记住所在文件夹那一行把文件夹整条摆出来 —— 授予的范围比这个文件大，得看得见
  const options: AskOption[] = []
  if (!(pathAsk && pathIsDirectory)) {
    options.push({
      id: 'allow',
      label: t('toolCall.askAllowOnce'),
      primary: true,
      onPick: () => onSubmit({ kind: 'ask', allowed: true })
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
  useOptionHotkeys(options.length, (i) => options[i]?.onPick())

  // 顶行的动作名：非路径类直接取工具自己的显示名，与上方步骤行共用一套词表
  const iconSize = touch ? 14 : 12
  const iconClass = 'flex-shrink-0'
  const { icon, title } = session
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
          {session ? (
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

      {/* 选项行：允许这一次 / 记住… / 拒绝 —— 也可以不选，直接在下面的输入框告诉 AI 换个做法 */}
      <div className="flex-shrink-0" role="group" aria-label={title}>
        {options.map((opt, i) => (
          <OptionRow
            key={opt.id}
            index={i}
            label={opt.label}
            detail={opt.detail}
            detailIsPath={opt.detailIsPath}
            primary={opt.primary}
            onPick={opt.onPick}
            data={{ 'data-ask-option': opt.id, ...opt.data }}
          />
        ))}
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
