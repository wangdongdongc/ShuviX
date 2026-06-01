import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Folder, Settings2, Archive, PictureInPicture2, Pin, PinOff, X } from 'lucide-react'
import {
  useChatStore,
  selectIsStreaming,
  selectIsCompacting,
  selectCanChat,
  selectCanEdit,
  type ChatMessage,
  type AssistantTextMessage
} from '../../stores/chatStore'
import { useChatActions } from '../../hooks/useChatActions'
import { useBrowserStore } from '../../stores/browserStore'
import { useSidebarStore } from '../../stores/sidebarStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { useSessionMeta } from '../../hooks/useSessionMeta'
import { MessageRenderer, type VisibleItem } from './MessageRenderer'
import { StreamingFooter } from './StreamingFooter'
import { WelcomeView, EmptySessionHint } from './WelcomeView'
import { PendingInputsPanel } from './PendingInputsPanel'
import { InputArea } from './InputArea'
import { StatusBanner } from './StatusBanner'
import { SessionConfigDialog } from './SessionConfigDialog'

/** 判断消息是否为中间步骤/工具项 */
function isStepOrToolMsg(msg: ChatMessage): boolean {
  return (
    msg.type === 'tool_use' ||
    msg.type === 'step_text' ||
    msg.type === 'step_thinking' ||
    msg.type === 'steer'
  )
}

/**
 * 预处理消息列表：将 step/tool 消息合并到后续的 assistant text 消息中
 * 流式时在末尾追加合成占位项，由 AssistantBubble 自行从 store 读取流式状态
 */
function buildVisibleItems(messages: ChatMessage[], isStreaming: boolean): VisibleItem[] {
  const items: VisibleItem[] = []
  const stepBuffer: VisibleItem[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    // 跳过 system_notify（但保留 error_event）
    if (msg.role === 'system_notify' && msg.type !== 'error_event') continue

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

  // 尾部残留 steps
  if (stepBuffer.length > 0) {
    if (isStreaming) {
      // 流式中：将残留 steps 挂载到合成流式占位项
      const sessionId = stepBuffer[0].msg.sessionId
      const syntheticMsg: AssistantTextMessage = {
        id: 'streaming-live',
        sessionId,
        role: 'assistant',
        type: 'text',
        content: '',
        metadata: null,
        model: '',
        createdAt: Date.now()
      }
      items.push({ msg: syntheticMsg, steps: [...stepBuffer], isStreamingPlaceholder: true })
    } else {
      // 非流式：创建 orphan bubble
      const syntheticMsg: AssistantTextMessage = {
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
    }
    stepBuffer.length = 0
  } else if (isStreaming) {
    // 流式中无残留 steps 时也追加空合成项（承载流式 content/thinking/toolCall）
    const lastMsg = messages[messages.length - 1]
    const sessionId = lastMsg?.sessionId || ''
    const syntheticMsg: AssistantTextMessage = {
      id: 'streaming-live',
      sessionId,
      role: 'assistant',
      type: 'text',
      content: '',
      metadata: null,
      model: '',
      createdAt: Date.now()
    }
    items.push({ msg: syntheticMsg, isStreamingPlaceholder: true })
  }

  return items
}

/**
 * 聊天主视图 — 消息列表 + 输入区
 * 使用 react-virtuoso 虚拟滚动，仅渲染可视区域内的消息
 *
 * pinnedMode:
 * - undefined: 默认主窗口形态
 * - 'floating': 在悬浮窗口里渲染，header 精简为标题 + 文件夹 + 关闭 X
 * - 'placeholder': 当前会话已被悬浮，正文替换为占位提示（恢复 / 聚焦悬浮窗）
 */
interface ChatViewProps {
  pinnedMode?: 'floating' | 'placeholder'
}

export function ChatView({ pinnedMode }: ChatViewProps = {}): React.JSX.Element {
  const { messages, activeSessionId, sessions } = useChatStore()
  const isStreaming = useChatStore(selectIsStreaming)
  const isCompacting = useChatStore(selectIsCompacting)
  const canChat = useChatStore(selectCanChat)
  const canEdit = useChatStore(selectCanEdit)
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  const { projectPath } = useSessionMeta()
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const sessionTitle = activeSession?.title || null

  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)
  const [showSessionConfig, setShowSessionConfig] = useState(false)

  // ── 归档消息回溯 ──
  const [archivedCount, setArchivedCount] = useState(0)
  const [archivedItems, setArchivedItems] = useState<VisibleItem[]>([])
  const [archivedOffset, setArchivedOffset] = useState(0)
  const [archivedLoading, setArchivedLoading] = useState(false)
  const hasMoreArchived = archivedOffset < archivedCount
  const toggleBrowser = useBrowserStore((s) => s.toggle)
  const isBrowserOpen = useBrowserStore((s) => s.isOpen)
  const toggleSidebar = useSidebarStore((s) => s.toggle)
  const isSidebarOpen = useSidebarStore((s) => s.isOpen)

  /** 悬浮窗"始终置顶"状态 —— 仅 floating 模式下使用 */
  const [alwaysOnTop, setAlwaysOnTopState] = useState(true)
  useEffect(() => {
    if (pinnedMode !== 'floating' || !activeSessionId) return
    let cancelled = false
    window.api.pinChat.getAlwaysOnTop(activeSessionId).then(({ alwaysOnTop }) => {
      if (!cancelled) setAlwaysOnTopState(alwaysOnTop)
    })
    return () => {
      cancelled = true
    }
  }, [pinnedMode, activeSessionId])
  const handleToggleAlwaysOnTop = useCallback(async () => {
    if (!activeSessionId) return
    const next = !alwaysOnTop
    const { alwaysOnTop: applied } = await window.api.pinChat.setAlwaysOnTop({
      sessionId: activeSessionId,
      value: next
    })
    setAlwaysOnTopState(applied)
  }, [activeSessionId, alwaysOnTop])
  const focusMode = useSettingsStore((s) => s.focusMode)
  /** 专注模式生效条件：开关打开 + 已选中会话 */
  const dim = focusMode && !!activeSessionId

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
    handleInputResponse
  } = useChatActions(activeSessionId)

  // ── 归档消息：会话切换时重置并获取归档数 ──
  useEffect(() => {
    setArchivedItems([])
    setArchivedOffset(0)
    setArchivedCount(0)
    if (!activeSessionId) return
    window.api.message.countArchived(activeSessionId).then((cnt) => setArchivedCount(cnt))
  }, [activeSessionId])

  /** 加载更多归档消息（每次 5 条主消息） */
  const loadMoreArchived = useCallback(async () => {
    if (!activeSessionId || archivedLoading || !hasMoreArchived) return
    setArchivedLoading(true)
    try {
      const batch = await window.api.message.listArchived({
        sessionId: activeSessionId,
        limit: 5,
        offset: archivedOffset
      })
      if (batch.length > 0) {
        const batchItems = buildVisibleItems(batch, false).map((item) => ({
          ...item,
          isArchived: true
        }))
        // 新加载的是更早的消息，需要放在已有归档项之前
        setArchivedItems((prev) => [...batchItems, ...prev])
        setArchivedOffset((prev) => prev + 5)
      }
    } finally {
      setArchivedLoading(false)
    }
  }, [activeSessionId, archivedLoading, hasMoreArchived, archivedOffset])

  // 预构建可见消息列表，messages 不变时复用缓存
  const liveItems = useMemo(() => buildVisibleItems(messages, isStreaming), [messages, isStreaming])
  // 合并：归档项在前，活跃项在后
  const visibleItems = useMemo(
    () => (archivedItems.length > 0 ? [...archivedItems, ...liveItems] : liveItems),
    [archivedItems, liveItems]
  )
  // 仅当最后一条消息是助手文本消息时才允许重新生成
  const lastAssistantTextId = useMemo(() => {
    const last = messages[messages.length - 1]
    return last?.role === 'assistant' && last?.type === 'text' ? last.id : null
  }, [messages])

  /** 渲染单条可见消息 */
  const renderItem = useCallback(
    (_index: number, item: VisibleItem) => {
      if (item.isArchived) {
        return (
          <div className="opacity-45">
            <MessageRenderer
              item={item}
              lastAssistantTextId={null}
              onRollback={undefined}
              onRegenerate={undefined}
            />
          </div>
        )
      }
      return (
        <MessageRenderer
          item={item}
          lastAssistantTextId={lastAssistantTextId}
          onRollback={canEdit ? handleRollback : undefined}
          onRegenerate={canEdit ? handleRegenerate : undefined}
        />
      )
    },
    [lastAssistantTextId, handleRollback, handleRegenerate, canEdit]
  )

  /** Virtuoso Header：归档消息横幅 */
  const ArchivedBanner = useMemo(() => {
    if (archivedCount === 0) return undefined
    return function ArchivedBannerHeader() {
      if (!hasMoreArchived && archivedItems.length === 0) return null
      return (
        <button
          onClick={loadMoreArchived}
          disabled={archivedLoading || !hasMoreArchived}
          className="w-full flex items-center justify-center gap-2 py-2 px-4 text-xs text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 transition-colors border-b border-border-secondary/40 disabled:opacity-50"
        >
          <Archive size={13} />
          {archivedLoading ? (
            <span>{t('compact.archivedLoading')}</span>
          ) : hasMoreArchived ? (
            <span>{t('compact.archivedBanner', { count: archivedCount - archivedOffset })}</span>
          ) : (
            <span>{t('compact.archivedAllLoaded')}</span>
          )}
        </button>
      )
    }
  }, [
    archivedCount,
    archivedOffset,
    archivedLoading,
    hasMoreArchived,
    archivedItems.length,
    loadMoreArchived,
    t
  ])

  return (
    <div className="relative flex flex-col h-full">
      {/* 窗口拖拽区 + 会话标题栏（单行布局） */}
      <div
        className={`titlebar-drag flex-shrink-0 flex items-center px-2 transition-opacity duration-200 ${window.api.app.platform === 'darwin' ? 'h-10' : 'h-8'} ${dim ? 'opacity-30 hover:opacity-100' : ''}`}
      >
        {/* 左侧：会话名 + 会话设置 + 工作目录（容器不加 no-drag，剩余空间可拖动） */}
        <div className="flex items-center gap-0.5 min-w-0 flex-1">
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
                className="titlebar-no-drag bg-transparent text-xs font-medium text-text-primary outline-none border-b border-accent/50 px-2 py-0.5 min-w-0 flex-shrink"
                autoFocus
              />
            ) : window.api.app.platform !== 'web' ? (
              <button
                onClick={startEditTitle}
                className="titlebar-no-drag text-xs font-medium text-text-secondary hover:text-text-primary transition-colors px-2 py-0.5 rounded-md hover:bg-bg-hover/50 truncate min-w-0"
                title={t('common.clickToEdit')}
              >
                {sessionTitle}
              </button>
            ) : (
              <span className="text-xs font-medium text-text-secondary px-2 py-0.5 truncate min-w-0">
                {sessionTitle}
              </span>
            ))}
          {sessionTitle && window.api.app.platform !== 'web' && (
            <button
              onClick={() => setShowSessionConfig(true)}
              className="titlebar-no-drag p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors flex-shrink-0"
              title={t('sessionConfig.title')}
            >
              <Settings2 size={12} />
            </button>
          )}
          {projectPath && (
            <button
              onClick={() => window.api.app.openFolder(projectPath)}
              className="titlebar-no-drag p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors flex-shrink-0"
              title={projectPath}
            >
              <Folder size={12} />
            </button>
          )}
        </div>

        {/* 右侧：按模式渲染不同按钮簇 */}
        <div className="titlebar-no-drag flex items-center gap-0.5 flex-shrink-0">
          {pinnedMode === 'floating' ? (
            <>
              <button
                onClick={handleToggleAlwaysOnTop}
                className={`p-1 rounded-md transition-colors ${
                  alwaysOnTop
                    ? 'text-accent hover:text-accent hover:bg-accent/10'
                    : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50'
                }`}
                title={
                  alwaysOnTop ? t('pinChat.disableAlwaysOnTop') : t('pinChat.enableAlwaysOnTop')
                }
              >
                {alwaysOnTop ? <Pin size={14} /> : <PinOff size={14} />}
              </button>
              <button
                onClick={toggleBrowser}
                className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
                title={t('panel.files')}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M15 3v18" />
                  {isBrowserOpen && (
                    <rect
                      x="15"
                      y="3"
                      width="6"
                      height="18"
                      rx="2"
                      fill="currentColor"
                      stroke="none"
                    />
                  )}
                </svg>
              </button>
              <button
                onClick={() => activeSessionId && void window.api.pinChat.unpin(activeSessionId)}
                className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
                title={t('pinChat.unpin')}
              >
                <X size={14} />
              </button>
            </>
          ) : (
            <>
              {pinnedMode !== 'placeholder' && activeSessionId && (
                <button
                  onClick={() => void window.api.pinChat.pin(activeSessionId)}
                  className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
                  title={t('pinChat.pin')}
                >
                  <PictureInPicture2 size={14} />
                </button>
              )}
              {window.api?.app?.platform !== 'web' && (
                <button
                  onClick={toggleSidebar}
                  className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect width="18" height="18" x="3" y="3" rx="2" />
                    <path d="M9 3v18" />
                    {isSidebarOpen && (
                      <rect
                        x="3"
                        y="3"
                        width="6"
                        height="18"
                        rx="2"
                        fill="currentColor"
                        stroke="none"
                      />
                    )}
                  </svg>
                </button>
              )}
              <button
                onClick={toggleBrowser}
                className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M15 3v18" />
                  {isBrowserOpen && (
                    <rect
                      x="15"
                      y="3"
                      width="6"
                      height="18"
                      rx="2"
                      fill="currentColor"
                      stroke="none"
                    />
                  )}
                </svg>
              </button>
            </>
          )}
        </div>
      </div>

      {activeSessionId && pinnedMode !== 'placeholder' && (
        <StatusBanner sessionId={activeSessionId} />
      )}

      {pinnedMode === 'placeholder' ? (
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="flex flex-col items-center gap-4 text-center max-w-sm">
            <PictureInPicture2 size={36} className="text-text-tertiary/60" />
            <div className="text-sm text-text-secondary">{t('pinChat.placeholderTitle')}</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => activeSessionId && void window.api.pinChat.focus(activeSessionId)}
                className="px-3 py-1.5 text-xs rounded-md bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
              >
                {t('pinChat.focusFloating')}
              </button>
              <button
                onClick={() => activeSessionId && void window.api.pinChat.unpin(activeSessionId)}
                className="px-3 py-1.5 text-xs rounded-md bg-bg-hover/60 text-text-secondary hover:bg-bg-hover transition-colors"
              >
                {t('pinChat.restoreHere')}
              </button>
            </div>
          </div>
        </div>
      ) : !activeSessionId ? (
        <WelcomeView />
      ) : (
        <>
          {/* 压缩中冻结遮罩 */}
          {isCompacting && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-bg-primary/80 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-3">
                <div className="animate-spin h-6 w-6 border-2 border-accent border-t-transparent rounded-full" />
                <span className="text-sm text-text-secondary">{t('compact.compressing')}</span>
              </div>
            </div>
          )}
          {messages.length === 0 && !isStreaming ? (
            <EmptySessionHint sessionId={activeSessionId!} />
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              className="flex-1"
              data={visibleItems}
              itemContent={renderItem}
              components={{
                Footer: StreamingFooter,
                ...(ArchivedBanner ? { Header: ArchivedBanner } : {})
              }}
              initialTopMostItemIndex={visibleItems.length - 1}
              key={activeSessionId}
              increaseViewportBy={{ top: 200, bottom: 400 }}
              computeItemKey={(_index, item) => item.msg.id}
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
          {/* 输入区 + 待处理用户输入悬浮面板 — readonly 隐藏 */}
          {canChat && (
            <div
              className={`relative transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100 focus-within:opacity-100' : ''}`}
            >
              <PendingInputsPanel onResponse={handleInputResponse} />
              <InputArea />
            </div>
          )}
        </>
      )}

      {/* 会话配置弹窗（WebUI 中不显示） */}
      {window.api.app.platform !== 'web' && showSessionConfig && activeSessionId && (
        <SessionConfigDialog
          sessionId={activeSessionId}
          onClose={() => setShowSessionConfig(false)}
        />
      )}
    </div>
  )
}
