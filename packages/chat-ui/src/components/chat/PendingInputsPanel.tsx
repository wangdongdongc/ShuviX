/**
 * PendingInputsPanel — 待处理输入（审批与选择题）
 *
 * 形态:
 * - 普通会话里在对话流末尾，由 PendingInputsCard 套一张卡片；笔记本的主界面不是对话，仍是输入框卡片内部的第一格
 *   (InputArea 的 accessory 插槽，经 PendingInputsDrawer)，这时只用一条 border-b 与下方输入区分隔。
 *   两处都不铺底色，语义色交给外面的描边与图标。
 * - 审批与选项题同一个形状:问题在上,下面一列占满宽度的选项行(inputs/OptionRows),
 *   桌面上数字键直接选行;触屏档行高 44px。
 * - 多条 pending 时,标题行右端出现 `‹ n/m ›` 步进器 + [一键提交已填];单条时不占任何额外空间。
 *   选中项存在 chatStore(sessionActiveInputId)。
 *
 * 设计取舍:
 * - 「其它」是每张卡片自己的最后一行(inputs/OtherAnswerRow,只写字投 `kind: 'other'`,选项题勾选之外写的话随勾选一起发,草稿逐条隔离),
 *   后端工具收到 other 时不执行副作用,把文本作为 tool result 返回 AI。主输入框只管发消息,有 pending 时也一样。
 * - 不提供"取消"按钮(用户主动取消的语义被"其它"取代);
 *   真正想中止整个 turn 应使用 agent.abort,而非 input 面板。
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { useChatStore, selectPendingInputs, selectActivePendingInput } from '../../stores/chatStore'
import { useChatDensity } from '../../host/chatHostContext'
import type {
  AskInputRequest,
  ChoiceInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import { AskForm } from './inputs/AskForm'
import { ChoiceForm } from './inputs/ChoiceForm'
import { answerErrorText } from './inputs/useAnswerSubmit'
import {
  buildAskResponse,
  buildChoiceResponse,
  emptyAskDraft,
  emptyChoiceDraft,
  type AskDraft,
  type ChoiceDraft
} from './inputs/drafts'

interface PendingInputsPanelProps {
  /**
   * 统一的"用户输入响应"回调。
   * 子表单提交 / 一键批量提交都通过它。返回 Promise 时，投「其它」的那一行会接住失败、把错误显示出来。
   */
  onResponse: (requestId: string, response: InputResponse) => void | Promise<void>
  /** 在哪里：composer = 输入框卡片的顶格（缺省），conversation = 对话流里自成一张卡片 */
  placement?: 'composer' | 'conversation'
}

/** 根据 request.kind 创建一个空白 draft */
function createDraftFor(req: InputRequest): unknown {
  if (req.kind === 'ask') return emptyAskDraft()
  if (req.kind === 'choice') return emptyChoiceDraft()
  return {}
}

/** 校验某个 request + draft 能否构造出有效 response */
function buildResponseFor(req: InputRequest, draft: unknown): InputResponse | null {
  if (req.kind === 'ask') return buildAskResponse(draft as AskDraft)
  if (req.kind === 'choice') return buildChoiceResponse(draft as ChoiceDraft)
  return null
}

export function PendingInputsPanel({
  onResponse,
  placement = 'composer'
}: PendingInputsPanelProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const touch = useChatDensity() === 'touch'
  const pendingInputs = useChatStore(selectPendingInputs)
  const activeRequest = useChatStore(selectActivePendingInput)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const sessionDrafts = useChatStore((s) =>
    activeSessionId ? s.sessionInputDrafts[activeSessionId] : undefined
  )
  const setInputDraft = useChatStore((s) => s.setInputDraft)
  const setActiveInputId = useChatStore((s) => s.setActiveInputId)
  const [batchError, setBatchError] = useState<string | null>(null)

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

  const activeDraft = activeRequest ? sessionDrafts?.[activeRequest.id] : undefined
  const activeIndex = activeRequest ? pendingInputs.findIndex((r) => r.id === activeRequest.id) : -1

  // 哪些 tab 已"填好"(主表单 build 通过)——决定[一键提交已填]是否可用
  const filledCount = useMemo(
    () =>
      pendingInputs.filter((req) => {
        const draft = sessionDrafts?.[req.id]
        return draft !== undefined && buildResponseFor(req, draft) !== null
      }).length,
    [pendingInputs, sessionDrafts]
  )

  if (pendingInputs.length === 0 || !activeRequest || !activeSessionId) return null

  /** 子表单 onDraftChange — 把改动写回 store */
  const handleDraftChange = (next: unknown): void => {
    setInputDraft(activeSessionId, activeRequest.id, next)
  }

  /** 子表单 onSubmit — 直接转发给父级 */
  const handleSubmit = (response: InputResponse): void | Promise<void> =>
    onResponse(activeRequest.id, response)

  /** 步进器：环形前后切换 */
  const step = (delta: number): void => {
    const next = (activeIndex + delta + pendingInputs.length) % pendingInputs.length
    setActiveInputId(activeSessionId, pendingInputs[next].id)
  }

  /** 一键提交所有"已填"的请求 */
  const handleSubmitAllFilled = (): void => {
    setBatchError(null)
    for (const req of pendingInputs) {
      const draft = sessionDrafts?.[req.id]
      const response = draft !== undefined ? buildResponseFor(req, draft) : null
      if (!response) continue
      // 没送到的那条还挂着、草稿也在：说一声，别让它变成没人接的 rejection
      Promise.resolve()
        .then(() => onResponse(req.id, response))
        .catch((err: unknown) => setBatchError(answerErrorText(err, t)))
    }
  }

  // 多条 pending 时的标题行右端：步进器 + 一键提交
  const stepBtn = `rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors ${
    touch ? 'p-1.5' : 'p-0.5'
  }`
  const stepper =
    pendingInputs.length > 1 ? (
      <div className="flex items-center gap-0.5 flex-shrink-0" data-pending-stepper="">
        {filledCount > 0 && (
          <button
            type="button"
            onClick={handleSubmitAllFilled}
            className={`flex items-center gap-1 mr-1 rounded-lg font-medium text-accent hover:bg-accent/10 transition-colors ${
              touch ? 'px-2.5 py-1.5 text-[13px]' : 'px-2 py-0.5 text-[11px]'
            }`}
          >
            <Check size={touch ? 14 : 11} />
            {t('pendingInputs.submitAllFilled')}
          </button>
        )}
        <button
          type="button"
          onClick={() => step(-1)}
          className={stepBtn}
          title={t('pendingInputs.prev')}
          aria-label={t('pendingInputs.prev')}
        >
          <ChevronLeft size={touch ? 16 : 13} />
        </button>
        <span
          className={`text-text-tertiary tabular-nums ${touch ? 'text-[13px]' : 'text-[11px]'}`}
        >
          {activeIndex + 1}/{pendingInputs.length}
        </span>
        <button
          type="button"
          onClick={() => step(1)}
          className={stepBtn}
          title={t('pendingInputs.next')}
          aria-label={t('pendingInputs.next')}
        >
          <ChevronRight size={touch ? 16 : 13} />
        </button>
      </div>
    ) : null

  return (
    // 长选项列表 / 长命令不能把选项顶出屏幕：这一格自身封顶，表单里只有内容那段滚动 ——
    // 选项行与确认键钉在底部，始终看得见。语义色只在外面的描边上，这一格不铺底色
    <div
      className={`flex flex-col min-h-0 ${touch ? 'max-h-[60vh]' : 'max-h-[50vh]'} ${
        placement === 'composer' ? 'rounded-t-2xl border-b border-border-secondary/40' : ''
      }`}
      data-pending-inputs={activeRequest.kind}
    >
      {/* key = 请求 id：步进到另一条时表单是新的一张（策略角标的展开态等不带过去） */}
      {activeRequest.kind === 'ask' && activeDraft !== undefined && (
        <AskForm
          key={activeRequest.id}
          request={activeRequest as AskInputRequest}
          draft={activeDraft as AskDraft}
          onDraftChange={handleDraftChange}
          onSubmit={handleSubmit}
          titleAccessory={stepper}
        />
      )}
      {activeRequest.kind === 'choice' && activeDraft !== undefined && (
        <ChoiceForm
          key={activeRequest.id}
          request={activeRequest as ChoiceInputRequest}
          draft={activeDraft as ChoiceDraft}
          onDraftChange={handleDraftChange}
          onSubmit={handleSubmit}
          titleAccessory={stepper}
        />
      )}
      {batchError && (
        <div
          data-pending-batch-error=""
          className={`flex-shrink-0 text-error break-words ${
            touch ? 'px-4 pb-2 text-xs' : 'px-3.5 pb-1.5 text-[11px]'
          }`}
        >
          {t('input.sendFailed', { error: batchError })}
        </div>
      )}
    </div>
  )
}
