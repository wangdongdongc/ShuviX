/**
 * 浏览器 Full Compaction 适配器 —— 把 @shuvix/agent-runtime 的 runCompaction 接到扩展宿主：
 * IndexedDB 存储（messageStore 归档/写入）、chrome.storage 模型解析、eventBus 广播。
 *
 * 与桌面 compactionService 对称：编排逻辑共享，仅依赖适配不同。压缩后归档旧消息、写入摘要、
 * 销毁 RuntimeSession（下次交互从摘要重建上下文）。
 */
import { v4 as uuid } from 'uuid'
import { runCompaction, type CompactionDeps } from '@shuvix/agent-runtime'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { messageStore } from '../storage/messageStore'
import { sessionStore } from '../storage/sessionStore'
import { settingsStore } from '../storage/settingsStore'
import { eventBus } from './eventBus'
import { resolveSessionModel } from './resolveSessionModel'
import { restoreAgentMessages, removeRuntimeSession, capsFor } from './agentRuntime'

const deps: CompactionDeps = {
  // MVP：仅恢复文本轮次（与 ensureRuntimeSession 的上下文恢复口径一致）
  loadAgentMessages: async (sessionId) => restoreAgentMessages(await messageStore.list(sessionId)),

  resolveModelAndKey: async (sessionId) => {
    const session = await sessionStore.getById(sessionId)
    await settingsStore.loadState()
    const def = settingsStore.getDefaultSelection()
    const provider = session?.provider || def.provider
    const modelId = session?.model || def.model
    const caps = capsFor(modelId)
    const model = resolveSessionModel(provider, modelId, caps)
    const apiKey = settingsStore.getApiKey(provider)
    if (!apiKey) {
      throw new Error(
        `当前会话使用的 Provider (${provider}) 没有配置 API Key,请到设置 → Provider 中填写后重试`
      )
    }
    return { model, apiKey, modelId }
  },

  // 浏览器形态暂无项目指令文件注入
  buildInstructionMessages: () => [],

  buildSummaryMessage: ({ sessionId, content, modelId, afterTs }) =>
    ({
      id: uuid(),
      sessionId,
      role: 'assistant',
      type: 'text',
      content,
      metadata: { isCompactionSummary: true },
      model: modelId,
      createdAt: Math.max(Date.now(), afterTs + 1)
    }) as ChatMessage,

  persist: async ({ sessionId, instructionMessages, summaryMessage }) => {
    // 归档旧消息（list 默认过滤），随后写入指令 + 摘要
    await messageStore.archiveBySessionId(sessionId)
    for (const im of instructionMessages) messageStore.insertMessage(im)
    messageStore.insertMessage(summaryMessage)
  },

  // 销毁运行时；下次 ensureRuntimeSession 从「仅含摘要」的活跃历史重建上下文
  invalidateAgent: (sessionId) => removeRuntimeSession(sessionId),

  broadcast: (event) => eventBus.emit(event),

  logger: {
    info: (m) => console.info('[shuvix]', m),
    warn: (m) => console.warn('[shuvix]', m),
    error: (m) => console.error('[shuvix]', m)
  }
}

/** 执行 Full Compaction（供 chatApiAdapter.compact.start 调用） */
export function compactSession(sessionId: string): Promise<ChatMessage> {
  return runCompaction(sessionId, deps)
}
