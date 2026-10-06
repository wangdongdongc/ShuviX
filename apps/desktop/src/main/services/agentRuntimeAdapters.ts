/**
 * Electron 宿主适配器 —— 把 @shuvix/agent-runtime 的注入接口对接到桌面端的具体设施
 * （事件汇 → chatFrontendRegistry 与几路旁听）。日历入账不在这里：它按用户条目 id 记（P3-07，见
 * sessionDayPromptService）。provider 凭据不经这里：模型层（services/models）每次请求从 DB 凭据库
 * 现取，从不写 process.env。
 *
 * 会话存储由 durable 自己落盘（SessionHost 打开），宿主不提供消息写入口。旧运行时的工具结果变换与
 * 请求日志两个适配器随旧运行时（pi 0.80 harness）一起删了（请求日志的写路径留在 httpLogService，
 * 见那里的说明）。
 */
import type { RuntimeEventSink } from '@shuvix/agent-runtime'
import { chatFrontendRegistry } from '../frontend/core'
import { notifyOnChatEvent } from './notificationService'
import { observeChromeTabRun } from './chromeBridge'
import { createLogger } from '../logger'

const log = createLogger('EventSink')

function tap(name: string, deliver: () => void): void {
  try {
    deliver()
  } catch (error) {
    log.warn(`事件旁路 ${name} 失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 事件广播适配器：委托 chatFrontendRegistry，并旁路一份给通知决策器，以及
 * Chrome 标签页会话的调试租约（一轮跑完就释放 Chrome 里的调试横幅 —— 与侧边栏开没开无关）。
 *
 * 通知**不走 ChatFrontend**：为通知造一个声明了输入能力却答不了的假前端，会让
 * `hasUserInputCapability` 在关窗后也返回 true，反过来改变询问的语义 —— 不如在这里明着分一路旁听。
 * 询问本身不经这里（P3-08）：通知从会话的询问钩子拿（`services/sessionSignals`）。
 */
export const electronEventSink: RuntimeEventSink = {
  // 三路各自隔离（P3-08-47）：一路抛错只记日志，不拦后面的 —— 通知出了问题，租约照样要在一轮结束时还
  broadcast: (event) => {
    tap('registry', () => chatFrontendRegistry.broadcast(event))
    tap('notification', () => notifyOnChatEvent(event))
    tap('chrome-lease', () => observeChromeTabRun(event))
  },
  hasUserInputCapability: (sessionId) => chatFrontendRegistry.hasCapability(sessionId, 'userInput')
}
