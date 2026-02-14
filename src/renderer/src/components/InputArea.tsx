import { useRef, useEffect, useState } from 'react'
import { Send, Square, ChevronDown } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'

/**
 * 输入区域 — 消息输入框 + 发送/停止按钮
 * 支持 Shift+Enter 换行，Enter 发送
 */
export function InputArea(): React.JSX.Element {
  const { inputText, setInputText, isStreaming, activeSessionId, setSessions } = useChatStore()
  const {
    availableModels,
    providers,
    activeProvider,
    activeModel,
    setActiveProvider,
    setActiveModel
  } = useSettingsStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerStep, setPickerStep] = useState<'provider' | 'model'>('provider')
  const [draftProvider, setDraftProvider] = useState(activeProvider)

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

  // 已启用 provider 列表（从 availableModels 推导）
  const enabledProviders = [...new Map(
    availableModels.map((m) => [m.providerId, { id: m.providerId, name: m.providerName }])
  ).values()]

  // 选择器内当前 provider 下可选模型（仅已启用）
  const draftProviderModels = availableModels.filter((m) => m.providerId === draftProvider)

  /** 点击外部关闭选择器 */
  useEffect(() => {
    if (!pickerOpen) return
    const handleClickOutside = (event: MouseEvent): void => {
      if (!pickerRef.current) return
      if (!pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false)
        setPickerStep('provider')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [pickerOpen])

  /** 打开单一选择器（默认先选 provider） */
  const togglePicker = (): void => {
    if (pickerOpen) {
      setPickerOpen(false)
      setPickerStep('provider')
      return
    }
    setDraftProvider(activeProvider)
    setPickerStep('provider')
    setPickerOpen(true)
  }

  /** 选择 provider 后进入模型选择 */
  const handlePickProvider = (providerId: string): void => {
    setDraftProvider(providerId)
    setPickerStep('model')
  }

  /** 紧凑选择器：确认模型并提交 provider/model 切换 */
  const handlePickModel = async (modelId: string): Promise<void> => {
    setActiveProvider(draftProvider)
    setActiveModel(modelId)

    // 会话级持久化：仅更新当前会话的 provider/model
    if (activeSessionId) {
      await window.api.session.updateModelConfig({
        id: activeSessionId,
        provider: draftProvider,
        model: modelId
      })
      const sessions = await window.api.session.list()
      setSessions(sessions)
    }

    const providerInfo = providers.find((p) => p.id === draftProvider)
    await window.api.agent.setModel({
      provider: draftProvider,
      model: modelId,
      baseUrl: providerInfo?.baseUrl || undefined
    })
    setPickerOpen(false)
    setPickerStep('provider')
  }

  const activeProviderName = enabledProviders.find((p) => p.id === activeProvider)?.name || activeProvider

  return (
    <div className="border-t border-border-secondary bg-bg-primary px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <div className="bg-bg-secondary rounded-xl border border-border-primary focus-within:border-accent/50 transition-colors">
          <div className="relative flex items-end gap-2">
            {/* 左下角紧凑扩展位：后续可从左向右增加更多选项 */}
            <div className="absolute left-2 bottom-2 z-10 flex items-center gap-1.5">
              <div ref={pickerRef} className="relative">
                <button
                  onClick={togglePicker}
                  className="h-6 inline-flex items-center gap-1 px-2 rounded-md border border-border-primary/70 bg-bg-primary/45 backdrop-blur-sm text-[10px] text-text-secondary hover:text-text-primary hover:bg-bg-primary/60 transition-colors"
                  title="切换提供商与模型"
                >
                  <span className="max-w-[120px] truncate">{activeModel}</span>
                  <ChevronDown size={11} />
                </button>

                {pickerOpen && (
                  <div className="absolute left-0 bottom-8 w-[220px] rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-hidden">
                    <div className="px-2 py-1.5 border-b border-border-secondary text-[10px] text-text-tertiary flex items-center justify-between">
                      <span>{pickerStep === 'provider' ? '选择提供商' : '选择模型'}</span>
                      {pickerStep === 'model' && (
                        <button
                          onClick={() => setPickerStep('provider')}
                          className="text-text-secondary hover:text-text-primary"
                        >
                          返回
                        </button>
                      )}
                    </div>

                    <div className="max-h-56 overflow-y-auto py-1">
                      {pickerStep === 'provider' && enabledProviders.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => handlePickProvider(p.id)}
                          className="w-full text-left px-2 py-1.5 text-[11px] text-text-primary hover:bg-bg-hover transition-colors"
                        >
                          {p.name}
                        </button>
                      ))}

                      {pickerStep === 'model' && draftProviderModels.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => {
                            void handlePickModel(m.modelId)
                          }}
                          className="w-full text-left px-2 py-1.5 text-[11px] text-text-primary hover:bg-bg-hover transition-colors"
                        >
                          {m.modelId}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={activeSessionId ? '输入消息... (Shift+Enter 换行)' : '请先创建或选择一个对话'}
              disabled={!activeSessionId}
              rows={1}
              className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary px-4 pt-3 pb-9 resize-none outline-none max-h-[200px] disabled:opacity-50"
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
        </div>
      </div>
    </div>
  )
}
