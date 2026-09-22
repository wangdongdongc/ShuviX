/**
 * 侧边栏的单会话对话接口 —— `SessionChannelApi` 里桌面接的那部分（白名单见 chat-protocol 的
 * `CHROME_PANEL_CHANNEL_PATHS`），逐条落到与 IPC 处理器同样的服务调用上。
 *
 * **每个带会话的调用都先核对归属**：会话必须是这条连接（这个浏览器的这一轮运行）的标签页会话。
 * 桥不是 `window.api` 的远程版 —— IPC 处理器不检查调用方（桌面窗口里谁都能调），照搬过来就等于
 * 把整个桌面交给了扩展。侧边栏只能碰它自己标签页的那条会话。
 */
import { validateShuvixMdText } from '@shuvix/agent-runtime'
import type {
  AgentFollowUpParams,
  AgentInitParams,
  AgentNextTurnParams,
  AgentPromptParams,
  AgentSteerParams
} from '@shuvix/chat-protocol/chatApi'
import {
  CHROME_PANEL_CHANNEL_PATHS,
  type ChromePanelChannelPath
} from '@shuvix/chat-protocol/chromeBridge'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { chatGateway, createChromeContext, operationContext } from '../core'
import { sessionService } from '../../services/sessionService'
import { taskRegistry } from '../../services/taskRegistry'
import { getBuiltinToolPresentations } from '../../services/toolRegistry'
import { getBuiltinToolDefinitions } from '../../services/agentToolBuilder'
import type { BridgeConnection } from '../../services/chromeBridge'
import { connectionOwnsSession } from './tabSessions'

const ALLOWED: ReadonlySet<string> = new Set(CHROME_PANEL_CHANNEL_PATHS)

/** 不属于这条连接的会话 —— 回给侧边栏的错误文本 */
export const NOT_YOUR_SESSION = 'This session does not belong to this Chrome tab.'

export function isPanelChannelPath(path: unknown): path is ChromePanelChannelPath {
  return typeof path === 'string' && ALLOWED.has(path)
}

/** 调一个对话接口；path 不在白名单、会话不归这条连接时抛错 */
export async function callPanelChannel(
  conn: BridgeConnection,
  path: unknown,
  args: unknown
): Promise<unknown> {
  if (!isPanelChannelPath(path)) {
    throw new Error(`"${String(path)}" is not available from the Chrome side panel.`)
  }
  const list = Array.isArray(args) ? args : []
  const installId = conn.info?.installId ?? ''
  /** 核对归属并回会话 id */
  const own = (sessionId: unknown): string => {
    if (!connectionOwnsSession(conn, sessionId)) throw new Error(NOT_YOUR_SESSION)
    return sessionId as string
  }
  /** 带会话参数对象的第一个实参 */
  const params = <T extends { sessionId: string }>(): T => {
    const p = list[0] as T | undefined
    own(p?.sessionId)
    return p as T
  }
  const inContext = <T>(sessionId: string, fn: () => T): T =>
    operationContext.run(createChromeContext(installId, sessionId), fn)

  switch (path) {
    case 'agent.init': {
      const p = params<AgentInitParams>()
      return inContext(p.sessionId, () => chatGateway.startChat(p.sessionId))
    }
    case 'agent.prompt': {
      const p = params<AgentPromptParams>()
      await inContext(p.sessionId, () =>
        chatGateway.prompt(p.sessionId, p.text, p.images, p.inlineTokens)
      )
      return { success: true }
    }
    case 'agent.steer': {
      const p = params<AgentSteerParams>()
      inContext(p.sessionId, () => chatGateway.steer(p.sessionId, p.text))
      return { success: true }
    }
    case 'agent.followUp': {
      const p = params<AgentFollowUpParams>()
      inContext(p.sessionId, () => chatGateway.followUp(p.sessionId, p.text))
      return { success: true }
    }
    case 'agent.nextTurn': {
      const p = params<AgentNextTurnParams>()
      inContext(p.sessionId, () => chatGateway.nextTurn(p.sessionId, p.text))
      return { success: true }
    }
    case 'agent.abort': {
      const sessionId = own(list[0])
      return inContext(sessionId, () => chatGateway.abort(sessionId))
    }
    case 'agent.respondToInput': {
      const p = params<{ sessionId: string; requestId: string; response: InputResponse }>()
      inContext(p.sessionId, () => chatGateway.respondToInput(p.sessionId, p.requestId, p.response))
      return { success: true }
    }
    case 'session.getById':
      return sessionService.getById(own(list[0])) ?? null
    case 'message.list': {
      const sessionId = own(list[0])
      return inContext(sessionId, () => chatGateway.listMessages(sessionId))
    }
    case 'runtime.statuses': {
      const sessionId = own(list[0])
      return chatGateway.getRuntimeStatuses(sessionId)
    }
    case 'bgTask.list':
      return taskRegistry.list(params<{ sessionId: string }>().sessionId)
    case 'tools.list':
      return chatGateway.listTools(own(list[0]))
    case 'tools.presentations':
      return getBuiltinToolPresentations()
    case 'tools.definitions':
      return getBuiltinToolDefinitions()
    case 'shuvixMd.validate': {
      const p = (list[0] ?? {}) as { type?: unknown; text?: unknown; name?: unknown }
      if (typeof p.type !== 'string' || typeof p.text !== 'string') {
        throw new Error('shuvixMd.validate needs { type, text }.')
      }
      return validateShuvixMdText(p.type, p.text, typeof p.name === 'string' ? p.name : undefined)
    }
  }
}
