/**
 * runCompaction —— 宿主无关的 Full Compaction 编排器。
 *
 * 把「加载历史 → 预处理 → 调 LLM 生成结构化摘要 → 归档旧消息 + 写摘要 → 失效 Agent →
 * 广播 ChatEvent」这套流程抽到此处，端差异（存储/模型解析/事件广播/指令文件）经
 * CompactionDeps 注入。桌面（SQLite + chatFrontendRegistry）与扩展（IndexedDB + eventBus）
 * 各自提供适配器，共用同一编排逻辑。
 */
import type { TextContent } from '@earendil-works/pi-ai'
import { completeSimple } from '@earendil-works/pi-ai/compat'
import { type AgentMessage, convertToLlm } from '@earendil-works/pi-agent-core'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { RuntimeLogger } from '../types'
import { buildCompactionPrompt, formatCompactSummary, buildSummaryContent } from './prompts'
import { prepareMessagesForCompaction } from './prepare'

/** completeSimple 的模型入参类型（pi-ai Model） */
type CompleteModel = Parameters<typeof completeSimple>[0]

export interface CompactionDeps {
  /** 加载会话历史并转换为 Agent 上下文消息（端各自实现：桌面 DAO 转换 / 扩展 IDB 文本恢复） */
  loadAgentMessages(sessionId: string): Promise<AgentMessage[]> | AgentMessage[]
  /** 解析当前会话的模型、API Key、模型 id（无 Key 应在此抛出带 provider 的明确错误） */
  resolveModelAndKey(
    sessionId: string
  ): Promise<{ model: CompleteModel; apiKey: string; modelId: string }>
  /** 构造指令消息（不写库）；浏览器端可返回 [] */
  buildInstructionMessages(sessionId: string): Promise<ChatMessage[]> | ChatMessage[]
  /** 用给定内容构造摘要消息对象（端控制 id / 时间戳 / 模型字段） */
  buildSummaryMessage(input: {
    sessionId: string
    content: string
    modelId: string
    afterTs: number
  }): ChatMessage
  /** 原子持久化：归档旧消息 + 插入指令 + 插入摘要 */
  persist(input: {
    sessionId: string
    instructionMessages: ChatMessage[]
    summaryMessage: ChatMessage
  }): Promise<void> | void
  /** 失效 Agent 上下文，下次交互从摘要重建 */
  invalidateAgent(sessionId: string): Promise<void> | void
  /** 广播 ChatEvent（桌面 chatFrontendRegistry / 扩展 eventBus） */
  broadcast(event: ChatEvent): void
  logger?: RuntimeLogger
}

/** 正在压缩的会话（进程内锁，防止并发） */
const compactingSessions = new Set<string>()

/** 检查会话是否正在压缩 */
export function isCompacting(sessionId: string): boolean {
  return compactingSessions.has(sessionId)
}

/**
 * 执行 Full Compaction。
 * @returns 新生成的摘要消息
 * @throws 并发压缩、无消息、缺少 API Key、LLM 调用失败等
 */
export async function runCompaction(sessionId: string, deps: CompactionDeps): Promise<ChatMessage> {
  const log = deps.logger

  // ─── 前置校验 ───────────────────────────────
  if (compactingSessions.has(sessionId)) {
    throw new Error('该会话正在压缩中，请稍候')
  }
  compactingSessions.add(sessionId)

  try {
    // 通知前端：压缩开始
    deps.broadcast({ type: 'compaction_start', sessionId })

    // ─── 1. 加载消息并预处理 ──────────────────
    const rawAgentMessages = await deps.loadAgentMessages(sessionId)
    if (!rawAgentMessages || rawAgentMessages.length === 0) {
      throw new Error('没有有效的对话消息可供压缩')
    }
    // 预处理：剥离图片/thinking、截断过长工具结果，减少总结请求的 token 开销
    const agentMessages = prepareMessagesForCompaction(rawAgentMessages)

    // ─── 2. 解析模型和 API Key ────────────────
    const { model, apiKey, modelId } = await deps.resolveModelAndKey(sessionId)

    // ─── 3. 调用 LLM 生成摘要 ─────────────────
    const compactionPrompt = buildCompactionPrompt()
    // 追加一条 user 消息作为压缩请求
    const summaryRequestMsg = {
      role: 'user' as const,
      content: compactionPrompt,
      timestamp: Date.now()
    }

    log?.info(`开始压缩 session=${sessionId}，消息数=${agentMessages.length}`)

    const result = await completeSimple(
      model,
      {
        systemPrompt:
          'You are a helpful AI assistant tasked with summarizing conversations. Respond with TEXT ONLY.',
        messages: convertToLlm([...agentMessages, summaryRequestMsg])
      },
      apiKey ? { apiKey } : {}
    )

    // ─── 4. 提取文本 ──────────────────────────
    const rawText = result.content
      ?.filter((c): c is TextContent => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim()

    if (!rawText) {
      // pi-ai 在 stopReason='error' 时把 provider 的真实错误塞在 errorMessage 字段里
      const r = result as {
        stopReason?: string
        errorMessage?: string
        usage?: unknown
      }
      const blockTypes = result.content?.map((c) => c.type).join(',') || '<no content>'
      const stopReason = r.stopReason || '<unknown>'
      const errorMessage = r.errorMessage || ''
      log?.error(
        `LLM 压缩返回为空 session=${sessionId} stopReason=${stopReason} blockTypes=[${blockTypes}] errorMessage=${errorMessage} usage=${JSON.stringify(r.usage)}`
      )
      const detail = errorMessage || `stopReason=${stopReason}, blocks=[${blockTypes}]`
      throw new Error(`LLM 返回空内容，压缩失败 (${detail})`)
    }

    // ─── 5. 格式化摘要 ─────────────────────────
    const formattedSummary = formatCompactSummary(rawText)
    const summaryContent = buildSummaryContent(formattedSummary)

    // ─── 6. 构造指令消息（不写库，纯函数） ───
    const instructionMessages = await deps.buildInstructionMessages(sessionId)

    // ─── 7. 构造摘要消息：时间戳晚于全部指令消息，确保排序在后 ───
    const lastInstructionTs =
      instructionMessages.length > 0
        ? instructionMessages[instructionMessages.length - 1].createdAt
        : 0
    const summaryMessage = deps.buildSummaryMessage({
      sessionId,
      content: summaryContent,
      modelId,
      afterTs: lastInstructionTs
    })

    // ─── 8. 原子持久化：归档旧消息 + 插入指令 + 插入摘要 ───
    await deps.persist({ sessionId, instructionMessages, summaryMessage })

    log?.info(
      `压缩完成 session=${sessionId}，摘要长度=${summaryContent.length}，指令消息=${instructionMessages.length}`
    )

    // ─── 9. 失效 Agent，下次交互重建上下文 ─────
    await deps.invalidateAgent(sessionId)

    // ─── 10. 通知前端：压缩成功（指令在前，摘要在后） ───
    deps.broadcast({
      type: 'compaction_end',
      sessionId,
      message: JSON.stringify(summaryMessage),
      instructionMessages:
        instructionMessages.length > 0
          ? instructionMessages.map((m) => JSON.stringify(m))
          : undefined
    })

    return summaryMessage
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log?.error(`压缩失败 session=${sessionId}: ${errorMsg}`)

    // 通知前端：压缩失败
    deps.broadcast({ type: 'compaction_error', sessionId, error: errorMsg })

    throw err
  } finally {
    compactingSessions.delete(sessionId)
  }
}
