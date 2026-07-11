import { getSessionChannelApi, getHostApi, useChatHost } from '@shuvix/chat-ui'
import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, Square, Mic, X, Archive } from 'lucide-react'
import { TokenChip } from './TokenChip'
import {
  expandCommandTemplate,
  buildCommandToken,
  parseSlashCommandInput
} from '@shuvix/chat-protocol/utils/inlineTokens'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import {
  useChatStore,
  selectIsStreaming,
  selectIsCompacting,
  selectCanEdit
} from '../../stores/chatStore'
import { useImageUpload } from '../../hooks/useImageUpload'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import { ModelPicker } from './ModelPicker'
import { ToolPicker } from './ToolPicker'
import { SlashCommandPopover } from './SlashCommandPopover'
import { useSlashCommands } from '../../hooks/useSlashCommands'
import { AtMentionPopover } from './AtMentionPopover'
import { MentionHighlighter } from './MentionHighlighter'
import { useAtMentions } from '../../hooks/useAtMentions'
import type { FileSuggestion } from '@shuvix/chat-protocol/utils/fileMap'

/** 将 token 数格式化为紧凑显示（如 12.5k、128k） */
function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`
  }
  return String(n)
}

export interface InputAreaProps {
  /**
   * 笔记本会话模式：复用本输入框，但发送走 `agent.notebookPrompt`（每次开启独立子智能体；
   * 子智能体上下文仅注入笔记本路径 + read 提示，正文由其自行读取），UI 调整为悬浮、矮、无压缩归档。
   * 模型/工具选择沿用 ModelPicker/ToolPicker（写会话配置 → 子智能体继承，与普通会话一致）。
   */
  notebook?: boolean
}

/**
 * 输入区域 — 消息输入框 + 发送/停止按钮
 * 支持 Shift+Enter 换行，Enter 发送
 *
 * 注:不再有"pending action 时输入框走 override"的联动。
 * 反馈给 AI 的入口由 PendingInputsPanel 中的"其它"输入框承担。
 */
export function InputArea({ notebook }: InputAreaProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const isNotebook = !!notebook
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
  const canEditSession = useChatStore(selectCanEdit)
  // 渠道端（无 HostApi）只读：禁用一切会话配置编辑（模型/工具/压缩等）
  const hasHost = getHostApi() !== null
  const canEdit = canEditSession && hasHost
  const assistantMsgCount = useChatStore(
    useCallback(
      (s) => s.messages.filter((m) => m.role === 'assistant' && m.type === 'text').length,
      []
    )
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)
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

  const { isDragging, handleDragOver, handleDragLeave, handleDrop, handlePaste } =
    useImageUpload(modelSupportsVision)

  // 语音输入 + 默认模型
  const chatHost = useChatHost()
  const voiceSttLanguage = chatHost.voice?.sttLanguage ?? 'auto'
  const activeModel = chatHost.models.activeModel
  const voice = useVoiceInput(voiceSttLanguage)

  // 斜杠命令自动补全
  const slash = useSlashCommands(slashCommands, inputText)

  // @ 工作区文件引用自动补全（可在任意位置触发，可多个；胶囊仅展示文件名）
  const at = useAtMentions(activeSessionId)
  // 背景镜像层（画 @ 胶囊）—— 与 textarea 同步 scrollTop
  const backdropRef = useRef<HTMLDivElement>(null)
  // 程序化改写文本后待应用的光标位置（select / 整体退格）
  const pendingCaretRef = useRef<number | null>(null)

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

  /** 输入变化处理：检测 "/commandId " 模式并自动转为芯片；同步 @ 引用触发态与登记表 */
  const handleInputChange = useCallback(
    (value: string, caret: number) => {
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
      at.prune(value)
      at.refresh(value, caret)
    },
    [slashChip, slashCommands, setInputText, at]
  )

  /** @ 引用选中：在光标处替换 @query → @token，登记引用，落回文本并置光标 */
  const applyAtSelect = useCallback(
    (s: FileSuggestion) => {
      const el = textareaRef.current
      const caret = el?.selectionStart ?? inputText.length
      const { text, caret: newCaret } = at.select(s, inputText, caret)
      setInputText(text)
      pendingCaretRef.current = newCaret
      setTimeout(() => textareaRef.current?.focus(), 0)
    },
    [at, inputText, setInputText]
  )

  // 拖拽调节的 textarea 最小高度。笔记本模式默认更矮（悬浮少遮挡）、不读持久化高度、不展示拖拽手柄。
  const DRAG_MIN = 60
  const DRAG_MAX = 480
  const DEFAULT_MIN_H = isNotebook ? 44 : 60
  const [minH, setMinH] = useState(() => {
    if (isNotebook) return DEFAULT_MIN_H
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

  /** 程序化改写文本（@ 选中 / 整体退格）后应用待定光标 */
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (el && pendingCaretRef.current != null) {
      const pos = pendingCaretRef.current
      pendingCaretRef.current = null
      el.selectionStart = el.selectionEnd = pos
    }
  }, [inputText])

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
      const host = getHostApi()
      if (!host) return // 渠道端无权改工具集；会话工具由宿主侧已配置
      const newTools = [...store.enabledTools, ...missing]
      store.setEnabledTools(newTools)
      void host.agent.setEnabledTools({ sessionId: activeSessionId, tools: newTools })
      void host.session.updateEnabledTools({ id: activeSessionId, enabledTools: newTools })
    },
    [activeSessionId]
  )

  /**
   * 构造发送文本 + 内联 Token（slash 命令 / skill 展开 + @ 文件引用）—— 主会话与笔记本会话共用。
   * - slash 命令：payload 为整条替换，无法与 at token 混用，故先把 @ 引用就地展开为 payload 文本内联进参数。
   * - 普通消息：@ 引用逐个替换为 {{token}} 标记 + 构造 at 类型 InlineToken（保留周围文字）。
   */
  const buildSlashOutgoing = useCallback(
    (
      raw: string,
      sid: string | null
    ): { contentText: string; inlineTokens?: Record<string, InlineToken> } => {
      if (slashChip) {
        return buildCommandToken(slashChip, at.resolveInline(raw), { sessionId: sid ?? undefined })
      }
      if (raw.startsWith('/')) {
        const parsed = parseSlashCommandInput(at.resolveInline(raw), slashCommands, {
          sessionId: sid ?? undefined
        })
        if (parsed) {
          autoEnableRequiredTools(parsed.command.requiredTools)
          return { contentText: parsed.contentText, inlineTokens: parsed.inlineTokens }
        }
      }
      return at.buildOutgoing(raw)
    },
    [slashChip, slashCommands, autoEnableRequiredTools, at]
  )

  /** 发送消息（支持图片） */
  const handleSend = async (): Promise<void> => {
    // 录音中则先停止录制
    if (voice.isRecording) voice.stopRecording()

    const rawText = inputText.trim()
    const images = pendingImages

    // 笔记本模式：每次发送开启独立子智能体（fire-and-forget）。子代理上下文仅注入笔记本路径 + read 提示，
    // 正文由其自行读取。不走主会话流式态（笔记本无主 Agent）；进展看右侧子智能体面板。模型/工具由会话配置决定。
    if (notebook) {
      if ((!rawText && !slashChip) || !activeSessionId) return
      // 笔记本会话同样支持 slash 命令 / skill：展开为内联 Token，后端解析为发给子代理的真实指令
      const { contentText, inlineTokens } = buildSlashOutgoing(rawText, activeSessionId)
      const store = useChatStore.getState()
      store.setInputText('')
      store.clearPendingImages()
      setSlashChip(null)
      at.reset()
      void getSessionChannelApi().agent.notebookPrompt({
        sessionId: activeSessionId,
        text: contentText,
        inlineTokens
      })
      return
    }

    // 有芯片时即使参数为空也允许发送（纯命令）
    if ((!rawText && !slashChip && images.length === 0) || isStreaming) return

    // 无会话则自动创建临时会话（欢迎页直接发送时走这条路径）。
    // 创建会话属宿主能力；渠道端总有一个已分享的当前会话，故此路径不会触发。
    let sid = activeSessionId
    if (!sid) {
      const host = getHostApi()
      if (!host) return
      const session = await host.session.create()
      sid = session.id
      await getSessionChannelApi().agent.init({ sessionId: sid })
      const sessions = await host.session.list()
      const s = useChatStore.getState()
      s.setSessions(sessions)
      s.setActiveSessionId(sid)
    }

    // ─── 前端斜杠命令展开 + Token 构造（与笔记本会话共用 buildSlashOutgoing） ───
    const outgoing = buildSlashOutgoing(rawText, sid)
    const inlineTokens = outgoing.inlineTokens
    // 纯图片消息（无文本无命令）回退占位文案
    const contentText = inlineTokens
      ? outgoing.contentText
      : outgoing.contentText || t('input.imageOnly')

    const store = useChatStore.getState()
    store.setInputText('')
    store.clearPendingImages()
    setSlashChip(null)
    at.reset()
    store.setIsStreaming(sid, true)
    store.clearStreamingContent(sid)

    // 发送给 Agent（附带图片 + 内联 Token），后端直接使用不再重复查询
    const agentImages =
      images.length > 0
        ? images.map((img) => ({
            type: 'image' as const,
            data: img.data,
            mimeType: img.mimeType
          }))
        : undefined
    await getSessionChannelApi().agent.prompt({
      sessionId: sid,
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
    const result = await getSessionChannelApi().agent.abort(sid)
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
      await getSessionChannelApi().agent.steer({ sessionId: activeSessionId, text })
    } else {
      store.setIsStreaming(activeSessionId, true)
      store.clearStreamingContent(activeSessionId)
      await getSessionChannelApi().agent.prompt({ sessionId: activeSessionId, text })
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
    // @ 引用 popover 可见时优先处理导航（可在任意位置触发，故先于斜杠命令）
    if (at.showPopover) {
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        const s = at.suggestions[at.selectedIndex]
        if (s) {
          e.preventDefault()
          applyAtSelect(s)
          return
        }
      }
      if (at.handleKeyDown(e)) return
    }

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

    // Backspace 光标紧邻 @ 引用尾部：整体删除该引用（一次退格删掉整颗胶囊）
    if (e.key === 'Backspace' && !at.showPopover) {
      const el = textareaRef.current
      if (el && el.selectionStart === el.selectionEnd) {
        const res = at.backspace(inputText, el.selectionStart)
        if (res) {
          e.preventDefault()
          setInputText(res.text)
          at.prune(res.text)
          pendingCaretRef.current = res.caret
          return
        }
      }
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
    !!activeModel

  // ─── 复用片段：模型/工具选择器 + 麦克风 + 发送/停止 ──
  // 普通会话：pickers 在外置工具栏、按钮在输入框右下角；笔记本：两者合并到输入框底部同一行。
  const pickers = (
    <div className="flex-shrink-0 flex items-center gap-1.5">
      <ModelPicker readonly={!canEdit} />
      {canEdit && <ToolPicker />}
    </div>
  )

  const micButton =
    chatHost.voice && voice.isAvailable && !isStreaming ? (
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
              {Math.floor(voice.duration / 60)}:{String(voice.duration % 60).padStart(2, '0')}
            </span>
          </div>
        ) : (
          <Mic size={14} />
        )}
      </button>
    ) : null

  const sendStopButtons = isStreaming ? (
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
  )

  return (
    <div
      className={
        isNotebook
          ? // 悬浮：绝对定位贴底，容器透明 + 不拦截指针，仅输入框本体接收事件，背景不遮挡正文
            `absolute bottom-0 left-0 right-0 pointer-events-none transition-colors ${
              isDragging ? 'bg-accent/5' : ''
            }`
          : `bg-bg-primary transition-colors ${
              isDragging ? 'border-t border-accent border-dashed bg-accent/5' : ''
            }`
      }
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={`max-w-3xl mx-auto p-2 ${isNotebook ? 'pointer-events-auto' : ''}`}>
        <div
          className={`border border-border-secondary/40 rounded-2xl ${
            isNotebook
              ? // 悬浮：磨砂模糊背景（透出并虚化正文）+ 柔和阴影
                'bg-bg-primary/80 backdrop-blur-md shadow-md'
              : 'bg-bg-primary shadow-sm'
          }`}
        >
          {/* 拖拽调节手柄（笔记本模式从简：不展示，靠内容自动增高） */}
          {!isNotebook && (
            <div
              onMouseDown={handleResizeStart}
              className="flex justify-center py-1 cursor-ns-resize group"
            >
              <div className="w-8 h-0.5 rounded-full bg-border-secondary group-hover:bg-text-tertiary transition-colors" />
            </div>
          )}
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

            {/* @ 工作区文件引用自动补全浮层 */}
            {at.showPopover && (
              <AtMentionPopover
                suggestions={at.suggestions}
                onSelect={applyAtSelect}
                selectedIndex={at.selectedIndex}
              />
            )}

            {/* 斜杠命令芯片：绝对定位在 textarea 首行，text-indent 让出空间 */}
            {slashChip && (
              <span
                ref={chipRef}
                className="absolute left-4 top-2 z-10 pointer-events-auto text-sm"
              >
                <TokenChip
                  token={{
                    type: 'cmd',
                    id: slashChip.commandId,
                    displayText: `/${slashChip.commandId}`,
                    payload: expandCommandTemplate(slashChip.template, inputText.trim()),
                    name: slashChip.name
                  }}
                />
              </span>
            )}

            {/* @ 引用镜像层：覆于 textarea 之上，仅把引用画成胶囊（非引用文字透明露出下层，逐字对齐） */}
            <MentionHighlighter
              ref={backdropRef}
              text={inputText}
              mentions={at.mentions}
              className={`absolute inset-0 z-[2] pointer-events-none select-none overflow-hidden whitespace-pre-wrap break-words text-sm text-transparent px-4 pt-2 ${
                isNotebook ? 'pb-2' : 'pb-9'
              }`}
              style={{
                minHeight: `${minH}px`,
                textIndent: chipWidth > 0 ? `${chipWidth + 4}px` : undefined
              }}
            />

            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => handleInputChange(e.target.value, e.target.selectionStart)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onScroll={(e) => {
                if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop
              }}
              placeholder={
                isStreaming
                  ? t('input.placeholderSteer')
                  : slashChip
                    ? t('input.placeholder')
                    : modelSupportsVision
                      ? t('input.placeholderVision')
                      : t('input.placeholder')
              }
              rows={isNotebook ? 1 : 3}
              style={{
                minHeight: `${minH}px`,
                textIndent: chipWidth > 0 ? `${chipWidth + 4}px` : undefined
              }}
              className={`relative z-[1] w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary px-4 pt-2 resize-none outline-none overflow-y-auto ${
                isNotebook ? 'pb-2' : 'pb-9'
              }`}
            />

            {/* 普通会话：Compact + Mic + Send/Stop 按钮保留在输入框右下角（绝对定位） */}
            {!isNotebook && (
              <div className="absolute right-2 bottom-1.5 z-10 flex items-center gap-0.5">
                {hasHost && assistantMsgCount >= 1 && !isStreaming && !isCompacting && (
                  <button
                    onClick={() => activeSessionId && getHostApi()?.compact.start(activeSessionId)}
                    className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
                    title={t('compact.button')}
                  >
                    <Archive size={14} />
                  </button>
                )}
                {micButton}
                {sendStopButtons}
              </div>
            )}

            {/* 语音输入错误提示 */}
            {voice.error && (
              <div className="absolute right-2 bottom-12 z-20 rounded-md border border-error/30 bg-error/10 px-2 py-1 text-[11px] text-error whitespace-nowrap">
                {voice.error}
              </div>
            )}
          </div>

          {/* 笔记本：模型/工具选择器与按钮合并到输入框底部同一行（避免被正文遮挡、收纳进框内） */}
          {isNotebook && (
            <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-0.5 text-text-tertiary">
              {pickers}
              <span className="flex-1" />
              {micButton}
              {sendStopButtons}
            </div>
          )}
        </div>

        {/* 外置工具栏（位于对话框下方）—— 笔记本模式下选择器已并入框内，不再外置 */}
        {!isNotebook && (
          <div
            ref={toolbarRef}
            className="mt-1.5 px-1 flex items-center gap-2.5 text-text-tertiary whitespace-nowrap"
          >
            {pickers}

            {/* 弹性空白 → 把上下文指示器推到最右 */}
            <span className="flex-1" />

            {/* 上下文用量指示器（空间不足时隐藏，位于右侧） */}
            {showToolbarExtras && (maxContextTokens > 0 || usedContextTokens !== null) && (
              <span className="relative inline-flex items-center group/token">
                <span className="inline-flex items-center text-[11px] select-none text-text-tertiary">
                  {usedContextTokens !== null ? formatTokenCount(usedContextTokens) : '-'}
                  {maxContextTokens > 0 && (
                    <>
                      {' / '}
                      {formatTokenCount(maxContextTokens)}
                    </>
                  )}
                </span>
                {/* 悬浮 tooltip：详细用量 */}
                <div className="pointer-events-none absolute right-0 bottom-6 z-20 hidden rounded-md border border-border-primary bg-bg-secondary px-2 py-1 shadow-xl group-hover/token:block whitespace-nowrap">
                  <div className="text-[11px] text-text-primary">
                    {maxContextTokens > 0
                      ? t('input.contextUsage', {
                          used:
                            usedContextTokens !== null ? usedContextTokens.toLocaleString() : '-',
                          max: maxContextTokens.toLocaleString()
                        })
                      : t('input.contextUsageUnknownMax', {
                          used:
                            usedContextTokens !== null ? usedContextTokens.toLocaleString() : '-'
                        })}
                  </div>
                </div>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
