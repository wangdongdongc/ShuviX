/**
 * CompactionService — 桌面端 Full Compaction 适配器。
 *
 * 编排逻辑已抽到 @shuvix/agent-runtime 的 runCompaction（端无关）；此处只提供 Electron 侧的
 * 依赖适配：DAO 存储事务、provider/model 解析、指令文件扫描、chatFrontendRegistry 广播。
 */
import { v7 as uuidv7 } from 'uuid'
import { runCompaction, isCompacting, type CompactionDeps } from '@shuvix/agent-runtime'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { messageDao, messageStepDao } from '../dao/messageDao'
import { sessionDao } from '../dao/sessionDao'
import { providerDao } from '../dao/providerDao'
import { databaseManager } from '../dao/database'
import { messageService } from './messageService'
import { sessionService } from './sessionService'
import { buildInstructionMessages } from './instruction'
import { chatFrontendRegistry } from '../frontend/core'
import { dbMessagesToAgentMessages } from '../utils/agentMessageConverter'
import type { Message } from '../types'
import { createLogger } from '../logger'

const log = createLogger('CompactionService')

class CompactionService {
  /** 检查会话是否正在压缩（委托共享内核的进程内锁） */
  isCompacting(sessionId: string): boolean {
    return isCompacting(sessionId)
  }

  /**
   * 执行 Full Compaction
   * @returns 新生成的摘要消息
   */
  async compact(sessionId: string): Promise<ChatMessage> {
    const deps: CompactionDeps = {
      loadAgentMessages: (sid) => {
        const dbMessages = messageService.listBySession(sid)
        if (dbMessages.length === 0) {
          throw new Error('没有可压缩的消息')
        }
        // converter 排除 system_notify / step 等不参与上下文的消息
        return dbMessagesToAgentMessages(dbMessages as unknown as Message[])
      },

      resolveModelAndKey: async (sid) => {
        const agentSession = sessionService.getAgentSession(sid)
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
        return { model, apiKey, modelId: String(model.id || '') }
      },

      buildInstructionMessages: (sid) => {
        const workingDir = sessionService.getById(sid)?.workingDirectory || ''
        const messages = workingDir ? buildInstructionMessages(sid, workingDir) : []
        return messages as unknown as ChatMessage[]
      },

      buildSummaryMessage: ({ sessionId: sid, content, modelId, afterTs }) => {
        const summaryMessage: Message = {
          id: uuidv7(),
          sessionId: sid,
          role: 'assistant',
          type: 'text',
          content,
          metadata: { isCompactionSummary: true },
          model: modelId,
          createdAt: Math.max(Date.now(), afterTs + 1)
        }
        return summaryMessage as unknown as ChatMessage
      },

      persist: ({ sessionId: sid, instructionMessages, summaryMessage }) => {
        // 原子事务：归档旧消息 + 插入指令 + 插入摘要
        const db = databaseManager.getDb()
        db.transaction(() => {
          messageDao.archiveBySessionId(sid)
          messageStepDao.archiveBySessionId(sid)
          for (const im of instructionMessages) messageDao.insert(im as unknown as Message)
          messageDao.insert(summaryMessage as unknown as Message)
          sessionDao.touch(sid)
        })()
      },

      invalidateAgent: (sid) => {
        sessionService.invalidateAgent(sid)
      },

      broadcast: (event) => chatFrontendRegistry.broadcast(event),

      logger: {
        info: (m) => log.info(m),
        warn: (m) => log.warn(m),
        error: (m) => log.error(m)
      }
    }

    return runCompaction(sessionId, deps)
  }
}

export const compactionService = new CompactionService()
