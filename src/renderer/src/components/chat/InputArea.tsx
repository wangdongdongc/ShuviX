import { useRef, useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, Square, ImagePlus, Mic, X, Archive } from 'lucide-react'
import { TokenBadge } from './InlineTokenBadge'
import { makeTokenMarker, expandCommandTemplate } from '../../../../shared/utils/inlineTokens'
import type { InlineToken } from '../../../../shared/types/chatMessage'
import {
  useChatStore,
  selectIsStreaming,
  selectIsCompacting,
  selectCanEdit
} from '../../stores/chatStore'
import { useImageUpload } from '../../hooks/useImageUpload'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import { useSessionMeta } from '../../hooks/useSessionMeta'
import { useSettingsStore } from '../../stores/settingsStore'
import { ModelPicker } from './ModelPicker'
import { ThinkingPicker } from './ThinkingPicker'
import { ToolPicker } from './ToolPicker'
import { SlashCommandPopover } from './SlashCommandPopover'
import { useSlashCommands } from '../../hooks/useSlashCommands'

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
 *
 * 注:不再有"pending action 时输入框走 override"的联动。
 * 反馈给 AI 的入口由 PendingInputsPanel 中的"其它"输入框承担。
 */
export function InputArea(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    inputText,
    setInputText,
    activeSessionId,
    modelSupportsVision,
    maxContextTokens,
    usedContextTokens,
    pendingImages,
    removePendingImage,
    slashCommands
  } = useChatStore()
  const isStreaming = useChatStore(selectIsStreaming)
  const isCompacting = useChatStore(selectIsCompacting)
  const canEdit = useChatStore(selectCanEdit)
  const assistantMsgCount = useChatStore(
    useCallback(
      (s) => s.messages.filter((m) => m.role === 'assistant' && m.type === 'text').length,
      []
    )
  )
  const { projectPath } = useSessionMeta()

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)

  // 工具栏宽度不足时隐藏上下文用量
  const [showToolbarExtras, setShowToolbarExtras] = useState(true)
  useEffect(() => {
    const el = toolbarRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setShowToolbarExtras(entry.contentRect.width > 420)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { isDragging, handleImageFiles, handleDragOver, handleDragLeave, handleDrop, handlePaste } =
    useImageUpload(modelSupportsVision)

  // 语音输入
  const { voiceSttLanguage } = useSettingsStore()
  const voice = useVoiceInput(voiceSttLanguage)

  // 斜杠命令自动补全
  const slash = useSlashCommands(slashCommands, inputText)

  // 斜杠命令芯片：选中命令后以 badge 展示，输入框只显示参数
  const [slashChip, setSlashChip] = useState<{
    commandId: string
    name: string
    description: string
    template: string
  } | null>(null)
  const [chipWidth, setChipWidth] = useState(0)
  const chipRef = useCallback((node: HTMLSpanElement | null) => {
    setChipWidth(node?.offsetWidth ?? 0)
  }, [])

  /** 输入变化处理：检测 "/commandId " 模式并自动转为芯片 */
  const handleInputChange = useCallback(
    (value: string) => {
      if (!slashChip && value.startsWith('/') && value.includes(' ')) {
        const spaceIdx = value.indexOf(' ')
        const cmdId = value.slice(1, spaceIdx)
        const cmd = slashCommands.find((c) => c.commandId === cmdId)
        if (cmd) {
          setSlashChip({
            commandId: cmd.commandId,
            name: cmd.name,
            description: cmd.description,
            template: cmd.template
          })
          setInputText(value.slice(spaceIdx + 1))
          return
        }
      }
      setInputText(value)
    },
    [slashChip, slashCommands, setInputText]
  )

  // 拖拽调节的 textarea 最小高度
  const DRAG_MIN = 60
  const DRAG_MAX = 480
  const DEFAULT_MIN_H = 72
  const [minH, setMinH] = useState(() => {
    const stored = localStorage.getItem('inputMinHeight')
    if (stored) {
      const n = Number(stored)
      if (Number.isFinite(n)) return Math.max(DRAG_MIN, Math.min(n, DRAG_MAX))
    }
    return DEFAULT_MIN_H
  })
  const draggingRef = useRef(false)

  /** 自动调整文本框高度（内容超出时自动扩展） */
  useEffect(() => {
    const el = textareaRef.current
    if (!el || draggingRef.current) return
    el.style.height = 'auto'
    el.style.height = Math.min(Math.max(el.scrollHeight, minH), DRAG_MAX) + 'px'
  }, [inputText, minH])

  /** 拖拽手柄：向上拖增大输入区，向下拖缩小 */
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
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
        // 持久化拖拽后的输入框高度
        const el = textareaRef.current
        if (el) localStorage.setItem('inputMinHeight', String(el.offsetHeight))
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [minH]
  )

  /** 自动启用命令依赖的工具（fire-and-forget） */
  const autoEnableRequiredTools = useCallback(
    (requiredTools: string[] | undefined): void => {
      if (!requiredTools?.length || !activeSessionId) return
      const store = useChatStore.getState()
      const current = new Set(store.enabledTools)
      const missing = requiredTools.filter((name) => !current.has(name))
      if (missing.length === 0) return
      const newTools = [...store.enabledTools, ...missing]
      store.setEnabledTools(newTools)
      void window.api.agent.setEnabledTools({ sessionId: activeSessionId, tools: newTools })
      void window.api.session.updateEnabledTools({ id: activeSessionId, enabledTools: newTools })
    },
    [activeSessionId]
  )

  /** 发送消息（支持图片） */
  const handleSend = async (): Promise<void> => {
    // 录音中则先停止录制
    if (voice.isRecording) voice.stopRecording()

    const rawText = inputText.trim()
    const images = pendingImages
    // 有芯片时即使参数为空也允许发送（纯命令）
    if ((!rawText && !slashChip && images.length === 0) || isStreaming || !activeSessionId) return

    // ─── 前端斜杠命令展开 + Token 构造 ───
    let contentText: string
    let inlineTokens: Record<string, InlineToken> | undefined

    if (slashChip) {
      // 芯片模式：从芯片中获取模板并展开
      const uid = 't0'
      const expandedText = expandCommandTemplate(slashChip.template, rawText)
      const token: InlineToken = {
        type: 'cmd',
        id: slashChip.commandId,
        displayText: `/${slashChip.commandId}`,
        payload: expandedText,
        name: slashChip.name
      }
      inlineTokens = { [uid]: token }
      contentText = rawText ? `${makeTokenMarker(uid)} ${rawText}` : makeTokenMarker(uid)
    } else if (rawText.startsWith('/')) {
      // 直接输入模式：检测斜杠命令并展开
      const spaceIdx = rawText.indexOf(' ')
      const cmdId = spaceIdx === -1 ? rawText.slice(1) : rawText.slice(1, spaceIdx)
      const args = spaceIdx === -1 ? '' : rawText.slice(spaceIdx + 1).trim()
      const cmd = slashCommands.find((c) => c.commandId === cmdId)
      if (cmd) {
        autoEnableRequiredTools(cmd.requiredTools)
        const uid = 't0'
        const expandedText = expandCommandTemplate(cmd.template, args)
        const token: InlineToken = {
          type: 'cmd',
          id: cmd.commandId,
          displayText: `/${cmd.commandId}`,
          payload: expandedText,
          name: cmd.name
        }
        inlineTokens = { [uid]: token }
        contentText = args ? `${makeTokenMarker(uid)} ${args}` : makeTokenMarker(uid)
      } else {
        contentText = rawText
      }
    } else {
      contentText = rawText || t('input.imageOnly')
    }

    const store = useChatStore.getState()
    store.setInputText('')
    store.clearPendingImages()
    setSlashChip(null)
    store.setIsStreaming(activeSessionId, true)
    store.clearStreamingContent(activeSessionId)

    // 发送给 Agent（附带图片 + 内联 Token），后端直接使用不再重复查询
    const agentImages =
      images.length > 0
        ? images.map((img) => ({
            type: 'image' as const,
            data: img.data,
            mimeType: img.mimeType
          }))
        : undefined
    await window.api.agent.prompt({
      sessionId: activeSessionId,
      text: contentText,
      images: agentImages,
      inlineTokens
    })
  }

  /** 中止生成（后端统一处理落库 + Agent 上下文同步） */
  const handleAbort = async (): Promise<void> => {
    if (!activeSessionId) return
    const sid = activeSessionId
    const store = useChatStore.getState()
    // 后端 abort 会持久化已生成的部分内容并返回已保存的消息
    const result = await window.api.agent.abort(sid)
    store.finishStreaming(sid, result.savedMessage ?? undefined)
  }

  /** 向运行中的 Agent 发送 steer 消息（引导/纠正方向） */
  const handleSteer = async (): Promise<void> => {
    const text = inputText.trim()
    if (!text || !activeSessionId) return
    const store = useChatStore.getState()
    store.setInputText('')
    // 竞态保护：agent 可能刚好结束，检查 isStreaming 决定走 steer 还是 prompt
    const stillStreaming = store.sessionStreams[activeSessionId]?.isStreaming
    if (stillStreaming) {
      await window.api.agent.steer({ sessionId: activeSessionId, text })
    } else {
      store.setIsStreaming(activeSessionId, true)
      store.clearStreamingContent(activeSessionId)
      await window.api.agent.prompt({ sessionId: activeSessionId, text })
    }
  }

  /** 斜杠命令选中回调：设置芯片，输入框只保留参数；自动启用依赖工具 */
  const handleSlashSelect = useCallback(
    (commandId: string) => {
      const cmd = slashCommands.find((c) => c.commandId === commandId)
      setSlashChip({
        commandId,
        name: cmd?.name || commandId,
        description: cmd?.description || '',
        template: cmd?.template || ''
      })
      setInputText('')
      setTimeout(() => textareaRef.current?.focus(), 0)
      autoEnableRequiredTools(cmd?.requiredTools)
    },
    [slashCommands, setInputText, autoEnableRequiredTools]
  )

  /** 键盘事件处理 */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // 斜杠命令 popover 可见时优先处理导航
    if (slash.showPopover) {
      // Enter/Tab 时选中当前项
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        const filtered = slashCommands.filter((cmd) =>
          cmd.commandId.toLowerCase().startsWith(slash.filter.toLowerCase())
        )
        const selected = filtered[slash.selectedIndex]
        if (selected) {
          e.preventDefault()
          handleSlashSelect(selected.commandId)
          return
        }
      }
      if (slash.handleKeyDown(e)) return
    }

    // Escape 取消录音
    if (e.key === 'Escape' && voice.isRecording) {
      e.preventDefault()
      voice.cancelRecording()
      return
    }

    // Backspace 在光标位置 0 且输入为空时，移除斜杠命令芯片
    if (e.key === 'Backspace' && slashChip && inputText === '') {
      e.preventDefault()
      setSlashChip(null)
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // streaming 时发送 steer 消息
      if (isStreaming) {
        if (inputText.trim()) handleSteer()
        return
      }
      handleSend()
    }
  }

  const canSend =
    (inputText.trim().length > 0 || pendingImages.length > 0 || !!slashChip) &&
    !isStreaming &&
    activeSessionId
  return (
    <div
      className={`bg-bg-primary transition-colors ${
        isDragging ? 'border-t border-accent border-dashed bg-accent/5' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="max-w-3xl mx-auto p-2">
        <div className="border border-border-secondary/40 bg-bg-secondary/50 shadow-sm rounded-lg">
          {/* 拖拽调节手柄 */}
          <div
            onMouseDown={handleResizeStart}
            className="flex justify-center py-1 cursor-ns-resize group"
          >
            <div className="w-8 h-0.5 rounded-full bg-border-secondary group-hover:bg-text-tertiary transition-colors" />
          </div>
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

          <div className="relative">
            {/* 斜杠命令自动补全浮层 */}
            {slash.showPopover && (
              <SlashCommandPopover
                filter={slash.filter}
                commands={slashCommands}
                onSelect={handleSlashSelect}
                selectedIndex={slash.selectedIndex}
              />
            )}

            {/* 底部工具栏 */}
            <div
              ref={toolbarRef}
              className="absolute left-2 right-2 bottom-1.5 z-10 flex items-center gap-2.5 text-text-tertiary whitespace-nowrap"
            >
              {/* Pickers 组：不可收缩 */}
              <div className="flex-shrink-0 flex items-center gap-1.5">
                <ModelPicker readonly={!canEdit} />
                {canEdit && <ThinkingPicker />}
                {canEdit && <ToolPicker />}
              </div>

              {/* 分隔线 */}
              {(modelSupportsVision ||
                (showToolbarExtras && (maxContextTokens > 0 || projectPath))) && (
                <span className="flex-shrink-0 h-3 w-px bg-border-secondary" />
              )}

              {/* 图片上传按钮（仅当模型支持 vision 时显示） */}
              {modelSupportsVision && (
                <>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-shrink-0 inline-flex items-center gap-1 text-[11px] text-emerald-400/70 hover:text-emerald-400 transition-colors"
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

              {/* 上下文用量指示器（空间不足时隐藏） */}
              {showToolbarExtras && maxContextTokens > 0 && (
                <span className="relative inline-flex items-center group/token">
                  <span className="inline-flex items-center text-[11px] select-none text-text-tertiary">
                    {usedContextTokens !== null ? formatTokenCount(usedContextTokens) : '-'}
                    {' / '}
                    {formatTokenCount(maxContextTokens)}
                  </span>
                  {/* 悬浮 tooltip：详细用量 */}
                  <div className="pointer-events-none absolute left-0 bottom-6 z-20 hidden rounded-md border border-border-primary bg-bg-secondary px-2 py-1 shadow-xl group-hover/token:block whitespace-nowrap">
                    <div className="text-[11px] text-text-primary">
                      {t('input.contextUsage', {
                        used: usedContextTokens !== null ? usedContextTokens.toLocaleString() : '-',
                        max: maxContextTokens.toLocaleString()
                      })}
                    </div>
                  </div>
                </span>
              )}

              {/* 右侧弹性空白 → 将按钮推到最右 */}
              <span className="flex-1" />

              {/* Compact + Mic + Send/Stop 按钮 */}
              <div className="flex items-center gap-0.5">
                {assistantMsgCount >= 2 && !isStreaming && !isCompacting && (
                  <button
                    onClick={() => activeSessionId && window.api.compact.start(activeSessionId)}
                    className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
                    title={t('compact.button')}
                  >
                    <Archive size={14} />
                  </button>
                )}
                {voice.isAvailable && !isStreaming && (
                  <button
                    onClick={voice.isRecording ? voice.stopRecording : voice.startRecording}
                    disabled={!activeSessionId}
                    className={`p-1 rounded transition-colors ${
                      voice.isRecording
                        ? 'text-error hover:bg-error/10'
                        : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
                    }`}
                    title={voice.isRecording ? t('voice.stopRecording') : t('voice.startRecording')}
                  >
                    {voice.isRecording ? (
                      <div className="flex items-center gap-1">
                        <span className="relative flex h-2.5 w-2.5">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-error opacity-75" />
                          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-error" />
                        </span>
                        <span className="text-[10px] tabular-nums">
                          {Math.floor(voice.duration / 60)}:
                          {String(voice.duration % 60).padStart(2, '0')}
                        </span>
                      </div>
                    ) : (
                      <Mic size={14} />
                    )}
                  </button>
                )}

                {isStreaming ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={handleSteer}
                      disabled={!inputText.trim()}
                      className={`p-1.5 rounded-lg transition-colors ${
                        inputText.trim()
                          ? 'bg-warning text-white hover:bg-warning/80'
                          : 'text-text-tertiary cursor-not-allowed'
                      }`}
                      title={t('input.steer')}
                    >
                      <Send size={14} />
                    </button>
                    <button
                      onClick={handleAbort}
                      className="p-1 rounded bg-error/20 text-error hover:bg-error/30 transition-colors"
                      title={t('input.stopGen')}
                    >
                      <Square size={14} fill="currentColor" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!canSend}
                    className={`p-1.5 rounded-lg transition-colors ${
                      canSend
                        ? 'bg-accent text-white hover:bg-accent-hover'
                        : 'text-text-tertiary cursor-not-allowed'
                    }`}
                    title={t('input.send')}
                  >
                    <Send size={14} />
                  </button>
                )}
              </div>
            </div>

            {/* 斜杠命令芯片：绝对定位在 textarea 首行，text-indent 让出空间 */}
            {slashChip && (
              <span
                ref={chipRef}
                className="absolute left-4 top-2 z-10 pointer-events-auto text-sm"
              >
                <TokenBadge
                  popoverDirection="up"
                  segment={{
                    type: 'token',
                    uid: 'input',
                    token: {
                      type: 'cmd',
                      id: slashChip.commandId,
                      displayText: `/${slashChip.commandId}`,
                      payload: expandCommandTemplate(slashChip.template, inputText.trim()),
                      name: slashChip.name
                    }
                  }}
                />
              </span>
            )}

            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                !activeSessionId
                  ? t('input.placeholderNoSession')
                  : isStreaming
                    ? t('input.placeholderSteer')
                    : slashChip
                      ? t('input.placeholder')
                      : modelSupportsVision
                        ? t('input.placeholderVision')
                        : t('input.placeholder')
              }
              disabled={!activeSessionId}
              rows={3}
              style={{
                minHeight: `${minH}px`,
                textIndent: chipWidth > 0 ? `${chipWidth + 4}px` : undefined
              }}
              className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary px-4 pt-2 pb-9 resize-none outline-none overflow-y-auto disabled:opacity-50"
            />

            {/* 语音输入错误提示 */}
            {voice.error && (
              <div className="absolute right-2 bottom-12 z-20 rounded-md border border-error/30 bg-error/10 px-2 py-1 text-[11px] text-error whitespace-nowrap">
                {voice.error}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
