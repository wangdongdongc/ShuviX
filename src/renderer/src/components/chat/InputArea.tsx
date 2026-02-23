import { useRef, useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, Square, ImagePlus, X } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useImageUpload } from '../../hooks/useImageUpload'
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

interface InputAreaProps {
  /** 用户通过输入框文本覆盖当前 pending action（审批拒绝 / ask 反馈） */
  onUserActionOverride?: (text: string) => void
}

/**
 * 输入区域 — 消息输入框 + 发送/停止按钮
 * 支持 Shift+Enter 换行，Enter 发送
 */
export function InputArea({ onUserActionOverride }: InputAreaProps): React.JSX.Element {
  const { t } = useTranslation()
  const { inputText, setInputText, isStreaming, activeSessionId, modelSupportsVision, maxContextTokens, usedContextTokens, pendingImages, removePendingImage } = useChatStore()

  // 检测是否有待用户操作的工具执行（ask 提问 / bash 审批）
  const hasPendingAction = useChatStore((s) =>
    s.toolExecutions.some((te) => te.status === 'pending_approval' || (te.status === 'pending_user_input' && te.toolName === 'ask'))
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { isDragging, handleImageFiles, handleDragOver, handleDragLeave, handleDrop, handlePaste } = useImageUpload(modelSupportsVision)

  // 拖拽调节的 textarea 最小高度
  const DRAG_MIN = 60
  const DRAG_MAX = 480
  const DEFAULT_MIN_H = 72
  const [minH, setMinH] = useState(DEFAULT_MIN_H)
  const draggingRef = useRef(false)

  /** 自动调整文本框高度（内容超出时自动扩展） */
  useEffect(() => {
    const el = textareaRef.current
    if (!el || draggingRef.current) return
    el.style.height = 'auto'
    el.style.height = Math.max(el.scrollHeight, minH) + 'px'
  }, [inputText, minH])

  /** 拖拽手柄：向上拖增大输入区，向下拖缩小 */
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    const startY = e.clientY
    const startH = minH
    const onMove = (ev: MouseEvent): void => {
      const delta = startY - ev.clientY
      const newH = Math.max(DRAG_MIN, Math.min(startH + delta, DRAG_MAX))
      setMinH(newH)
      // 拖拽时直接设置 textarea 高度
      if (textareaRef.current) {
        textareaRef.current.style.height = newH + 'px'
      }
    }
    const onUp = (): void => {
      draggingRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [minH])

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

  /** 用户通过输入框提交文本覆盖当前 pending action */
  const handleOverrideSend = (): void => {
    const text = inputText.trim()
    if (!text || !onUserActionOverride) return
    onUserActionOverride(text)
    useChatStore.getState().setInputText('')
  }

  /** 键盘事件处理 */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // pending action 时优先走 override 流程
      if (hasPendingAction && inputText.trim()) {
        handleOverrideSend()
        return
      }
      if (isStreaming) return
      handleSend()
    }
  }

  // pending action 时输入框临时可用
  const effectiveStreaming = isStreaming && !hasPendingAction
  const canSend = (inputText.trim().length > 0 || pendingImages.length > 0) && !effectiveStreaming && activeSessionId

  return (
    <div
      className={`border-t bg-bg-secondary transition-colors ${
        isDragging
          ? 'border-accent border-dashed bg-accent/5'
          : 'border-border-secondary'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 拖拽调节手柄 */}
      <div
        onMouseDown={handleResizeStart}
        className="flex justify-center py-1 cursor-ns-resize group"
      >
        <div className="w-8 h-0.5 rounded-full bg-border-secondary group-hover:bg-text-tertiary transition-colors" />
      </div>
      <div className="max-w-3xl mx-auto">
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
            <div className="absolute left-2 bottom-1.5 z-10 flex items-center gap-2.5 text-text-tertiary">
              <ModelPicker />

              {/* 图片上传按钮（仅当模型支持 vision 时显示） */}
              {modelSupportsVision && (
                <>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1 text-[11px] text-emerald-400/70 hover:text-emerald-400 transition-colors"
                    title={t('input.uploadImage')}
                  >
                    <ImagePlus size={12} />
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
                  className="inline-flex items-center text-[11px] select-none"
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
              placeholder={
                !activeSessionId ? t('input.placeholderNoSession')
                : hasPendingAction ? t('input.placeholderOverride')
                : modelSupportsVision ? t('input.placeholderVision')
                : t('input.placeholder')
              }
              disabled={!activeSessionId}
              rows={3}
              style={{ minHeight: `${minH}px` }}
              className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary px-4 pt-2 pb-9 resize-none outline-none disabled:opacity-50"
            />

            {effectiveStreaming ? (
              <button
                onClick={handleAbort}
                className="flex-shrink-0 m-2 p-2 rounded-lg bg-error/20 text-error hover:bg-error/30 transition-colors"
                title={t('input.stopGen')}
              >
                <Square size={16} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={hasPendingAction ? handleOverrideSend : handleSend}
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
  )
}
