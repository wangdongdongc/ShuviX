/**
 * 共享 session 工具内核 —— 压缩子代理（compact agent）读取会话转写并执行压缩归档。
 *
 * 数据源是 **Agent 上下文**（不是存储层）：宿主经 ensure*Session 确保根会话 Agent 已初始化
 * （未初始化则先从存储恢复上下文），返回其 `AgentMessage[]`；内核经 transcript/ 模块
 * （反向投影 + chat-protocol transcribeConversation 引擎）按压缩档位渲染为 Markdown 转写。
 * 因此转写内容 = LLM 实际看到的上下文（含 hook 注入 / steer / 指令消息），且同一套能力
 * 对任何 RuntimeAgent（含派生临时 agent）生效，端无关。
 *
 * 两个动作，一读一写：
 *   - transcript：只读。渲染转写并记录此刻的「上下文指纹」（条数 + 末条时间戳），
 *     作为后续 compact 的一致性凭据。
 *   - compact：原子提交。summary 经 buildSummaryContent 包上延续框架文案后交给宿主的
 *     persistCompact 一次性完成「归档旧消息 + （桌面）重注入指令 + 写入摘要 + 失效 Agent +
 *     广播 messages_reloaded」。未提交前会话零改动 —— 任何一步失败都不损伤会话。
 *
 * 防护（内核统一，宿主无需重复）：
 *   - 进程内锁：同会话并发 compact 直接拒绝；
 *   - 顺序约束：本次派发内必须先 transcript 后 compact；
 *   - 一致性：compact 时宿主用 verifyContextFingerprint 校验上下文未变
 *     （期间有新消息 / Agent 被失效重建 → 指纹失配 → 报错请重读转写）；
 *   - 摘要下限：过短的 summary 视为误调用拒绝。
 * 宿主职责：persistCompact 内部再做「根会话 Agent 正在生成则拒绝」的忙碌检查 + 原子落库。
 */
import { Type, type Static } from 'typebox'
import type { AgentMessage, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { TranscribeOptions } from '@shuvix/chat-protocol/utils/transcript'
import { BaseTool } from '../tools/baseTool'
import { transcribeAgentMessages } from '../transcript'

export const SessionToolParamsSchema = Type.Object({
  action: Type.Union([Type.Literal('transcript'), Type.Literal('compact')], {
    description:
      '"transcript" returns the full conversation transcript of the current session; "compact" archives all active messages and installs `summary` as the replacement context.'
  }),
  summary: Type.Optional(
    Type.String({
      description:
        'Required for "compact": the complete structured summary that replaces the archived conversation. It becomes the ONLY context carried forward — it must be self-contained.'
    })
  )
})

export type SessionToolParams = Static<typeof SessionToolParamsSchema>

export const SESSION_TOOL_DESCRIPTION =
  'Read and compact the current chat session history. ' +
  'action "transcript": returns the active conversation (the agent context) as a Markdown transcript (thinking stripped, images as [image], long tool results truncated); if the tool result itself gets truncated, its note points to a spill file containing the full text. ' +
  'action "compact": atomically archives ALL active messages and replaces them with `summary` as the sole carried-over context; requires a prior "transcript" call in this run, and fails safely (session untouched) if new messages arrived meanwhile, another compaction is running, or the session agent is busy.'

/**
 * 压缩转写档位 —— 两端统一且不可绕过。与导出的精简档位不同：压缩摘要需要工具轨迹。
 * step / thinking 保持排除；上下文里的指令注入消息以普通 user 轮次进入转写
 * （上下文即真源 —— LLM 看到什么就总结什么）。
 */
const COMPACT_TRANSCRIBE_OPTIONS: TranscribeOptions = {
  includeToolCalls: true,
  includeToolResults: true,
  includeImages: true,
  expandInlineTokens: true,
  maxToolResultChars: 1500
}

/** 上下文指纹 —— transcript 时快照，compact 提交前校验未变 */
export interface SessionContextFingerprint {
  messageCount: number
  lastTimestamp: number | null
}

/** 计算一段 Agent 上下文的指纹 */
export function contextFingerprint(messages: AgentMessage[]): SessionContextFingerprint {
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined
  return {
    messageCount: messages.length,
    lastTimestamp: (last as { timestamp?: number } | undefined)?.timestamp ?? null
  }
}

/**
 * 校验当前上下文与 transcript 快照一致，失配即抛 LLM 可读错误（文案单一真源）。
 * 宿主在 persistCompact 里对「重新 ensure 后的上下文」调用。
 */
export function verifyContextFingerprint(
  messages: AgentMessage[],
  expected: SessionContextFingerprint
): void {
  const current = contextFingerprint(messages)
  if (
    current.messageCount !== expected.messageCount ||
    current.lastTimestamp !== expected.lastTimestamp
  ) {
    throw new Error(
      'The conversation changed after the transcript was read — the summary would silently drop the new content. Call {action:"transcript"} again and rebuild the summary.'
    )
  }
}

export interface SessionToolDeps {
  /** 目标会话（派生 agent 的 ToolContext 绑定根会话 id） */
  sessionId: string
  /**
   * 确保根会话 Agent 已初始化并返回其上下文消息
   * （桌面 ensureAgentSession().getMessages() / 扩展 ensureRuntimeSession().getMessages()）。
   */
  getAgentMessages: () => Promise<AgentMessage[]>
  /**
   * 原子压缩提交：归档全部活跃消息 + （桌面）重注入指令文件 + 写入摘要消息 +
   * 失效根会话 Agent + 广播 messages_reloaded。内部须先做忙碌检查，并对重新取到的
   * 上下文调用 verifyContextFingerprint(messages, expectedFingerprint)，不满足时 throw。
   */
  persistCompact: (input: {
    /** 已包好延续框架文案的完整摘要消息正文 */
    summaryContent: string
    /** transcript 时记录的上下文指纹；提交前必须仍然一致 */
    expectedFingerprint: SessionContextFingerprint
  }) => Promise<{ archivedCount: number }>
  label: string
  abortError: string
}

/** 摘要最短字符数 —— 拦住误把占位文本当 summary 提交的调用 */
const MIN_SUMMARY_CHARS = 200

/** 正在压缩的会话（进程内锁，防止并发提交） */
const compactingSessions = new Set<string>()

/** 构建压缩后落库的摘要消息正文：摘要 + 延续指引（重建上下文时随消息进入 LLM） */
export function buildSummaryContent(summary: string): string {
  return `This session is being continued from a previous conversation that has been compressed. The summary below covers the earlier portion of the conversation.

${summary.trim()}

Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`
}

export class SessionTool extends BaseTool<typeof SessionToolParamsSchema> {
  readonly name = 'session'
  readonly label: string
  readonly description = SESSION_TOOL_DESCRIPTION
  readonly parameters = SessionToolParamsSchema
  // 转写可能很大：放宽单结果上限（超出仍走宿主截断/落盘管线，middle 策略保头尾）
  readonly outputMaxBytes = 384 * 1024
  readonly outputMaxLines = 40000

  /** 本次派发内最近一次 transcript 的上下文指纹（compact 的前置凭据） */
  private lastSeen: SessionContextFingerprint | null = null

  constructor(private deps: SessionToolDeps) {
    super()
    this.label = deps.label
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(
    _toolCallId: string,
    _params: SessionToolParams,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(this.deps.abortError)
  }

  protected async executeInternal(
    _toolCallId: string,
    params: SessionToolParams,
    signal?: AbortSignal
  ): Promise<AgentToolResult<undefined>> {
    if (signal?.aborted) throw new Error(this.deps.abortError)
    return params.action === 'transcript' ? this.runTranscript() : this.runCompact(params)
  }

  private async runTranscript(): Promise<AgentToolResult<undefined>> {
    const messages = await this.deps.getAgentMessages()
    const text = transcribeAgentMessages(messages, COMPACT_TRANSCRIBE_OPTIONS).trim()
    if (!text) {
      throw new Error('This session has no conversation messages to compact.')
    }
    this.lastSeen = contextFingerprint(messages)
    return {
      content: [
        {
          type: 'text',
          text: `Session transcript (${messages.length} context messages, oldest first):\n\n${text}`
        }
      ],
      details: undefined
    }
  }

  private async runCompact(params: SessionToolParams): Promise<AgentToolResult<undefined>> {
    const { sessionId } = this.deps
    const summary = params.summary?.trim() ?? ''
    if (!this.lastSeen) {
      throw new Error(
        'Call {action:"transcript"} first — compact requires a transcript snapshot from this run.'
      )
    }
    if (summary.length < MIN_SUMMARY_CHARS) {
      throw new Error(
        `The summary is too short (${summary.length} chars) to be a real conversation summary. Provide the complete structured summary in the "summary" parameter.`
      )
    }
    if (compactingSessions.has(sessionId)) {
      throw new Error('Another compaction of this session is already in progress.')
    }
    compactingSessions.add(sessionId)
    try {
      const { archivedCount } = await this.deps.persistCompact({
        summaryContent: buildSummaryContent(summary),
        expectedFingerprint: this.lastSeen
      })
      return {
        content: [
          {
            type: 'text',
            text: `Compaction committed: ${archivedCount} messages archived; the summary is now the only carried-over context of this session.`
          }
        ],
        details: undefined
      }
    } finally {
      compactingSessions.delete(sessionId)
    }
  }
}

/** 创建 session 工具（注入端适配） */
export function createSessionTool(deps: SessionToolDeps): SessionTool {
  return new SessionTool(deps)
}
