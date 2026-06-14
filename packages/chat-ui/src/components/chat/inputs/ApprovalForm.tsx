import { getChatApi } from '@shuvix/chat-ui'
import { FilePen, FileText, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import { useChatStore } from '../../../stores/chatStore'
import type { ApprovalInputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { InputFormProps } from './types'
import type { ApprovalDraft } from './drafts'

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
      {description && (
        <p className="text-[10px] text-text-secondary leading-snug px-0.5">{description}</p>
      )}
      <pre className="text-[11px] leading-snug bg-bg-primary/50 rounded px-2 py-1 overflow-auto max-h-28 whitespace-pre-wrap break-words border border-border-secondary/40 !m-0">
        <code className="hljs language-bash" dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  )
}

/** 路径审批预览:文件路径单独展示,可选 description */
function PathPreview({
  path,
  description
}: {
  path: string
  description?: string
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      {description && (
        <p className="text-[10px] text-text-secondary leading-snug px-0.5">{description}</p>
      )}
      <div className="text-[11px] leading-snug bg-bg-primary/50 rounded px-2 py-1 break-all font-mono text-text-primary border border-border-secondary/40">
        {path}
      </div>
    </div>
  )
}

export function ApprovalForm({
  request,
  draft: _draft,
  onDraftChange: _onDraftChange,
  onSubmit
}: InputFormProps<ApprovalInputRequest, ApprovalDraft>): React.JSX.Element {
  const { t } = useTranslation()
  const { toolName, command, description, pathIsDirectory } = request

  // 命令类(bash/ssh):显示拆解后的多个 patterns(后端拉取);
  // 路径类(read/write/edit/...):显示单元素 [absolutePath];
  // 二者统一渲染为预览块,允许用户在按下"允许并记住"前看到具体将写入 allowList 的内容
  const isCommandApproval = toolName === 'bash' || toolName === 'ssh'
  const isPathApproval = !isCommandApproval
  const canRemember = !!command

  const pathApproval: { mode: 'read' | 'write'; path: string } | null = useMemo(() => {
    if (!isPathApproval) return null
    const m = command.match(/^(Read|Write)\((.+)\)$/)
    if (!m) return null
    return { mode: m[1] === 'Read' ? 'read' : 'write', path: m[2] }
  }, [isPathApproval, command])

  // 待加入 allowList 的模式列表 — 渲染时即懒加载,无 Confirm 中间态
  const [previewPatterns, setPreviewPatterns] = useState<string[] | null>(null)
  const [loadingPatterns, setLoadingPatterns] = useState(false)

  useEffect(() => {
    if (!canRemember) return
    // 路径类:同步派生
    if (isPathApproval && pathApproval) {
      setPreviewPatterns([pathApproval.path])
      return
    }
    // 命令类:异步从后端拉取拆解后的 patterns
    let cancelled = false
    setLoadingPatterns(true)
    void (async () => {
      try {
        const sessionId = useChatStore.getState().activeSessionId || undefined
        const toolType = (toolName === 'ssh' ? 'ssh' : 'bash') as 'bash' | 'ssh'
        const patterns = await getChatApi().session.previewAllowPatterns({
          command,
          sessionId,
          toolType
        })
        if (!cancelled) setPreviewPatterns(patterns)
      } finally {
        if (!cancelled) setLoadingPatterns(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRemember, command, toolName])

  /** 单次允许 — 立即提交,不写 allowList */
  const handleAllow = (): void => {
    onSubmit({ kind: 'approval', approved: true })
  }

  /** 拒绝 — 立即提交 */
  const handleDeny = (): void => {
    onSubmit({ kind: 'approval', approved: false })
  }

  /** 允许并记住 — 立即提交,后端按 extra.rememberPattern 写入 allowList */
  const handleAllowAndRemember = (): void => {
    onSubmit({
      kind: 'approval',
      approved: true,
      extra: { rememberPattern: true }
    })
  }

  // 是否已有可记住的模式(空列表禁用"允许并记住"按钮)
  const hasPatterns = previewPatterns !== null && previewPatterns.length > 0

  return (
    <div className="rounded-md border border-warning/30 bg-warning/5 overflow-hidden">
      {/* 标题 + 主体预览 */}
      <div className="px-2 pt-1.5 pb-1.5 space-y-1">
        <div className="flex items-center gap-1.5">
          {pathApproval ? (
            pathApproval.mode === 'write' ? (
              <FilePen size={11} className="text-warning flex-shrink-0" />
            ) : (
              <FileText size={11} className="text-warning flex-shrink-0" />
            )
          ) : (
            <ShieldAlert size={11} className="text-warning flex-shrink-0" />
          )}
          <p className="text-[11px] text-text-primary font-medium">
            {pathApproval
              ? pathApproval.mode === 'write'
                ? t('toolCall.pendingPathWrite')
                : pathIsDirectory
                  ? t('toolCall.pendingPathReadDir')
                  : t('toolCall.pendingPathRead')
              : t('toolCall.pendingApproval')}
          </p>
        </div>
        {pathApproval ? (
          <PathPreview path={pathApproval.path} description={description} />
        ) : (
          <CommandPreview command={command} description={description} />
        )}
      </div>

      {/* 待记住的模式预览 — 当 canRemember 时始终展示,无中间确认态 */}
      {canRemember && (
        <div className="mx-2 mb-1.5 rounded border border-emerald-500/30 bg-emerald-500/5 p-1.5">
          <p className="text-[10px] text-text-secondary font-medium mb-1">
            {t('toolCall.patternsToAllow')}
          </p>
          {loadingPatterns ? (
            <p className="text-[10px] text-text-tertiary italic">{t('toolCall.loadingPatterns')}</p>
          ) : !hasPatterns ? (
            <p className="text-[10px] text-text-tertiary italic">{t('toolCall.noPatternsLeft')}</p>
          ) : (
            <div className="flex flex-col gap-0.5 max-h-32 overflow-y-auto">
              {previewPatterns!.map((pattern) => (
                <div
                  key={pattern}
                  className="px-1.5 py-0.5 rounded bg-bg-primary/50 border border-border-secondary/40 text-[10px] font-mono text-text-primary break-all whitespace-pre-wrap leading-tight"
                >
                  {pattern}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 操作栏 */}
      <div className="flex items-center gap-1 px-2 py-1 border-t border-border-secondary/40">
        {/* 目录路径:只显示"允许此目录" + Deny — 目录授权天然持久,不提供单次放行 */}
        {!(isPathApproval && pathIsDirectory) && (
          <button
            onClick={handleAllow}
            className="px-2.5 py-0.5 rounded text-[11px] font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            {t('toolCall.allow')}
          </button>
        )}
        {canRemember && (
          <button
            onClick={handleAllowAndRemember}
            disabled={loadingPatterns || !hasPatterns}
            className="px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPathApproval && pathIsDirectory
              ? t('toolCall.allowThisDirectory')
              : t('toolCall.allowAndRemember')}
          </button>
        )}
        <button
          onClick={handleDeny}
          className="px-2.5 py-0.5 rounded text-[11px] font-medium text-text-secondary hover:bg-bg-hover transition-colors"
        >
          {t('toolCall.deny')}
        </button>
      </div>
    </div>
  )
}
