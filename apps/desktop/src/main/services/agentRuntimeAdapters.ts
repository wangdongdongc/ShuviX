/**
 * Electron 宿主适配器 —— 把 @shuvix/agent-runtime 的注入接口对接到桌面端的具体设施
 * （chatFrontendRegistry / 安全模块 / httpLogService / process.env / i18n）。
 *
 * 迁移到 AgentHarness 后 **RuntimePersistence 适配器已删除**：消息落盘由 harness
 * 自己经 SessionStorage（SqliteSessionStorage）完成，宿主不再提供 add/addToolUse/
 * completeToolUse 那一组写入口。
 */
import type {
  RuntimeEventSink,
  RuntimeEnv,
  RuntimeHttpLog,
  RuntimeLogger,
  ToolResultTransform
} from '@shuvix/agent-runtime'
import type { TextContent, ImageContent } from '@earendil-works/pi-ai'
import { chatFrontendRegistry } from '../frontend/core'
import { notifyOnChatEvent } from './notificationService'
import { transformToolResultForPersist } from './stepPersistPipeline'
import { httpLogService } from './httpLogService'
import { createLogger } from '../logger'
import { t } from '../i18n'

/**
 * 事件广播适配器：委托 chatFrontendRegistry，并旁路一份给通知决策器。
 *
 * 通知**不走 ChatFrontend**：registry 按能力过滤，`input_request` 只发给
 * `userInput: true` 的前端 —— 而询问恰恰是最该弹通知的一类事件。与其为通知造一个
 * 声明了输入能力却答不了的假前端（那会让 `hasUserInputCapability` 在关窗后也返回 true，
 * 反过来改变 harnessSession 的询问语义），不如在这里明着分一路旁听。
 */
export const electronEventSink: RuntimeEventSink = {
  broadcast: (event) => {
    chatFrontendRegistry.broadcast(event)
    notifyOnChatEvent(event)
  },
  hasUserInputCapability: (sessionId) => chatFrontendRegistry.hasCapability(sessionId, 'userInput')
}

/** 环境变量注入：写 process.env（pi-ai 内置 provider 凭证） */
export const electronEnv: RuntimeEnv = {
  setApiKey: (envKey, value) => {
    process.env[envKey] = value
  }
}

/** 可选 HTTP 日志：委托 httpLogService */
export const electronHttpLog: RuntimeHttpLog = {
  updateUsage: (logId, input, output, total, responseJson) =>
    httpLogService.updateUsage(logId, input, output, total, responseJson)
}

/**
 * 工具结果转换：委托 stepPersistPipeline（图片 → 路径提示等瘦身）。
 *
 * 语义变化：旧模型下这条管线只作用于**入库路径**，广播路径保留原始内容（双轨）。
 * harness 的 entry 树里存的就是发给模型的原始 toolResult，没有独立的入库路径，
 * 所以这里退化为只影响**广播**（UI 展示），落盘内容保持原样。
 */
export const electronToolResultTransform: ToolResultTransform = (input) =>
  transformToolResultForPersist({
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    sessionId: input.sessionId,
    isError: input.isError,
    content: input.content as ReadonlyArray<TextContent | ImageContent>,
    details: input.details
  })

/** 运行时日志适配器：复用 electron-log scoped logger */
export const runtimeLogger: RuntimeLogger = createLogger('AgentRuntime')

/** 本地化（abort 时的「工具已中止」文案等） */
export const localize = (key: string): string => t(key)
