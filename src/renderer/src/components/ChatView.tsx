import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Folder } from 'lucide-react'
import { useChatStore, type ChatMessage } from '../stores/chatStore'
import { useChatActions } from '../hooks/useChatActions'
import { useSessionMeta } from '../hooks/useSessionMeta'
import { MessageRenderer, type VisibleItem } from './MessageRenderer'
import { StreamingFooter } from './StreamingFooter'
import { WelcomeView, EmptySessionHint } from './WelcomeView'
import { AskPanel } from './AskPanel'
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

/** 预处理消息列表中的可见项（过滤掉不渲染的消息） */
function buildVisibleItems(messages: ChatMessage[], toolIndex: ToolIndex): VisibleItem[] {
  const items: VisibleItem[] = []
  for (const msg of messages) {
    // 跳过 system_notify
    if (msg.role === 'system_notify') continue
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
  return items
}

/**
 * 聊天主视图 — 消息列表 + 输入区
 * 使用 react-virtuoso 虚拟滚动，仅渲染可视区域内的消息
 */
export function ChatView(): React.JSX.Element {
  const { messages, streamingContent, streamingThinking, isStreaming, activeSessionId } = useChatStore()
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const atBottomRef = useRef(true)

  const projectPath = useSessionMeta(activeSessionId)
  const { handleRollback, handleRegenerate, handleToolApproval, handleUserInput, handleNewChat } = useChatActions(activeSessionId)

  // 跟踪用户是否在底部附近
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom
  }, [])

  // 预构建工具调用索引 + 可见消息列表，messages 不变时复用缓存
  const toolIndex = useMemo(() => buildToolIndex(messages), [messages])
  const visibleItems = useMemo(() => buildVisibleItems(messages, toolIndex), [messages, toolIndex])

  // 流式内容 / 新消息更新时，若用户在底部则自动滚动
  useEffect(() => {
    if (atBottomRef.current && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' })
    }
  }, [streamingContent, streamingThinking, messages])

  // 仅当最后一条消息是助手文本消息时才允许重新生成
  const lastAssistantTextId = useMemo(() => {
    const last = messages[messages.length - 1]
    return last?.role === 'assistant' && last?.type === 'text' ? last.id : null
  }, [messages])

  /** 渲染单条可见消息 */
  const renderItem = useCallback((_index: number, item: VisibleItem) => (
    <MessageRenderer
      item={item}
      isLastMessage={item.msg.id === messages[messages.length - 1]?.id}
      lastAssistantTextId={lastAssistantTextId}
      onRollback={handleRollback}
      onRegenerate={handleRegenerate}
      onApproval={handleToolApproval}
    />
  ), [messages, lastAssistantTextId, handleRollback, handleRegenerate, handleToolApproval])

  return (
    <div className="flex flex-col h-full">
      {/* macOS 窗口拖拽区 + 工作目录 */}
      <div className="titlebar-drag h-12 flex-shrink-0 flex items-end justify-center pb-1.5">
        {projectPath && (
          <button
            onClick={() => window.api.app.openFolder(projectPath)}
            className="titlebar-no-drag flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors max-w-[80%] truncate cursor-pointer"
            title={projectPath}
          >
            <Folder size={11} className="flex-shrink-0 text-text-tertiary/70" />
            <span className="truncate">{projectPath}</span>
          </button>
        )}
      </div>

      {!activeSessionId ? (
        <WelcomeView onNewChat={handleNewChat} />
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
              followOutput="smooth"
              initialTopMostItemIndex={visibleItems.length - 1}
              key={activeSessionId}
              increaseViewportBy={200}
              computeItemKey={(_index, item) => item.msg.id}
              atBottomStateChange={handleAtBottomChange}
              atBottomThreshold={100}
            />
          )}

          {/* ask 工具浮动选项面板 */}
          <AskPanel onUserInput={handleUserInput} />
          {/* 输入区 */}
          <InputArea />
        </>
      )}
    </div>
  )
}
