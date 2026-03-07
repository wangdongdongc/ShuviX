import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Copy, Folder, Globe, Settings2, Trash2, TriangleAlert, X } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import {
  useChatStore,
  selectStreamingContent,
  selectStreamingThinking,
  selectStreamingImages,
  selectIsStreaming,
  selectCanChat,
  selectCanEdit,
  type ChatMessage,
  type AssistantTextMessage,
  type ShareMode
} from '../../stores/chatStore'
import { useDialogClose } from '../../hooks/useDialogClose'
import { useSettingsStore } from '../../stores/settingsStore'
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

/** 判断消息是否为中间步骤/工具项 */
function isStepOrToolMsg(msg: ChatMessage): boolean {
  return msg.type === 'tool_use' || msg.type === 'step_text' || msg.type === 'step_thinking'
}

/**
 * 预处理消息列表：将 step/tool 消息合并到后续的 assistant text 消息中
 * @param isStreaming 当前是否正在流式生成（流式中的 steps 不进入 items，由 StreamingFooter 展示）
 */
function buildVisibleItems(
  messages: ChatMessage[],
  isStreaming: boolean
): VisibleItem[] {
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
          <button
            onClick={() => window.api.app.openFolder(projectPath)}
            className="titlebar-no-drag flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors max-w-[80%] truncate cursor-pointer"
            title={projectPath}
          >
            <Folder size={10} className="flex-shrink-0 text-text-tertiary/70" />
            <span className="truncate">{projectPath}</span>
          </button>
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
            const settings = useSettingsStore.getState()
            const session = await window.api.session.create({
              provider: settings.activeProvider,
              model: settings.activeModel,
              systemPrompt: settings.systemPrompt,
              projectId
            })
            const allSessions = await window.api.session.list()
            useChatStore.getState().setSessions(allSessions)
            useChatStore.getState().setActiveSessionId(session.id)
          }}
        />
      )}
    </div>
  )
}

// ─── 会话配置弹窗 ─────────────────────────────────

function SessionConfigDialog({
  sessionId,
  onClose
}: {
  sessionId: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const session = useChatStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const [title, setTitle] = useState(session?.title || '')

  const [sshAutoApprove, setSshAutoApprove] = useState(session?.settings.sshAutoApprove === true)

  // LAN 分享状态（null = 未分享）
  const [lanShareMode, setLanShareMode] = useState<ShareMode | null>(null)
  const [shareUrls, setShareUrls] = useState<string[]>([])
  const [copied, setCopied] = useState(false)

  // Telegram Bot 绑定
  const [telegramBots, setTelegramBots] = useState<
    Array<{ id: string; name: string; username: string; boundSessionId: string | null }>
  >([])
  const [boundBotId, setBoundBotId] = useState<string | null>(null)

  useEffect(() => {
    window.api.webui.getShareMode(sessionId).then((mode) => {
      setLanShareMode(mode)
      if (mode) {
        window.api.webui.serverStatus().then((status) => {
          if (status.running && status.urls && status.urls.length > 0) {
            setShareUrls(status.urls.map((u) => `${u}/shuvix/sessions/${sessionId}`))
          }
        })
      } else {
        setShareUrls([])
      }
    })
    // 加载 Telegram Bot 列表 + 当前绑定
    Promise.all([
      window.api.telegram.listBots(),
      window.api.telegram.getSessionBotId(sessionId)
    ]).then(([bots, botId]) => {
      setTelegramBots(bots.map((b) => ({ id: b.id, name: b.name, username: b.username, boundSessionId: b.boundSessionId })))
      setBoundBotId(botId)
    })
  }, [sessionId])

  // Escape 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose])

  /** 保存标题 */
  const handleSaveTitle = async (): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed || trimmed === session?.title) return
    await window.api.session.updateTitle({ id: sessionId, title: trimmed })
    useChatStore.getState().updateSessionTitle(sessionId, trimmed)
  }

  // 删除确认
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  /** 点击删除：有消息时先确认，无消息直接删除 */
  const handleRequestDelete = async (): Promise<void> => {
    const msgs = await window.api.message.list(sessionId)
    if (msgs.length > 0) {
      setShowDeleteConfirm(true)
    } else {
      await doDeleteSession()
    }
  }

  /** 执行删除 */
  const doDeleteSession = async (): Promise<void> => {
    await window.api.session.delete(sessionId)
    useChatStore.getState().removeSession(sessionId)
    onClose()
  }

  /** 切换 LAN 分享模式 */
  const handleSetShareMode = async (mode: ShareMode | null): Promise<void> => {
    setLanShareMode(mode)
    await window.api.webui.setShared({ sessionId, shared: mode !== null, mode: mode ?? undefined })
    if (mode) {
      const status = await window.api.webui.serverStatus()
      if (status.running && status.urls && status.urls.length > 0) {
        setShareUrls(status.urls.map((u) => `${u}/shuvix/sessions/${sessionId}`))
      }
    } else {
      setShareUrls([])
    }
    // 更新 chatStore 中的分享列表
    const shared = await window.api.webui.listShared()
    useChatStore.getState().setSharedSessionIds(new Map(shared.map((s) => [s.sessionId, s.mode])))
  }

  /** 复制分享链接 */
  const handleCopyShareUrl = (url: string): void => {
    copyToClipboard(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  /** 选择 Telegram Bot 绑定 */
  const handleSelectTelegramBot = async (botId: string | null): Promise<void> => {
    // 先解绑当前
    if (boundBotId) {
      await window.api.telegram.unbindSession({ sessionId })
    }
    // 再绑定新 Bot
    if (botId) {
      await window.api.telegram.bindSession({ botId, sessionId })
    }
    setBoundBotId(botId)
    // 更新 chatStore
    useChatStore.getState().updateSessionSettings(sessionId, { telegramBotId: botId ?? undefined })
    const bindings = new Map(useChatStore.getState().telegramBindings)
    if (botId) {
      const bot = telegramBots.find((b) => b.id === botId)
      bindings.set(sessionId, { botId, username: bot?.username ?? '' })
    } else {
      bindings.delete(sessionId)
    }
    useChatStore.getState().setTelegramBindings(bindings)
    // 刷新 bot 列表（绑定状态变化）
    const bots = await window.api.telegram.listBots()
    setTelegramBots(bots.map((b) => ({ id: b.id, name: b.name, username: b.username, boundSessionId: b.boundSessionId })))
  }

  /** 切换 SSH 免审批 */
  const handleToggleSshAutoApprove = async (): Promise<void> => {
    const next = !sshAutoApprove
    setSshAutoApprove(next)
    await window.api.session.updateSshAutoApprove({ id: sessionId, sshAutoApprove: next })
    useChatStore.getState().updateSessionSettings(sessionId, { sshAutoApprove: next })
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
      onClick={handleClose}
    >
      <div
        className="w-80 bg-bg-primary border border-border-secondary rounded-xl shadow-xl overflow-hidden dialog-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-secondary/50 bg-bg-secondary/50">
          <h3 className="text-sm font-semibold text-text-primary">{t('sessionConfig.title')}</h3>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          {/* 会话标题 */}
          <div>
            <label className="block text-[10px] text-text-tertiary mb-1">
              {t('sessionConfig.sessionTitle')}
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => void handleSaveTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSaveTitle()
              }}
              className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent/50 transition-colors"
            />
          </div>

          {/* SSH 免审批 */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-secondary">
                {t('sessionConfig.sshAutoApprove')}
              </span>
              <button
                onClick={handleToggleSshAutoApprove}
                className={`relative w-8 h-[18px] rounded-full transition-colors ${
                  sshAutoApprove ? 'bg-amber-500' : 'bg-bg-hover'
                }`}
              >
                <span
                  className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
                    sshAutoApprove ? 'left-[16px]' : 'left-[2px]'
                  }`}
                />
              </button>
            </div>
            <p className="text-[10px] text-text-tertiary mt-1">
              {t('sessionConfig.sshAutoApproveDesc')}
            </p>
            {sshAutoApprove && (
              <div className="flex items-start gap-1.5 mt-2 px-2.5 py-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5">
                <TriangleAlert size={11} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-relaxed">
                  {t('chat.sshAutoApproveWarning')}
                </p>
              </div>
            )}
          </div>

          {/* LAN 分享 */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-secondary">
                {t('sessionConfig.lanShare')}
              </span>
              <button
                onClick={() => void handleSetShareMode(lanShareMode ? null : 'readonly')}
                className={`relative w-8 h-[18px] rounded-full transition-colors ${
                  lanShareMode ? 'bg-accent' : 'bg-bg-hover'
                }`}
              >
                <span
                  className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
                    lanShareMode ? 'left-[16px]' : 'left-[2px]'
                  }`}
                />
              </button>
            </div>
            <p className="text-[10px] text-text-tertiary mt-1">{t('sessionConfig.lanShareDesc')}</p>

            {/* 分享模式选择（仅在开启分享时显示） */}
            {lanShareMode && (
              <div className="mt-2 space-y-1.5">
                <span className="text-[10px] text-text-tertiary">
                  {t('sessionConfig.shareMode')}
                </span>
                <div className="flex gap-1">
                  {(['readonly', 'chat', 'full'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => void handleSetShareMode(mode)}
                      className={`flex-1 px-2 py-1.5 rounded-md text-[10px] font-medium transition-colors border ${
                        lanShareMode === mode
                          ? 'bg-accent/15 text-accent border-accent/30'
                          : 'bg-bg-tertiary text-text-tertiary border-border-primary hover:bg-bg-hover hover:text-text-secondary'
                      }`}
                    >
                      {t(`sessionConfig.shareMode${mode.charAt(0).toUpperCase() + mode.slice(1)}`)}
                    </button>
                  ))}
                </div>
                <p className="text-[9px] text-text-tertiary leading-relaxed">
                  {lanShareMode === 'readonly'
                    ? t('sessionConfig.shareModeReadonlyDesc')
                    : lanShareMode === 'chat'
                      ? t('sessionConfig.shareModeChatDesc')
                      : t('sessionConfig.shareModeFullDesc')}
                </p>
              </div>
            )}

            {lanShareMode && shareUrls.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {shareUrls.map((url) => (
                  <div key={url} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-bg-tertiary border border-border-primary">
                    <Globe size={11} className="text-accent shrink-0" />
                    <span className="text-[10px] text-text-secondary truncate flex-1">{url}</span>
                    <button
                      onClick={() => handleCopyShareUrl(url)}
                      className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary transition-colors shrink-0"
                      title={copied ? t('common.copied') : t('common.copy')}
                    >
                      <Copy size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Telegram Bot 绑定 */}
          <div>
            <div className="text-xs font-medium text-text-secondary mb-1">
              {t('sessionConfig.telegramBot')}
            </div>
            <select
              value={boundBotId ?? ''}
              onChange={(e) => void handleSelectTelegramBot(e.target.value || null)}
              className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-border-primary bg-bg-primary text-text-primary focus:outline-none focus:border-accent"
            >
              <option value="">{t('sessionConfig.telegramNone')}</option>
              {telegramBots
                .filter((b) => !b.boundSessionId || b.boundSessionId === sessionId)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}{b.username ? ` (@${b.username})` : ''}
                  </option>
                ))}
            </select>
            <p className="text-[10px] text-text-tertiary mt-1">
              {t('sessionConfig.telegramBotDesc')}
            </p>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="px-4 py-3 border-t border-border-secondary/50 bg-bg-secondary/30 flex items-center justify-between">
          <button
            onClick={() => void handleRequestDelete()}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-text-tertiary hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={12} />
            {t('common.delete')}
          </button>
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.close')}
          </button>
        </div>
      </div>

      {/* 删除会话确认弹窗 */}
      {showDeleteConfirm && (
        <ConfirmDialog
          title={t('sidebar.confirmDelete')}
          description={
            <>
              {t('sidebar.deleteWarning')}
              <span className="text-error font-medium">{t('sidebar.deleteWarningBold')}</span>
              {t('sidebar.deleteWarningEnd')}
            </>
          }
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={() => void doDeleteSession()}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  )
}
