import { getHostApi } from '@shuvix/chat-ui'
import {
  ChevronDown,
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
import { ReviewOpinion } from '../ReviewTag'
import { renderToolIcon } from '../ToolCallBlock'
import { useChatStore } from '../../../stores/chatStore'
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
    <pre className="text-[11px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 overflow-auto max-h-28 whitespace-pre-wrap break-words !m-0">
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
    <div className="mt-0.5 text-[10px] leading-snug break-all font-mono text-text-tertiary">
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
    <div className="text-[11px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 break-all font-mono text-text-primary">
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
      <div className="text-[11px] leading-snug break-all font-mono text-text-secondary px-0.5">
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
      <div className="text-[11px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 min-w-0">
        <div className="truncate text-text-primary">
          {session.title || t('toolCall.sessionAskUntitled')}
        </div>
        <div className="truncate font-mono text-[10px] text-text-tertiary">{session.sessionId}</div>
      </div>
      {message && (
        <div>
          <div className="px-0.5 text-[10px] text-text-tertiary">
            {t('toolCall.sessionAskMessage')}
          </div>
          <pre
            className="text-[11px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 overflow-auto whitespace-pre-wrap break-words !m-0 text-text-primary"
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
      onClick={onToggle}
      title={attribution ? `${prompt.text}\n${attribution}` : prompt.text}
      className={`flex items-center gap-1 min-w-0 text-[10px] transition-colors ${
        open ? 'text-text-secondary' : 'text-text-tertiary hover:text-text-secondary'
      }`}
    >
      <Shield size={10} className="flex-shrink-0" />
      <span className="truncate border-b border-dotted border-current/50">{label}</span>
    </button>
  )
}

export function AskForm({
  request,
  draft: _draft,
  onDraftChange: _onDraftChange,
  onSubmit,
  titleAccessory
}: InputFormProps<AskInputRequest, AskDraft>): React.JSX.Element {
  const { t } = useTranslation()
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
  const [folderOpen, setFolderOpen] = useState(false)

  /** 单次允许 — 立即提交,不写权限表 */
  const handleAllow = (): void => {
    onSubmit({ kind: 'ask', allowed: true })
  }

  /** 拒绝 — 立即提交 */
  const handleDeny = (): void => {
    onSubmit({ kind: 'ask', allowed: false })
  }

  /** 允许并记住 — 立即提交,后端按 extra.rememberPath 写进会话权限表（给文件夹就记那个文件夹） */
  const handleAllowAndRemember = (folder?: string): void => {
    onSubmit({
      kind: 'ask',
      allowed: true,
      extra: { rememberPath: folder ?? true }
    })
  }

  /** 会话询问的「允许并记住」：后端按 extra.remember 把这条会话（查看 / 对话）写进会话权限表 */
  const handleAllowSessionAndRemember = (): void => {
    onSubmit({ kind: 'ask', allowed: true, extra: { remember: true } })
  }

  // 标题 = 这次要放行的**动作**。非路径类直接取工具自己的显示名，与上方步骤行共用一套词表 ——
  // 「等待确认」对每条命令都一样，占着唯一的标题位却不说这次要做什么。
  const iconClass = 'text-warning flex-shrink-0'
  const { icon, title } = session
    ? session.access === 'write'
      ? {
          icon: <MessagesSquare size={13} className={iconClass} />,
          title: t('toolCall.sessionAskWrite')
        }
      : {
          icon: <Eye size={13} className={iconClass} />,
          title: t('toolCall.sessionAskRead')
        }
    : diffPreview
      ? diffPreview.isNewFile
        ? {
            icon: <FileOutput size={13} className={iconClass} />,
            title: t('toolCall.pendingCreatePreview')
          }
        : toolName === 'edit'
          ? {
              icon: <FilePen size={13} className={iconClass} />,
              title: t('toolCall.pendingEditPreview')
            }
          : {
              icon: <FileOutput size={13} className={iconClass} />,
              title: t('toolCall.pendingWritePreview')
            }
      : pathAsk
        ? pathAsk.mode === 'write'
          ? {
              icon: <FileOutput size={13} className={iconClass} />,
              title: t('toolCall.pendingPathWrite')
            }
          : pathIsDirectory
            ? {
                icon: <FolderOpen size={13} className={iconClass} />,
                title: t('toolCall.pendingPathReadDir')
              }
            : {
                icon: <FileText size={13} className={iconClass} />,
                title: t('toolCall.pendingPathRead')
              }
        : {
            icon: presentation ? (
              <span className={`${iconClass} flex items-center`}>
                {renderToolIcon(presentation)}
              </span>
            ) : (
              <ShieldAlert size={13} className={iconClass} />
            ),
            title: presentation?.label ?? t('toolCall.pendingAsk')
          }

  return (
    <div className="space-y-2">
      {/* 标题行：动作名 + 工具自己的说明（说明只占一行，摊开的原文在预览块里） */}
      <div className="flex items-center gap-1.5 min-w-0">
        {icon}
        <p className="text-xs text-text-primary font-medium whitespace-nowrap">{title}</p>
        <span
          className="flex-1 min-w-0 text-[11px] text-text-secondary truncate"
          title={description}
        >
          {description}
        </span>
        {/* 后台任务标签 —— 与「跑完就完的命令」在视觉上分开：这条批准之后进程会一直活着 */}
        {background && <BackgroundBadge />}
        {unsandboxed && <FullAccessBadge />}
        {titleAccessory}
      </div>

      {/* 审查员看过、交给你的：它那句大白话放在原文上方 —— 读懂一条命令要懂 shell，读懂它不用 */}
      {review && <ReviewOpinion review={review} />}

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

      {/* 操作栏：左端是命中的策略（角标），动作一律靠右 —— 与输入区的发送键同侧 */}
      <div className="flex items-center gap-1.5">
        {policyPrompt && (
          <PolicyPromptChip
            prompt={policyPrompt}
            open={policyOpen}
            onToggle={() => setPolicyOpen(!policyOpen)}
          />
        )}
        <span className="flex-1" />
        <button
          onClick={handleDeny}
          className="px-2.5 py-1 rounded-lg text-xs font-medium text-text-secondary hover:bg-bg-hover transition-colors"
        >
          {t('toolCall.deny')}
        </button>
        {canRememberSession && (
          <button
            onClick={handleAllowSessionAndRemember}
            data-remember-session=""
            className="px-2.5 py-1 rounded-lg border border-border-secondary/60 text-xs font-medium text-text-primary hover:bg-bg-hover transition-colors"
          >
            {t('toolCall.allowAndRememberSession')}
          </button>
        )}
        {canRemember && (
          <div className="flex items-stretch rounded-lg border border-border-secondary/60">
            <button
              onClick={() => handleAllowAndRemember()}
              className={`px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-bg-hover transition-colors ${
                rememberFolder ? 'rounded-l-lg' : 'rounded-lg'
              }`}
            >
              {pathIsDirectory
                ? t('toolCall.allowThisDirectory')
                : t('toolCall.allowAndRememberPath')}
            </button>
            {rememberFolder && (
              <button
                onClick={() => setFolderOpen(!folderOpen)}
                title={t('toolCall.rememberOptions')}
                aria-label={t('toolCall.rememberOptions')}
                aria-expanded={folderOpen}
                data-remember-options=""
                className="px-1 rounded-r-lg border-l border-border-secondary/60 text-text-secondary hover:bg-bg-hover transition-colors"
              >
                <ChevronDown size={12} />
              </button>
            )}
          </div>
        )}
        {/* 目录路径:只显示"允许此目录" + 拒绝 — 目录授权天然持久,不提供单次放行 */}
        {!(pathAsk && pathIsDirectory) && (
          <button
            onClick={handleAllow}
            className="px-3 py-1 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
          >
            {t('toolCall.allow')}
          </button>
        )}
      </div>

      {/* 记下所在的文件夹：点开下拉才出现，路径整条摆出来 —— 授予的范围比这个文件大，得看得见 */}
      {rememberFolder && folderOpen && (
        <div className="flex justify-end">
          <button
            onClick={() => handleAllowAndRemember(rememberFolder)}
            data-remember-folder={rememberFolder}
            className="flex max-w-full items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-text-primary border border-border-secondary/60 hover:bg-bg-hover transition-colors"
          >
            <FolderOpen size={12} className="shrink-0 text-text-tertiary" />
            <span className="shrink-0 font-medium">{t('toolCall.rememberFolder')}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-text-secondary [direction:rtl]">
              <bdi>{rememberFolder}</bdi>
            </span>
          </button>
        </div>
      )}

      {policyPrompt && policyOpen && (
        <p className="text-[11px] leading-snug text-text-secondary whitespace-pre-wrap break-words px-0.5">
          {policyPrompt.text}
        </p>
      )}
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
