import type { AgentEvent } from '@mariozechner/pi-agent-core'
import type { AssistantMessage, ImageContent, TextContent } from '@mariozechner/pi-ai'
import { isAssistantMessage } from '../utils/messageGuards'
import { httpLogService } from './httpLogService'
import { messageService } from './messageService'
import { sessionDao } from '../dao/sessionDao'
import { isCommandAllowed } from '../tools/utils/allowList'
import { dockerManager } from './dockerManager'
import { parallelCoordinator } from './parallelExecution'
import type { Message, MessageMetadata, ToolResultDetails } from '../types'
import type { ChatEvent } from '../frontend'
import { createLogger } from '../logger'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const log = createLogger('AgentEvent')

/** 检查工具是否需要用户审批/输入（复用于 handleMessageEnd 预展示和 handleToolExecutionStart） */
function checkToolApproval(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>
): { approvalRequired: boolean; userInputRequired: boolean; sshCredentialRequired: boolean } {
  let approvalRequired = false
  if (toolName === 'bash') {
    const sess = sessionDao.findById(sessionId)
    if (!sess?.settings.bashAutoApprove) {
      const command = (args?.command as string) || ''
      approvalRequired = !isCommandAllowed(sess?.settings.bashAllowList, command)
    }
  } else if (toolName === 'shuvix-project' && args?.action === 'update') {
    approvalRequired = true
  } else if (toolName === 'shuvix-setting' && args?.action === 'set') {
    approvalRequired = true
  } else if (toolName === 'ssh' && args?.action === 'exec') {
    const sess = sessionDao.findById(sessionId)
    if (!sess?.settings.sshAutoApprove) {
      const command = (args?.command as string) || ''
      approvalRequired = !isCommandAllowed(sess?.settings.sshAllowList, command)
    }
  }
  const userInputRequired = toolName === 'ask'
  const sshCredentialRequired =
    toolName === 'ssh' && args?.action === 'connect' && !args?.credentialName
  return { approvalRequired, userInputRequired, sshCredentialRequired }
}

/** 会话级项目指令文件加载状态 */
export interface ProjectInstructionLoadState {
  agentMdLoaded: boolean
}

/** 读取项目根目录指令文件（优先 AGENTS.MD，回退 AGENT.md；不存在或读取失败时返回空） */
export function readProjectAgentMd(projectPath: string): string {
  for (const name of ['AGENTS.MD', 'AGENT.md']) {
    const filePath = join(projectPath, name)
    if (!existsSync(filePath)) continue
    try {
      const content = readFileSync(filePath, 'utf-8').trim()
      if (content) {
        log.info(`已加载项目指令文件: ${name}`)
        return content
      }
    } catch (err: unknown) {
      log.warn(
        `读取 ${name} 失败: ${filePath} (${err instanceof Error ? err.message : String(err)})`
      )
    }
  }
  return ''
}

// ─── Per-session 事件上下文 ─────────────────────────────────

/** AgentSession 的可变事件状态（直接引用，handler 可读写） */
export interface SessionEventState {
  streamBuffer: {
    content: string
    thinking: string
    images: Array<{ data: string; mimeType: string; thoughtSignature?: string }>
  }
  turnCounter: number
  pendingLogIds: string[]
  /** 已预展示的 toolCallId 集合（并行 batch 预展示用） */
  preEmittedToolCalls: Set<string>
  /** toolCallId → tool_use 消息 ID 的映射（用于 completeToolUse） */
  toolUseMessageIds: Map<string, string>
}

/** 事件处理器上下文 — per-session 直接引用，不再使用共享 Map */
export interface SessionEventHandlerContext {
  sessionId: string
  state: SessionEventState
  broadcastEvent: (event: ChatEvent) => void
  persistStreamBuffer: (extraMeta?: MessageMetadata) => Message | null
  emitDockerEvent: (
    action: 'container_created' | 'container_destroyed',
    extra?: { containerId?: string; image?: string; reason?: string }
  ) => void
}

// ─── Handler 实现 ────────────────────────────────────────

/** agent_start 事件：初始化缓冲区和 turn 计数 */
function handleAgentStart(ctx: SessionEventHandlerContext): void {
  log.info(`开始 session=${ctx.sessionId}`)
  ctx.state.streamBuffer = { content: '', thinking: '', images: [] }
  ctx.state.turnCounter = 0
  ctx.state.preEmittedToolCalls.clear()
  ctx.state.toolUseMessageIds.clear()
  ctx.broadcastEvent({ type: 'agent_start', sessionId: ctx.sessionId })
}

/** turn_start 事件：递增 turn 计数器 */
function handleTurnStart(ctx: SessionEventHandlerContext): void {
  ctx.state.turnCounter += 1
  log.info(`Turn ${ctx.state.turnCounter} 开始 session=${ctx.sessionId}`)
}

/** turn_end 事件：记录日志 */
function handleTurnEnd(ctx: SessionEventHandlerContext): void {
  log.info(`Turn ${ctx.state.turnCounter} 结束 session=${ctx.sessionId}`)
}

/** agent_end 事件：Docker 清理、token 统计、持久化 */
function handleAgentEnd(
  ctx: SessionEventHandlerContext,
  event: Extract<AgentEvent, { type: 'agent_end' }>
): void {
  log.info(`结束 session=${ctx.sessionId}`)
  ctx.state.preEmittedToolCalls.clear()
  ctx.state.toolUseMessageIds.clear()
  // Docker 模式下，回复完成后延迟销毁容器（空闲超时后自动清理）
  dockerManager.scheduleDestroy(ctx.sessionId, (containerId) => {
    ctx.emitDockerEvent('container_destroyed', {
      containerId: containerId.slice(0, 12),
      reason: 'idle'
    })
  })
  // 检查 agent_end 中的消息是否携带错误信息
  const endMessages = event.messages
  for (const m of endMessages) {
    if (isAssistantMessage(m) && m.errorMessage) {
      log.error(`流式错误: ${m.errorMessage}`)
      ctx.broadcastEvent({ type: 'error', sessionId: ctx.sessionId, error: m.errorMessage })
    }
  }
  // 从 agent_end 自带的 messages 中提取每条 AssistantMessage 的 token 用量
  const details: Array<{
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
    stopReason: string
  }> = []
  for (const m of endMessages) {
    if (isAssistantMessage(m) && m.usage) {
      details.push({
        input: m.usage.input || 0,
        output: m.usage.output || 0,
        cacheRead: m.usage.cacheRead || 0,
        cacheWrite: m.usage.cacheWrite || 0,
        total: m.usage.totalTokens || 0,
        stopReason: m.stopReason || ''
      })
    }
  }
  const totalUsage = details.reduce(
    (acc, d) => ({
      input: acc.input + d.input,
      output: acc.output + d.output,
      cacheRead: acc.cacheRead + d.cacheRead,
      cacheWrite: acc.cacheWrite + d.cacheWrite,
      total: acc.total + d.total
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  )
  // 最后一轮 thinking 也独立落库为 step_thinking（与中间轮次一致）
  const buf = ctx.state.streamBuffer
  if (buf.thinking) {
    const session = sessionDao.findById(ctx.sessionId)
    const thinkingMsg = messageService.addStepThinking({
      sessionId: ctx.sessionId,
      content: buf.thinking,
      turnIndex: ctx.state.turnCounter,
      model: session?.model || ''
    })
    ctx.broadcastEvent({
      type: 'step_end',
      sessionId: ctx.sessionId,
      messageId: thinkingMsg.id,
      message: JSON.stringify(thinkingMsg)
    })
    buf.thinking = ''
  }
  // 后端统一落库：将缓冲区内容持久化为 assistant 消息（携带 usage，不含 thinking）
  const savedMsg = ctx.persistStreamBuffer(
    totalUsage.total > 0 ? { usage: { ...totalUsage, details } } : {}
  )
  ctx.broadcastEvent({
    type: 'agent_end',
    sessionId: ctx.sessionId,
    usage: { ...totalUsage, details },
    message: savedMsg ? JSON.stringify(savedMsg) : undefined
  })
}

/** message_update 事件：累积 text/thinking delta */
function handleMessageUpdate(
  ctx: SessionEventHandlerContext,
  event: Extract<AgentEvent, { type: 'message_update' }>
): void {
  const msgEvent = event.assistantMessageEvent
  if (msgEvent.type === 'text_delta') {
    ctx.state.streamBuffer.content += msgEvent.delta || ''
    ctx.broadcastEvent({
      type: 'text_delta',
      sessionId: ctx.sessionId,
      delta: msgEvent.delta || ''
    })
  } else if (msgEvent.type === 'thinking_delta') {
    ctx.state.streamBuffer.thinking += msgEvent.delta || ''
    ctx.broadcastEvent({
      type: 'thinking_delta',
      sessionId: ctx.sessionId,
      delta: msgEvent.delta || ''
    })
  }
}

/** message_end 事件：HTTP 日志更新、图片提取 */
function handleMessageEnd(
  ctx: SessionEventHandlerContext,
  event: Extract<AgentEvent, { type: 'message_end' }>
): void {
  const msg = event.message
  if (isAssistantMessage(msg)) {
    // 检查流式响应中的错误
    if (msg.stopReason === 'error' && msg.errorMessage) {
      log.error(`API 错误: ${msg.errorMessage}`)
      ctx.broadcastEvent({ type: 'error', sessionId: ctx.sessionId, error: msg.errorMessage })
    }
    const logId = ctx.state.pendingLogIds.shift()
    const msgWithImages = msg as AssistantMessage & {
      _images?: Array<{ data: string; mimeType: string; thoughtSignature?: string }>
    }
    if (logId) {
      const usage = msg.usage
      const logImages = msgWithImages._images
      let responseJson: string | undefined
      try {
        const respData: {
          content: AssistantMessage['content']
          stopReason: AssistantMessage['stopReason']
          images?: Array<{ data: string; mimeType: string; thoughtSignature?: string }>
        } = { content: msg.content, stopReason: msg.stopReason }
        if (logImages && logImages.length > 0) {
          respData.images = logImages
        }
        responseJson = JSON.stringify(respData, null, 2)
      } catch {
        /* 序列化失败则不存响应 */
      }
      httpLogService.updateUsage(logId, usage.input, usage.output, usage.totalTokens, responseJson)
    }
    // 提取 Google Gemini 图片输出
    const images = msgWithImages._images
    if (images && images.length > 0) {
      ctx.state.streamBuffer.images.push(...images)
      for (const img of images) {
        ctx.broadcastEvent({
          type: 'image_data',
          sessionId: ctx.sessionId,
          image: JSON.stringify({
            data: `data:${img.mimeType};base64,${img.data}`,
            mimeType: img.mimeType
          })
        })
      }
    }
  }
  // 提取本次 LLM 回复中的工具调用
  let rawToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
  if (isAssistantMessage(msg)) {
    rawToolCalls = (
      msg.content as Array<{
        type: string
        id?: string
        name?: string
        arguments?: Record<string, unknown>
      }>
    )
      .filter((c) => c.type === 'toolCall' && c.id && c.name)
      .map((tc) => ({ id: tc.id!, name: tc.name!, arguments: tc.arguments || {} }))
  }

  // 中间轮次 step 持久化：有工具调用 → 将 buffer 拆分为 step_thinking + step_text 落库
  if (rawToolCalls.length > 0) {
    const buf = ctx.state.streamBuffer
    const session = sessionDao.findById(ctx.sessionId)
    const turnIndex = ctx.state.turnCounter
    const model = session?.model || ''

    // 1) 思考 → step_thinking
    if (buf.thinking) {
      const thinkingMsg = messageService.addStepThinking({
        sessionId: ctx.sessionId,
        content: buf.thinking,
        turnIndex,
        model
      })
      ctx.broadcastEvent({
        type: 'step_end',
        sessionId: ctx.sessionId,
        messageId: thinkingMsg.id,
        message: JSON.stringify(thinkingMsg)
      })
    }

    // 2) 文本 → step_text（如有图片一并存入 metadata）
    if (buf.content || buf.images.length) {
      const images = buf.images.length
        ? buf.images.map((img) => ({
            data: `data:${img.mimeType};base64,${img.data}`,
            mimeType: img.mimeType,
            ...(img.thoughtSignature && { thoughtSignature: img.thoughtSignature })
          }))
        : undefined
      const textMsg = messageService.addStepText({
        sessionId: ctx.sessionId,
        content: buf.content,
        turnIndex,
        images,
        model
      })
      ctx.broadcastEvent({
        type: 'step_end',
        sessionId: ctx.sessionId,
        messageId: textMsg.id,
        message: JSON.stringify(textMsg)
      })
    }

    // 重置 buffer：下一轮从空开始累积
    ctx.state.streamBuffer = { content: '', thinking: '', images: [] }
  }

  // 注册并行执行 batch
  let batchToolCalls: typeof rawToolCalls | null = null
  if (rawToolCalls.length >= 2) {
    batchToolCalls = rawToolCalls
    parallelCoordinator.registerBatch(ctx.sessionId, batchToolCalls)
  }

  ctx.broadcastEvent({ type: 'text_end', sessionId: ctx.sessionId })

  // 并行 batch 预展示
  if (batchToolCalls) {
    const sessionForTool = sessionDao.findById(ctx.sessionId)
    const turnIndex = ctx.state.turnCounter
    for (const tc of batchToolCalls) {
      const { approvalRequired, userInputRequired, sshCredentialRequired } = checkToolApproval(
        ctx.sessionId,
        tc.name,
        tc.arguments
      )
      if (approvalRequired || userInputRequired || sshCredentialRequired) continue
      const toolUseMsg = messageService.addToolUse({
        sessionId: ctx.sessionId,
        toolCallId: tc.id,
        toolName: tc.name,
        args: tc.arguments,
        turnIndex,
        model: sessionForTool?.model || ''
      })
      ctx.state.toolUseMessageIds.set(tc.id, toolUseMsg.id)
      ctx.broadcastEvent({
        type: 'tool_start',
        sessionId: ctx.sessionId,
        toolCallId: tc.id,
        toolName: tc.name,
        toolArgs: tc.arguments,
        messageId: toolUseMsg.id,
        approvalRequired: false,
        userInputRequired: false,
        sshCredentialRequired: false,
        turnIndex
      })
      ctx.state.preEmittedToolCalls.add(tc.id)
    }
  }
}

/** tool_execution_start 事件：持久化 tool_call、审批判断 */
function handleToolExecutionStart(
  ctx: SessionEventHandlerContext,
  event: Extract<AgentEvent, { type: 'tool_execution_start' }>
): void {
  // 并行 batch 预展示：如果已提前发送过 tool_start，跳过重复处理
  if (ctx.state.preEmittedToolCalls.has(event.toolCallId)) {
    ctx.state.preEmittedToolCalls.delete(event.toolCallId)
    return
  }
  const args = event.args as Record<string, unknown> | undefined
  const sessionForTool = sessionDao.findById(ctx.sessionId)
  const toolUseMsg = messageService.addToolUse({
    sessionId: ctx.sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    args,
    turnIndex: ctx.state.turnCounter,
    model: sessionForTool?.model || ''
  })
  ctx.state.toolUseMessageIds.set(event.toolCallId, toolUseMsg.id)
  const { approvalRequired, userInputRequired, sshCredentialRequired } = checkToolApproval(
    ctx.sessionId,
    event.toolName,
    args || {}
  )
  ctx.broadcastEvent({
    type: 'tool_start',
    sessionId: ctx.sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    toolArgs: args,
    messageId: toolUseMsg.id,
    approvalRequired,
    userInputRequired,
    sshCredentialRequired,
    turnIndex: ctx.state.turnCounter
  })
}

/** tool_execution_end 事件：持久化 tool_result */
function handleToolExecutionEnd(
  ctx: SessionEventHandlerContext,
  event: Extract<AgentEvent, { type: 'tool_execution_end' }>
): void {
  const result = event.result as
    | {
        content?: Array<TextContent | ImageContent>
        details?: ToolResultDetails
      }
    | undefined
  const resultContent =
    result?.content
      ?.map((c: TextContent | ImageContent) => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n') || ''
  // 工具已返回强类型 details，直接透传到持久化和前端
  const toolDetails = result?.details

  // 查找对应的 tool_use 消息 ID 并原地更新
  const toolUseMessageId = ctx.state.toolUseMessageIds.get(event.toolCallId)
  if (toolUseMessageId) {
    messageService.completeToolUse({
      messageId: toolUseMessageId,
      content: resultContent,
      isError: event.isError || false,
      details: toolDetails
    })
    ctx.state.toolUseMessageIds.delete(event.toolCallId)
  }
  ctx.broadcastEvent({
    type: 'tool_end',
    sessionId: ctx.sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    result: resultContent,
    isError: event.isError || false,
    messageId: toolUseMessageId,
    details: toolDetails
  })
}

// ─── 对外分发入口 ──────────────────────────────────────

/** 将 pi-agent-core 事件转换并发送到 Renderer（薄分发器） */
export function forwardAgentEvent(ctx: SessionEventHandlerContext, event: AgentEvent): void {
  switch (event.type) {
    case 'agent_start':
      handleAgentStart(ctx)
      break
    case 'turn_start':
      handleTurnStart(ctx)
      break
    case 'turn_end':
      handleTurnEnd(ctx)
      break
    case 'agent_end':
      handleAgentEnd(ctx, event)
      break
    case 'message_update':
      handleMessageUpdate(ctx, event)
      break
    case 'message_end':
      handleMessageEnd(ctx, event)
      break
    case 'tool_execution_start':
      handleToolExecutionStart(ctx, event)
      break
    case 'tool_execution_end':
      handleToolExecutionEnd(ctx, event)
      break
    default:
      break
  }
}
