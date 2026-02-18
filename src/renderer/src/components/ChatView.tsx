import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { MessageSquarePlus, Sparkles, Container, AlertCircle } from 'lucide-react'
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

/** 渲染单条消息 */
function renderMessage(msg: ChatMessage, toolIndex: ToolIndex): React.ReactNode {
  if (msg.type === 'docker_event') {
    const isCreate = msg.content === 'container_created'
    return (
      <div key={msg.id} className="flex items-center gap-1.5 mx-4 my-1 text-[11px] text-text-tertiary">
        <Container size={12} />
        <span>{isCreate ? '容器已创建' : '容器已销毁'}</span>
      </div>
    )
  }

  if (msg.type === 'tool_call') {
    const meta = toolIndex.metaCache.get(msg.id) || {}
    // 有配对结果 → 跳过（由 tool_result 合并渲染）
    if (meta.toolCallId && toolIndex.pairedIds.has(meta.toolCallId)) return null
    return (
      <ToolCallBlock
        key={msg.id}
        toolName={meta.toolName || '未知工具'}
        args={meta.args}
        status="running"
      />
    )
  }

  if (msg.type === 'tool_result') {
    const meta = toolIndex.metaCache.get(msg.id) || {}
    const paired = meta.toolCallId ? toolIndex.callMeta.get(meta.toolCallId) : undefined
    return (
      <ToolCallBlock
        key={msg.id}
        toolName={meta.toolName || '未知工具'}
        args={paired?.args}
        result={msg.content}
        status={meta.isError ? 'error' : 'done'}
      />
    )
  }

  // shirobot_notify 等非对话消息不渲染为气泡
  if (msg.role === 'shirobot_notify') return null

  return (
    <MessageBubble
      key={msg.id}
      role={msg.role as 'user' | 'assistant' | 'system' | 'tool'}
      content={msg.content}
      metadata={msg.metadata}
    />
  )
}

/**
 * 聊天主视图 — 消息列表 + 输入区
 * 包含空状态引导和自动滚动
 */
export function ChatView(): React.JSX.Element {
  const { messages, streamingContent, streamingThinking, isStreaming, activeSessionId, error, setError } = useChatStore()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const prevSessionIdRef = useRef<string | null>(null)
  const instantScrollRef = useRef(0)

  // 预构建工具调用索引，messages 不变时复用缓存
  const toolIndex = useMemo(() => buildToolIndex(messages), [messages])

  // 渲染阶段检测会话切换（在 hooks 之前执行）
  if (prevSessionIdRef.current !== activeSessionId) {
    // 给 2 次渲染周期的瞬间滚动，覆盖异步加载消息的延迟
    instantScrollRef.current = 2
    prevSessionIdRef.current = activeSessionId
  }

  /** 切换会话时在绘制前直接定位到底部（无闪烁） */
  useLayoutEffect(() => {
    if (instantScrollRef.current > 0) {
      const el = scrollContainerRef.current
      if (el) el.scrollTop = el.scrollHeight
      instantScrollRef.current--
    }
  }, [activeSessionId, messages])

  /** 同会话内新消息/流式更新时平滑滚动到底部 */
  useEffect(() => {
    if (instantScrollRef.current <= 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, streamingContent])

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
      {/* macOS 窗口拖拽区 */}
      <div className="titlebar-drag h-12 flex-shrink-0" />

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
          <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
            {messages.length === 0 && !isStreaming ? (
              /* 空会话引导 */
              <div className="flex items-center justify-center h-full">
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
              <div className="max-w-3xl mx-auto py-4">
                {messages.map((msg) => renderMessage(msg, toolIndex))}

                {/* 流式思考过程 */}
                {isStreaming && streamingThinking && (
                  <div className="mx-4 my-2">
                    <details open className="group">
                      <summary className="cursor-pointer select-none text-xs text-text-tertiary hover:text-text-secondary flex items-center gap-1.5 py-1">
                        <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="animate-pulse">思考中…</span>
                      </summary>
                      <div className="mt-1 ml-4.5 pl-3 border-l-2 border-purple-500/30 text-xs text-text-tertiary leading-relaxed whitespace-pre-wrap max-h-[300px] overflow-y-auto">
                        {streamingThinking}
                      </div>
                    </details>
                  </div>
                )}

                {/* 流式输出的助手消息 */}
                {isStreaming && streamingContent && (
                  <MessageBubble
                    role="assistant"
                    content={streamingContent}
                    isStreaming
                  />
                )}

                {/* 等待响应的加载指示器 */}
                {isStreaming && !streamingContent && !error && (
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
                {error && (
                  <div className="mx-4 my-2 flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg bg-error/10 border border-error/20">
                    <AlertCircle size={15} className="text-error flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-error font-medium mb-0.5">生成失败</p>
                      <p className="text-[11px] text-error/80 break-words whitespace-pre-wrap">{error}</p>
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

                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* 输入区 */}
          <InputArea />
        </>
      )}
    </div>
  )
}
