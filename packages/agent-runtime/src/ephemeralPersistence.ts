/**
 * Ephemeral persistence —— 内存态 RuntimePersistence 实现。
 *
 * 派生任务 agent 与会话根 agent 共用同一套 RuntimeAgent + 事件管线，唯一差异是
 * 持久化注入：派生 agent 注入本实现 —— 消息只在内存合成（事件广播仍携带完整消息体
 * 供前端渲染），不产生任何会话/消息记录，agent 销毁即消失。
 *
 * id 约定：tool_use 消息 id 为 `${sessionId}-tc-${toolCallId}`（与既有前端子会话
 * 事件的 messageId 形态一致），其余消息用自增序号保证唯一。
 */
import type { RuntimePersistence, ChatMessage, MessageMetadata, ToolResultDetails } from './types'

export function createEphemeralPersistence(): RuntimePersistence {
  let seq = 0
  const nextId = (sessionId: string, kind: string): string => `${sessionId}-${kind}-${seq++}`

  return {
    listMessages: () => [],

    add: (p) =>
      ({
        id: nextId(p.sessionId, p.type ?? 'msg'),
        sessionId: p.sessionId,
        role: p.role,
        type: p.type ?? 'text',
        content: p.content,
        metadata: p.metadata ?? null,
        model: p.model ?? '',
        createdAt: Date.now()
      }) as ChatMessage,

    addAssistantText: (p) =>
      ({
        id: nextId(p.sessionId, 'final'),
        sessionId: p.sessionId,
        role: 'assistant',
        type: 'text',
        content: p.content,
        metadata: (p.metadata ?? null) as MessageMetadata | null,
        model: p.model,
        createdAt: Date.now()
      }) as ChatMessage,

    addToolUse: (p) =>
      ({
        id: `${p.sessionId}-tc-${p.toolCallId}`,
        sessionId: p.sessionId,
        role: 'assistant',
        type: 'tool_use',
        content: '',
        metadata: {
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          args: p.args,
          turnIndex: p.turnIndex
        },
        model: p.model,
        createdAt: Date.now()
      }) as ChatMessage,

    completeToolUse: (_p: {
      messageId: string
      content: string
      isError?: boolean
      details?: ToolResultDetails
    }) => {
      /* 内存态：结果只经 tool_end 事件送达前端，无需回写 */
    },

    addStepThinking: (p) =>
      ({
        id: nextId(p.sessionId, 'step-thinking'),
        sessionId: p.sessionId,
        role: 'assistant',
        type: 'step_thinking',
        content: p.content,
        metadata: { turnIndex: p.turnIndex },
        model: p.model,
        createdAt: Date.now()
      }) as ChatMessage,

    addStepText: (p) =>
      ({
        id: nextId(p.sessionId, 'step-text'),
        sessionId: p.sessionId,
        role: 'assistant',
        type: 'step_text',
        content: p.content,
        metadata: { turnIndex: p.turnIndex, images: p.images },
        model: p.model,
        createdAt: Date.now()
      }) as ChatMessage
  }
}
