import { getHostApi } from '@shuvix/chat-ui'
import { FilePen, FileText, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useMemo } from 'react'
import { BackgroundBadge } from '../BgTaskTag'
import { useTranslation } from 'react-i18next'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import type { AskInputRequest, AskPolicyPrompt } from '@shuvix/chat-protocol/types/inputRequest'
import type { InputFormProps } from './types'
import type { AskDraft } from './drafts'
import { DiffViewer } from '../DiffViewer'
import { ASK_PREVIEW_MAX_H } from '../detailViewport'

hljs.registerLanguage('bash', bash)

function CommandPreview({
  command,
  description
}: {
  command: string
  description?: string
}): React.JSX.Element {
  const highlighted = useMemo(() => {
    if (!command) return ''
    try {
      return hljs.highlight(command, { language: 'bash' }).value
    } catch {
      return command.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  }, [command])

  return (
    <div className="space-y-1">
      {description && <p className="text-xs text-text-secondary leading-snug">{description}</p>}
      <pre className="text-[11px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 overflow-auto max-h-28 whitespace-pre-wrap break-words !m-0">
        <code className="hljs language-bash" dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  )
}

/** 路径询问预览:文件路径单独展示,可选 description */
function PathPreview({
  path,
  description
}: {
  path: string
  description?: string
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      {description && <p className="text-xs text-text-secondary leading-snug">{description}</p>}
      <div className="text-[11px] leading-snug bg-bg-secondary/70 rounded-lg px-2.5 py-1.5 break-all font-mono text-text-primary">
        {path}
      </div>
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
  diff,
  description
}: {
  path: string
  diff: string
  description?: string
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      {description && <p className="text-xs text-text-secondary leading-snug">{description}</p>}
      <div className="text-[11px] leading-snug break-all font-mono text-text-secondary px-0.5">
        {path}
      </div>
      <DiffViewer diff={diff} maxHeight={ASK_PREVIEW_MAX_H} />
    </div>
  )
}

/**
 * 命中策略的提示语 —— 与工具自己的 description 分开呈现并署名到策略上，
 * 用户才知道这句话是谁说的、该去改哪份策略（policyPrompt 只在询问场景出现）。
 *
 * 散排一段，不套边框/底色：外层询问本身就是一张卡片，再嵌一层框就是卡片套卡片。
 */
function PolicyPromptNote({ prompt }: { prompt: AskPolicyPrompt }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-1.5 px-0.5">
      <ShieldCheck size={12} className="mt-[2px] shrink-0 text-text-tertiary" />
      <div className="min-w-0">
        <p className="text-[11px] leading-snug text-text-secondary whitespace-pre-wrap break-words">
          {prompt.text}
        </p>
        {prompt.policies.length > 0 && (
          <p className="text-[10px] leading-snug text-text-tertiary">
            {t('toolCall.policyPromptFrom', { policies: prompt.policies.join(' · ') })}
          </p>
        )}
      </div>
    </div>
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
  const { command, description, pathIsDirectory, policyPrompt, preview, toolName, background } =
    request
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

  return (
    <div className="space-y-2">
      {/* 标题行 */}
      <div className="flex items-center gap-1.5">
        {pathAsk ? (
          pathAsk.mode === 'write' ? (
            <FilePen size={13} className="text-warning flex-shrink-0" />
          ) : (
            <FileText size={13} className="text-warning flex-shrink-0" />
          )
        ) : (
          <ShieldAlert size={13} className="text-warning flex-shrink-0" />
        )}
        <p className="text-xs text-text-primary font-medium">
          {diffPreview
            ? diffPreview.isNewFile
              ? t('toolCall.pendingCreatePreview')
              : toolName === 'edit'
                ? t('toolCall.pendingEditPreview')
                : t('toolCall.pendingWritePreview')
            : pathAsk
              ? pathAsk.mode === 'write'
                ? t('toolCall.pendingPathWrite')
                : pathIsDirectory
                  ? t('toolCall.pendingPathReadDir')
                  : t('toolCall.pendingPathRead')
              : t('toolCall.pendingAsk')}
        </p>
        {/* 后台任务标签 —— 与「跑完就完的命令」在视觉上分开：这条批准之后进程会一直活着 */}
        {background && <BackgroundBadge />}
        <span className="flex-1" />
        {titleAccessory}
      </div>

      {diffPreview ? (
        <DiffPreview path={diffPreview.path} diff={diffPreview.diff} description={description} />
      ) : pathAsk ? (
        <PathPreview path={pathAsk.path} description={description} />
      ) : (
        <CommandPreview command={command} description={description} />
      )}

      {policyPrompt && <PolicyPromptNote prompt={policyPrompt} />}

      {/* 操作栏 */}
      <div className="flex items-center gap-1.5">
        {/* 目录路径:只显示"允许此目录" + Deny — 目录授权天然持久,不提供单次放行 */}
        {!(pathAsk && pathIsDirectory) && (
          <button
            onClick={handleAllow}
            className="px-3 py-1 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
          >
            {t('toolCall.allow')}
          </button>
        )}
        {canRemember && (
          <button
            onClick={handleAllowAndRemember}
            className="px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
          >
            {pathIsDirectory
              ? t('toolCall.allowThisDirectory')
              : t('toolCall.allowAndRememberPath')}
          </button>
        )}
        <button
          onClick={handleDeny}
          className="px-2.5 py-1 rounded-lg text-xs font-medium text-text-secondary hover:bg-bg-hover transition-colors"
        >
          {t('toolCall.deny')}
        </button>
      </div>
    </div>
  )
}
