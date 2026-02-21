import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { MessageSquarePlus, Sparkles, Container, AlertCircle, Folder } from 'lucide-react'
import { useChatStore, type ChatMessage } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { MessageBubble } from './MessageBubble'
import { ToolCallBlock } from './ToolCallBlock'
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
interface VisibleItem {
  msg: ChatMessage
  meta?: any
  pairedCallMeta?: any
}

function buildVisibleItems(messages: ChatMessage[], toolIndex: ToolIndex): VisibleItem[] {
  const items: VisibleItem[] = []
  for (const msg of messages) {
    // 跳过 shirobot_notify
    if (msg.role === 'shirobot_notify') continue
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
  const { messages, streamingContent, streamingThinking, isStreaming, activeSessionId, error, setError } = useChatStore()
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const atBottomRef = useRef(true)

  // 当前项目工作目录
  const [projectPath, setProjectPath] = useState<string | null>(null)

  useEffect(() => {
    if (!activeSessionId) {
      setProjectPath(null)
      return
    }
    window.api.session.getById(activeSessionId).then((s) => setProjectPath(s?.workingDirectory || null))
  }, [activeSessionId])

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

  /** 回退到指定消息（删除之后的所有消息，重新初始化 Agent） */
  const handleRollback = useCallback(async (messageId: string) => {
    if (!activeSessionId) return
    if (!window.confirm('回退到此处将删除之后的所有消息，是否继续？')) return
    await window.api.message.rollback({ sessionId: activeSessionId, messageId })
    // 重新拉取消息 + 重建 Agent
    const msgs = await window.api.message.list(activeSessionId)
    useChatStore.getState().setMessages(msgs)
    await window.api.agent.init({ sessionId: activeSessionId })
  }, [activeSessionId])

  /** 重新生成最近一次助手回复（回退到用户消息前 + 重发） */
  const handleRegenerate = useCallback(async (assistantMsgId: string) => {
    if (!activeSessionId) return
    const store = useChatStore.getState()
    const idx = store.messages.findIndex((m) => m.id === assistantMsgId)
    // 向前查找最近的 user/text 消息
    let lastUserText = ''
    let userMsgId = ''
    for (let j = idx - 1; j >= 0; j--) {
      if (store.messages[j].role === 'user' && store.messages[j].type === 'text') {
        lastUserText = store.messages[j].content
        userMsgId = store.messages[j].id
        break
      }
    }
    if (!userMsgId) return
    // 删除用户消息及之后的所有消息
    await window.api.message.deleteFrom({ sessionId: activeSessionId, messageId: userMsgId })
    // 重新拉取消息 + 重建 Agent
    const msgs = await window.api.message.list(activeSessionId)
    store.setMessages(msgs)
    await window.api.agent.init({ sessionId: activeSessionId })
    // 重新保存用户消息并发送
    const userMsg = await window.api.message.add({ sessionId: activeSessionId, role: 'user', content: lastUserText })
    store.addMessage(userMsg)
    await window.api.agent.prompt({ sessionId: activeSessionId, text: lastUserText })
  }, [activeSessionId])

  // 仅当最后一条消息是助手文本消息时才允许重新生成
  const lastAssistantTextId = useMemo(() => {
    const last = messages[messages.length - 1]
    return last?.role === 'assistant' && last?.type === 'text' ? last.id : null
  }, [messages])

  /** 渲染单条可见消息 */
  const renderItem = useCallback((_index: number, item: VisibleItem) => {
    const { msg, meta, pairedCallMeta } = item

    if (msg.type === 'docker_event') {
      const isCreate = msg.content === 'container_created'
      return (
        <div className="flex items-center gap-1.5 mx-4 my-1 text-[11px] text-text-tertiary">
          <Container size={12} />
          <span>{isCreate ? '容器已创建' : '容器已销毁'}</span>
        </div>
      )
    }

    if (msg.type === 'tool_call') {
      return (
        <ToolCallBlock
          toolName={meta?.toolName || '未知工具'}
          args={meta?.args}
          status="running"
        />
      )
    }

    if (msg.type === 'tool_result') {
      return (
        <ToolCallBlock
          toolName={meta?.toolName || '未知工具'}
          args={pairedCallMeta?.args}
          result={msg.content}
          status={meta?.isError ? 'error' : 'done'}
        />
      )
    }

    return (
      <MessageBubble
        role={msg.role as 'user' | 'assistant' | 'system' | 'tool'}
        content={msg.content}
        metadata={msg.metadata}
        onRollback={msg.id !== messages[messages.length - 1]?.id ? () => handleRollback(msg.id) : undefined}
        onRegenerate={msg.id === lastAssistantTextId ? () => handleRegenerate(msg.id) : undefined}
      />
    )
  }, [handleRollback, handleRegenerate, lastAssistantTextId])

  /** 流式内容 / 思考 / 加载指示器 / 错误提示（固定在列表底部） */
  const Footer = useCallback(() => {
    const store = useChatStore.getState()
    const streaming = store.isStreaming
    const content = store.streamingContent
    const thinking = store.streamingThinking
    const err = store.error

    return (
      <>
        {/* 流式思考过程 */}
        {streaming && thinking && (
          <div className="mx-4 my-2">
            <details open className="group">
              <summary className="cursor-pointer select-none text-xs text-text-tertiary hover:text-text-secondary flex items-center gap-1.5 py-1">
                <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                <span className="animate-pulse">思考中…</span>
              </summary>
              <div className="mt-1 ml-4.5 pl-3 border-l-2 border-purple-500/30 text-xs text-text-tertiary leading-relaxed whitespace-pre-wrap max-h-[300px] overflow-y-auto">
                {thinking}
              </div>
            </details>
          </div>
        )}

        {/* 流式输出的助手消息 */}
        {streaming && content && (
          <MessageBubble
            role="assistant"
            content={content}
            isStreaming
          />
        )}

        {/* 等待响应的加载指示器 */}
        {streaming && !content && !err && (
          <div className="flex gap-3 px-4 py-3">
            <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-bg-tertiary flex items-center justify-center">
              <Sparkles size={14} className="text-text-secondary animate-pulse" />
            </div>
            <div className="flex items-center gap-1 pt-1">
              <div className="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}

        {/* 错误提示 */}
        {err && (
          <div className="mx-4 my-2 flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg bg-error/10 border border-error/20">
            <AlertCircle size={15} className="text-error flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-error font-medium mb-0.5">生成失败</p>
              <p className="text-[11px] text-error/80 break-words whitespace-pre-wrap">{err}</p>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-error/50 hover:text-error transition-colors flex-shrink-0"
              title="关闭"
            >
              ×
            </button>
          </div>
        )}
      </>
    )
  }, [setError, isStreaming, streamingContent, streamingThinking, error])

  /** 创建新会话 */
  const handleNewChat = async (): Promise<void> => {
    const settings = useSettingsStore.getState()
    const session = await window.api.session.create({
      provider: settings.activeProvider,
      model: settings.activeModel,
      systemPrompt: settings.systemPrompt
    })
    const sessions = await window.api.session.list()
    useChatStore.getState().setSessions(sessions)
    useChatStore.getState().setActiveSessionId(session.id)
  }

  return (
    <div className="flex flex-col h-full">
      {/* macOS 窗口拖拽区 + 工作目录 */}
      <div className="titlebar-drag h-12 flex-shrink-0 flex items-end justify-center pb-1.5">
        {projectPath && (
          <div className="titlebar-no-drag flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] text-text-tertiary max-w-[80%] truncate" title={projectPath}>
            <Folder size={11} className="flex-shrink-0 text-text-tertiary/70" />
            <span className="truncate">{projectPath}</span>
          </div>
        )}
      </div>

      {!activeSessionId ? (
        /* 空状态 — 欢迎页 */
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md px-6">
            <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto mb-6">
              <Sparkles size={32} className="text-accent" />
            </div>
            <h2 className="text-xl font-semibold text-text-primary mb-2">
              欢迎使用 ShiroBot
            </h2>
            <p className="text-sm text-text-secondary mb-6 leading-relaxed">
              一个基于多模型的 AI 智能体助手，支持自然对话和扩展能力。
            </p>
            <button
              onClick={handleNewChat}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors"
            >
              <MessageSquarePlus size={16} />
              开始新对话
            </button>
          </div>
        </div>
      ) : (
        /* 聊天消息列表 */
        <>
          {messages.length === 0 && !isStreaming ? (
            /* 空会话引导 */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center px-6">
                <div className="w-12 h-12 rounded-xl bg-bg-tertiary flex items-center justify-center mx-auto mb-4">
                  <Sparkles size={24} className="text-text-tertiary" />
                </div>
                <p className="text-sm text-text-secondary">
                  发送一条消息开始对话
                </p>
              </div>
            </div>
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              className="flex-1"
              data={visibleItems}
              itemContent={renderItem}
              components={{ Footer }}
              followOutput="smooth"
              initialTopMostItemIndex={visibleItems.length - 1}
              key={activeSessionId}
              increaseViewportBy={200}
              computeItemKey={(_index, item) => item.msg.id}
              atBottomStateChange={handleAtBottomChange}
              atBottomThreshold={100}
            />
          )}

          {/* 输入区 */}
          <InputArea />
        </>
      )}
    </div>
  )
}
