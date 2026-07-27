/**
 * session 工具（桌面注册）—— 复用 @shuvix/agent-runtime 的共享 createSessionTool 内核。
 *
 * 数据源是 Agent 上下文：转写渲染 / 顺序约束 / 并发锁 / 指纹校验文案 / 摘要框架全共享；
 * 桌面只注入端适配：
 *   - getAgentMessages：ensureAgentSession 懒初始化（未建则从 DB 恢复上下文）→ getMessages()；
 *   - persistCompact：忙碌检查（根会话 Agent 正在生成则拒绝）+ verifyContextFingerprint
 *     （上下文与转写快照一致）+ better-sqlite3 事务（归档 messages/message_steps +
 *     重注入指令文件 + 写入摘要）+ invalidateAgent + 广播 messages_reloaded。
 *
 * 注册 defaultEnabled: false（与 git/preview 同模式）：主 Agent 默认不注入，
 * compact 子代理经白名单按名解析使用。
 */
import { v7 as uuidv7 } from 'uuid'
import {
  createSessionTool,
  verifyContextFingerprint,
  SessionToolParamsSchema,
  SESSION_TOOL_DESCRIPTION
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { TOOL_ABORTED, type ToolContext } from '../services/toolContext'
import { registerBuiltinTool } from '../services/toolRegistry'
import { sessionService } from '../services/sessionService'
import { buildInstructionMessages } from '../services/instruction'
import { messageDao, messageStepDao } from '../dao/messageDao'
import { sessionDao } from '../dao/sessionDao'
import { databaseManager } from '../dao/database'
import { chatFrontendRegistry } from '../frontend/core'
import type { Message } from '../types'
import type { AgentSession } from '../services/agentSession'
import { t } from '../i18n'
import { createLogger } from '../logger'

const log = createLogger('Tool:session')

/** 确保根会话 Agent 已初始化（未建则从 DB 恢复上下文），不存在的会话直接抛错 */
async function ensureAgent(sessionId: string): Promise<AgentSession> {
  const agentSession = await sessionService.ensureAgentSession(sessionId)
  if (!agentSession) throw new Error(`Session not found: ${sessionId}`)
  return agentSession
}

/** 构建桌面 session 工具实例（ctx.sessionId = 根会话 id，派生 agent 装配时由 AgentManager 绑定） */
export const makeSessionTool = (ctx: ToolContext): ReturnType<typeof createSessionTool> =>
  createSessionTool({
    sessionId: ctx.sessionId,
    label: t(BUILTIN_TOOL_PRESENTATIONS.session.labelKey),
    abortError: TOOL_ABORTED,

    getAgentMessages: async () => (await ensureAgent(ctx.sessionId)).getMessages(),

    persistCompact: async ({ summaryContent, expectedFingerprint }) => {
      const sessionId = ctx.sessionId
      const agentSession = await ensureAgent(sessionId)
      // 忙碌检查：根会话 Agent 正在生成时提交会截断其上下文，直接拒绝
      if (agentSession.getAgent().state.isStreaming) {
        throw new Error(
          'The session agent is currently generating. Wait for it to finish, then start over from {action:"transcript"}.'
        )
      }
      // 一致性校验：transcript 之后上下文有变（新消息 / 回退重建）→ 摘要不完整，要求重读
      verifyContextFingerprint(agentSession.getMessages(), expectedFingerprint)

      const workingDir = sessionService.getById(sessionId)?.workingDirectory || ''
      const instructionMessages = workingDir ? buildInstructionMessages(sessionId, workingDir) : []
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
        model: String(agentSession.getAgent().state.model.id ?? ''),
        // 摘要时间戳晚于全部指令消息，确保排序在后
        createdAt: Math.max(Date.now(), lastInstructionTs + 1)
      }

      // 原子事务：归档旧消息 + 插入指令 + 插入摘要
      let archivedCount = 0
      const db = databaseManager.getDb()
      db.transaction(() => {
        archivedCount = messageDao.archiveBySessionId(sessionId)
        archivedCount += messageStepDao.archiveBySessionId(sessionId)
        for (const im of instructionMessages) messageDao.insert(im)
        messageDao.insert(summaryMessage)
        sessionDao.touch(sessionId)
      })()

      // 失效 Agent（下次交互从摘要重建上下文），随后通知前端重拉消息列表
      sessionService.invalidateAgent(sessionId)
      chatFrontendRegistry.broadcast({ type: 'messages_reloaded', sessionId })
      log.info(
        `compacted session=${sessionId} archived=${archivedCount} instructions=${instructionMessages.length}`
      )
      return { archivedCount }
    }
  })

registerBuiltinTool({
  name: 'session',
  group: 'general',
  // 主 Agent 默认不注入（与 git/preview 同模式）；compact 子代理经白名单按名解析
  defaultEnabled: false,
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.session.labelKey),
  getHint: () => t('tool.sessionHint'),
  factory: (ctx) => makeSessionTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS.session.presentation,
  describe: () => ({ description: SESSION_TOOL_DESCRIPTION, parameters: SessionToolParamsSchema })
})
