import { getHostApi } from '@shuvix/chat-ui'
import { FileOutput, FilePen, FileText, FolderOpen, Shield, ShieldAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { BackgroundBadge } from '../BgTaskTag'
import { renderToolIcon } from '../ToolCallBlock'
import { useChatStore } from '../../../stores/chatStore'
import { useTranslation } from 'react-i18next'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import type { AskInputRequest, AskPolicyPrompt } from '@shuvix/chat-protocol/types/inputRequest'
import { fallbackToolPresentation } from '@shuvix/chat-protocol/builtinMcpPresentations'
import type { InputFormProps } from './types'
import type { AskDraft } from './drafts'
import { DiffViewer } from '../DiffViewer'
import { ASK_PREVIEW_MAX_H } from '../detailViewport'

hljs.registerLanguage('bash', bash)

function CommandPreview({ command }: { command: string }): React.JSX.Element {
  const highlighted = useMemo(() => {
    if (!command) return ''
    try {
      return hljs.highlight(command, { language: 'bash' }).value
    } catch {
      return command.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  }, [command])

  return (
    <pre className="text-[11px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 overflow-auto max-h-28 whitespace-pre-wrap break-words !m-0">
      <code className="hljs language-bash" dangerouslySetInnerHTML={{ __html: highlighted }} />
    </pre>
  )
}

/** 路径询问预览：待放行的那条路径 */
function PathPreview({ path }: { path: string }): React.JSX.Element {
  return (
    <div className="text-[11px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 break-all font-mono text-text-primary">
      {path}
    </div>
  )
}

/**
 * 预览询问：路径一行 + 即将发生的改动。
 *
 * 这里的 diff 与工具执行后步骤块里那份是同一个字符串（后端算一次两处共用），
 * 所以用的也必须是同一个 DiffViewer —— 换渲染器就等于给"所见即所批"开了个口子。
 */
function DiffPreview({ path, diff }: { path: string; diff: string }): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="text-[11px] leading-snug break-all font-mono text-text-secondary px-0.5">
        {path}
      </div>
      <DiffViewer diff={diff} maxHeight={ASK_PREVIEW_MAX_H} />
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
  const { command, description, pathIsDirectory, policyPrompt, preview, toolName, background } =
    request
  const hostPresentation = useChatStore((s) => s.toolPresentations[toolName])
  // 内置 MCP 能力服务器发起的询问（browser 打开一个地址、读一个本地文件；ssh 执行一条命令）
  // 也要有工具名与图标 —— 宿主下发的表里没有它们
  const presentation = hostPresentation ?? fallbackToolPresentation(toolName, t)
  const diffPreview = preview?.kind === 'diff' ? preview : null

  // 路径类(read/write/edit/...):command 形如 Read(path)/Write(path),可"允许并记住"整条路径。
  // 命令类(bash/ssh)与简单类(浏览器操作等):不入 allowList —— 命令逐条询问,
  //   免询问只能由会话级 autoAllow 开关整体打开(不再有命令模式记忆)。
  const pathAsk: { mode: 'read' | 'write'; path: string } | null = useMemo(() => {
    const m = command.match(/^(Read|Write)\((.+)\)$/)
    if (!m) return null
    return { mode: m[1] === 'Read' ? 'read' : 'write', path: m[2] }
  }, [command])

  // 「记住/始终允许」会持久化 allowList（宿主能力）：仅路径类,且需宿主提供 HostApi
  const canRemember = pathAsk !== null && getHostApi() !== null

  /** 单次允许 — 立即提交,不写 allowList */
  const handleAllow = (): void => {
    onSubmit({ kind: 'ask', allowed: true })
  }

  /** 拒绝 — 立即提交 */
  const handleDeny = (): void => {
    onSubmit({ kind: 'ask', allowed: false })
  }

  /** 允许并记住 — 立即提交,后端按 extra.rememberPath 写入 allowList */
  const handleAllowAndRemember = (): void => {
    onSubmit({
      kind: 'ask',
      allowed: true,
      extra: { rememberPath: true }
    })
  }

  // 标题 = 这次要放行的**动作**。非路径类直接取工具自己的显示名，与上方步骤行共用一套词表 ——
  // 「等待确认」对每条命令都一样，占着唯一的标题位却不说这次要做什么。
  const iconClass = 'text-warning flex-shrink-0'
  const { icon, title } = diffPreview
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
            <span className={`${iconClass} flex items-center`}>{renderToolIcon(presentation)}</span>
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
        {titleAccessory}
      </div>

      {diffPreview ? (
        <DiffPreview path={diffPreview.path} diff={diffPreview.diff} />
      ) : pathAsk ? (
        <PathPreview path={pathAsk.path} />
      ) : (
        <CommandPreview command={command} />
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
        {canRemember && (
          <button
            onClick={handleAllowAndRemember}
            className="px-2.5 py-1 rounded-lg text-xs font-medium text-text-primary border border-border-secondary/60 hover:bg-bg-hover transition-colors"
          >
            {pathIsDirectory
              ? t('toolCall.allowThisDirectory')
              : t('toolCall.allowAndRememberPath')}
          </button>
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

      {policyPrompt && policyOpen && (
        <p className="text-[11px] leading-snug text-text-secondary whitespace-pre-wrap break-words px-0.5">
          {policyPrompt.text}
        </p>
      )}
    </div>
  )
}
