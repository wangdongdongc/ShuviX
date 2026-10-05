/**
 * chat-ui 测试夹具（P3-08）：造 `SessionView` / 消息 / 实时卡，以及把 chatStore 复位到干净状态。
 *
 *  - `V(sid, overrides)`：从 `emptySessionView` 起一份视图（`source` 缺省 durable）；
 *  - `user` / `assistant` / `toolBlock` / `errorRow` / `liveCard`：消息与块的最小合法形状；
 *  - `resetStore()`：还原这些用例碰到的全部 chatStore 键与写入口的模块状态。
 *
 * 只给单测用；不引 agent-runtime。
 */
import {
  emptySessionView,
  type LiveCard,
  type SessionView
} from '@shuvix/chat-protocol/types/sessionView'
import type {
  AssistantBlock,
  AssistantMessage,
  AssistantToolBlock,
  ErrorEventMessage,
  UserTextMessage
} from '@shuvix/chat-protocol/types/chatMessage'
import { resetSessionViewStateForTests, useChatStore } from '../../stores/chatStore'

export function V(sessionId: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    ...emptySessionView(sessionId),
    source: 'durable',
    capabilities: { send: true, rollback: true, continue: true },
    conversationId: 1,
    ...overrides
  }
}

export function user(
  id: string,
  content: string,
  sessionId = 's1',
  metadata: UserTextMessage['metadata'] = null
): UserTextMessage {
  return { id, sessionId, role: 'user', type: 'text', content, model: '', createdAt: 0, metadata }
}

export function assistant(
  id: string,
  blocks: AssistantBlock[],
  sessionId = 's1',
  metadata: AssistantMessage['metadata'] = null
): AssistantMessage {
  return {
    id,
    sessionId,
    role: 'assistant',
    type: 'message',
    blocks,
    content: blocks
      .filter((b): b is Extract<AssistantBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join(''),
    model: 'm',
    createdAt: 0,
    metadata
  }
}

export const text = (t: string): AssistantBlock => ({ type: 'text', text: t })
export const thinking = (t: string): AssistantBlock => ({ type: 'thinking', text: t })

export function toolBlock(
  toolCallId: string,
  toolName = 'read',
  args: Record<string, unknown> = {},
  extra: Partial<AssistantToolBlock> = {}
): AssistantToolBlock {
  return { type: 'tool', toolCallId, toolName, args, ...extra }
}

export function errorRow(id: string, content: string, sessionId = 's1'): ErrorEventMessage {
  return {
    id,
    sessionId,
    role: 'system_notify',
    type: 'error_event',
    content,
    model: '',
    createdAt: 0,
    metadata: null
  }
}

/** 实时卡：`id` = `message.id` = `live:<taskId>` */
export function liveCard(
  taskId: number,
  blocks: AssistantBlock[],
  argsText?: Record<string, string>,
  sessionId = 's1'
): LiveCard {
  const id = `live:${taskId}`
  return {
    id,
    message: assistant(id, blocks, sessionId),
    ...(argsText === undefined ? {} : { argsText })
  }
}

/** 还原用例碰到的 chatStore 键与写入口的模块状态 */
export function resetStore(activeSessionId: string | null = null): void {
  resetSessionViewStateForTests()
  useChatStore.setState({
    sessions: [],
    active: activeSessionId ? { type: 'session', id: activeSessionId } : null,
    activeSessionId,
    messages: [],
    sessionViews: {},
    sessionStreams: {},
    sessionClosing: {},
    sessionAgentCreated: {},
    sessionPendingPrompt: {},
    sessionMcpConnecting: {},
    sessionToolExecutions: {},
    sessionToolReviewing: {},
    sessionPendingInputs: {},
    sessionAskCounts: {},
    sessionInputDrafts: {},
    sessionActiveInputId: {},
    sessionQueues: {},
    sessionLocalErrors: {},
    usedContextTokens: null,
    inputText: '',
    pendingImages: []
  })
}

export const store = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()
