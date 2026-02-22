import { useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, Square, ImagePlus, X } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { useImageUpload } from '../hooks/useImageUpload'
import { ModelPicker } from './ModelPicker'
import { ThinkingPicker } from './ThinkingPicker'
import { ToolPicker } from './ToolPicker'

/** 将 token 数格式化为紧凑显示（如 12.5k、128k） */
function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`
  }
  return String(n)
}

/**
 * 输入区域 — 消息输入框 + 发送/停止按钮
 * 支持 Shift+Enter 换行，Enter 发送
 */
export function InputArea(): React.JSX.Element {
  const { t } = useTranslation()
  const { inputText, setInputText, isStreaming, activeSessionId, modelSupportsVision, maxContextTokens, usedContextTokens, pendingImages, removePendingImage } = useChatStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { isDragging, handleImageFiles, handleDragOver, handleDragLeave, handleDrop, handlePaste } = useImageUpload(modelSupportsVision)

  /** 自动调整文本框高度 */
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [inputText])

  /** 发送消息（支持图片） */
  const handleSend = async (): Promise<void> => {
    const text = inputText.trim()
    const images = pendingImages
    if ((!text && images.length === 0) || isStreaming || !activeSessionId) return

    const store = useChatStore.getState()
    store.setInputText('')
    store.clearPendingImages()
    store.setIsStreaming(activeSessionId, true)
    store.clearStreamingContent(activeSessionId)
    store.setError(null)

    // 构造消息内容：文本 + 图片标记
    const contentText = text || t('input.imageOnly')
    // 图片信息存入 metadata 用于消息气泡渲染
    const metadata = images.length > 0
      ? JSON.stringify({ images: images.map((img) => ({ mimeType: img.mimeType, preview: img.preview })) })
      : undefined

    // 保存用户消息到数据库
    const userMsg = await window.api.message.add({
      sessionId: activeSessionId,
      role: 'user',
      content: contentText,
      metadata
    })
    store.addMessage(userMsg)

    // 发送给 Agent（附带图片）
    const agentImages = images.length > 0
      ? images.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType }))
      : undefined
    await window.api.agent.prompt({ sessionId: activeSessionId, text: contentText, images: agentImages })
  }

  /** 中止生成 */
  const handleAbort = (): void => {
    if (!activeSessionId) return
    window.api.agent.abort(activeSessionId)
  }

  /** 键盘事件处理 */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isStreaming) return
      handleSend()
    }
  }

  const canSend = (inputText.trim().length > 0 || pendingImages.length > 0) && !isStreaming && activeSessionId

  return (
    <div className="border-t border-border-secondary bg-bg-primary px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <div
          className={`bg-bg-secondary rounded-xl border transition-colors ${
            isDragging
              ? 'border-accent border-dashed bg-accent/5'
              : 'border-border-primary focus-within:border-accent/50'
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* 图片预览条 */}
          {pendingImages.length > 0 && (
            <div className="flex gap-2 px-3 pt-3 pb-1 overflow-x-auto">
              {pendingImages.map((img, idx) => (
                <div key={idx} className="relative flex-shrink-0 group/img">
                  <img
                    src={img.preview}
                    alt={`附图 ${idx + 1}`}
                    className="w-16 h-16 object-cover rounded-lg border border-border-primary"
                  />
                  <button
                    onClick={() => removePendingImage(idx)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-error text-white flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="relative flex items-end gap-2">
            {/* 左下角紧凑扩展位 */}
            <div className="absolute left-2 bottom-2 z-10 flex items-center gap-1.5">
              <ModelPicker />

              {/* 图片上传按钮（仅当模型支持 vision 时显示） */}
              {modelSupportsVision && (
                <>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="h-6 inline-flex items-center gap-1 px-2 rounded-md border border-border-primary/70 bg-bg-primary/45 backdrop-blur-sm text-[10px] text-text-secondary hover:text-text-primary hover:bg-bg-primary/60 transition-colors"
                    title={t('input.uploadImage')}
                  >
                    <ImagePlus size={11} />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files) void handleImageFiles(e.target.files)
                      e.target.value = ''
                    }}
                  />
                </>
              )}

              {/* 上下文用量指示器 */}
              {maxContextTokens > 0 && (
                <span
                  className="h-6 inline-flex items-center px-2 rounded-md border border-border-primary/70 bg-bg-primary/45 backdrop-blur-sm text-[10px] text-text-tertiary select-none"
                  title={t('input.contextUsage', { used: usedContextTokens !== null ? usedContextTokens.toLocaleString() : '-', max: maxContextTokens.toLocaleString() })}
                >
                  {usedContextTokens !== null ? formatTokenCount(usedContextTokens) : '-'}
                  {' / '}
                  {formatTokenCount(maxContextTokens)}
                </span>
              )}

              <ThinkingPicker />
              <ToolPicker />
            </div>

            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={activeSessionId ? (modelSupportsVision ? t('input.placeholderVision') : t('input.placeholder')) : t('input.placeholderNoSession')}
              disabled={!activeSessionId}
              rows={1}
              className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary px-4 pt-3 pb-9 resize-none outline-none max-h-[200px] disabled:opacity-50"
            />

            {isStreaming ? (
              <button
                onClick={handleAbort}
                className="flex-shrink-0 m-2 p-2 rounded-lg bg-error/20 text-error hover:bg-error/30 transition-colors"
                title={t('input.stopGen')}
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
                title={t('input.send')}
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
