import { useRef, useEffect } from 'react'
import { Send, Square } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'

/**
 * 输入区域 — 消息输入框 + 发送/停止按钮
 * 支持 Shift+Enter 换行，Enter 发送
 */
export function InputArea(): React.JSX.Element {
  const { inputText, setInputText, isStreaming, activeSessionId } = useChatStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /** 自动调整文本框高度 */
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [inputText])

  /** 发送消息 */
  const handleSend = async (): Promise<void> => {
    const text = inputText.trim()
    if (!text || isStreaming || !activeSessionId) return

    const store = useChatStore.getState()
    store.setInputText('')
    store.setIsStreaming(true)
    store.clearStreamingContent()
    store.setError(null)

    // 保存用户消息到数据库
    const userMsg = await window.api.message.add({
      sessionId: activeSessionId,
      role: 'user',
      content: text
    })
    store.addMessage(userMsg)

    // 发送给 Agent
    await window.api.agent.prompt(text)
  }

  /** 中止生成 */
  const handleAbort = (): void => {
    window.api.agent.abort()
  }

  /** 键盘事件处理 */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isStreaming) return
      handleSend()
    }
  }

  const canSend = inputText.trim().length > 0 && !isStreaming && activeSessionId

  return (
    <div className="border-t border-border-secondary bg-bg-primary px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-end gap-2 bg-bg-secondary rounded-xl border border-border-primary focus-within:border-accent/50 transition-colors">
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={activeSessionId ? '输入消息... (Shift+Enter 换行)' : '请先创建或选择一个对话'}
            disabled={!activeSessionId}
            rows={1}
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary px-4 py-3 resize-none outline-none max-h-[200px] disabled:opacity-50"
          />

          {isStreaming ? (
            <button
              onClick={handleAbort}
              className="flex-shrink-0 m-2 p-2 rounded-lg bg-error/20 text-error hover:bg-error/30 transition-colors"
              title="停止生成"
            >
              <Square size={16} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={`flex-shrink-0 m-2 p-2 rounded-lg transition-colors ${
                canSend
                  ? 'bg-accent text-white hover:bg-accent-hover'
                  : 'bg-bg-tertiary text-text-tertiary cursor-not-allowed'
              }`}
              title="发送"
            >
              <Send size={16} />
            </button>
          )}
        </div>

        <div className="flex items-center justify-center mt-2">
          <span className="text-[10px] text-text-tertiary">
            AI 可能会产生不准确的内容，请注意甄别
          </span>
        </div>
      </div>
    </div>
  )
}
