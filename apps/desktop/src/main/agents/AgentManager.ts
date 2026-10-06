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
 *   - sessionReady：会话信号的就绪表（sessionSignalSeams）—— 面板追问 / 宿主派发在驱动会话之前等它
 *   - 索引重建（P3-14，`routerIndex.ts`）：路由把自己登记进 sessionSignalSeams，会话宿主的开 / 关钩子经
 *     扇出转给它的 `indexSession` / `onSessionClosed`；建出来时把已经打开着的会话各重建一次（PIN-16）
 */
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import {
  createSubAgentManager,
  type DurableSession,
  type InProcessAgentType
} from '@shuvix/agent-runtime'
import { electronEventSink } from '../services/agentRuntimeAdapters'
import { getSessionHost, peekSessionHost } from '../services/sessionHost'
import {
  sessionSignalsReady,
  setAgentIndexer,
  setRegisteredAgentCheck
} from '../services/sessionSignalSeams'
import { t } from '../i18n'
import { createLogger } from '../logger'
import { taskRegistry } from '../services/taskRegistry'
import { openSessionsOf, wireRouterIndex } from './routerIndex'

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
  tasks: taskRegistry,
  // 面板追问可能刚 peek 开会话：等会话信号接好，这一轮的生命周期才有人发（P3-14-12；P3-08 PIN-09 的表）
  sessionReady: (sessionId) => sessionSignalsReady(sessionId)
})

/**
 * 此刻打开着的会话。本模块可能在会话宿主模块**求值途中**被求值（sessionHost → sessionService → agentSession →
 * hookService → 这里的环）：那时宿主单例还在暂时性死区里 —— 宿主模块都没跑完，自然没有宿主、没有打开着的
 * 会话。
 */
function currentlyOpenSessions(): DurableSession[] {
  let host: ReturnType<typeof peekSessionHost>
  try {
    host = peekSessionHost()
  } catch (error) {
    if (error instanceof ReferenceError) return []
    throw error
  }
  return openSessionsOf(host)
}

// 会话打开时重建索引、删除 / 清空时丢掉（P3-14）；此刻已经打开着的会话现在就各重建一次（PIN-16）
wireRouterIndex(agentManager, {
  register: setAgentIndexer,
  openSessions: currentlyOpenSessions,
  logger: { warn: (m) => log.warn(m) }
})

// 会话信号只给路由认识的派生 agent 发生命周期（P3-08 PIN-19）
setRegisteredAgentCheck((agentId) => agentManager.has(agentId))
