/**
 * Electron 宿主适配器 —— 把 @shuvix/agent-runtime 的注入接口对接到桌面端的具体设施
 * （事件汇 → chatFrontendRegistry 与几路旁听）。provider 凭据不经这里：
 * 模型层（services/models）每次请求从 DB 凭据库现取，从不写 process.env。
 *
 * 会话存储由 durable 自己落盘（SessionHost 打开），宿主不提供消息写入口。旧运行时的工具结果变换与
 * 请求日志两个适配器随 HarnessSession 一起删了（请求日志的写路径留在 httpLogService，见那里的说明）。
 */
import type { RuntimeEventSink } from '@shuvix/agent-runtime'
import { chatFrontendRegistry } from '../frontend/core'
import { notifyOnChatEvent } from './notificationService'
import { recordFromUserMessageEvent } from './sessionDayPromptService'
import { observeChromeTabRun } from './chromeBridge'

/**
 * 事件广播适配器：委托 chatFrontendRegistry，并旁路一份给通知决策器、当日提示词记录，以及
 * Chrome 标签页会话的调试租约（一轮跑完就释放 Chrome 里的调试横幅 —— 与侧边栏开没开无关）。
 *
 * 通知**不走 ChatFrontend**：registry 按能力过滤，`input_request` 只发给
 * `userInput: true` 的前端 —— 而询问恰恰是最该弹通知的一类事件。与其为通知造一个
 * 声明了输入能力却答不了的假前端（那会让 `hasUserInputCapability` 在关窗后也返回 true，
 * 反过来改变询问的语义），不如在这里明着分一路旁听。
 */
export const electronEventSink: RuntimeEventSink = {
  broadcast: (event) => {
    chatFrontendRegistry.broadcast(event)
    notifyOnChatEvent(event)
    recordFromUserMessageEvent(event)
    observeChromeTabRun(event)
  },
  hasUserInputCapability: (sessionId) => chatFrontendRegistry.hasCapability(sessionId, 'userInput')
}
