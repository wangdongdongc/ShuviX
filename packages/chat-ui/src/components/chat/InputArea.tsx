import { getSessionChannelApi, getHostApi, useChatHost } from '@shuvix/chat-ui'
import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, Square, X, Zap, CornerDownLeft, CirclePause, Lock } from 'lucide-react'
import { TokenChip } from './TokenChip'
import { QueuePanel } from './QueuePanel'
import { TaskListPanel } from './TaskListPanel'
import {
  expandCommandTemplate,
  buildCommandToken,
  parseSlashCommandInput,
  rebuildDraftFromContent
} from '@shuvix/chat-protocol/utils/inlineTokens'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import {
  useChatStore,
  selectIsStreaming,
  selectIsAgentClosing,
  selectActivePendingInput,
  selectSessionCapabilities,
  selectSessionRun,
  selectSessionSource,
  pendingPromptMessage
} from '../../stores/chatStore'
import { useImageUpload } from '../../hooks/useImageUpload'
import { ModelPicker } from './ModelPicker'
import { ToolPicker } from './ToolPicker'
import { addSessionTools } from '../../hooks/useSessionTools'
import { SlashCommandPopover } from './SlashCommandPopover'
import { useSlashCommands } from '../../hooks/useSlashCommands'
import { AtMentionPopover } from './AtMentionPopover'
import { CacheBreakConfirmHost } from './CacheBreakConfirm'
import { MentionHighlighter } from './MentionHighlighter'
import { useAtMentions, type AtSuggestion } from '../../hooks/useAtMentions'
import { usePasteChips } from '../../hooks/usePasteChips'
import { useSecretChips } from '../../hooks/useSecretChips'
import { useRedactionHints, type RedactionHintItem } from '../../hooks/useRedactionHints'
import { ComposerPlusMenu, RedactionHintBar } from './ComposerSecrets'
import type { UserSecret } from '@shuvix/chat-protocol/utils/redactionPlaceholders'
import { isImeComposing } from '../../utils/ime'
import { useClickOutside } from '../../hooks/useClickOutside'
import { useChatDensity } from '../../host/chatHostContext'

/**
 * 运行中的两个发送出口（P3-11 两档），顺序即急迫度从高到低：
 * 立即（pi steer，下个轮次边界插入）/ 追加（followUp，本轮本应结束时续跑）。
 *
 * Enter 绑第一个（运行中回车 = 立即）；追加没有快捷键（PIN-12）。两者落地的消息数据完全相同，
 * 差别只在 pi 把它插进 agent loop 的时机。排着的那些可以在队列面板里撤回。
 */
const QUEUE_TIERS = [
  { tier: 'steer' as const, Icon: Zap, primary: true },
  { tier: 'followUp' as const, Icon: CornerDownLeft, primary: false }
]

// 输入框高度：统一紧凑单行（44px，与原笔记本模式一致），内容超出自动增高至上限；不提供拖拽调高
const MIN_H = 44
const MAX_H = 480

export interface InputAreaProps {
  /** 常规流内嵌模式（欢迎页）：外观同悬浮卡片，但随文档流布局、不绝对定位贴底 */
  inline?: boolean
  /** 卡片最顶插槽（对话抽屉）：渲染在待处理输入面板之上，卡片首格的顶圆角由插槽内容自己承担 */
  thread?: React.ReactNode
  /** 卡片顶部插槽（待处理输入面板）：渲染进卡片内部第一格，与输入区共用同一张卡片的边框与圆角 */
  accessory?: React.ReactNode
  /** 输入区整体（卡片 + 外边距）高度变化回调，卸载时回调 0；宿主用于给消息列表留出底部空白 */
  onHeightChange?: (height: number) => void
}

/**
 * 输入区域 — 消息输入框 + 发送/停止按钮
 * 支持 Shift+Enter 换行，Enter 发送
 *
 * 有待处理输入请求（询问/选择/SSH）时，本输入框同时就是「其它」反馈入口：
 * 卡片顶部长出 PendingInputsPanel，描边转语义色，回车/发送投递 `kind: 'other'` 给选中的那条请求
 * （后端工具收到 other 时不执行副作用，把文本作为 tool result 返回 AI），而不是发普通消息或 steer。
 */
export function InputArea({
  inline,
  thread,
  accessory,
  onHeightChange
}: InputAreaProps = {}): React.JSX.Element {
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
  /**
   * 运行时正在关停（回退/切档案/清空触发）。一个会话只允许一个 Agent，新的要等旧的
   * 彻底停下才出生 —— 这期间任何发送都无处可去，直接拦在输入框。
   */
  const isAgentClosing = useChatStore(selectIsAgentClosing)
  // 待处理输入请求（步进器选中的那条）——非空时输入框改投「其它」反馈，并按 kind 换描边色
  const activePendingInput = useChatStore(selectActivePendingInput)
  const pendingTone: 'warning' | 'accent' | null = !activePendingInput
    ? null
    : activePendingInput.kind === 'ask'
      ? 'warning'
      : 'accent'
  /**
   * 上个进程退出时这条会话正在跑（P3-12，Q-P3-10）：输入卡片顶上一条横幅 +「继续」，下面一行提示「直接发新消息
   * 也行，会先停掉被中断的那一轮」—— 发送照常走 `agent.prompt`，运行时先中止再发（abort-then-send）。
   * 横幅只跟着视图的 `run.state` 走，从不乐观收起（PIN-17）
   */
  const run = useChatStore(selectSessionRun)
  const source = useChatStore(selectSessionSource)
  const isInterrupted = !!activeSessionId && source === 'durable' && run.state === 'interrupted'
  /**
   * 旧格式会话（P4-01，§2A）：输入卡片里只有一条只读横幅。只看视图的
   * `source`，不看能力位 —— 与上面的中断横幅互斥（那条只认 durable），两条永远不会同时出现
   */
  const isLegacy = !!activeSessionId && source === 'legacy'
  /**
   * 这条会话不能发消息（`capabilities.send:false`，Q-P3-21：旧格式会话即如此）。
   * 还没收到视图时按新会话的口径（能发）
   */
  const canSendInSession = useChatStore((s) => selectSessionCapabilities(s).send)
  const sendBlocked = !!activeSessionId && !canSendInSession
  // 渠道端（无 HostApi）只读：禁用一切会话配置编辑（模型/工具等）
  const hasHost = getHostApi() !== null
  const canEdit = hasHost
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { isDragging, handleDragOver, handleDragLeave, handleDrop, handlePaste, handleImageFiles } =
    useImageUpload(modelSupportsVision)
  // 「+」背后的文件选择（手机上没有拖放，粘贴图片也少见：这是那里唯一的附图入口）
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 默认模型
  const chatHost = useChatHost()
  const activeModel = chatHost.models.activeModel
  /**
   * 触屏密度（手机布局）：工具行的控件放大到 36px、发送 / 停止是圆钮；回车换行（手机键盘没有 Shift+回车，
   * 回车就发送的话写不了第二行）、只有发送键发送；运行中只出一个「立即」，长按才选「追加」
   */
  const touch = useChatDensity() === 'touch'
  // 运行中长按「立即」弹出的两档发法。记下弹出时的那段文字：文字变了（发掉、被别处改掉）菜单就不算数；
  // 一敲键（handleInputChange）、运行起停（下面）都直接关掉 —— 改回同样的字、下一轮恰好同样的字，它都不自己冒出来
  const [queueMenuFor, setQueueMenuFor] = useState<string | null>(null)
  const [menuRunState, setMenuRunState] = useState(isStreaming)
  if (menuRunState !== isStreaming) {
    // 运行起停时收起（渲染期调整状态，React 文档的「prop 变了就调整 state」写法）
    setMenuRunState(isStreaming)
    setQueueMenuFor(null)
  }
  const queueMenuOpen = queueMenuFor !== null && queueMenuFor === inputText && isStreaming
  const queueMenuRef = useRef<HTMLDivElement>(null)
  const closeQueueMenu = useCallback(() => setQueueMenuFor(null), [])
  useClickOutside(queueMenuRef, closeQueueMenu, queueMenuOpen)
  // 上下文用量环的数字：悬停之外点一下也出（触屏没有悬停）
  const [ctxOpen, setCtxOpen] = useState(false)
  const ctxRef = useRef<HTMLSpanElement>(null)
  const closeCtx = useCallback(() => setCtxOpen(false), [])
  useClickOutside(ctxRef, closeCtx, ctxOpen)

  // 斜杠命令自动补全
  const slash = useSlashCommands(slashCommands, inputText)

  // @ 引用自动补全（可在任意位置触发，可多个）：工作区文件
  const at = useAtMentions(activeSessionId)
  // 长文粘贴折叠为芯片（占位明文进 textarea，完整内容随 paste 类型 InlineToken 发送）
  const paste = usePasteChips()
  // 要对模型藏起来的值（docs/auto-redaction-design.md §14）：+ 添加的、确认了提示的。发送时随 secrets 交给宿主
  const secrets = useSecretChips()
  // 提示：可能是敏感信息的几处 —— 只提示，点了才藏；不理会的照原样发
  const hints = useRedactionHints({
    sessionId: activeSessionId,
    provider: chatHost.models.activeProvider ?? undefined,
    model: activeModel ?? undefined,
    text: inputText,
    pastes: paste.chips.map((chip) => chip.payload),
    isHidden: secrets.isHidden,
    enabled: !sendBlocked
  })
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

  /**
   * 自动勾上命令依赖的扩展能力（fire-and-forget）。与工具选择器同一个写入口：会话已有 Agent
   * 运行时（勾选只读）/ 渠道端时什么也不做；`sid` 为 null（欢迎页）时并进草稿。
   * 目标会话由调用方给：欢迎页直接发送时命令在新会话建好之后才展开，依赖项要落到新会话上。
   */
  const autoEnableRequiredTools = useCallback(
    (requiredTools: string[] | undefined, sid: string | null): void => {
      if (!requiredTools?.length) return
      void addSessionTools(sid, requiredTools)
    },
    []
  )

  /**
   * 发送失败的原因（建会话 / 写配置 / 发出消息任一步抛错）。显示在卡片里，下一次输入或发送时清掉 ——
   * 失败时输入框文本与欢迎页草稿都还在，原样重试即可。
   */
  const [sendError, setSendError] = useState<string | null>(null)

  /**
   * 「继续」按下之后的那条会话（PIN-17）：按钮保持禁用，直到视图离开 interrupted 或调用失败 —— 调用本身要等
   * 整轮落定才回，界面不靠它的时机改形态。ref 挡连点（同一刻只发一次）
   */
  const [continuingFor, setContinuingFor] = useState<string | null>(null)
  const continuingRef = useRef(false)
  useEffect(() => {
    if (continuingFor !== null && (continuingFor !== activeSessionId || !isInterrupted)) {
      continuingRef.current = false
      setContinuingFor(null)
    }
  }, [continuingFor, activeSessionId, isInterrupted])

  const handleContinue = async (): Promise<void> => {
    const sid = activeSessionId
    if (!sid || continuingRef.current || isAgentClosing) return
    continuingRef.current = true
    setContinuingFor(sid)
    setSendError(null)
    try {
      const result = await getSessionChannelApi().agent.continue(sid)
      if (!result.success) throw new Error(result.error ?? 'continue failed')
    } catch (err) {
      if (useChatStore.getState().activeSessionId !== sid) return
      continuingRef.current = false
      setContinuingFor(null)
      setSendError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 输入变化处理：检测 "/commandId " 模式并自动转为芯片；同步 @ 引用触发态与登记表 */
  const handleInputChange = useCallback(
    (value: string, caret: number) => {
      setSendError(null)
      setQueueMenuFor(null)
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
          // 与从弹层选中同一处理：转成芯片的那一刻就勾上依赖（欢迎页并进草稿）。发送时芯片分支
          // 不再解析命令，错过这一刻依赖就永远不会被勾上
          autoEnableRequiredTools(cmd.requiredTools, useChatStore.getState().activeSessionId)
          return
        }
      }
      setInputText(value)
      at.prune(value)
      paste.prune(value)
      secrets.prune(value)
      at.refresh(value, caret)
    },
    [slashChip, slashCommands, setInputText, at, paste, secrets, autoEnableRequiredTools]
  )

  // 消息回退：把历史消息重建为可编辑草稿——paste/at 重新登记恢复胶囊，cmd 转 /id 明文（发送时重新解析）。
  // 直接回填裸 content 会让 {{shuvixInlineToken}} 标记失去 metadata → token 失效丢信息。
  const draftRestore = useChatStore((s) => s.draftRestoreRequest)
  useEffect(() => {
    if (!draftRestore) return
    useChatStore.getState().clearDraftRestore()
    const { text, atTokens, pasteTokens } = rebuildDraftFromContent(
      draftRestore.content,
      draftRestore.inlineTokens
    )
    if (pasteTokens.length > 0) paste.restoreFromTokens(pasteTokens)
    if (atTokens.length > 0) at.restoreFromTokens(atTokens)
    setInputText(text)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [draftRestore, at, paste, setInputText])

  // 登记「这个会话有输入框」（Files 面板据此给「在对话中引用」）。撤的时候只撤自己那条：换会话时
  // React 先跑旧的清理再跑新的登记，但别处的输入框若已登记了别的会话，不能被这里清掉
  useEffect(() => {
    if (!activeSessionId) return
    useChatStore.getState().setComposerSessionId(activeSessionId)
    return () => {
      if (useChatStore.getState().composerSessionId === activeSessionId) {
        useChatStore.getState().setComposerSessionId(null)
      }
    }
  }, [activeSessionId])

  // Files 面板右键「在对话中引用」：插在光标处（失焦的 textarea 仍记着光标），只认本会话的请求
  const mentionInsert = useChatStore((s) => s.mentionInsertRequest)
  useEffect(() => {
    if (!mentionInsert || mentionInsert.sessionId !== activeSessionId) return
    useChatStore.getState().clearMentionInsert()
    const text = useChatStore.getState().inputText
    const caret = textareaRef.current?.selectionStart ?? text.length
    const res = at.insert(mentionInsert.ref, mentionInsert.displayText, text, caret)
    setInputText(res.text)
    pendingCaretRef.current = res.caret
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [mentionInsert, activeSessionId, at, setInputText])

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
      secrets.prune(res.text)
      pendingCaretRef.current = res.caret
    },
    [handlePaste, paste, at, secrets, inputText, setInputText]
  )

  /** @ 引用选中：在光标处替换 @query → @token，登记引用，落回文本并置光标 */
  const applyAtSelect = useCallback(
    (s: AtSuggestion) => {
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
          autoEnableRequiredTools(parsed.command.requiredTools, sid)
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

  /**
   * 无会话时自动创建临时会话（欢迎页直接发送时使用）。创建属宿主能力；渠道端总有当前会话，不会触发。
   *
   * 欢迎页上的选择要在 Agent 创建之前落进新会话 —— 模型、思考档位与扩展能力都只在创建那一刻读
   * 一次。模型写选择器**此刻显示的**那个（所见即所得：没动过也是它，而不是让后端回落到默认模型、
   * 再把界面拨回去）。档位同样写显示的那一档，唯一的例外是它还是宿主启动时种的默认档
   * （`thinkingLevelIsDefault`）：那不是用户的选择，不写，由后端按与侧栏新建会话同一条规则回落
   * （模型声明了推理 → 设置里的默认档，否则 off）—— 否则没标推理能力的模型也会被显式写上默认档、
   * 原样发给上游。扩展能力与知识库写欢迎页的草稿，写完清空草稿。
   */
  const createSessionForSend = async (): Promise<string | null> => {
    const host = getHostApi()
    if (!host) return null
    const session = await host.session.create()
    const sid = session.id
    const welcome = useChatStore.getState()
    const { activeProvider, activeModel: pickedModel } = chatHost.models
    try {
      if (activeProvider && pickedModel) {
        await host.agent.setModel({ sessionId: sid, provider: activeProvider, model: pickedModel })
      }
      if (welcome.thinkingLevel && !welcome.thinkingLevelIsDefault) {
        await host.agent.setThinkingLevel({
          sessionId: sid,
          level: welcome.thinkingLevel as ThinkingLevel
        })
      }
      if (welcome.welcomeEnabledTools.length > 0) {
        await host.session.updateEnabledTools({
          id: sid,
          enabledTools: welcome.welcomeEnabledTools
        })
      }
      // 知识库没有锁，但系统提示词里的 `<knowledge_bases>` 围栏在创建 Agent 那一刻定型 —— 同样要先落下
      if (welcome.welcomeKnowledgeBases.length > 0) {
        await host.session.updateKnowledgeBases({
          id: sid,
          knowledgeBases: welcome.welcomeKnowledgeBases
        })
      }
    } catch (err) {
      // 配了一半的会话不留：重试会再建一条，留着它只会在侧栏里多出一条没人要的空会话
      await host.session.delete(sid).catch(() => undefined)
      throw err
    }
    welcome.setWelcomeEnabledTools([])
    welcome.setWelcomeKnowledgeBases([])
    await getSessionChannelApi().agent.init({ sessionId: sid })
    const sessions = await host.session.list()
    const s = useChatStore.getState()
    s.setSessions(sessions)
    s.setActiveSessionId(sid)
    return sid
  }

  /** 清空输入态（正文 / 图片 / 命令芯片 / @ 引用 / 粘贴芯片） */
  const resetComposer = (): void => {
    const store = useChatStore.getState()
    store.setInputText('')
    store.clearPendingImages()
    setSlashChip(null)
    at.reset()
    paste.reset()
    secrets.reset()
  }

  /** 把一条用户消息发给主会话 Agent：清空输入态 → 乐观占位（同时即流式态）→ agent.prompt */
  const sendToMainAgent = async (
    sid: string,
    outgoing: { contentText: string; inlineTokens?: Record<string, InlineToken> },
    images: typeof pendingImages,
    hidden: UserSecret[]
  ): Promise<void> => {
    // 乐观占位气泡里不出现要藏的真值（换回胶囊文字）：要在清空胶囊之前算
    const shown = {
      contentText: secrets.maskForDisplay(outgoing.contentText),
      inlineTokens:
        outgoing.inlineTokens && maskTokenPayloads(outgoing.inlineTokens, secrets.maskForDisplay)
    }
    resetComposer()
    const store = useChatStore.getState()
    // 乐观占位（Q-P3-07）：用户消息要等会话受理才出现在视图里，而创建运行时（含 MCP 惰性连接）
    // 可能要几秒 —— 输入框已清空、列表里却没这句话，像是消息丢了。先顶上（它在的时候界面就是
    // 「在跑」的形态），视图里出现这条用户消息即在同一次更新里换成真的
    store.touchSessionActive(sid)
    store.setPendingPrompt(
      sid,
      pendingPromptMessage(sid, shown.contentText, {
        inlineTokens: shown.inlineTokens,
        images: images.map((img) => ({ data: img.data, mimeType: img.mimeType }))
      })
    )
    try {
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
        inlineTokens: outgoing.inlineTokens,
        // 带上（哪怕是空的）= 输入框处理过：宿主只换这些，其余照原样发
        secrets: hidden
      })
    } finally {
      // 占位的兜底收尾。正常路径上视图早就把它换成真的了，这里兜两种它到不了的情况：整轮跑完仍没
      // 受理（发送被拒、prompt 以 {error} 落定），以及 prompt 本身抛出（IPC 把主进程的异常原样拒绝
      // 回来，没有 finally 的话占位会一直挂着）。**不能改由 error 事件撤** —— 见 useAgentEvents
      useChatStore.getState().setPendingPrompt(sid, null)
    }
  }

  /**
   * 有待处理请求时：正文作为「其它」反馈投给选中的那条。
   * 图片不随 tool result 回传，故只清文本相关输入态，留着图片给下一条普通消息。
   */
  const handleSubmitOther = async (): Promise<void> => {
    if (!activePendingInput || !activeSessionId) return
    // 该通道不携带 inlineTokens → 粘贴芯片就地展开为完整原文；要藏的值展开回真值、随 secrets 交出去
    const { text, secrets: hidden } = secrets.expand(paste.resolveInline(inputText.trim()))
    if (!text) return
    useChatStore.getState().setInputText('')
    at.reset()
    paste.reset()
    secrets.reset()
    await getSessionChannelApi().agent.respondToInput({
      sessionId: activeSessionId,
      requestId: activePendingInput.id,
      response: { kind: 'other', text, secrets: hidden }
    })
    // 询问落定后视图里就没有它了 → store 自动移除该 pending
  }

  /**
   * 发送消息（支持图片）。回车与发送按钮都走这里，两处都不 await —— 失败必须在这里接住：
   * 否则是一条没人处理的 rejection，用户眼里什么也没发生
   */
  const handleSend = async (): Promise<void> => {
    setSendError(null)
    try {
      await sendMessage()
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    }
  }

  const sendMessage = async (): Promise<void> => {
    // 待处理请求优先于一切发送路径（普通消息 / steer / 档案切换）：Agent 正等这条输入
    if (activePendingInput) {
      await handleSubmitOther()
      return
    }

    // 没选中模型不发。守卫必须落在这里而不是只挂在按钮的 disabled 上 ——
    // 回车走的是 handleKeyDown → handleSend，根本不经过按钮，
    // 否则会出现「按钮灰着、回车照发」（Agent 被建起来并落下一轮消息）。
    if (!activeModel) return

    const rawText = inputText.trim()
    const images = pendingImages

    // 有芯片时即使参数为空也允许发送（纯命令）
    if (
      (!rawText && !slashChip && images.length === 0) ||
      isStreaming ||
      isAgentClosing ||
      sendBlocked
    )
      return

    // 无会话则自动创建临时会话（欢迎页直接发送时走这条路径）。
    let sid = activeSessionId
    if (!sid) {
      sid = await createSessionForSend()
      if (!sid) return
    }

    // ─── 要藏的值的胶囊展开回真值 + 前端斜杠命令展开 + Token 构造 ───
    const expanded = secrets.expand(rawText)
    const outgoing = buildSlashOutgoing(expanded.text, sid)
    await sendToMainAgent(
      sid,
      {
        // 纯图片消息（无文本无命令）回退占位文案
        contentText: outgoing.inlineTokens
          ? outgoing.contentText
          : outgoing.contentText || t('input.imageOnly'),
        inlineTokens: outgoing.inlineTokens
      },
      images,
      expanded.secrets
    )
  }

  /** 中止生成（后端统一处理落库 + Agent 上下文同步） */
  const handleAbort = async (): Promise<void> => {
    if (!activeSessionId) return
    // 已生成的部分内容由运行时自己落成条目（stopReason='aborted'），流式态随视图的运行状态收起
    await getSessionChannelApi().agent.abort(activeSessionId)
  }

  /**
   * 把当前输入投进 pi 的某条用户消息队列（立即 / 追加）。
   *
   * 队列通道不携带 inlineTokens（harness 在 drain 那一刻才写 user 消息，
   * 显示侧车没法紧邻它落盘）→ 粘贴芯片就地展开为完整原文。
   */
  const handleQueueSend = async (tier: 'steer' | 'followUp'): Promise<void> => {
    const { text, secrets: hidden } = secrets.expand(paste.resolveInline(inputText.trim()))
    if (!text || !activeSessionId) return
    const store = useChatStore.getState()
    store.setInputText('')
    paste.reset()
    secrets.reset()
    const api = getSessionChannelApi().agent
    // 竞态保护：点下去的那一刻 run 可能刚好结束（视图已是 idle / interrupted）—— 两档都退回普通 prompt
    // （中断态的发送由运行时先中止再发）；关停中哪儿也不发
    if (useChatStore.getState().sessionClosing[activeSessionId]) return
    const stillStreaming = store.sessionStreams[activeSessionId]?.isStreaming
    if (!stillStreaming) {
      await api.prompt({ sessionId: activeSessionId, text, secrets: hidden })
      return
    }
    await api[tier]({ sessionId: activeSessionId, text, secrets: hidden })
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
      autoEnableRequiredTools(cmd?.requiredTools, useChatStore.getState().activeSessionId)
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

    // Backspace 光标紧邻 @ 引用 / 粘贴芯片尾部：整体删除（一次退格删掉整颗胶囊）
    if (e.key === 'Backspace' && !at.showPopover) {
      const el = textareaRef.current
      if (el && el.selectionStart === el.selectionEnd) {
        const res =
          at.backspace(inputText, el.selectionStart) ??
          paste.backspace(inputText, el.selectionStart) ??
          secrets.backspace(inputText, el.selectionStart)
        if (res) {
          e.preventDefault()
          setInputText(res.text)
          at.prune(res.text)
          paste.prune(res.text)
          secrets.prune(res.text)
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

    // 触屏：回车就是换行，交给 textarea（发送只走发送键）；接了实体键盘的用 ⌘ / Ctrl + 回车发
    if (e.key === 'Enter' && !e.shiftKey && (!touch || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      // streaming 时发送 steer 消息（有待处理请求时除外 —— handleSend 会路由到「其它」反馈）
      if (isStreaming && !activePendingInput) {
        if (inputText.trim()) handleQueueSend('steer')
        return
      }
      handleSend()
    }
  }

  const canSend =
    (inputText.trim().length > 0 || pendingImages.length > 0 || !!slashChip) &&
    !isStreaming &&
    !isAgentClosing &&
    !sendBlocked &&
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
  // 窄卡片（手机）里位置不够时选择器先让：模型名继续截短；右侧的用量环与发送 / 停止从不收缩，
  // 不会被挤出卡片
  const pickers = (
    <div
      data-composer-pickers=""
      className={`min-w-0 flex items-center ${touch ? 'gap-2' : 'gap-1.5'}`}
    >
      <ModelPicker readonly={!canEdit} />
      {canEdit && <ToolPicker />}
    </div>
  )

  /** + 添加的敏感信息：放进选区（打开时选中了那段就替换它）或光标处，成为一个胶囊 */
  const addSecret = (
    value: string,
    category: string,
    range: { start: number; end: number } | null
  ): void => {
    const el = textareaRef.current
    const caret = el?.selectionStart ?? inputText.length
    const from = range?.start ?? caret
    const to = range?.end ?? caret
    const res = secrets.insert(value, category, inputText, from, to)
    setInputText(res.text)
    at.prune(res.text)
    paste.prune(res.text)
    pendingCaretRef.current = res.caret
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  /** 确认提示：这些值换成胶囊（文本里没有的 —— 在粘贴芯片里 —— 只记下值） */
  const hideHinted = (items: RedactionHintItem[]): void => {
    let text = inputText
    for (const item of items) text = secrets.hide(item.value, item.category, text)
    setInputText(text)
    at.prune(text)
    paste.prune(text)
  }

  // 「+」：添加图片（只在模型能看图时出现 —— 拖放、粘贴两条路也一样只对这种模型开）、添加敏感信息
  const attachButton = !sendBlocked ? (
    <>
      <ComposerPlusMenu
        touch={touch}
        images={modelSupportsVision}
        onImages={() => fileInputRef.current?.click()}
        onSecret={addSecret}
        selection={() => {
          const el = textareaRef.current
          if (!el) return null
          return {
            start: el.selectionStart,
            end: el.selectionEnd,
            text: inputText.slice(el.selectionStart, el.selectionEnd)
          }
        }}
      />
      {modelSupportsVision && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-attach-input=""
          onChange={(e) => {
            if (e.target.files?.length) void handleImageFiles(e.target.files)
            // 清空：同一张图再选一次也要触发 change
            e.target.value = ''
          }}
        />
      )}
    </>
  ) : null

  const queueDisabled = !inputText.trim()
  /** 圆钮（触屏）/ 小方钮（桌面）的外形；颜色由各个按钮自己给 */
  const roundCls = touch
    ? 'flex-shrink-0 h-9 w-9 rounded-full flex items-center justify-center transition-colors'
    : 'flex-shrink-0 p-1.5 rounded-lg transition-colors'
  const stopButton = (
    <button
      onClick={handleAbort}
      className={
        touch
          ? `${roundCls} bg-error/15 text-error active:bg-error/25`
          : 'p-1 rounded bg-error/20 text-error hover:bg-error/30 transition-colors'
      }
      title={t('input.stopGen')}
      aria-label={t('input.stopGen')}
    >
      <Square size={touch ? 13 : 14} fill="currentColor" />
    </button>
  )
  const touchQueue = (
    // 触屏运行中：一颗「立即」（回车在这里是换行，没有别的快捷出口），长按出两档的说明与「追加」；
    // 没打字时整颗不出，只剩停止 —— 和 Claude 的输入框一样
    <div ref={queueMenuRef} className="relative flex-shrink-0">
      <button
        data-queue-tier="steer"
        onClick={() => handleQueueSend('steer')}
        onContextMenu={(e) => {
          // 长按（手机外壳把按住半秒变成 contextmenu）/ 右键：弹出两档
          e.preventDefault()
          setQueueMenuFor(inputText)
        }}
        title={t('queue.touchSendHint')}
        aria-label={t('queue.steer')}
        style={{ WebkitTouchCallout: 'none' }}
        className={`${roundCls} select-none bg-warning text-white active:bg-warning/80`}
      >
        <Zap size={17} />
      </button>
      {queueMenuOpen && (
        <div
          data-queue-menu=""
          className="absolute bottom-full right-0 mb-2 z-30 w-64 overflow-hidden rounded-xl border border-border-primary bg-bg-secondary py-1 shadow-xl whitespace-normal"
        >
          {QUEUE_TIERS.map(({ tier, Icon }) => (
            <button
              key={tier}
              data-queue-tier={tier}
              onClick={() => {
                setQueueMenuFor(null)
                handleQueueSend(tier)
              }}
              className="w-full flex items-start gap-3 px-4 py-2.5 text-left active:bg-bg-hover"
            >
              <Icon size={16} className="mt-0.5 flex-shrink-0 text-text-secondary" />
              <span className="min-w-0">
                <span className="block text-[15px] text-text-primary">{t(`queue.${tier}`)}</span>
                <span className="block text-[12px] leading-snug text-text-tertiary">
                  {t(`queue.${tier}Hint`)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
  const sendStopButtons = isStreaming ? (
    <div className={`flex-shrink-0 flex items-center ${touch ? 'gap-2' : 'gap-1'}`}>
      {activePendingInput ? (
        // 待处理请求优先：这个按钮投「其它」反馈，不进队列
        <button
          onClick={handleSubmitOther}
          disabled={queueDisabled}
          className={`${touch ? roundCls : 'p-1.5 rounded-lg transition-colors'} ${
            queueDisabled
              ? touch
                ? 'bg-bg-tertiary text-text-tertiary'
                : 'text-text-tertiary cursor-not-allowed'
              : pendingTone === 'accent'
                ? 'bg-accent text-white hover:bg-accent-hover'
                : 'bg-warning text-white hover:bg-warning/80'
          }`}
          title={t('pendingInputs.submitOther')}
        >
          <Send size={touch ? 17 : 14} />
        </button>
      ) : touch ? (
        !queueDisabled && touchQueue
      ) : (
        // 两个发送出口 = pi 的两条队列。分段成一组：读作「一个发送控件的两个出口」，
        // 而不是两个各自独立的按钮
        <div className="flex items-center rounded-lg border border-border-secondary/60 overflow-hidden">
          {QUEUE_TIERS.map(({ tier, Icon, primary }, i) => (
            <button
              key={tier}
              data-queue-tier={tier}
              onClick={() => handleQueueSend(tier)}
              disabled={queueDisabled}
              title={t(`queue.${tier}Hint`)}
              aria-label={t(`queue.${tier}`)}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] transition-colors ${
                i > 0 ? 'border-l border-border-secondary/60' : ''
              } ${
                queueDisabled
                  ? 'text-text-tertiary cursor-not-allowed'
                  : primary
                    ? 'bg-warning text-white hover:bg-warning/80'
                    : 'text-text-secondary hover:bg-bg-hover'
              }`}
            >
              <Icon size={12} />
              {/* 窄卡片里只留图标：带字的两个出口加停止键会占掉整行，把选择器挤到它们底下；
                  按工具行自身的宽度判断（容器查询），桌面的对话栏都比这宽 */}
              <span className="hidden @[26rem]:inline">{t(`queue.${tier}`)}</span>
            </button>
          ))}
        </div>
      )}
      {stopButton}
    </div>
  ) : (
    <button
      onClick={handleSend}
      disabled={!canSend}
      className={`${roundCls} ${
        canSend
          ? 'bg-accent text-white hover:bg-accent-hover'
          : touch
            ? 'bg-bg-tertiary text-text-tertiary'
            : 'text-text-tertiary cursor-not-allowed'
      }`}
      title={t('input.send')}
      aria-label={t('input.send')}
    >
      <Send size={touch ? 17 : 14} />
    </button>
  )

  /** 旧格式会话（P4-01）的整张卡片内容：一行安静的说明（锁 + 次级文字色），没有任何操作 */
  const legacyNotice = (
    <div data-legacy-banner="" className="px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <Lock size={13} className="flex-shrink-0 text-text-tertiary" />
        <span
          data-legacy-text=""
          className="flex-1 min-w-0 text-xs leading-relaxed text-text-secondary"
        >
          {t('chat.legacySessionReadOnly')}
        </span>
      </div>
    </div>
  )

  return (
    <div
      className={
        inline
          ? // 内嵌（欢迎页）：随文档流布局，仅保留拖拽高亮
            `transition-colors ${isDragging ? 'bg-accent/5' : ''}`
          : // 悬浮：绝对定位贴底，容器透明 + 不拦截指针，仅输入框本体接收事件，背景不遮挡正文
            `absolute bottom-0 left-0 pointer-events-none transition-colors ${
              isDragging ? 'bg-accent/5' : ''
            }`
      }
      // 悬浮时右缘让出下面列表的滚动条（--chat-scrollbar-w，对话列由 Conversation 写入；没写过即 0）：
      // 正文按滚动容器的内容区居中，卡片也得在同一块宽度里居中，否则一出滚动条两者就错开半条
      style={inline ? undefined : { right: 'var(--chat-scrollbar-w, 0px)' }}
      // 只读会话没有附图入口，拖进来的图片无处可去
      onDragOver={isLegacy ? undefined : handleDragOver}
      onDragLeave={isLegacy ? undefined : handleDragLeave}
      onDrop={isLegacy ? undefined : handleDrop}
    >
      {/* 换模型 / 扩展能力会打穿提示词缓存时的确认框（画在 body 上） */}
      <CacheBreakConfirmHost />
      <div
        ref={wrapRef}
        className={`relative max-w-3xl mx-auto p-2 ${inline ? '' : 'pointer-events-auto'}`}
      >
        {/* 卡片本体：磨砂模糊背景（悬浮时透出并虚化正文）+ 柔和阴影。
            有待处理请求时整张卡片换语义描边 + 一圈极淡外环 —— 「你要打字的这个框在问你话」 */}
        <div
          className={`border rounded-2xl bg-bg-primary/80 backdrop-blur-md shadow-md transition-colors ${
            isLegacy
              ? 'border-border-secondary/40'
              : pendingTone === 'warning'
                ? 'border-warning/45 ring-[3px] ring-warning/10'
                : pendingTone === 'accent'
                  ? 'border-accent/45 ring-[3px] ring-accent/10'
                  : 'border-border-secondary/40'
          }`}
        >
          {/* 卡片最顶：对话抽屉（笔记本会话）—— 排在待处理输入之上，让审批紧邻输入区 */}
          {thread}

          {/* 旧格式会话（P4-01）：卡片里只剩这一行只读提示 —— 没有输入框、选择器与发送，看着就不是
              「一个坏掉的输入框」。有宿主时行尾附一个不起眼的 [新建对话]（渠道端没有建会话的能力） */}
          {isLegacy ? (
            legacyNotice
          ) : (
            <>
              {/* 任务列表（plan server，实验）：排在待处理输入之上 —— 审批 / 提问更急，要紧挨着输入框 */}
              <TaskListPanel />

              {/* 卡片顶格：待处理输入面板（自身无边框/阴影，只用 border-b 与输入区分隔） */}
              {accessory}

              {/* 待投递队列（可逐条撤回）。排在 accessory 之下 —— 待处理请求的优先级更高 */}
              <QueuePanel />

              {/* 被中断的运行（P3-12）：横幅 +「继续」，提示行在横幅可见时恒显示（PIN-20） */}
              {isInterrupted && (
                <div
                  data-interrupted-banner=""
                  className="px-3 pt-2.5 pb-2 border-b border-border-secondary/40"
                >
                  <div className="flex items-center gap-2">
                    <CirclePause size={14} className="flex-shrink-0 text-warning" />
                    <span
                      data-interrupted-text=""
                      className="flex-1 min-w-0 text-xs text-text-primary"
                    >
                      {t('run.interruptedBanner')}
                    </span>
                    <button
                      type="button"
                      data-interrupted-continue=""
                      onClick={handleContinue}
                      disabled={continuingFor === activeSessionId || isAgentClosing}
                      className={`flex-shrink-0 px-2.5 py-1 rounded-lg text-[11px] transition-colors ${
                        continuingFor === activeSessionId || isAgentClosing
                          ? 'bg-bg-hover text-text-tertiary cursor-not-allowed'
                          : 'bg-accent text-white hover:bg-accent-hover'
                      }`}
                    >
                      {t('run.interruptedContinue')}
                    </button>
                  </div>
                  <div
                    data-interrupted-hint=""
                    className="mt-1 pl-[22px] text-[11px] text-text-tertiary"
                  >
                    {t('run.interruptedHint')}
                  </div>
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
                        aria-label={t('common.delete')}
                        // 触屏没有悬浮：常驻且放大
                        className={`absolute -top-1.5 -right-1.5 rounded-full bg-error text-white flex items-center justify-center transition-opacity ${
                          touch ? 'w-6 h-6' : 'w-4 h-4 opacity-0 group-hover/img:opacity-100'
                        }`}
                      >
                        <X size={touch ? 13 : 10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {sendError && (
                <div data-send-error className="px-4 pt-2 text-xs text-error break-words">
                  {t('input.sendFailed', { error: sendError })}
                </div>
              )}

              <RedactionHintBar
                items={hints.items}
                touch={touch}
                onHide={hideHinted}
                onDismiss={hints.dismiss}
              />

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
                  secretChips={secrets.chips}
                  hintSpans={hints.spans}
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
                    if (backdropRef.current)
                      backdropRef.current.scrollTop = e.currentTarget.scrollTop
                  }}
                  disabled={sendBlocked}
                  placeholder={
                    // 旧格式会话根本不渲染输入框（P4-01），这里的只读提示只给 durable + `send:false`
                    sendBlocked
                      ? t('chat.legacySessionReadOnly')
                      : isAgentClosing
                        ? t('input.placeholderClosing')
                        : activePendingInput
                          ? // 不选上面的行，直接写：审批是「换个做法」，选项题是「自己的回答」
                            activePendingInput.kind === 'ask'
                            ? t('pendingInputs.otherPlaceholderAsk')
                            : t('pendingInputs.otherPlaceholderChoice')
                          : isStreaming
                            ? t('input.placeholderSteer')
                            : touch
                              ? // 手机：没有拖放，也没有 Shift+回车（回车本身就是换行）
                                t('input.placeholderTouch')
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
              </div>

              {/* 底部工具行（统一布局）：选择器居左；右侧为上下文用量环，最右为发送/停止 */}
              <div
                className={`@container flex items-center text-text-tertiary whitespace-nowrap ${
                  touch ? 'gap-2 px-2.5 pb-2.5 pt-1' : 'gap-1.5 px-2 pb-1.5 pt-0.5'
                }`}
              >
                {attachButton}
                {pickers}

                {/* 弹性空白 → 把右侧按钮簇推到最右 */}
                <span className="flex-1" />

                {/* 上下文用量环：填充 = 已用占比（≥75% 警示、≥90% 告警）；hover 出精确数字。
                  纯只读指示器 —— 运行时 Agent 快照归设置页的「监视器 → 智能体」，这里不再是入口。 */}
                {(maxContextTokens > 0 || usedContextTokens !== null) && (
                  <span
                    ref={ctxRef}
                    aria-label={ctxTooltip}
                    data-context-ring=""
                    onClick={() => setCtxOpen((v) => !v)}
                    className={`relative group/token flex-shrink-0 rounded flex items-center cursor-default ${
                      // 触屏：点按区 36px，但左右各 8px 伸进两侧的间距里，排版上只占 20px（把宽度留给模型名）
                      touch ? 'h-9 w-9 -mx-2 justify-center' : 'p-1'
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
                    {/* 悬浮 tooltip：精确用量 + 占比 */}
                    <div
                      data-context-tooltip=""
                      className={`pointer-events-none absolute right-0 bottom-7 z-20 rounded-md border border-border-primary bg-bg-secondary px-2 py-1 shadow-xl group-hover/token:block whitespace-nowrap text-left ${
                        ctxOpen ? 'block' : 'hidden'
                      }`}
                    >
                      <div className="text-[11px] text-text-primary">
                        {ctxTooltip}
                        {ctxFraction !== null ? ` · ${Math.round(ctxFraction * 100)}%` : ''}
                      </div>
                    </div>
                  </span>
                )}

                {sendStopButtons}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 内联 Token 的全文（粘贴芯片）也换一遍：乐观占位气泡里不出现要藏的真值 */
function maskTokenPayloads(
  tokens: Record<string, InlineToken>,
  mask: (text: string) => string
): Record<string, InlineToken> {
  return Object.fromEntries(
    Object.entries(tokens).map(([uid, token]) => [uid, { ...token, payload: mask(token.payload) }])
  )
}
