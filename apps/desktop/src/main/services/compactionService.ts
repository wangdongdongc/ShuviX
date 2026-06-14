/**
 * CompactionService — Full Compaction 核心编排器
 *
 * 流程：
 * 1. 加载当前会话所有未归档消息
 * 2. 转换为 LLM 消息格式，调用 completeSimple 生成结构化摘要
 * 3. 在 SQLite 事务中原子性地：归档旧消息 + 插入摘要消息
 * 4. 通过 ChatEvent 通知前端状态变化
 */

import { v7 as uuidv7 } from 'uuid'
import {
  type TextContent,
  type ImageContent,
  type ThinkingContent,
  type ToolCall,
  type UserMessage,
  type AssistantMessage as PiAssistantMessage,
  type ToolResultMessage,
  completeSimple
} from '@earendil-works/pi-ai'
import { type AgentMessage, convertToLlm } from '@earendil-works/pi-agent-core'
import { messageDao, messageStepDao } from '../dao/messageDao'
import { sessionDao } from '../dao/sessionDao'
import { providerDao } from '../dao/providerDao'
import { databaseManager } from '../dao/database'
import { messageService } from './messageService'
import { sessionService } from './sessionService'
import { buildInstructionMessages } from './instruction'
import { chatFrontendRegistry } from '../frontend/core'
import { dbMessagesToAgentMessages } from '../utils/agentMessageConverter'
import {
  buildCompactionPrompt,
  formatCompactSummary,
  buildSummaryContent
} from './compactionPrompt'
import type { Message } from '../types'
import { createLogger } from '../logger'

const log = createLogger('CompactionService')

/** 单个工具结果的最大字符数 */
const MAX_TOOL_RESULT_CHARS = 1500
/** 截断标记 */
const TRUNCATED_MARKER = '\n... [content truncated for compaction]'

/**
 * 压缩前消息预处理 — 借鉴 Claude Code 的 stripImages + microcompact 逻辑
 *
 * 1. 用户消息：图片 → [image] 占位符
 * 2. 助手消息：剥离 thinking 块、图片 → [image]
 * 3. 工具结果：图片 → [image]，文本截断到 MAX_TOOL_RESULT_CHARS
 */
function prepareMessagesForCompaction(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    // ── UserMessage ──
    if (msg.role === 'user') {
      const userMsg = msg as UserMessage
      if (typeof userMsg.content === 'string') return msg
      let changed = false
      const newContent = userMsg.content.map((block: TextContent | ImageContent) => {
        if (block.type === 'image') {
          changed = true
          return { type: 'text' as const, text: '[image]' }
        }
        return block
      })
      return changed ? { ...userMsg, content: newContent } : msg
    }

    // ── AssistantMessage ──
    if (msg.role === 'assistant') {
      const assistantMsg = msg as PiAssistantMessage
      let changed = false
      const filtered: (TextContent | ThinkingContent | ToolCall)[] = []
      for (const block of assistantMsg.content) {
        // 剥离 thinking 块（对总结无信息量，且很长）
        if (block.type === 'thinking') {
          changed = true
          continue
        }
        // 图片 → 占位符（通过 unknown 类型传入的 image 块）
        if ((block as unknown as { type: string }).type === 'image') {
          changed = true
          filtered.push({ type: 'text', text: '[image]' })
          continue
        }
        filtered.push(block)
      }
      return changed ? { ...assistantMsg, content: filtered } : msg
    }

    // ── ToolResultMessage ──
    if (msg.role === 'toolResult') {
      const toolMsg = msg as ToolResultMessage
      let changed = false
      const newContent = toolMsg.content.map((block: TextContent | ImageContent) => {
        // 图片 → 占位符
        if (block.type === 'image') {
          changed = true
          return { type: 'text' as const, text: '[image]' } as TextContent
        }
        // 截断过长的文本结果
        if (block.type === 'text' && block.text.length > MAX_TOOL_RESULT_CHARS) {
          changed = true
          return {
            type: 'text' as const,
            text: block.text.slice(0, MAX_TOOL_RESULT_CHARS) + TRUNCATED_MARKER
          } as TextContent
        }
        return block
      })
      return changed ? { ...toolMsg, content: newContent } : msg
    }

    return msg
  })
}

class CompactionService {
  /** 正在压缩的会话（内存锁，防止并发） */
  private compactingSessions = new Set<string>()

  /** 检查会话是否正在压缩 */
  isCompacting(sessionId: string): boolean {
    return this.compactingSessions.has(sessionId)
  }

  /**
   * 执行 Full Compaction
   * @returns 新生成的摘要消息
   * @throws 并发压缩、无消息、LLM 调用失败等
   */
  async compact(sessionId: string): Promise<Message> {
    // ─── 前置校验 ───────────────────────────────
    if (this.compactingSessions.has(sessionId)) {
      throw new Error('该会话正在压缩中，请稍候')
    }

    this.compactingSessions.add(sessionId)

    try {
      // 通知前端：压缩开始
      chatFrontendRegistry.broadcast({ type: 'compaction_start', sessionId })

      // ─── 1. 加载消息 ──────────────────────────
      const dbMessages = messageService.listBySession(sessionId)
      if (dbMessages.length === 0) {
        throw new Error('没有可压缩的消息')
      }

      // ─── 2. 转换为 LLM 格式并预处理 ────────────
      // converter 排除 system_notify / step 等不参与上下文的消息
      const rawAgentMessages = dbMessagesToAgentMessages(dbMessages)
      if (rawAgentMessages.length === 0) {
        throw new Error('没有有效的对话消息可供压缩')
      }
      // 预处理：剥离图片/thinking、截断过长工具结果，减少总结请求的 token 开销
      const agentMessages = prepareMessagesForCompaction(rawAgentMessages)

      // ─── 3. 解析模型和 API Key ────────────────
      const agentSession = sessionService.getAgentSession(sessionId)
      if (!agentSession) {
        throw new Error('Agent 未初始化，请先打开该会话')
      }

      const model = agentSession.getAgent().state.model
      const providerId = String(model.provider)
      const currentProvider = providerDao.pick(providerId, ['apiKey'])
      const apiKey = currentProvider?.apiKey
      if (!apiKey) {
        throw new Error(
          `当前会话使用的 Provider (${providerId}) 没有配置 API Key,请到设置 → Provider 中填写后重试`
        )
      }

      // ─── 4. 调用 LLM 生成摘要 ─────────────────
      const compactionPrompt = buildCompactionPrompt()

      // 追加一条 user 消息作为压缩请求
      const summaryRequestMsg = {
        role: 'user' as const,
        content: compactionPrompt,
        timestamp: Date.now()
      }

      log.info(`开始压缩 session=${sessionId}，消息数=${agentMessages.length}`)

      const result = await completeSimple(
        model,
        {
          systemPrompt:
            'You are a helpful AI assistant tasked with summarizing conversations. Respond with TEXT ONLY.',
          messages: convertToLlm([...agentMessages, summaryRequestMsg])
        },
        apiKey ? { apiKey } : {}
      )

      // ─── 5. 提取文本 ──────────────────────────
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
        log.error(
          `LLM 压缩返回为空 session=${sessionId} stopReason=${stopReason} blockTypes=[${blockTypes}] errorMessage=${errorMessage} usage=${JSON.stringify(r.usage)}`
        )
        try {
          log.error(`完整返回内容: ${JSON.stringify(result.content)?.slice(0, 2000)}`)
        } catch {
          /* ignore stringify failure */
        }
        const detail = errorMessage || `stopReason=${stopReason}, blocks=[${blockTypes}]`
        throw new Error(`LLM 返回空内容，压缩失败 (${detail})`)
      }

      // ─── 6. 格式化摘要 ─────────────────────────
      const formattedSummary = formatCompactSummary(rawText)
      const summaryContent = buildSummaryContent(formattedSummary)

      // ─── 7. 构造指令消息（不写库，纯函数） ───
      const workingDir = sessionService.getById(sessionId)?.workingDirectory || ''
      const instructionMessages = workingDir ? buildInstructionMessages(sessionId, workingDir) : []

      // ─── 8. 构造摘要消息：时间戳晚于全部指令消息，确保排序在后 ───
      const lastInstructionTs =
        instructionMessages.length > 0
          ? instructionMessages[instructionMessages.length - 1].createdAt
          : 0
      const summaryMessage: Message = {
        id: uuidv7(),
        sessionId,
        role: 'assistant',
        type: 'text',
        content: summaryContent,
        metadata: { isCompactionSummary: true },
        model: String(model.id || ''),
        createdAt: Math.max(Date.now(), lastInstructionTs + 1)
      }

      // ─── 9. 原子事务：归档旧消息 + 插入指令 + 插入摘要 ───
      const db = databaseManager.getDb()
      db.transaction(() => {
        messageDao.archiveBySessionId(sessionId)
        messageStepDao.archiveBySessionId(sessionId)
        for (const im of instructionMessages) messageDao.insert(im)
        messageDao.insert(summaryMessage)
        sessionDao.touch(sessionId)
      })()

      log.info(
        `压缩完成 session=${sessionId}，摘要长度=${summaryContent.length}，指令消息=${instructionMessages.length}`
      )

      // ─── 10. 失效 Agent，下次交互重建上下文 ─────
      sessionService.invalidateAgent(sessionId)

      // ─── 11. 通知前端：压缩成功（指令在前，摘要在后） ───
      chatFrontendRegistry.broadcast({
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
      log.error(`压缩失败 session=${sessionId}: ${errorMsg}`)

      // 通知前端：压缩失败
      chatFrontendRegistry.broadcast({
        type: 'compaction_error',
        sessionId,
        error: errorMsg
      })

      throw err
    } finally {
      this.compactingSessions.delete(sessionId)
    }
  }
}

export const compactionService = new CompactionService()
