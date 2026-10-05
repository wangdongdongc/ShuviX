/**
 * 派生 agent 路由（桌面装配，P2-05）—— 复用 @shuvix/agent-runtime 的 createSubAgentManager。
 *
 * 派生 agent 住在它的 durable 会话里（`session.agents`，协调器）；路由按会话 id 找到会话（主进程唯一的
 * SessionHost，`getSessionHost()`，每次现取 —— 模块初始化时不建宿主），负责进程内的呈现：register / end
 * 广播、taskRegistry 的 'agent' 条目、agentId 索引、面板的追问 / 中断 / 销毁。桌面在此只接线：
 *   - sessions：单例 SessionHost 的 `get` / `peek`（惰性；面板追问在会话关着时 peek，从不 open）
 *   - broadcast：electronEventSink —— 即 chatFrontendRegistry **加上**通知决策器旁路。
 *     直接用 registry 会让决策器收不到 sub_session_register/-end：血缘不在手上，派生 agent 的
 *     agent_end 就跟根会话的长得一模一样，于是每个子 agent 跑完都弹一条「已完成」
 *     （标题还取不到会话行，显示为「未命名会话」）。
 *   - tasks：后台任务枢纽（taskId = agentId），面板因此与 bash、子会话同列一张表
 */
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { createSubAgentManager, type InProcessAgentType } from '@shuvix/agent-runtime'
import { electronEventSink } from '../services/agentRuntimeAdapters'
import { getSessionHost } from '../services/sessionHost'
import { t } from '../i18n'
import { createLogger } from '../logger'
import { taskRegistry } from '../services/taskRegistry'

export type { InProcessAgentType }

const log = createLogger('Agent')

export const agentManager = createSubAgentManager({
  // 惰性：宿主第一次真用时才建（保持箭头包装，也避开 ESM 循环下的初始化次序）
  sessions: {
    get: (sessionId) => getSessionHost().get(sessionId),
    peek: (sessionId) => getSessionHost().peek(sessionId)
  },
  broadcast: (event: ChatEvent) => electronEventSink.broadcast(event),
  logger: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
  getAbortedNote: () => t('agent.toolAborted') || 'Aborted by user.',
  tasks: taskRegistry
})
