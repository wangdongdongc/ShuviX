/**
 * PendingInputsPanel — 输入框卡片的「上半格」：待处理输入
 *
 * 形态:
 * - 不是独立浮窗,而是渲染进输入框卡片内部的第一格(InputArea 的 accessory 插槽),
 *   自身无边框/底色/阴影/圆角,只用一条 border-b 与下方输入区分隔 —— 视觉上是同一张卡片。
 *   语义色交给卡片描边(InputArea 按 kind 换色)与图标;这一格不铺底色。
 * - 审批与选项题同一个形状:问题在上,下面一列占满宽度的选项行(inputs/OptionRows),
 *   桌面上数字键直接选行;触屏档行高 44px。
 * - 多条 pending 时,标题行右端出现 `‹ n/m ›` 步进器 + [一键提交已填];单条时不占任何额外空间。
 *   选中项存在 chatStore(sessionActiveInputId),与输入框共用 —— 输入框据此知道
 *   「其它」反馈该投给哪条请求。
 *
 * 设计取舍:
 * - 没有独立的「其它」输入框:主输入框在有 pending 时就是它(回车/发送投递 `kind: 'other'`),
 *   后端工具收到 other 时不执行副作用,把文本作为 tool result 返回 AI。
 *   代价是「其它」草稿按会话共用一份而非逐条隔离 —— 换掉一整个重复输入位,值。
 * - 不提供"取消"按钮(用户主动取消的语义被"其它"取代);
 *   真正想中止整个 turn 应使用 agent.abort,而非 input 面板。
 */
import { useEffect, useMemo } from 'react'
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
   * 子表单提交 / 一键批量提交都通过它（「其它」反馈由输入框直接投递）。
   */
  onResponse: (requestId: string, response: InputResponse) => void
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
  onResponse
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
  const handleSubmit = (response: InputResponse): void => {
    onResponse(activeRequest.id, response)
  }

  /** 步进器：环形前后切换 */
  const step = (delta: number): void => {
    const next = (activeIndex + delta + pendingInputs.length) % pendingInputs.length
    setActiveInputId(activeSessionId, pendingInputs[next].id)
  }

  /** 一键提交所有"已填"的请求 */
  const handleSubmitAllFilled = (): void => {
    for (const req of pendingInputs) {
      const draft = sessionDrafts?.[req.id]
      const response = draft !== undefined ? buildResponseFor(req, draft) : null
      if (response) onResponse(req.id, response)
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
    // 长选项列表 / 长命令不能把输入区顶出屏幕：上半格自身封顶，表单里只有内容那段滚动 ——
    // 选项行与确认键钉在底部，始终看得见。语义色只在卡片描边上（InputArea），这一格不再铺底色
    <div
      className={`rounded-t-2xl border-b border-border-secondary/40 flex flex-col min-h-0 ${
        touch ? 'max-h-[60vh]' : 'max-h-[50vh]'
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
    </div>
  )
}
