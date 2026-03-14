import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Copy, Folder, Settings2 } from 'lucide-react'
import {
  useChatStore,
  selectStreamingContent,
  selectStreamingThinking,
  selectStreamingImages,
  selectIsStreaming,
  selectCanChat,
  selectCanEdit,
  type ChatMessage,
  type AssistantTextMessage
} from '../../stores/chatStore'
import { useChatActions } from '../../hooks/useChatActions'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { useSessionMeta } from '../../hooks/useSessionMeta'
import { MessageRenderer, type VisibleItem } from './MessageRenderer'
import { StreamingFooter } from './StreamingFooter'
import { WelcomeView, EmptySessionHint } from './WelcomeView'
import { ProjectCreateDialog } from '../sidebar/ProjectCreateDialog'
import { UserActionPanel } from './UserActionPanel'
import { InputArea } from './InputArea'
import { StatusBanner } from './StatusBanner'
import { SessionConfigDialog } from './SessionConfigDialog'

/** 判断消息是否为中间步骤/工具项 */
function isStepOrToolMsg(msg: ChatMessage): boolean {
  return msg.type === 'tool_use' || msg.type === 'step_text' || msg.type === 'step_thinking'
}

/**
 * 预处理消息列表：将 step/tool 消息合并到后续的 assistant text 消息中
 * @param isStreaming 当前是否正在流式生成（流式中的 steps 不进入 items，由 StreamingFooter 展示）
 */
function buildVisibleItems(messages: ChatMessage[], isStreaming: boolean): VisibleItem[] {
  const items: VisibleItem[] = []
  const stepBuffer: VisibleItem[] = []

  // 流式中：找到最后一个 user text 消息的索引，之后的 step/tool 不加入 items
  let streamCutoff = -1
  if (isStreaming) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && messages[i].type === 'text') {
        streamCutoff = i
        break
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    // 跳过 system_notify（但保留 error_event）
    if (msg.role === 'system_notify' && msg.type !== 'error_event') continue

    // 流式中：最后一个 user text 之后的 step/tool 消息跳过（由 StreamingFooter 展示）
    if (isStreaming && streamCutoff >= 0 && i > streamCutoff && isStepOrToolMsg(msg)) continue

    // step/tool 消息 → 收集到 buffer
    if (isStepOrToolMsg(msg)) {
      stepBuffer.push({ msg })
      continue
    }

    // 非 step/tool 消息：先 flush buffer
    if (msg.role === 'assistant' && msg.type === 'text') {
      // assistant text → 将 buffer 中的 steps 附加到这条消息
      items.push({ msg, steps: stepBuffer.length > 0 ? [...stepBuffer] : undefined })
      stepBuffer.length = 0
      continue
    }

    // user text / error_event 等
    // 如果有未消费的 steps（如 agent 中断），先创建一个空 assistant bubble 承载它们
    if (stepBuffer.length > 0) {
      const syntheticMsg: AssistantTextMessage = {
        id: `orphan-${stepBuffer[0].msg.id}`,
        sessionId: msg.sessionId,
        role: 'assistant',
        type: 'text',
        content: '',
        metadata: null,
        model: stepBuffer[0].msg.model || '',
        createdAt: stepBuffer[0].msg.createdAt
      }
      items.push({ msg: syntheticMsg, steps: [...stepBuffer] })
      stepBuffer.length = 0
    }
    items.push({ msg })
  }

  // 尾部残留 steps（非流式场景下 agent 中断）
  if (stepBuffer.length > 0 && !isStreaming) {
    const syntheticMsg: ChatMessage = {
      id: `orphan-${stepBuffer[0].msg.id}`,
      sessionId: stepBuffer[0].msg.sessionId,
      role: 'assistant',
      type: 'text',
      content: '',
      metadata: null,
      model: stepBuffer[0].msg.model || '',
      createdAt: stepBuffer[0].msg.createdAt
    }
    items.push({ msg: syntheticMsg, steps: [...stepBuffer] })
    stepBuffer.length = 0
  }

  return items
}

/**
 * 提取流式中的 steps（最后一个 user text 之后的 step/tool 消息）
 * 这些 steps 在 StreamingFooter 的气泡中渲染
 */
function extractStreamingSteps(messages: ChatMessage[]): VisibleItem[] {
  // 找到最后一个 user text 消息
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].type === 'text') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return []

  const steps: VisibleItem[] = []
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (isStepOrToolMsg(msg)) steps.push({ msg })
  }
  return steps
}

/**
 * 聊天主视图 — 消息列表 + 输入区
 * 使用 react-virtuoso 虚拟滚动，仅渲染可视区域内的消息
 */
export function ChatView(): React.JSX.Element {
  const { messages, activeSessionId, sessions } = useChatStore()
  const streamingContent = useChatStore(selectStreamingContent)
  const streamingThinking = useChatStore(selectStreamingThinking)
  const streamingImages = useChatStore(selectStreamingImages)
  const isStreaming = useChatStore(selectIsStreaming)
  const canChat = useChatStore(selectCanChat)
  const canEdit = useChatStore(selectCanEdit)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const atBottomRef = useRef(true)
  const scrollRafRef = useRef<number>(0)

  const { projectPath } = useSessionMeta()
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const sessionTitle = activeSession?.title || null

  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [showSessionConfig, setShowSessionConfig] = useState(false)

  /** 开始编辑会话标题 */
  const startEditTitle = (): void => {
    if (!sessionTitle || !activeSessionId) return
    setDraftTitle(sessionTitle)
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.select(), 0)
  }

  /** 提交会话标题修改 */
  const commitEditTitle = async (): Promise<void> => {
    setEditingTitle(false)
    const trimmed = draftTitle.trim()
    if (!trimmed || !activeSessionId || trimmed === sessionTitle) return
    await window.api.session.updateTitle({ id: activeSessionId, title: trimmed })
    useChatStore.getState().updateSessionTitle(activeSessionId, trimmed)
  }
  const { t } = useTranslation()
  const {
    handleRollback,
    pendingRollbackId,
    confirmRollback,
    cancelRollback,
    handleRegenerate,
    handleToolApproval,
    handleAllowAndRemember,
    handleUserInput,
    handleSshCredentials,
    handleUserActionOverride,
    handleNewChat
  } = useChatActions(activeSessionId)

  // 跟踪用户是否在底部附近
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom
  }, [])

  // 预构建可见消息列表，messages 不变时复用缓存
  const visibleItems = useMemo(
    () => buildVisibleItems(messages, isStreaming),
    [messages, isStreaming]
  )
  const streamingSteps = useMemo(
    () => (isStreaming ? extractStreamingSteps(messages) : []),
    [isStreaming, messages]
  )

  // 流式内容 / 新消息更新时，若用户在底部则自动滚动
  // 使用 rAF 合并同帧内多次更新，behavior:'auto' 避免 smooth 动画重叠抖动
  useEffect(() => {
    if (!atBottomRef.current || !virtuosoRef.current) return
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
      scrollRafRef.current = 0
    })
  }, [streamingContent, streamingThinking, streamingImages, messages])

  // 组件卸载时清理 rAF
  useEffect(() => {
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
    }
  }, [])

  // 仅当最后一条消息是助手文本消息时才允许重新生成
  const lastAssistantTextId = useMemo(() => {
    const last = messages[messages.length - 1]
    return last?.role === 'assistant' && last?.type === 'text' ? last.id : null
  }, [messages])

  /** 渲染单条可见消息 */
  const renderItem = useCallback(
    (_index: number, item: VisibleItem) => (
      <MessageRenderer
        item={item}
        lastAssistantTextId={lastAssistantTextId}
        onRollback={canEdit ? handleRollback : undefined}
        onRegenerate={canEdit ? handleRegenerate : undefined}
      />
    ),
    [messages, lastAssistantTextId, handleRollback, handleRegenerate, canEdit]
  )

  return (
    <div className="flex flex-col h-full">
      {/* 窗口拖拽区 + 会话标题 / 工作目录（macOS 为交通灯留出顶部空间） */}
      <div
        className={`titlebar-drag flex-shrink-0 flex flex-col items-center justify-end pb-1 ${window.api.app.platform === 'darwin' ? 'min-h-12' : 'min-h-8'}`}
      >
        {sessionTitle &&
          (editingTitle && window.api.app.platform !== 'web' ? (
            <input
              ref={titleInputRef}
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={() => void commitEditTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitEditTitle()
                if (e.key === 'Escape') setEditingTitle(false)
              }}
              className="titlebar-no-drag bg-transparent text-center text-xs font-medium text-text-primary outline-none border-b border-accent/50 px-2 py-0.5 max-w-[60%]"
              autoFocus
            />
          ) : (
            <div className="titlebar-no-drag flex items-center gap-0.5 max-w-[70%]">
              {window.api.app.platform !== 'web' ? (
                <button
                  onClick={startEditTitle}
                  className="text-xs font-medium text-text-secondary hover:text-text-primary transition-colors px-2 py-0.5 rounded-md hover:bg-bg-hover/50 truncate"
                  title={t('common.clickToEdit')}
                >
                  {sessionTitle}
                </button>
              ) : (
                <span className="text-xs font-medium text-text-secondary px-2 py-0.5 truncate">
                  {sessionTitle}
                </span>
              )}
              {window.api.app.platform !== 'web' && (
                <button
                  onClick={() => setShowSessionConfig(true)}
                  className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors flex-shrink-0"
                  title={t('sessionConfig.title')}
                >
                  <Settings2 size={12} />
                </button>
              )}
            </div>
          ))}
        {projectPath && (
          <div className="titlebar-no-drag flex items-center gap-0.5 max-w-[60%]">
            <button
              onClick={() => window.api.app.openFolder(projectPath)}
              className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors cursor-pointer min-w-0"
              title={projectPath}
            >
              <Folder size={10} className="flex-shrink-0 text-text-tertiary/70" />
              <span className="truncate">{projectPath}</span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                navigator.clipboard.writeText(projectPath)
              }}
              className="flex-shrink-0 p-0.5 rounded hover:bg-bg-hover/50 text-text-tertiary/50 hover:text-text-secondary transition-colors"
              title={t('common.copy')}
            >
              <Copy size={10} />
            </button>
          </div>
        )}
      </div>

      {activeSessionId && <StatusBanner sessionId={activeSessionId} />}

      {!activeSessionId ? (
        <WelcomeView onNewChat={handleNewChat} onCreateProject={() => setShowCreateProject(true)} />
      ) : (
        <>
          {messages.length === 0 && !isStreaming ? (
            <EmptySessionHint />
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              className="flex-1"
              data={visibleItems}
              itemContent={renderItem}
              context={{ streamingSteps }}
              components={{ Footer: StreamingFooter }}
              followOutput="auto"
              initialTopMostItemIndex={visibleItems.length - 1}
              key={activeSessionId}
              increaseViewportBy={200}
              computeItemKey={(_index, item) => item.msg.id}
              atBottomStateChange={handleAtBottomChange}
              atBottomThreshold={300}
            />
          )}

          {/* 回退确认弹窗 */}
          {pendingRollbackId && (
            <ConfirmDialog
              title={t('chat.rollbackConfirm')}
              description={t('chat.rollbackWarning')}
              confirmText={t('common.confirm')}
              cancelText={t('common.cancel')}
              onConfirm={confirmRollback}
              onCancel={cancelRollback}
            />
          )}
          {/* 用户操作浮动面板（ask 提问 / bash 审批 / SSH 凭据）— readonly 隐藏 */}
          {canChat && (
            <UserActionPanel
              onUserInput={handleUserInput}
              onApproval={handleToolApproval}
              onAllowAndRemember={handleAllowAndRemember}
              onSshCredentials={handleSshCredentials}
            />
          )}
          {/* 输入区 — readonly 隐藏 */}
          {canChat && <InputArea onUserActionOverride={handleUserActionOverride} />}
        </>
      )}

      {/* 会话配置弹窗（WebUI 中不显示） */}
      {window.api.app.platform !== 'web' && showSessionConfig && activeSessionId && (
        <SessionConfigDialog
          sessionId={activeSessionId}
          onClose={() => setShowSessionConfig(false)}
        />
      )}

      {/* 新建项目弹窗（欢迎页触发） */}
      {showCreateProject && (
        <ProjectCreateDialog
          onClose={() => setShowCreateProject(false)}
          onCreated={async (projectId) => {
            setShowCreateProject(false)
            // 在新项目下创建一个会话并激活
            const session = await window.api.session.create(projectId)
            const allSessions = await window.api.session.list()
            useChatStore.getState().setSessions(allSessions)
            useChatStore.getState().setActiveSessionId(session.id)
          }}
        />
      )}
    </div>
  )
}
