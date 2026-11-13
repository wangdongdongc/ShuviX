/**
 * 会话 fork（把一条会话复制成一条新会话）在运行时这一侧的唯一部件：拷贝收尾。
 *
 * 跨会话的 fork 由宿主做：pi-durable 不能跨存储 fork 对话，所以新会话的存储是源会话存储的一份整拷贝
 * （条目 id、显示侧车、用量文档原样），宿主在源会话的 `whileIdle` 里拷，拷完先在这里收尾、再交给
 * SessionHost 打开，要从某条回复分支时最后在新会话上 `branchAt`。
 *
 * 不依赖 Node / Electron。
 */
import { createSession, type Storage } from '@earendil-works/pi-durable'
import { backgroundContext as BG } from './context'
import { parseLockRecord } from './agentRecord'
import { AgentStateDoc, SessionStateDoc } from './docs'

/**
 * 拷贝收尾（新会话的存储第一次被打开**之前**）：会话级状态里属于源会话那一场的东西清掉 ——
 *  - 锁：缺省清掉（打开时也会清，这里先清，打开就不必走那一步）。`keepLock` → 留着：fork 沿用源会话的
 *    agent（宿主同时 `SessionHost.adoptForkedAgent`），打开时按锁重建同一组工具，系统提示与工具表逐字节
 *    不变，第一次请求就命中源会话的提示词缓存（2026-11-06）。给了 `sessionId`（fork 自己的 id），锁住的
 *    那个对话的根会话 id 改成它（人设正文不动）；
 *  - driven-run 标记：父会话驱动的是源会话的那一轮。留着它，打开时的扫描会替新会话向父会话报一次
 *    「那一轮落定了」；
 *  - 待送达的通知：写给源会话的，不该在新会话的下一次发送之前冒出来。
 * 当前对话指针原样（fork 缺省就是源会话此刻的当前对话），对话、条目、任务都不碰。用完关掉存储。
 * 返回锁有没有留下（`keepLock` 且源会话此刻有 agent）—— 只有留下了，宿主才该 `adoptForkedAgent`。
 */
export async function resetForkedSessionState(
  storage: Storage,
  options: { keepLock?: boolean; sessionId?: string } = {}
): Promise<{ lockKept: boolean }> {
  const session = createSession(storage)
  let lockKept = false
  try {
    await session.commit(async (tx) => {
      const state = await tx.doc(SessionStateDoc)
      lockKept = options.keepLock === true && state.lock !== undefined
      if (!lockKept) delete state.lock
      // 留下的锁不会重新冻结：锁住的那个对话的 AgentStateDoc 还写着源会话的根会话 id，活段落（指令文件、项目
      // 提示词、知识库、bot）按它解析 —— 改成 fork 自己的，否则 fork 跟着源会话的知识库勾选走，源会话一删就落空
      const conversationId = lockKept ? parseLockRecord(state.lock)?.conversationId : undefined
      if (conversationId !== undefined && options.sessionId !== undefined) {
        const agent = await tx.doc(AgentStateDoc, conversationId)
        if (agent.kind === 'root') agent.rootSessionId = options.sessionId
      }
      delete state.driven
      state.deferredNotices.splice(0)
    }, BG)
  } finally {
    await session.close(BG)
  }
  return { lockKept }
}
