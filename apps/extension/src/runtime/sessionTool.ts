/**
 * 扩展 session 工具 —— 复用 @shuvix/agent-runtime 的共享 createSessionTool 内核。
 *
 * 数据源是 Agent 上下文（与桌面 tools/session.ts 对称）：
 *   - getAgentMessages：ensureRuntimeSession 懒初始化（未建则从 IndexedDB 恢复上下文，
 *     恢复已升级为共享全保真投影 —— 含工具轨迹）→ getMessages()；
 *   - persistCompact：忙碌检查（根会话 RuntimeAgent 正在生成则拒绝）+
 *     verifyContextFingerprint（上下文与转写快照一致）+ 归档旧消息 + 写入摘要
 *     （扩展无项目指令文件注入）+ removeRuntimeSession + eventBus 广播 messages_reloaded。
 *     IndexedDB 无跨表事务：归档与写摘要之间的窗口接受为 MVP 口径（失败重跑不丢数据 ——
 *     归档仍可回看）。
 */
import { v4 as uuid } from 'uuid'
import i18next from 'i18next'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createSessionTool, verifyContextFingerprint } from '@shuvix/agent-runtime'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { messageStore } from '../storage/messageStore'
import { sessionStore } from '../storage/sessionStore'
import { eventBus } from './eventBus'
import { ensureRuntimeSession, removeRuntimeSession } from './agentRuntime'
import type { RuntimeAgent } from '@shuvix/agent-runtime'

/** 确保根会话 RuntimeAgent 已初始化（未建则从 IDB 恢复上下文），不存在时抛错 */
async function ensureAgent(sessionId: string): Promise<RuntimeAgent> {
  const runtime = await ensureRuntimeSession(sessionId)
  if (!runtime) throw new Error(`Session not found: ${sessionId}`)
  return runtime
}

/** 创建扩展 session 工具（绑定根会话） */
export function createExtensionSessionTool(rootSessionId: string): AgentTool {
  return createSessionTool({
    sessionId: rootSessionId,
    label: i18next.t('tool.sessionLabel'),
    abortError: 'TOOL_ABORTED',

    getAgentMessages: async () => (await ensureAgent(rootSessionId)).getMessages(),

    persistCompact: async ({ summaryContent, expectedFingerprint }) => {
      const runtime = await ensureAgent(rootSessionId)
      // 忙碌检查：根会话正在生成时提交会截断其上下文，直接拒绝
      if (runtime.getAgent().state.isStreaming) {
        throw new Error(
          'The session agent is currently generating. Wait for it to finish, then start over from {action:"transcript"}.'
        )
      }
      // 一致性校验：transcript 之后上下文有变 → 摘要不完整，要求重读
      verifyContextFingerprint(runtime.getMessages(), expectedFingerprint)

      const session = await sessionStore.getById(rootSessionId)
      const rows = await messageStore.list(rootSessionId)
      await messageStore.archiveBySessionId(rootSessionId)
      const summaryMessage = {
        id: uuid(),
        sessionId: rootSessionId,
        role: 'assistant',
        type: 'text',
        content: summaryContent,
        metadata: { isCompactionSummary: true },
        model: session?.model || '',
        createdAt: Date.now()
      } as ChatMessage
      messageStore.insertMessage(summaryMessage)

      // 销毁运行时；下次 ensureRuntimeSession 从「仅含摘要」的活跃历史重建上下文
      removeRuntimeSession(rootSessionId)
      eventBus.emit({ type: 'messages_reloaded', sessionId: rootSessionId })
      return { archivedCount: rows.length }
    }
  }) as unknown as AgentTool
}
