import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core'
import type { AssistantMessage, ImageContent, TextContent } from '@mariozechner/pi-ai'
import { httpLogService } from './httpLogService'
import { messageService } from './messageService'
import { sessionDao } from '../dao/sessionDao'
import { resolveProjectConfig } from '../tools/types'
import { dockerManager } from './dockerManager'
import { parallelCoordinator } from './parallelExecution'
import type { Message } from '../types'
import type { ChatEvent } from '../frontend'
import { createLogger } from '../logger'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const log = createLogger('AgentEvent')

/** 提前发送过 tool_start 的 toolCallId 集合（sessionId → Set），用于并行工具预展示 */
const preEmittedToolCalls = new Map<string, Set<string>>()

/** 检查工具是否需要用户审批/输入（复用于 handleMessageEnd 预展示和 handleToolExecutionStart） */
function checkToolApproval(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>
): { approvalRequired: boolean; userInputRequired: boolean; sshCredentialRequired: boolean } {
  let approvalRequired = false
  if (toolName === 'bash') {
    const config = resolveProjectConfig({ sessionId })
    approvalRequired = config.sandboxEnabled
  } else if (toolName === 'shuvix-project' && args?.action === 'update') {
    approvalRequired = true
  } else if (toolName === 'shuvix-setting' && args?.action === 'set') {
    approvalRequired = true
  } else if (toolName === 'ssh' && args?.action === 'exec') {
    let sshAutoApprove = false
    try {
      const sess = sessionDao.findById(sessionId)
      sshAutoApprove = JSON.parse(sess?.settings || '{}').sshAutoApprove === true
    } catch {
      /* ignore */
    }
    approvalRequired = !sshAutoApprove
  }
  const userInputRequired = toolName === 'ask'
  const sshCredentialRequired =
    toolName === 'ssh' && args?.action === 'connect' && !args?.credentialName
  return { approvalRequired, userInputRequired, sshCredentialRequired }
}

/** 会话级项目指令文件加载状态（由 AgentService 统一维护） */
export interface ProjectInstructionLoadState {
  agentMdLoaded: boolean
}

/** 读取项目根目录指令文件（优先 AGENTS.MD，回退 AGENT.md；不存在或读取失败时返回空） */
export function readProjectAgentMd(projectPath: string): string {
  // 优先 AGENTS.MD，兼容旧版 AGENT.md
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

/** 事件处理器所需的上下文（避免直接依赖 AgentService） */
export interface EventHandlerContext {
  streamBuffers: Map<
    string,
    {
      content: string
      thinking: string
      images: Array<{ data: string; mimeType: string; thoughtSignature?: string }>
    }
  >
  turnCounters: Map<string, number>
  pendingLogIds: Map<string, string[]>
  broadcastEvent: (event: ChatEvent) => void
  persistStreamBuffer: (sessionId: string, extraMeta?: Record<string, unknown>) => Message | null
  isAssistantMessage: (message: AgentMessage) => message is AssistantMessage
  emitDockerEvent: (sessionId: string, action: string, extra?: Record<string, string>) => void
}

/** agent_start 事件：初始化缓冲区和 turn 计数 */
function handleAgentStart(ctx: EventHandlerContext, sessionId: string): void {
  log.info(`开始 session=${sessionId}`)
  ctx.streamBuffers.set(sessionId, { content: '', thinking: '', images: [] })
  ctx.turnCounters.set(sessionId, 0)
  preEmittedToolCalls.delete(sessionId)
  ctx.broadcastEvent({ type: 'agent_start', sessionId })
}

/** turn_start 事件：递增 turn 计数器 */
function handleTurnStart(ctx: EventHandlerContext, sessionId: string): void {
  const turnIdx = (ctx.turnCounters.get(sessionId) || 0) + 1
  ctx.turnCounters.set(sessionId, turnIdx)
  log.info(`Turn ${turnIdx} 开始 session=${sessionId}`)
}

/** turn_end 事件：记录日志 */
function handleTurnEnd(ctx: EventHandlerContext, sessionId: string): void {
  log.info(`Turn ${ctx.turnCounters.get(sessionId) || 0} 结束 session=${sessionId}`)
}

/** agent_end 事件：Docker 清理、token 统计、持久化 */
function handleAgentEnd(
  ctx: EventHandlerContext,
  sessionId: string,
  event: Extract<AgentEvent, { type: 'agent_end' }>
): void {
  log.info(`结束 session=${sessionId}`)
  preEmittedToolCalls.delete(sessionId)
  // Docker 模式下，回复完成后延迟销毁容器（空闲超时后自动清理）
  dockerManager.scheduleDestroy(sessionId, (containerId) => {
    ctx.emitDockerEvent(sessionId, 'container_destroyed', {
      containerId: containerId.slice(0, 12),
      reason: 'idle'
    })
  })
  // 检查 agent_end 中的消息是否携带错误信息
  const endMessages = event.messages
  for (const m of endMessages) {
    if (ctx.isAssistantMessage(m) && m.errorMessage) {
      log.error(`流式错误: ${m.errorMessage}`)
      ctx.broadcastEvent({ type: 'error', sessionId, error: m.errorMessage })
    }
  }
  // 从 agent_end 自带的 messages 中提取每条 AssistantMessage 的 token 用量
  const details: Array<{
    input: number
    output: number
    cacheRead: number
    total: number
    stopReason: string
  }> = []
  for (const m of endMessages) {
    if (ctx.isAssistantMessage(m) && m.usage) {
      details.push({
        input: m.usage.input || 0,
        output: m.usage.output || 0,
        cacheRead: m.usage.cacheRead || 0,
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
      total: acc.total + d.total
    }),
    { input: 0, output: 0, cacheRead: 0, total: 0 }
  )
  // 后端统一落库：将缓冲区内容持久化为 assistant 消息（携带 usage）
  const savedMsg = ctx.persistStreamBuffer(
    sessionId,
    totalUsage.total > 0 ? { usage: { ...totalUsage, details } } : {}
  )
  ctx.broadcastEvent({
    type: 'agent_end',
    sessionId,
    usage: { ...totalUsage, details },
    message: savedMsg ? JSON.stringify(savedMsg) : undefined
  })
}

/** message_update 事件：累积 text/thinking delta */
function handleMessageUpdate(
  ctx: EventHandlerContext,
  sessionId: string,
  event: Extract<AgentEvent, { type: 'message_update' }>
): void {
  const msgEvent = event.assistantMessageEvent
  if (msgEvent.type === 'text_delta') {
    // 后端累积 delta（用于 agent_end / abort 时落库）
    const buf = ctx.streamBuffers.get(sessionId) || { content: '', thinking: '', images: [] }
    buf.content += msgEvent.delta || ''
    ctx.streamBuffers.set(sessionId, buf)
    // 仍转发给前端用于实时 UI 展示
    ctx.broadcastEvent({ type: 'text_delta', sessionId, delta: msgEvent.delta || '' })
  } else if (msgEvent.type === 'thinking_delta') {
    const buf = ctx.streamBuffers.get(sessionId) || { content: '', thinking: '', images: [] }
    buf.thinking += msgEvent.delta || ''
    ctx.streamBuffers.set(sessionId, buf)
    ctx.broadcastEvent({ type: 'thinking_delta', sessionId, delta: msgEvent.delta || '' })
  }
}

/** message_end 事件：HTTP 日志更新、图片提取 */
function handleMessageEnd(
  ctx: EventHandlerContext,
  sessionId: string,
  event: Extract<AgentEvent, { type: 'message_end' }>
): void {
  // 如果是 assistant 消息，将 token 用量回填到对应的 HTTP 日志
  const msg = event.message
  if (ctx.isAssistantMessage(msg)) {
    // 检查流式响应中的错误（如 API 返回的错误）
    if (msg.stopReason === 'error' && msg.errorMessage) {
      log.error(`API 错误: ${msg.errorMessage}`)
      ctx.broadcastEvent({ type: 'error', sessionId, error: msg.errorMessage })
    }
    const logId = ctx.pendingLogIds.get(sessionId)?.shift()
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
    // 提取 Google Gemini 图片输出（_images 附加字段）
    const images = msgWithImages._images
    if (images && images.length > 0) {
      const buf = ctx.streamBuffers.get(sessionId)
      if (buf) {
        buf.images.push(...images)
      }
      // 实时推送图片到前端
      for (const img of images) {
        ctx.broadcastEvent({
          type: 'image_data',
          sessionId,
          image: JSON.stringify({
            data: `data:${img.mimeType};base64,${img.data}`,
            mimeType: img.mimeType
          })
        })
      }
    }
  }
  // 注册并行执行 batch + 预展示：assistant 消息含 2+ toolCalls 时，提前发送 tool_start
  let batchToolCalls: Array<{
    id: string
    name: string
    arguments: Record<string, unknown>
  }> | null = null
  if (ctx.isAssistantMessage(msg)) {
    const rawToolCalls = (
      msg.content as Array<{
        type: string
        id?: string
        name?: string
        arguments?: Record<string, unknown>
      }>
    ).filter((c) => c.type === 'toolCall' && c.id && c.name)
    if (rawToolCalls.length >= 2) {
      batchToolCalls = rawToolCalls.map((tc) => ({
        id: tc.id!,
        name: tc.name!,
        arguments: tc.arguments || {}
      }))
      parallelCoordinator.registerBatch(sessionId, batchToolCalls)
    }
  }

  ctx.broadcastEvent({ type: 'text_end', sessionId })

  // 并行 batch 预展示：提前发送所有不需审批的工具 tool_start，让 UI 同时显示为执行中
  if (batchToolCalls) {
    const preEmitted = new Set<string>()
    const sessionForTool = sessionDao.findById(sessionId)
    const turnIndex = ctx.turnCounters.get(sessionId) || 0
    for (const tc of batchToolCalls) {
      const { approvalRequired, userInputRequired, sshCredentialRequired } = checkToolApproval(
        sessionId,
        tc.name,
        tc.arguments
      )
      // 需要用户交互的工具仍由框架按顺序触发，不预展示
      if (approvalRequired || userInputRequired || sshCredentialRequired) continue
      const toolCallMsg = messageService.add({
        sessionId,
        role: 'assistant',
        type: 'tool_call',
        content: '',
        metadata: JSON.stringify({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments,
          turnIndex
        }),
        model: sessionForTool?.model || ''
      })
      ctx.broadcastEvent({
        type: 'tool_start',
        sessionId,
        toolCallId: tc.id,
        toolName: tc.name,
        toolArgs: tc.arguments,
        messageId: toolCallMsg.id,
        approvalRequired: false,
        userInputRequired: false,
        sshCredentialRequired: false,
        turnIndex
      })
      preEmitted.add(tc.id)
    }
    if (preEmitted.size > 0) {
      preEmittedToolCalls.set(sessionId, preEmitted)
    }
  }
}

/** tool_execution_start 事件：持久化 tool_call、审批判断 */
function handleToolExecutionStart(
  ctx: EventHandlerContext,
  sessionId: string,
  event: Extract<AgentEvent, { type: 'tool_execution_start' }>
): void {
  // 并行 batch 预展示：如果已在 handleMessageEnd 中提前发送过 tool_start，跳过重复处理
  const preEmitted = preEmittedToolCalls.get(sessionId)
  if (preEmitted?.has(event.toolCallId)) {
    preEmitted.delete(event.toolCallId)
    if (preEmitted.size === 0) preEmittedToolCalls.delete(sessionId)
    return
  }
  const args = event.args as Record<string, unknown> | undefined
  // 持久化工具调用消息
  const sessionForTool = sessionDao.findById(sessionId)
  const toolCallMsg = messageService.add({
    sessionId,
    role: 'assistant',
    type: 'tool_call',
    content: '',
    metadata: JSON.stringify({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args,
      turnIndex: ctx.turnCounters.get(sessionId) || 0
    }),
    model: sessionForTool?.model || ''
  })
  const { approvalRequired, userInputRequired, sshCredentialRequired } = checkToolApproval(
    sessionId,
    event.toolName,
    args || {}
  )
  ctx.broadcastEvent({
    type: 'tool_start',
    sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    toolArgs: args,
    messageId: toolCallMsg.id,
    approvalRequired,
    userInputRequired,
    sshCredentialRequired,
    turnIndex: ctx.turnCounters.get(sessionId) || 0
  })
}

/** tool_execution_end 事件：持久化 tool_result */
function handleToolExecutionEnd(
  ctx: EventHandlerContext,
  sessionId: string,
  event: Extract<AgentEvent, { type: 'tool_execution_end' }>
): void {
  const result = event.result as { content?: Array<TextContent | ImageContent> } | undefined
  // 持久化工具结果消息
  const resultContent =
    result?.content
      ?.map((c: TextContent | ImageContent) => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n') || ''
  const toolResultMsg = messageService.add({
    sessionId,
    role: 'tool',
    type: 'tool_result',
    content: resultContent,
    metadata: JSON.stringify({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError || false
    })
  })
  ctx.broadcastEvent({
    type: 'tool_end',
    sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    result: resultContent,
    isError: event.isError || false,
    messageId: toolResultMsg.id
  })
}

/** 将 pi-agent-core 事件转换并发送到 Renderer（薄分发器） */
export function forwardAgentEvent(
  ctx: EventHandlerContext,
  sessionId: string,
  event: AgentEvent
): void {
  switch (event.type) {
    case 'agent_start':
      handleAgentStart(ctx, sessionId)
      break
    case 'turn_start':
      handleTurnStart(ctx, sessionId)
      break
    case 'turn_end':
      handleTurnEnd(ctx, sessionId)
      break
    case 'agent_end':
      handleAgentEnd(ctx, sessionId, event)
      break
    case 'message_update':
      handleMessageUpdate(ctx, sessionId, event)
      break
    case 'message_end':
      handleMessageEnd(ctx, sessionId, event)
      break
    case 'tool_execution_start':
      handleToolExecutionStart(ctx, sessionId, event)
      break
    case 'tool_execution_end':
      handleToolExecutionEnd(ctx, sessionId, event)
      break
    default:
      break
  }
}
