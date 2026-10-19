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
import { SessionStateDoc } from './docs'

/**
 * 拷贝收尾（新会话的存储第一次被打开**之前**）：会话级状态里属于源会话那一场的东西全部清掉 ——
 *  - 锁：源会话的 agent，不是这一份的（打开时也会清，这里先清，打开就不必走那一步）；
 *  - driven-run 标记：父会话驱动的是源会话的那一轮。留着它，打开时的扫描会替新会话向父会话报一次
 *    「那一轮落定了」；
 *  - 待送达的通知：写给源会话的，不该在新会话的下一次发送之前冒出来。
 * 当前对话指针原样（fork 缺省就是源会话此刻的当前对话），对话、条目、任务都不碰。用完关掉存储。
 */
export async function resetForkedSessionState(storage: Storage): Promise<void> {
  const session = createSession(storage)
  try {
    await session.commit(async (tx) => {
      const state = await tx.doc(SessionStateDoc)
      delete state.lock
      delete state.driven
      state.deferredNotices.splice(0)
    }, BG)
  } finally {
    await session.close(BG)
  }
}
