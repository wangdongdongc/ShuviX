import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Folder } from 'lucide-react'
import { useChatStore, selectStreamingContent, selectStreamingThinking, selectIsStreaming, type ChatMessage } from '../../stores/chatStore'
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

/** 工具调用索引：预解析 metadata，O(1) 查找配对关系 */
interface ToolIndex {
  /** toolCallId → tool_call 消息的解析后 meta */
  callMeta: Map<string, any>
  /** 已有配对 result 的 toolCallId 集合 */
  pairedIds: Set<string>
  /** msgId → 解析后的 meta */
  metaCache: Map<string, any>
}

/** 构建工具调用索引（纯函数，供 useMemo 缓存） */
function buildToolIndex(messages: ChatMessage[]): ToolIndex {
  const callMeta = new Map<string, any>()
  const pairedIds = new Set<string>()
  const metaCache = new Map<string, any>()

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
    } catch { /* 忽略解析失败 */ }
  }

  return { callMeta, pairedIds, metaCache }
}

/** 判断 VisibleItem 是否为工具调用项（tool_call 或 tool_result） */
function isToolItem(item: VisibleItem): boolean {
  return item.msg.type === 'tool_call' || item.msg.type === 'tool_result'
}

/** 获取工具项的 turnIndex（优先从 pairedCallMeta 取，回退到 meta） */
function getItemTurnIndex(item: VisibleItem): number | undefined {
  return item.pairedCallMeta?.turnIndex ?? item.meta?.turnIndex
}

/** 预处理消息列表中的可见项（过滤掉不渲染的消息，并计算 turn 分组信息） */
function buildVisibleItems(messages: ChatMessage[], toolIndex: ToolIndex): VisibleItem[] {
  const items: VisibleItem[] = []
  for (const msg of messages) {
    // 跳过 system_notify（但保留 docker_event / ssh_event / error_event 类型）
    if (msg.role === 'system_notify' && msg.type !== 'docker_event' && msg.type !== 'ssh_event' && msg.type !== 'error_event') continue
    // 跳过已有配对结果的 tool_call（由 tool_result 合并渲染）
    if (msg.type === 'tool_call') {
      const meta = toolIndex.metaCache.get(msg.id)
      if (meta?.toolCallId && toolIndex.pairedIds.has(meta.toolCallId)) continue
      items.push({ msg, meta })
      continue
    }
    if (msg.type === 'tool_result') {
      const meta = toolIndex.metaCache.get(msg.id)
      const pairedCallMeta = meta?.toolCallId ? toolIndex.callMeta.get(meta.toolCallId) : undefined
      items.push({ msg, meta, pairedCallMeta })
      continue
    }
    items.push({ msg })
  }

  // ─── 计算 turn 分组信息 ─────────────────────────────────
  // 识别连续的工具项分组（同一 turnIndex 的连续工具项为一组）
  interface TurnGroup { startIdx: number; endIdx: number; turnIndex: number | undefined }
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
  const { handleRollback, pendingRollbackId, confirmRollback, cancelRollback, handleRegenerate, handleToolApproval, handleUserInput, handleSshCredentials, handleUserActionOverride, handleNewChat } = useChatActions(activeSessionId)

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
  }, [streamingContent, streamingThinking, messages])

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
  const renderItem = useCallback((_index: number, item: VisibleItem) => (
    <MessageRenderer
      item={item}
      lastAssistantTextId={lastAssistantTextId}
      onRollback={handleRollback}
      onRegenerate={handleRegenerate}
    />
  ), [messages, lastAssistantTextId, handleRollback, handleRegenerate])

  return (
    <div className="flex flex-col h-full">
      {/* 窗口拖拽区 + 会话标题 / 工作目录（macOS 为交通灯留出顶部空间） */}
      <div className={`titlebar-drag flex-shrink-0 flex flex-col items-center justify-end pb-1 ${window.api.app.platform === 'darwin' ? 'min-h-12' : 'min-h-8'}`}>
        {sessionTitle && (
          editingTitle ? (
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
            <button
              onClick={startEditTitle}
              className="titlebar-no-drag text-xs font-medium text-text-secondary hover:text-text-primary transition-colors px-2 py-0.5 rounded-md hover:bg-bg-hover/50 max-w-[60%] truncate"
              title={t('common.clickToEdit')}
            >
              {sessionTitle}
            </button>
          )
        )}
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
          <UserActionPanel onUserInput={handleUserInput} onApproval={handleToolApproval} onSshCredentials={handleSshCredentials} />
          {/* 输入区 */}
          <InputArea onUserActionOverride={handleUserActionOverride} />
        </>
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
