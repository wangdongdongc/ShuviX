import { useEffect, useLayoutEffect, useRef } from 'react'
import { MessageSquarePlus, Sparkles } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { MessageBubble } from './MessageBubble'
import { ToolCallBlock } from './ToolCallBlock'
import { InputArea } from './InputArea'

/**
 * 聊天主视图 — 消息列表 + 输入区
 * 包含空状态引导和自动滚动
 */
export function ChatView(): React.JSX.Element {
  const { messages, streamingContent, isStreaming, activeSessionId } = useChatStore()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const prevSessionIdRef = useRef<string | null>(null)
  const instantScrollRef = useRef(0)

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
                {messages.map((msg) => {
                  if (msg.type === 'tool_call') {
                    const meta = msg.metadata ? JSON.parse(msg.metadata) : {}
                    // 查找是否已有配对的 tool_result
                    const hasPairedResult = messages.some(
                      (m) => m.type === 'tool_result' && m.metadata &&
                        JSON.parse(m.metadata).toolCallId === meta.toolCallId
                    )
                    // 有结果 → 跳过（由 tool_result 合并渲染）；无结果 → 显示执行中
                    if (hasPairedResult) return null
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
                    const meta = msg.metadata ? JSON.parse(msg.metadata) : {}
                    const pairedCall = messages.find(
                      (m) => m.type === 'tool_call' && m.metadata &&
                        JSON.parse(m.metadata).toolCallId === meta.toolCallId
                    )
                    const callMeta = pairedCall?.metadata ? JSON.parse(pairedCall.metadata) : {}
                    return (
                      <ToolCallBlock
                        key={msg.id}
                        toolName={meta.toolName || '未知工具'}
                        args={callMeta.args}
                        result={msg.content}
                        status={meta.isError ? 'error' : 'done'}
                        isHistorical
                      />
                    )
                  }
                  return (
                    <MessageBubble
                      key={msg.id}
                      role={msg.role}
                      content={msg.content}
                    />
                  )
                })}

                {/* 流式输出的助手消息 */}
                {isStreaming && streamingContent && (
                  <MessageBubble
                    role="assistant"
                    content={streamingContent}
                    isStreaming
                  />
                )}

                {/* 等待响应的加载指示器 */}
                {isStreaming && !streamingContent && (
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
