/**
 * `shuvix.spawn` 扩展 —— 宿主派发的锚任务（P2-08，PIN-01）。
 *
 * 观察型 hook（起标题）派出的 agent 不由任何工具调用拥有：它的子对话归一个**后台锚任务**所有。锚建在会话的
 * 当前对话里（回退之后是 fork 出的那条），`background: true`，一跑就以 `completed`（结果 null）收场 ——
 * 照抄 durable 示例 23。durable 让一个拥有活着的工作的任务以 `completing` 挂到那些工作结束，所以锚活多久
 * 只由它名下那条子对话决定；而后台任务不在父对话的普通范围里：根的 Esc（`abortConversation`）、
 * `continue()` 的 `waitForIdle` 都碰不到它，拥有者边又给了 phase 3 一条通向根的血缘（Q-P2-07）。
 *
 * 它不带工具、不带系统提示词段落，只带这一个任务定义；会话宿主在每次打开时把它装进那条会话自己的注册表
 * （与段落扩展同一处）—— 重开之后 durable 要按名解析存储里残留的锚任务，否则 `open()` 会报「不认识的任务」。
 * 锚**不**进任何对话的 agent 扩展清单（`AgentDoc.extensions`）：任务定义按注册表解析，与对话的扩展无关。
 *
 * 运行状态（PIN-02）：一个后台任务、且它拥有的对话全都是辅助工作 —— 这种锚不算忙、不算中断，但照样挡着
 * LRU（`evictable` = 什么都没在跑）。打开时**不**给锚打中止标记：它名下的工作被打了标记、收场之后它自己就完成。
 */
import { defineExtension, defineTask } from '@earendil-works/pi-durable'

/** 扩展名 */
export const SHUVIX_SPAWN_EXTENSION = 'shuvix.spawn'

/** 锚任务的种类（任务定义名） */
export const SPAWN_ANCHOR_TASK = 'shuvix.spawn.anchor'

/** 锚：后台、对话拥有、一跑就完成；被中止 → aborted */
export const SpawnAnchor = defineTask<null, { phase: 'done' }, null>({
  name: SPAWN_ANCHOR_TASK,
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        context
      )
  },
  abort: (_anchor, runtime, context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context)
})

/** 每条会话的注册表在打开时装上它（会话宿主） */
export const spawnExtension = defineExtension({
  name: SHUVIX_SPAWN_EXTENSION,
  tasks: [SpawnAnchor]
})
