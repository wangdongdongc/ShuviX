/**
 * 派生 Agent 协调器（桌面装配）—— 复用 @shuvix/agent-runtime 的 createSubAgentManager 内核。
 *
 * 执行/事件管线/abort/深度校验全在共享核心；agent 创建（工具解析/模型构建/LLM 日志/
 * 内存会话树）经统一创建管线（agents/agentHost 的 agentFactory）完成 —— 与根会话
 * 同一条管线、同一张 root/spawned 决策表。桌面在此只接线：
 *   - createAgent：agentFactory.createAgent（惰性引用，避免模块初始化环）
 *   - requestUserInput：派生 agent 询问/询问转发到根会话（userInputBroker）
 *   - broadcast：electronEventSink —— 即 chatFrontendRegistry **加上**通知决策器旁路。
 *     直接用 registry 会让决策器收不到 sub_session_register/-end：血缘不在手上，派生 agent 的
 *     agent_end 就跟根会话的长得一模一样，于是每个子 agent 跑完都弹一条「已完成」
 *     （标题还取不到会话行，显示为「未命名会话」）。
 */
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { createSubAgentManager, type InProcessAgentType } from '@shuvix/agent-runtime'
import { electronEventSink } from '../services/agentRuntimeAdapters'
import { requestUserInputFor } from '../services/userInputBroker'
import { t } from '../i18n'
import { createLogger } from '../logger'
import { agentFactory } from './agentHost'

export type { InProcessAgentType }

const log = createLogger('Agent')

export const agentManager = createSubAgentManager({
  // 统一创建管线（保持箭头包装：ESM 循环下惰性取 agentFactory 绑定）
  createAgent: (params) => agentFactory.createAgent(params),
  // 派生 agent 询问/询问转发到根会话（sessionService 在 userInputBroker 注册 resolver）
  requestUserInput: (rootSessionId, req) => requestUserInputFor(rootSessionId, req),
  broadcast: (event: ChatEvent) => electronEventSink.broadcast(event),
  logger: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
  getAbortedNote: () => t('agent.toolAborted') || 'Aborted by user.'
})
