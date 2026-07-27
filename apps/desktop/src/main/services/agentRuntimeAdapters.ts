/**
 * Electron 宿主适配器 —— 把 @shuvix/agent-runtime 的注入接口对接到桌面端的具体设施
 * （messageService / chatFrontendRegistry / sessionDao / httpLogService / process.env / 审批 / i18n）。
 *
 * RuntimeSession + eventHandler（宿主无关）通过这些适配器在 Electron 主进程运行；
 * Chrome 扩展则提供另一套（IndexedDB / 内存 eventBus / no-op env）适配器。
 */
import type {
  RuntimePersistence,
  RuntimeEventSink,
  RuntimeEnv,
  RuntimeHttpLog,
  RuntimeLogger,
  ToolResultTransform,
  ChatMessage
} from '@shuvix/agent-runtime'
import type { TextContent, ImageContent } from '@earendil-works/pi-ai'
import { messageService } from './messageService'
import { chatFrontendRegistry } from '../frontend/core'
import { sessionDao } from '../dao/sessionDao'
import { transformToolResultForPersist } from './stepPersistPipeline'
import { httpLogService } from './httpLogService'
import { createLogger } from '../logger'
import { t } from '../i18n'

/** 持久化适配器：委托 messageService（better-sqlite3，天然同步） */
export const electronPersistence: RuntimePersistence = {
  listMessages: (sessionId) => messageService.listBySession(sessionId),
  add: (p) => messageService.add(p) as unknown as ChatMessage,
  addAssistantText: (p) => messageService.addAssistantText(p),
  addToolUse: (p) => messageService.addToolUse(p),
  completeToolUse: (p) => messageService.completeToolUse(p),
  addStepThinking: (p) => messageService.addStepThinking(p),
  addStepText: (p) => messageService.addStepText(p)
}

/** 事件广播适配器：委托 chatFrontendRegistry */
export const electronEventSink: RuntimeEventSink = {
  broadcast: (event) => chatFrontendRegistry.broadcast(event),
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

/** 工具结果入库前转换：委托 stepPersistPipeline（图片 → 路径提示等瘦身） */
export const electronToolResultTransform: ToolResultTransform = (input) =>
  transformToolResultForPersist({
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    sessionId: input.sessionId,
    isError: input.isError,
    content: input.content as ReadonlyArray<TextContent | ImageContent>,
    details: input.details
  })

/**
 * 创建绑定到具体 session 的预展示跳过判定（需要读取 session 的 autoApprove）。
 * 与桌面版 checkToolApproval 一致：需用户交互的工具（待审批 bash / ssh / ask / ssh 凭证）跳过。
 */
export function createShouldDeferToolDisplay(
  sessionId: string
): (toolName: string, args: Record<string, unknown>) => boolean {
  return (toolName, args) => {
    // 命令类工具逐条审批，只有会话级「免审批」能豁免（与 bash.ts / ssh.ts 的判定保持一致）
    const isCommandTool = toolName === 'bash' || (toolName === 'ssh' && args?.action === 'exec')
    const approvalRequired =
      isCommandTool && !sessionDao.pickSettings(sessionId, ['autoApprove'])?.autoApprove
    const isUserInput = toolName === 'ask'
    const sshCredentialRequired =
      toolName === 'ssh' && args?.action === 'connect' && !args?.credentialName
    return approvalRequired || isUserInput || sshCredentialRequired
  }
}

/** 运行时日志适配器：复用 electron-log scoped logger */
export const runtimeLogger: RuntimeLogger = createLogger('AgentRuntime')

/** 本地化（abort 时的「工具已中止」文案等） */
export const localize = (key: string): string => t(key)
