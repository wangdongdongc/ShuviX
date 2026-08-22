/**
 * 两阶段自动会话标题 —— 宿主无关的**触发策略**内核。
 *
 * 桌面 AgentSession 与扩展 Side Panel 运行时共用同一状态机：
 *   - 'quick'  首轮：会话仍是默认标题时，用用户这条消息的意图快速生成一个粗标题
 *   - 'refine' 精修：积累到足够上下文（第 2 轮回复后）时，用整段对话重生成覆盖粗标题
 *
 * 只在标题仍是自动生成/默认值时才动手：一旦用户手动改名（title ≠ lastAutoTitle 且 ≠ 默认），
 * 或是笔记本会话（默认标题为文件名），都不覆盖。落库与广播由宿主的 applyTitle 负责。
 *
 * 模型调用本身见同目录 generateTitle.ts（端各自解析标题模型来源 + apiKey）。
 */

/** 参与标题生成的最小消息形状（结构上匹配两端的 ChatMessage） */
export interface TitleSourceMessage {
  role: string
  type?: string
  content: string
}

export interface SessionTitlerDeps {
  /** 会话当前标题；会话已不存在返回 null/undefined（跳过本次） */
  getCurrentTitle: () => string | null | undefined | Promise<string | null | undefined>
  /** 通用默认标题（「新对话」，i18n 由宿主解析） */
  getDefaultTitle: () => string
  /** 会话消息全量（精修阶段用于拼接上下文） */
  listMessages: () => TitleSourceMessage[] | Promise<TitleSourceMessage[]>
  /** 调模型产出标题；未配置标题模型 / 无 API Key 等情况返回 null */
  generate: (conversationText: string) => Promise<string | null>
  /** 落库 + 广播（宿主实现） */
  applyTitle: (title: string) => void | Promise<void>
  /** 失败告警（不抛出，标题生成永远不该影响会话主流程） */
  warn?: (message: string) => void
}

/** 送入模型的对话文本上限（取末尾 N 字） */
const MAX_CONTEXT_CHARS = 1000
/** 精修所需的最少文本消息数（第 2 轮回复后 user×2 + assistant×2） */
const REFINE_MIN_TEXT_MESSAGES = 3

export class SessionTitler {
  private quickDone = false // 首轮快速标题是否已生成
  private refineDone = false // 精修是否已完成
  private lastAutoTitle: string | null = null // 最近一次自动写入的标题（用于判断用户是否手动改名）

  constructor(private readonly deps: SessionTitlerDeps) {}

  /** 首轮快速标题：宿主在 prompt 正式派发时调用（不 await） */
  quick(userText: string): Promise<void> {
    return this.run('quick', userText)
  }

  /** 精修：宿主在一轮 prompt 完成后调用（不 await） */
  refine(): Promise<void> {
    return this.run('refine')
  }

  private async run(phase: 'quick' | 'refine', userText?: string): Promise<void> {
    try {
      const currentTitle = await this.deps.getCurrentTitle()
      if (currentTitle == null) return

      const title =
        phase === 'quick'
          ? await this.runQuick(currentTitle, userText)
          : await this.runRefine(currentTitle)
      if (!title) return

      this.lastAutoTitle = title
      await this.deps.applyTitle(title)
    } catch (err) {
      this.deps.warn?.(
        `自动标题生成失败(${phase}): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private async runQuick(currentTitle: string, userText?: string): Promise<string | null> {
    if (this.quickDone) return null
    // 仅当标题仍是通用默认值（跳过笔记本会话的文件名标题 / 用户已改名）
    if (currentTitle !== this.deps.getDefaultTitle()) return null
    const text = (userText ?? '').trim()
    if (!text) return null
    this.quickDone = true
    return this.deps.generate(`User: ${text}`.slice(-MAX_CONTEXT_CHARS))
  }

  private async runRefine(currentTitle: string): Promise<string | null> {
    // 精修一次：需先有过快速标题，且用户未手动改名（当前标题仍是我们上次自动写入的）
    if (this.refineDone || !this.quickDone) return null
    if (this.lastAutoTitle == null || currentTitle !== this.lastAutoTitle) return null

    // 等积累到足够上下文再精修
    const msgs = await this.deps.listMessages()
    // 只要有正文的对话消息：助手卡的 content 是其 text 块拼接，
    // 纯工具调用那条自然是空串，不占门槛（错误提示等系统消息也不算）
    const textMsgs = msgs.filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && !!m.content.trim()
    )
    if (textMsgs.length < REFINE_MIN_TEXT_MESSAGES) return null

    this.refineDone = true
    const conversationText = textMsgs
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n')
      .slice(-MAX_CONTEXT_CHARS)
    if (!conversationText.trim()) return null
    return this.deps.generate(conversationText)
  }
}
