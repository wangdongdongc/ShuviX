/**
 * PendingInputsPanel — 多 tab 待处理输入面板
 *
 * 功能:
 * - 顶部 tab 头展示当前会话所有 pending 请求(命令审批 / 选择题 / SSH 凭证),每个 tab
 *   显示工具名 + 摘要,带"已填"绿点提示
 * - 中间根据当前选中 tab 渲染对应子表单(从 chat/inputs/ 抽出)
 * - 子表单底部内置"其它"输入框:用户对工具预期不认可时,可填一段反馈文本提交,
 *   后端工具收到 `kind: 'other'` 时不执行副作用,把文本作为 tool result 返回 AI
 * - 底部多 tab 操作栏:[一键提交已填]
 * - 草稿 + "其它"文本都持久化到 chatStore,跨 tab/会话切换不丢
 * - 每条请求被解决后,后端广播 input_request_resolved → store 自动移除 pending +
 *   清掉对应 draft 和 other 文本;UI 自动跳到下一条
 *
 * 设计取舍:
 * - 不再提供"取消"按钮(用户主动取消的语义被"其它"取代);
 * - 真正想中止整个 turn 应使用 agent.abort,而非 input 面板
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  MessageCircleQuestion,
  MessageSquare,
  Send,
  ShieldAlert,
  Terminal
} from 'lucide-react'
import { useChatStore, selectPendingInputs } from '../../stores/chatStore'
import type {
  ApprovalInputRequest,
  ChoiceInputRequest,
  InputRequest,
  InputResponse,
  SshCredentialsInputRequest
} from '../../../../shared/types/inputRequest'
import { ApprovalForm } from './inputs/ApprovalForm'
import { ChoiceForm } from './inputs/ChoiceForm'
import { SshCredentialsForm } from './inputs/SshCredentialsForm'
import {
  buildApprovalResponse,
  buildChoiceResponse,
  buildSshCredentialsResponse,
  emptyApprovalDraft,
  emptyChoiceDraft,
  emptySshCredentialsDraft,
  type ApprovalDraft,
  type ChoiceDraft,
  type SshCredentialsDraft
} from './inputs/drafts'

interface PendingInputsPanelProps {
  /**
   * 统一的"用户输入响应"回调。
   * 子表单提交 / 一键批量提交 / 其它反馈都通过它。
   */
  onResponse: (requestId: string, response: InputResponse) => void
}

/** 根据 request.kind 创建一个空白 draft */
function createDraftFor(req: InputRequest): unknown {
  if (req.kind === 'approval') return emptyApprovalDraft()
  if (req.kind === 'choice') return emptyChoiceDraft()
  if (req.kind === 'sshCredentials') return emptySshCredentialsDraft(req.prefill)
  return {}
}

/** 校验某个 request + draft 能否构造出有效 response */
function buildResponseFor(req: InputRequest, draft: unknown): InputResponse | null {
  if (req.kind === 'approval') return buildApprovalResponse(draft as ApprovalDraft)
  if (req.kind === 'choice') return buildChoiceResponse(draft as ChoiceDraft)
  if (req.kind === 'sshCredentials')
    return buildSshCredentialsResponse(draft as SshCredentialsDraft)
  return null
}

/** Tab 头标签 — 显示工具名 + 摘要 */
function tabSummary(req: InputRequest): string {
  if (req.kind === 'approval') return req.command.slice(0, 40) || req.toolName
  if (req.kind === 'choice') return req.question.slice(0, 40)
  if (req.kind === 'sshCredentials')
    return req.prefill?.host ? `${req.prefill.username ?? ''}@${req.prefill.host}` : 'SSH'
  return ''
}

function tabIcon(req: InputRequest): React.JSX.Element {
  if (req.kind === 'approval') return <ShieldAlert size={11} className="text-warning" />
  if (req.kind === 'choice') return <MessageCircleQuestion size={11} className="text-accent/80" />
  if (req.kind === 'sshCredentials') return <Terminal size={11} className="text-accent" />
  return <ShieldAlert size={11} />
}

export function PendingInputsPanel({
  onResponse
}: PendingInputsPanelProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const pendingInputs = useChatStore(selectPendingInputs)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const sessionDrafts = useChatStore((s) =>
    activeSessionId ? s.sessionInputDrafts[activeSessionId] : undefined
  )
  const sessionOthers = useChatStore((s) =>
    activeSessionId ? s.sessionOtherInputs[activeSessionId] : undefined
  )
  const setInputDraft = useChatStore((s) => s.setInputDraft)
  const setOtherInput = useChatStore((s) => s.setOtherInput)

  // 用户主动选中的 tab id(可能为已失效的 id);最终展示的 activeId 由 useMemo 派生
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const activeId = useMemo<string | null>(() => {
    if (pendingInputs.length === 0) return null
    if (selectedId && pendingInputs.some((r) => r.id === selectedId)) return selectedId
    return pendingInputs[0].id
  }, [pendingInputs, selectedId])

  // 为每条 pending 准备 draft(惰性初始化:首次使用时写入 store,避免每次渲染创建新对象)
  useEffect(() => {
    if (!activeSessionId) return
    for (const req of pendingInputs) {
      const existing = sessionDrafts?.[req.id]
      if (existing === undefined) {
        setInputDraft(activeSessionId, req.id, createDraftFor(req))
      }
    }
  }, [activeSessionId, pendingInputs, sessionDrafts, setInputDraft])

  const activeRequest = useMemo(
    () => (activeId ? pendingInputs.find((r) => r.id === activeId) : undefined),
    [activeId, pendingInputs]
  )
  const activeDraft = activeRequest ? sessionDrafts?.[activeRequest.id] : undefined
  const activeOtherText = activeRequest ? (sessionOthers?.[activeRequest.id] ?? '') : ''

  // 哪些 tab 已"填好":主表单 build 通过 OR "其它"输入有内容
  const filledMap = useMemo(() => {
    const map: Record<string, boolean> = {}
    for (const req of pendingInputs) {
      const draft = sessionDrafts?.[req.id]
      const other = sessionOthers?.[req.id]
      const hasOther = !!other && other.trim().length > 0
      const hasMain = draft !== undefined && buildResponseFor(req, draft) !== null
      if (hasMain || hasOther) map[req.id] = true
    }
    return map
  }, [pendingInputs, sessionDrafts, sessionOthers])

  if (pendingInputs.length === 0 || !activeRequest || !activeSessionId) return null

  /** 子表单 onDraftChange — 把改动写回 store */
  const handleDraftChange = (next: unknown): void => {
    setInputDraft(activeSessionId, activeRequest.id, next)
  }

  /** 子表单 onSubmit — 直接转发给父级 */
  const handleSubmit = (response: InputResponse): void => {
    onResponse(activeRequest.id, response)
  }

  /** "其它"文本变化 */
  const handleOtherChange = (text: string): void => {
    setOtherInput(activeSessionId, activeRequest.id, text)
  }

  /** 提交"其它"反馈 */
  const handleSubmitOther = (): void => {
    const text = activeOtherText.trim()
    if (!text) return
    onResponse(activeRequest.id, { kind: 'other', text })
  }

  /** 一键提交所有"已填"的 tab — 优先用主表单 response,若仅"其它"有内容则用 other */
  const handleSubmitAllFilled = (): void => {
    for (const req of pendingInputs) {
      const draft = sessionDrafts?.[req.id]
      const mainResponse = draft !== undefined ? buildResponseFor(req, draft) : null
      if (mainResponse) {
        onResponse(req.id, mainResponse)
        continue
      }
      const otherText = sessionOthers?.[req.id]?.trim() ?? ''
      if (otherText) {
        onResponse(req.id, { kind: 'other', text: otherText })
      }
    }
  }

  const filledCount = Object.values(filledMap).filter(Boolean).length

  return (
    <div className="pointer-events-none absolute bottom-full right-3 z-20 pb-2 flex justify-end">
      <div className="pointer-events-auto w-[360px] max-w-[calc(100vw-1.5rem)] border border-border-secondary/40 bg-bg-secondary/85 backdrop-blur-md shadow-xl rounded-lg overflow-hidden animate-in slide-in-from-right-2 duration-150">
        {/* 顶部 tab 头 — 仅多 pending 时展示 */}
        {pendingInputs.length > 1 && (
          <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-border-secondary/40 overflow-x-auto">
            {pendingInputs.map((req) => {
              const isActive = req.id === activeId
              const isFilled = filledMap[req.id]
              return (
                <button
                  key={req.id}
                  onClick={() => setSelectedId(req.id)}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? 'bg-bg-primary/70 text-text-primary'
                      : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40'
                  }`}
                  title={tabSummary(req)}
                >
                  {tabIcon(req)}
                  <span className="font-mono truncate max-w-[120px]">{tabSummary(req)}</span>
                  {isFilled && (
                    <span className="w-1 h-1 rounded-full bg-emerald-500 flex-shrink-0" />
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* 当前 tab 内容 */}
        <div className="px-2 py-1.5 space-y-1.5">
          {activeRequest.kind === 'approval' && activeDraft !== undefined && (
            <ApprovalForm
              request={activeRequest as ApprovalInputRequest}
              draft={activeDraft as ApprovalDraft}
              onDraftChange={handleDraftChange}
              onSubmit={handleSubmit}
            />
          )}
          {activeRequest.kind === 'choice' && activeDraft !== undefined && (
            <ChoiceForm
              request={activeRequest as ChoiceInputRequest}
              draft={activeDraft as ChoiceDraft}
              onDraftChange={handleDraftChange}
              onSubmit={handleSubmit}
            />
          )}
          {activeRequest.kind === 'sshCredentials' && activeDraft !== undefined && (
            <SshCredentialsForm
              request={activeRequest as SshCredentialsInputRequest}
              draft={activeDraft as SshCredentialsDraft}
              onDraftChange={handleDraftChange}
              onSubmit={handleSubmit}
            />
          )}

          {/* "其它"反馈输入框 — 所有类型共用 */}
          <div className="flex items-center gap-1 rounded-md border border-border-secondary/40 bg-bg-primary/30 px-2 py-1">
            <MessageSquare size={11} className="text-text-tertiary flex-shrink-0" />
            <input
              type="text"
              value={activeOtherText}
              onChange={(e) => handleOtherChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && activeOtherText.trim()) {
                  e.preventDefault()
                  handleSubmitOther()
                }
              }}
              placeholder={t('pendingInputs.otherPlaceholder')}
              className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary/60"
            />
            <button
              onClick={handleSubmitOther}
              disabled={!activeOtherText.trim()}
              className="flex-shrink-0 p-0.5 rounded text-text-tertiary hover:text-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title={t('pendingInputs.submitOther')}
            >
              <Send size={11} />
            </button>
          </div>
        </div>

        {/* 底部多 tab 操作栏 */}
        {pendingInputs.length > 1 && (
          <div className="flex items-center gap-2 px-2 py-1 border-t border-border-secondary/40">
            <span className="text-[10px] text-text-tertiary">
              {t('pendingInputs.filledHint', {
                filled: filledCount,
                total: pendingInputs.length
              })}
            </span>
            <div className="flex-1" />
            <button
              onClick={handleSubmitAllFilled}
              disabled={filledCount === 0}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-accent/15 text-accent hover:bg-accent/25 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Check size={10} />
              {t('pendingInputs.submitAllFilled')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
