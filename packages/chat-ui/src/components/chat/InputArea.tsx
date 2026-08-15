import { getSessionChannelApi, getHostApi, useChatHost } from '@shuvix/chat-ui'
import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, Square, Mic, X } from 'lucide-react'
import { TokenChip } from './TokenChip'
import {
  expandCommandTemplate,
  buildCommandToken,
  parseSlashCommandInput,
  rebuildDraftFromContent
} from '@shuvix/chat-protocol/utils/inlineTokens'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import { useChatStore, selectIsStreaming, selectActivePendingInput } from '../../stores/chatStore'
import { useImageUpload } from '../../hooks/useImageUpload'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import { ModelPicker } from './ModelPicker'
import { ToolPicker } from './ToolPicker'
import { AgentProfilePicker } from './AgentProfilePicker'
import { SlashCommandPopover } from './SlashCommandPopover'
import { useSlashCommands } from '../../hooks/useSlashCommands'
import { AtMentionPopover } from './AtMentionPopover'
import { MentionHighlighter } from './MentionHighlighter'
import { useAtMentions } from '../../hooks/useAtMentions'
import { usePasteChips } from '../../hooks/usePasteChips'
import { isImeComposing } from '../../utils/ime'
import type { FileSuggestion } from '@shuvix/chat-protocol/utils/fileMap'

// 输入框高度：统一紧凑单行（44px，与原笔记本模式一致），内容超出自动增高至上限；不提供拖拽调高
const MIN_H = 44
const MAX_H = 480

export interface InputAreaProps {
  /**
   * 笔记本会话模式（仅行为差异，外观已与普通会话统一为悬浮卡片）：发送走 `agent.notebookPrompt`
   * （每次开启独立子智能体；子智能体上下文仅注入笔记本路径 + read 提示，正文由其自行读取）。
   * 无主 Agent → 不显示压缩归档 / Agent 信息 / 上下文用量，不参与草稿回退。
   * 模型/工具选择沿用 ModelPicker/ToolPicker（写会话配置 → 子智能体继承，与普通会话一致）。
   */
  notebook?: boolean
  /** 常规流内嵌模式（欢迎页）：外观同悬浮卡片，但随文档流布局、不绝对定位贴底 */
  inline?: boolean
  /** 卡片顶部插槽（待处理输入面板）：渲染进卡片内部第一格，与输入区共用同一张卡片的边框与圆角 */
  accessory?: React.ReactNode
  /** 输入区整体（卡片 + 外边距）高度变化回调，卸载时回调 0；宿主用于给消息列表留出底部空白 */
  onHeightChange?: (height: number) => void
}

/**
 * 输入区域 — 消息输入框 + 发送/停止按钮
 * 支持 Shift+Enter 换行，Enter 发送
 *
 * 有待处理输入请求（审批/选择/SSH）时，本输入框同时就是「其它」反馈入口：
 * 卡片顶部长出 PendingInputsPanel，描边转语义色，回车/发送投递 `kind: 'other'` 给选中的那条请求
 * （后端工具收到 other 时不执行副作用，把文本作为 tool result 返回 AI），而不是发普通消息或 steer。
 */
export function InputArea({
  notebook,
  inline,
  accessory,
  onHeightChange
}: InputAreaProps = {}): React.JSX.Element {
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
  // 待处理输入请求（步进器选中的那条）——非空时输入框改投「其它」反馈，并按 kind 换描边色
  const activePendingInput = useChatStore(selectActivePendingInput)
  const pendingTone: 'warning' | 'accent' | null = !activePendingInput
    ? null
    : activePendingInput.kind === 'approval'
      ? 'warning'
      : 'accent'
  // 渠道端（无 HostApi）只读：禁用一切会话配置编辑（模型/工具等）
  const hasHost = getHostApi() !== null
  const canEdit = hasHost
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
  // 长文粘贴折叠为芯片（占位明文进 textarea，完整内容随 paste 类型 InlineToken 发送）
  const paste = usePasteChips()
  // 背景镜像层（画 @ / 粘贴胶囊）—— 与 textarea 同步 scrollTop
  const backdropRef = useRef<HTMLDivElement>(null)
  // 程序化改写文本后待应用的光标位置（select / 整体退格）
  const pendingCaretRef = useRef<number | null>(null)

  // 斜杠命令芯片：选中命令后以 badge 展示，输入框只显示参数
  const [slashChip, setSlashChip] = useState<{
    commandId: string
    name: string
    description: string
    template: string
    /** 命令来源（'skill' 走 skill 徽章渲染） */
    kind?: 'project' | 'skill'
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
            template: cmd.template,
            kind: cmd.kind
          })
          setInputText(value.slice(spaceIdx + 1))
          return
        }
      }
      setInputText(value)
      at.prune(value)
      paste.prune(value)
      at.refresh(value, caret)
    },
    [slashChip, slashCommands, setInputText, at, paste]
  )

  // 消息回退：把历史消息重建为可编辑草稿——paste/at 重新登记恢复胶囊，cmd 转 /id 明文（发送时重新解析）。
  // 直接回填裸 content 会让 {{shuvixInlineToken}} 标记失去 metadata → token 失效丢信息。
  const draftRestore = useChatStore((s) => s.draftRestoreRequest)
  useEffect(() => {
    if (!draftRestore || isNotebook) return
    useChatStore.getState().clearDraftRestore()
    const { text, atTokens, pasteTokens } = rebuildDraftFromContent(
      draftRestore.content,
      draftRestore.inlineTokens
    )
    if (pasteTokens.length > 0) paste.restoreFromTokens(pasteTokens)
    if (atTokens.length > 0) at.restoreFromTokens(atTokens)
    setInputText(text)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [draftRestore, isNotebook, at, paste, setInputText])

  /** 粘贴处理：图片交给 useImageUpload；超阈值长文本折叠为粘贴芯片（短文本走默认粘贴） */
  const handleTextareaPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      handlePaste(e) // 图片粘贴（不 preventDefault，与文本分支互不影响）
      const clip = e.clipboardData.getData('text/plain')
      if (!clip) return
      const el = e.currentTarget
      const res = paste.capture(clip, inputText, el.selectionStart, el.selectionEnd)
      if (!res) return
      e.preventDefault()
      setInputText(res.text)
      // 选区替换可能吞掉其他占位/引用 → 同步剪除
      at.prune(res.text)
      paste.prune(res.text)
      pendingCaretRef.current = res.caret
    },
    [handlePaste, paste, at, inputText, setInputText]
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

  /** 自动调整文本框高度（内容超出时自动扩展） */
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(Math.max(el.scrollHeight, MIN_H), MAX_H) + 'px'
  }, [inputText])

  /** 程序化改写文本（@ 选中 / 整体退格）后应用待定光标 */
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (el && pendingCaretRef.current != null) {
      const pos = pendingCaretRef.current
      pendingCaretRef.current = null
      el.selectionStart = el.selectionEnd = pos
    }
  }, [inputText])

  // 输入区整体高度上报（含外边距）：宿主据此给消息列表留出底部空白，避免悬浮卡片遮住末尾消息。
  // 回调应传稳定引用（useCallback）；变更时重建观察器并立即重报当前高度
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = wrapRef.current
    if (!el || !onHeightChange) return
    const ro = new ResizeObserver(() => onHeightChange(el.offsetHeight))
    ro.observe(el)
    return () => {
      ro.disconnect()
      onHeightChange(0)
    }
  }, [onHeightChange])

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
    },
    [activeSessionId]
  )

  /**
   * 构造发送文本 + 内联 Token（slash 命令 / skill 展开 + @ 文件引用 + 粘贴芯片）—— 主会话与笔记本会话共用。
   * - slash 命令：payload 为整条替换，无法与 at token 混用，故先把 @ 引用就地展开为 payload 文本内联进参数；
   *   粘贴芯片保留 {{token}} 标记进参数（resolveTokensForAgent 对 cmd payload 二次替换展开），
   *   聊天记录里命令参数仍显示为胶囊而非全文。
   * - 普通消息：@ 引用 / 粘贴占位逐个替换为 {{token}} 标记 + 构造 at / paste 类型 InlineToken（保留周围文字）。
   */
  const buildSlashOutgoing = useCallback(
    (
      raw: string,
      sid: string | null
    ): { contentText: string; inlineTokens?: Record<string, InlineToken> } => {
      if (slashChip) {
        const pasteOut = paste.buildOutgoing(at.resolveInline(raw))
        const r = buildCommandToken(slashChip, pasteOut.contentText, {
          sessionId: sid ?? undefined
        })
        return {
          contentText: r.contentText,
          inlineTokens: { ...r.inlineTokens, ...pasteOut.inlineTokens }
        }
      }
      if (raw.startsWith('/')) {
        const pasteOut = paste.buildOutgoing(at.resolveInline(raw))
        const parsed = parseSlashCommandInput(pasteOut.contentText, slashCommands, {
          sessionId: sid ?? undefined
        })
        if (parsed) {
          autoEnableRequiredTools(parsed.command.requiredTools)
          return {
            contentText: parsed.contentText,
            inlineTokens: { ...parsed.inlineTokens, ...pasteOut.inlineTokens }
          }
        }
      }
      const atOut = at.buildOutgoing(raw)
      const pasteOut = paste.buildOutgoing(atOut.contentText)
      if (!atOut.inlineTokens && !pasteOut.inlineTokens) {
        return { contentText: pasteOut.contentText }
      }
      return {
        contentText: pasteOut.contentText,
        inlineTokens: { ...atOut.inlineTokens, ...pasteOut.inlineTokens }
      }
    },
    [slashChip, slashCommands, autoEnableRequiredTools, at, paste]
  )

  /** 无会话时自动创建临时会话（欢迎页直接发送时使用）。创建属宿主能力；渠道端总有当前会话，不会触发 */
  const createSessionForSend = async (): Promise<string | null> => {
    const host = getHostApi()
    if (!host) return null
    const session = await host.session.create()
    const sid = session.id
    // 欢迎页先选了档案：会话此刻才存在，把选择落到它身上（连带档案声明的模型/工具种子）
    const pending = useChatStore.getState().pendingAgentProfile
    if (pending) {
      const switched = await host.session.updateAgentProfile({ id: sid, name: pending })
      useChatStore.getState().setPendingAgentProfile(null)
      if (switched.success && switched.applied) applyProfileSeed(switched.applied)
    }
    await getSessionChannelApi().agent.init({ sessionId: sid })
    const sessions = await host.session.list()
    const s = useChatStore.getState()
    s.setSessions(sessions)
    s.setActiveSessionId(sid)
    return sid
  }

  /**
   * 应用切档案带来的配置种子：后端已把模型 / 工具勾选写进会话树，这里只同步前端显示 ——
   * 不能回调 setModel / setEnabledTools，那会在树上多写一条重复的 change entry。
   * 模型部分的落点与 ModelPicker 选中模型后的那套一致。
   */
  const applyProfileSeed = (applied: {
    model?: { provider: string; model: string; capabilities: ModelCapabilities }
    tools: string[]
  }): void => {
    const store = useChatStore.getState()
    store.setEnabledTools(applied.tools)
    if (!applied.model) return
    chatHost.models.setActiveProvider(applied.model.provider)
    chatHost.models.setActiveModel(applied.model.model)
    store.setModelSupportsVision(!!applied.model.capabilities.vision)
    store.setMaxContextTokens(applied.model.capabilities.maxInputTokens || 0)
    store.setUsedContextTokens(null)
  }

  /** 清空输入态（正文 / 图片 / 命令芯片 / @ 引用 / 粘贴芯片），发送与纯切档案共用 */
  const resetComposer = (): void => {
    const store = useChatStore.getState()
    store.setInputText('')
    store.clearPendingImages()
    setSlashChip(null)
    at.reset()
    paste.reset()
  }

  /** 把一条用户消息发给主会话 Agent：清空输入态 → 置流式态 → agent.prompt */
  const sendToMainAgent = async (
    sid: string,
    outgoing: { contentText: string; inlineTokens?: Record<string, InlineToken> },
    images: typeof pendingImages
  ): Promise<void> => {
    resetComposer()
    const store = useChatStore.getState()
    store.setIsStreaming(sid, true)
    store.clearStreamingContent(sid)
    // 后端直接使用附带的图片 + 内联 Token，不再重复查询
    await getSessionChannelApi().agent.prompt({
      sessionId: sid,
      text: outgoing.contentText,
      images:
        images.length > 0
          ? images.map((img) => ({
              type: 'image' as const,
              data: img.data,
              mimeType: img.mimeType
            }))
          : undefined,
      inlineTokens: outgoing.inlineTokens
    })
  }

  /**
   * 有待处理请求时：正文作为「其它」反馈投给选中的那条。
   * 图片不随 tool result 回传，故只清文本相关输入态，留着图片给下一条普通消息。
   */
  const handleSubmitOther = async (): Promise<void> => {
    if (!activePendingInput || !activeSessionId) return
    // 该通道不携带 inlineTokens → 粘贴芯片就地展开为完整原文
    const text = paste.resolveInline(inputText.trim())
    if (!text) return
    useChatStore.getState().setInputText('')
    at.reset()
    paste.reset()
    await getSessionChannelApi().agent.respondToInput({
      sessionId: activeSessionId,
      requestId: activePendingInput.id,
      response: { kind: 'other', text }
    })
    // 后端 resolve 后广播 input_request_resolved → store 自动移除该 pending
  }

  /** 发送消息（支持图片） */
  const handleSend = async (): Promise<void> => {
    // 录音中则先停止录制
    if (voice.isRecording) voice.stopRecording()

    // 待处理请求优先于一切发送路径（普通消息 / steer / 档案切换）：Agent 正等这条输入
    if (activePendingInput) {
      await handleSubmitOther()
      return
    }

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
      paste.reset()
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
    let sid = activeSessionId
    if (!sid) {
      sid = await createSessionForSend()
      if (!sid) return
    }

    // ─── 前端斜杠命令展开 + Token 构造（与笔记本会话共用 buildSlashOutgoing） ───
    const outgoing = buildSlashOutgoing(rawText, sid)
    await sendToMainAgent(
      sid,
      {
        // 纯图片消息（无文本无命令）回退占位文案
        contentText: outgoing.inlineTokens
          ? outgoing.contentText
          : outgoing.contentText || t('input.imageOnly'),
        inlineTokens: outgoing.inlineTokens
      },
      images
    )
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
    // steer 通道不携带 inlineTokens → 粘贴芯片就地展开为完整原文
    const text = paste.resolveInline(inputText.trim())
    if (!text || !activeSessionId) return
    const store = useChatStore.getState()
    store.setInputText('')
    paste.reset()
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
        template: cmd?.template || '',
        kind: cmd?.kind
      })
      setInputText('')
      setTimeout(() => textareaRef.current?.focus(), 0)
      autoEnableRequiredTools(cmd?.requiredTools)
    },
    [slashCommands, setInputText, autoEnableRequiredTools]
  )

  /** 键盘事件处理 */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // 输入法组字中：回车是「确认选词」、上下键是候选翻页、退格是删字母，全部交还输入法。
    // 不拦截的话，中文/日文/韩文用户选词的那一下回车会把半成品文本直接发出去
    if (isImeComposing(e)) return

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

    // Backspace 光标紧邻 @ 引用 / 粘贴芯片尾部：整体删除（一次退格删掉整颗胶囊）
    if (e.key === 'Backspace' && !at.showPopover) {
      const el = textareaRef.current
      if (el && el.selectionStart === el.selectionEnd) {
        const res =
          at.backspace(inputText, el.selectionStart) ??
          paste.backspace(inputText, el.selectionStart)
        if (res) {
          e.preventDefault()
          setInputText(res.text)
          at.prune(res.text)
          paste.prune(res.text)
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
      // streaming 时发送 steer 消息（有待处理请求时除外 —— handleSend 会路由到「其它」反馈）
      if (isStreaming && !activePendingInput) {
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

  // ─── 上下文用量环形指示器（普通会话）──
  // 合并原「文本计数 + Agent 信息按钮」：环的填充 = 已用占比，hover 出精确数字，点击打开 Agent 信息弹窗
  const ctxFraction =
    maxContextTokens > 0 && usedContextTokens !== null
      ? Math.min(usedContextTokens / maxContextTokens, 1)
      : null
  const ctxNearLimit = ctxFraction !== null && ctxFraction >= 0.75
  // hover 背景（bg-hover）与灰色环对比不足 → hover 时轨道/中性弧同步加深一档保持可读
  const ctxRingColor =
    ctxFraction !== null && ctxFraction >= 0.9
      ? 'text-error'
      : ctxNearLimit
        ? 'text-warning'
        : 'text-text-secondary group-hover/token:text-text-primary'
  const ctxTooltip =
    maxContextTokens > 0
      ? t('input.contextUsage', {
          used: usedContextTokens !== null ? usedContextTokens.toLocaleString() : '-',
          max: maxContextTokens.toLocaleString()
        })
      : t('input.contextUsageUnknownMax', {
          used: usedContextTokens !== null ? usedContextTokens.toLocaleString() : '-'
        })
  // 环参数：r=6 → 周长 2πr；dasharray 首段为填充弧长
  const CTX_RING_C = 2 * Math.PI * 6

  // ─── 复用片段：模型/工具选择器 + 麦克风 + 发送/停止 ──
  // 统一布局：全部收纳进卡片底部同一行（普通会话另在右侧追加上下文用量 / Agent 信息 / 压缩入口）。
  const pickers = (
    <div className="flex-shrink-0 flex items-center gap-1.5">
      {/* 档案选择器居首：档案决定系统提示词与内置工具白名单，是三者里最上位的一层。
          笔记本会话没有根 Agent（每次发送都是一次性子代理），没有可切的会话档案 */}
      {canEdit && !isNotebook && (
        <AgentProfilePicker disabled={isStreaming} onApplied={applyProfileSeed} />
      )}
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
      {/* 有待处理请求 → 投「其它」反馈（按 kind 取语义色）；否则是 steer */}
      <button
        onClick={activePendingInput ? handleSubmitOther : handleSteer}
        disabled={!inputText.trim()}
        className={`p-1.5 rounded-lg transition-colors ${
          !inputText.trim()
            ? 'text-text-tertiary cursor-not-allowed'
            : pendingTone === 'accent'
              ? 'bg-accent text-white hover:bg-accent-hover'
              : 'bg-warning text-white hover:bg-warning/80'
        }`}
        title={activePendingInput ? t('pendingInputs.submitOther') : t('input.steer')}
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
        inline
          ? // 内嵌（欢迎页）：随文档流布局，仅保留拖拽高亮
            `transition-colors ${isDragging ? 'bg-accent/5' : ''}`
          : // 悬浮：绝对定位贴底，容器透明 + 不拦截指针，仅输入框本体接收事件，背景不遮挡正文
            `absolute bottom-0 left-0 right-0 pointer-events-none transition-colors ${
              isDragging ? 'bg-accent/5' : ''
            }`
      }
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        ref={wrapRef}
        className={`relative max-w-3xl mx-auto p-2 ${inline ? '' : 'pointer-events-auto'}`}
      >
        {/* 卡片本体：磨砂模糊背景（悬浮时透出并虚化正文）+ 柔和阴影。
            有待处理请求时整张卡片换语义描边 + 一圈极淡外环 —— 「你要打字的这个框在问你话」 */}
        <div
          className={`border rounded-2xl bg-bg-primary/80 backdrop-blur-md shadow-md transition-colors ${
            pendingTone === 'warning'
              ? 'border-warning/45 ring-[3px] ring-warning/10'
              : pendingTone === 'accent'
                ? 'border-accent/45 ring-[3px] ring-accent/10'
                : 'border-border-secondary/40'
          }`}
        >
          {/* 卡片顶格：待处理输入面板（自身无边框/阴影，只用 border-b 与输入区分隔） */}
          {accessory}

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

            {/* @ 引用 / 粘贴芯片镜像层：覆于 textarea 之上，仅把命中画成胶囊（其余文字透明露出下层，逐字对齐） */}
            <MentionHighlighter
              ref={backdropRef}
              text={inputText}
              mentions={at.mentions}
              pasteChips={paste.chips}
              className="absolute inset-0 z-[2] pointer-events-none select-none overflow-hidden whitespace-pre-wrap break-words text-sm text-transparent px-4 pt-2 pb-2"
              style={{
                minHeight: `${MIN_H}px`,
                textIndent: chipWidth > 0 ? `${chipWidth + 4}px` : undefined
              }}
            />

            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => handleInputChange(e.target.value, e.target.selectionStart)}
              onKeyDown={handleKeyDown}
              onPaste={handleTextareaPaste}
              onScroll={(e) => {
                if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop
              }}
              placeholder={
                activePendingInput
                  ? t('pendingInputs.otherPlaceholder')
                  : isStreaming
                    ? t('input.placeholderSteer')
                    : slashChip
                      ? t('input.placeholder')
                      : modelSupportsVision
                        ? t('input.placeholderVision')
                        : t('input.placeholder')
              }
              rows={1}
              style={{
                minHeight: `${MIN_H}px`,
                textIndent: chipWidth > 0 ? `${chipWidth + 4}px` : undefined
              }}
              className="relative z-[1] w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary px-4 pt-2 pb-2 resize-none outline-none overflow-y-auto"
            />

            {/* 语音输入错误提示 */}
            {voice.error && (
              <div className="absolute right-2 bottom-full mb-1 z-20 rounded-md border border-error/30 bg-error/10 px-2 py-1 text-[11px] text-error whitespace-nowrap">
                {voice.error}
              </div>
            )}
          </div>

          {/* 底部工具行（统一布局）：选择器居左；普通会话在右侧追加上下文用量环 / 压缩入口
              （笔记本会话无主 Agent，无这些项）；最右为麦克风 + 发送/停止 */}
          <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-0.5 text-text-tertiary whitespace-nowrap">
            {pickers}

            {/* 弹性空白 → 把右侧按钮簇推到最右 */}
            <span className="flex-1" />

            {/* 上下文用量环：填充 = 已用占比（≥75% 警示、≥90% 告警）；hover 出精确数字，
                点击揭示会话面板的 Agent 页（信号交宿主外壳消费；Agent 未创建时该页会就地建出来）。
                渠道端（无 HostApi，无会话面板）仅展示不可点 */}
            {!isNotebook && (maxContextTokens > 0 || usedContextTokens !== null) && (
              <button
                type="button"
                onClick={
                  hasHost && activeSessionId
                    ? () => useChatStore.getState().requestAgentInfoReveal()
                    : undefined
                }
                aria-label={ctxTooltip}
                className={`relative group/token p-1 rounded flex items-center transition-colors ${
                  hasHost ? 'hover:bg-bg-hover' : 'cursor-default'
                }`}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" className="flex-shrink-0">
                  {/* 轨道 */}
                  <circle
                    cx="8"
                    cy="8"
                    r="6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    className="text-border-secondary group-hover/token:text-text-tertiary transition-colors"
                  />
                  {/* 填充弧（自顶部起顺时针；上限未知或零用量时不画） */}
                  {ctxFraction !== null && ctxFraction > 0 && (
                    <circle
                      cx="8"
                      cy="8"
                      r="6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeDasharray={`${ctxFraction * CTX_RING_C} ${CTX_RING_C}`}
                      transform="rotate(-90 8 8)"
                      className={`${ctxRingColor} transition-colors`}
                    />
                  )}
                </svg>
                {/* 悬浮 tooltip：精确用量 + 占比；可点击时提示 Agent 信息入口 */}
                <div className="pointer-events-none absolute right-0 bottom-7 z-20 hidden rounded-md border border-border-primary bg-bg-secondary px-2 py-1 shadow-xl group-hover/token:block whitespace-nowrap text-left">
                  <div className="text-[11px] text-text-primary">
                    {ctxTooltip}
                    {ctxFraction !== null ? ` · ${Math.round(ctxFraction * 100)}%` : ''}
                  </div>
                  {hasHost && (
                    <div className="mt-0.5 text-[10px] text-text-tertiary">
                      {t('agentInfo.button')}
                    </div>
                  )}
                </div>
              </button>
            )}

            {micButton}
            {sendStopButtons}
          </div>
        </div>
      </div>
    </div>
  )
}
