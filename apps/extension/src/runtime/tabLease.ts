/**
 * 标签页「运行租约」—— agent 运行结束后自动释放接管的标签页，不再依赖模型自觉调用 release_tab。
 *
 * cdp 的 attach 状态是应用级单例（主会话 / 笔记本任务 / 子代理追问共享），所以按「活跃
 * agent 运行数」计数：每个运行入口持有一份租约，计数归零才 detachAll（横幅消失）。
 * 释放是廉价的：下一轮任何操作工具经 ensureAttached 自动重新接管，无授权弹窗；
 * uid 映射丢失无碍——系统提示本就要求 click/fill 前先 snapshot。
 *
 * 注：主轮内经 Agent 派发工具派生的子代理是被 await 的（dispatchTool.executeInternal），
 * 天然在主租约覆盖内；只有 fire-and-forget 入口（笔记本任务、子代理追问）需各自持有租约。
 */
import { cdpManager } from './cdp'

let activeRuns = 0

/** 在一份标签页租约内执行一次 agent 运行；结束（含异常/中止）且无其他活跃运行时释放全部标签页 */
export async function withTabLease<T>(run: () => Promise<T>): Promise<T> {
  activeRuns++
  try {
    return await run()
  } finally {
    activeRuns--
    if (activeRuns <= 0) {
      activeRuns = 0
      // fire-and-forget：释放失败不影响运行结果；若用户立即发起新一轮，工具会自动重新 attach
      void cdpManager.detachAll()
    }
  }
}
