import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Folder, Settings2, Trash2, TriangleAlert, X } from 'lucide-react'
import {
  useChatStore,
  selectStreamingContent,
  selectStreamingThinking,
  selectStreamingImages,
  selectIsStreaming,
  type ChatMessage
} from '../../stores/chatStore'
import { useDialogClose } from '../../hooks/useDialogClose'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatActions } from '../../hooks/useChatActions'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { useSessionMeta } from '../../hooks/useSessionMeta'
import { MessageRenderer, type VisibleItem } from './MessageRenderer'
import { KEEP_RECENT_TURNS } from '../../../../shared/constants'
import { StreamingFooter } from './StreamingFooter'
import { WelcomeView, EmptySessionHint } from './WelcomeView'
import { ProjectCreateDialog } from '../sidebar/ProjectCreateDialog'
import { UserActionPanel } from './UserActionPanel'
import { InputArea } from './InputArea'
import { StatusBanner } from './StatusBanner'

/** 工具调用索引：预解析 metadata，O(1) 查找配对关系 */
interface ToolIndex {
  /** toolCallId → tool_call 消息的解析后 meta */
  callMeta: Map<string, Record<string, unknown>>
  /** 已有配对 result 的 toolCallId 集合 */
  pairedIds: Set<string>
  /** msgId → 解析后的 meta */
  metaCache: Map<string, Record<string, unknown>>
}

/** 构建工具调用索引（纯函数，供 useMemo 缓存） */
function buildToolIndex(messages: ChatMessage[]): ToolIndex {
  const callMeta = new Map<string, Record<string, unknown>>()
  const pairedIds = new Set<string>()
  const metaCache = new Map<string, Record<string, unknown>>()

  for (const m of messages) {
    if (!m.metadata) continue
    try {
      const parsed = JSON.parse(m.metadata)
      if (m.type === 'tool_call' && parsed.toolCallId) {
        callMeta.set(parsed.toolCallId, parsed)
        metaCache.set(m.id, parsed)
      } else if (m.type === 'tool_result' && parsed.toolCallId) {
        pairedIds.add(parsed.toolCallId)
        metaCache.set(m.id, parsed)
      }
    } catch {
      /* 忽略解析失败 */
    }
  }

  return { callMeta, pairedIds, metaCache }
}

/** 判断 VisibleItem 是否为工具调用项（tool_call 或 tool_result） */
function isToolItem(item: VisibleItem): boolean {
  return item.msg.type === 'tool_call' || item.msg.type === 'tool_result'
}

/** 获取工具项的 turnIndex（优先从 pairedCallMeta 取，回退到 meta） */
function getItemTurnIndex(item: VisibleItem): number | undefined {
  return (
    (item.pairedCallMeta?.turnIndex as number | undefined) ??
    (item.meta?.turnIndex as number | undefined)
  )
}

/** 预处理消息列表中的可见项（过滤掉不渲染的消息，并计算 turn 分组信息） */
function buildVisibleItems(messages: ChatMessage[], toolIndex: ToolIndex): VisibleItem[] {
  const items: VisibleItem[] = []
  for (const msg of messages) {
    // 跳过 system_notify（但保留 docker_event / ssh_event / error_event 类型）
    if (
      msg.role === 'system_notify' &&
      msg.type !== 'docker_event' &&
      msg.type !== 'ssh_event' &&
      msg.type !== 'error_event'
    )
      continue
    // 跳过已有配对结果的 tool_call（由 tool_result 合并渲染）
    if (msg.type === 'tool_call') {
      const meta = toolIndex.metaCache.get(msg.id)
      const toolCallId = meta?.toolCallId as string | undefined
      if (toolCallId && toolIndex.pairedIds.has(toolCallId)) continue
      items.push({ msg, meta })
      continue
    }
    if (msg.type === 'tool_result') {
      const meta = toolIndex.metaCache.get(msg.id)
      const toolCallId = meta?.toolCallId as string | undefined
      const pairedCallMeta = toolCallId ? toolIndex.callMeta.get(toolCallId) : undefined
      items.push({ msg, meta, pairedCallMeta })
      continue
    }
    items.push({ msg })
  }

  // ─── 计算 turn 分组信息 ─────────────────────────────────
  // 识别连续的工具项分组（同一 turnIndex 的连续工具项为一组）
  interface TurnGroup {
    startIdx: number
    endIdx: number
    turnIndex: number | undefined
  }
  const turnGroups: TurnGroup[] = []
  let i = 0
  while (i < items.length) {
    if (isToolItem(items[i])) {
      const turnIdx = getItemTurnIndex(items[i])
      const start = i
      // 将相同 turnIndex 的连续工具项归为一组
      while (i < items.length && isToolItem(items[i]) && getItemTurnIndex(items[i]) === turnIdx) {
        i++
      }
      turnGroups.push({ startIdx: start, endIdx: i - 1, turnIndex: turnIdx })
    } else {
      i++
    }
  }

  // 根据 KEEP_RECENT_TURNS 确定哪些 turn 将被压缩
  const totalGroups = turnGroups.length
  const compressThreshold = totalGroups - KEEP_RECENT_TURNS // globalIndex < threshold 的将被压缩

  // 注入 turnGroup 信息到每个工具项
  for (let gi = 0; gi < turnGroups.length; gi++) {
    const g = turnGroups[gi]
    const groupSize = g.endIdx - g.startIdx + 1
    const willBeCompressed = gi < compressThreshold
    for (let idx = g.startIdx; idx <= g.endIdx; idx++) {
      items[idx].turnGroup = {
        globalIndex: gi,
        isFirst: idx === g.startIdx,
        isLast: idx === g.endIdx,
        willBeCompressed,
        groupSize
      }
    }
  }

  return items
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

  // 预构建工具调用索引 + 可见消息列表，messages 不变时复用缓存
  const toolIndex = useMemo(() => buildToolIndex(messages), [messages])
  const visibleItems = useMemo(() => buildVisibleItems(messages, toolIndex), [messages, toolIndex])

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
        onRollback={handleRollback}
        onRegenerate={handleRegenerate}
      />
    ),
    [messages, lastAssistantTextId, handleRollback, handleRegenerate]
  )

  return (
    <div className="flex flex-col h-full">
      {/* 窗口拖拽区 + 会话标题 / 工作目录（macOS 为交通灯留出顶部空间） */}
      <div
        className={`titlebar-drag flex-shrink-0 flex flex-col items-center justify-end pb-1 ${window.api.app.platform === 'darwin' ? 'min-h-12' : 'min-h-8'}`}
      >
        {sessionTitle &&
          (editingTitle ? (
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
              <button
                onClick={startEditTitle}
                className="text-xs font-medium text-text-secondary hover:text-text-primary transition-colors px-2 py-0.5 rounded-md hover:bg-bg-hover/50 truncate"
                title={t('common.clickToEdit')}
              >
                {sessionTitle}
              </button>
              <button
                onClick={() => setShowSessionConfig(true)}
                className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors flex-shrink-0"
                title={t('sessionConfig.title')}
              >
                <Settings2 size={12} />
              </button>
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
          {/* 用户操作浮动面板（ask 提问 / bash 审批 / SSH 凭据） */}
          <UserActionPanel
            onUserInput={handleUserInput}
            onApproval={handleToolApproval}
            onSshCredentials={handleSshCredentials}
          />
          {/* 输入区 */}
          <InputArea onUserActionOverride={handleUserActionOverride} />
        </>
      )}

      {/* 会话配置弹窗 */}
      {showSessionConfig && activeSessionId && (
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

  // 解析 sshAutoApprove
  const sessionSettings = useMemo(() => {
    try {
      return JSON.parse(session?.settings || '{}')
    } catch {
      return {}
    }
  }, [session?.settings])
  const [sshAutoApprove, setSshAutoApprove] = useState(sessionSettings.sshAutoApprove === true)

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

  /** 切换 SSH 免审批 */
  const handleToggleSshAutoApprove = async (): Promise<void> => {
    const next = !sshAutoApprove
    setSshAutoApprove(next)
    const updated = { ...sessionSettings, sshAutoApprove: next }
    const json = JSON.stringify(updated)
    await window.api.session.updateSettings({ id: sessionId, settings: json })
    useChatStore.getState().updateSessionSettings(sessionId, json)
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
