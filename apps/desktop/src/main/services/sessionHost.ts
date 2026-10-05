/**
 * 桌面的 SessionHost —— 打开着的会话存储（每会话一个 pi-durable Harness）的唯一簿记者，外加桌面 seam。
 *
 * 运行时（agent-runtime 的 `createSessionHost`）不认识 Electron、不认识 node:sqlite、不认识 DB：
 * 存储怎么开（sessionStorage 的路由）、模型从哪来（services/models 的注册表）、会话配置怎么读
 * （sessionService 的形态推导 + 会话设置）、事件往哪发（electronEventSink）、锁与运行状态的镜像写到哪
 * （`sessions.settings.agentLocked` / `.runState`，经 sessionRecords —— 内存会话就写在内存里），都由这里回答。
 *
 *  - **懒建**：第一次 `getSessionHost()` 才建（模型注册表、DB 此刻都已就绪）；import 本模块什么都不做。
 *  - **钉住**（PIN-04）：会话还有活着的后台任务（bg bash、被驱动的子会话）就不被 LRU 关掉 ——
 *    完成通知回来时它还开着。忙碌的会话本来就不会被关。
 *  - **镜像**（PIN-06）：值没变就不写（每次写都会 bump `updatedAt`），也不发会话配置变更广播。
 *  - **退出**（PIN-11）：`installSessionHostQuitHook` —— 第一次 `before-quit` 先拦下，`closeAll()`
 *    （最多等 5 秒），再 `app.quit()`。正忙的会话被关停时不报运行状态，DB 里的 busy 标记熬过退出，
 *    下次打开报 interrupted。
 *
 * 工具 / 提示词 seam 来自 `agents/agentHost`：ToolHost（内置工具 / 按 agent 解析 / 按锁重建；调用方身份
 * 经 `sessionOf` 按对话现问这条会话的 `agentIdentity` —— 同步 `get`，从不打开会话）、PromptHost（五个活
 * 段落）与人设变量表。
 */
import {
  abortSessionReviews,
  createSessionHost,
  DEFAULT_INTERRUPTED_SEND_POLICY,
  localDate,
  reopenSessionReviews,
  type DrivenSettledEvent,
  type InterruptedSendPolicy,
  type RuntimeLogger,
  type SessionHost,
  type SessionHostDeps
} from '@shuvix/agent-runtime'
import {
  createDesktopToolHost,
  desktopPromptHost,
  desktopPromptVars,
  resolveProfileModelSpec,
  type DesktopToolHostDeps
} from '../agents/agentHost'
import { createLogger } from '../logger'
import type { ToolAgentIdentity } from './toolAgent'
import { electronEventSink } from './agentRuntimeAdapters'
import { getModelRegistry, providerCredentialPort } from './models'
import { writeSessionMirror } from './sessionMirror'
import { sessionRecords } from './sessionRecords'
// 仅在函数体内调用（resolveAgentConfig）：sessionService 也 import 本模块，ESM 活绑定下无初始化环
import { sessionService } from './sessionService'
import { deleteSessionStorage, openSessionStorage, sessionStorageExists } from './sessionStorage'
import { settingsService } from './settingsService'
import { taskRegistry } from './taskRegistry'

const log = createLogger('SessionHost')

/**
 * 自动续跑开关（现读，改了立刻生效）。**缺省开** —— 只有修剪后字面量 'false' 才关（口径在运行时的
 * `autoResumeAllowed`）：设置项是纯文本键值，一个写坏的值不该把能力关掉。
 */
export const AUTO_RESUME_KEY = 'session.autoResume'

/**
 * 中断会话上收到用户发送时怎么办（裁决 R5，用户 2026-10-04 定为 abort-then-send）：
 * 先中止被中断的那件事，再发送。另一种策略 `'continue-then-queue'` 仍保留在运行时里，换只改这一行。
 */
export const INTERRUPTED_SEND_POLICY: InterruptedSendPolicy = DEFAULT_INTERRUPTED_SEND_POLICY

/** 退出时等会话关停的上限 */
export const QUIT_CLOSE_CAP_MS = 5000

// ─── 依赖 ───────────────────────────────────────────────

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 子会话运行器按需加载（P2-10）：它经网关 import 了整套工具与服务，本模块又被 sessionService /
 * agentSession 静态 import —— 静态 import 它会在加载期成环，而且 import 本模块就会把运行器建出来。
 * 两处 seam 都只在运行时（会话已经开着）才走到这里。
 */
function subSessionRunnerModule(): Promise<typeof import('./subSessionRunner')> {
  return import('./subSessionRunner')
}

/**
 * 子会话被驱动的那一轮落定（P2-09 的 seam）→ 运行器决定通不通知父会话、怎么送达（P2-10 PIN-01：
 * 完成通知只走这一条路）。拒绝 = 送达失败，运行时留着标记下次打开再报。
 */
export async function onSubSessionDrivenSettled(event: DrivenSettledEvent): Promise<void> {
  const { subSessionRunner } = await subSessionRunnerModule()
  await subSessionRunner.onDrivenSettled(event)
}

/**
 * 会话的中止前 seam（同步，在中止标记提交之前）：作废这条会话进行中的自动审查；再把父会话的中止级联给
 * 它前台驱动着、此刻被中断的子会话（P2-10 PIN-08；不等、幂等，失败只记日志）。
 */
export function beforeSessionAbort(sessionId: string): void {
  abortSessionReviews(sessionId)
  void subSessionRunnerModule()
    .then(({ subSessionRunner }) => subSessionRunner.cascadeParentAbort(sessionId))
    .catch((err: unknown) =>
      log.warn(`父会话中止的级联失败 session=${sessionId}: ${errorText(err)}`)
    )
}

const runtimeLog: RuntimeLogger = {
  info: (message) => log.info(message),
  warn: (message) => log.warn(message),
  error: (message) => log.error(message)
}

/**
 * 桌面 seam 拼成的 `SessionHostDeps`。`overrides` 整项替换（测试注入假的 ToolHost / 模型 / 存储）；
 * `sessionOf` 给 ToolHost 按会话找打开着的 durable 会话（调用方身份按对话问它；缺省读单例宿主）。
 */
export function buildSessionHostDeps(
  overrides: Partial<SessionHostDeps> = {},
  sessionOf: DesktopToolHostDeps['sessionOf'] = (sessionId) => getSessionHost().get(sessionId)
): SessionHostDeps {
  const needsRegistry = overrides.models === undefined || overrides.modelCatalog === undefined
  const registry = needsRegistry ? getModelRegistry() : undefined
  return {
    models: registry?.models as SessionHostDeps['models'],
    modelCatalog: { registry: registry!, port: providerCredentialPort },
    toolHost: createDesktopToolHost({ sessionOf }),
    promptHost: desktopPromptHost,
    promptVars: desktopPromptVars,
    // 派生 agent 档案的 `shuvix-model`（P2-05：派发在桌面真跑起来了）：不可用 → null，协调器回落调用方的模型
    resolveProfileModel: (spec) => {
      const hit = resolveProfileModelSpec(spec)
      return hit ? { provider: hit.provider, modelId: hit.model } : null
    },
    resolveAgentConfig: (sessionId) => sessionService.resolveAgentConfig(sessionId),
    onLockChange: (sessionId, locked) => writeSessionMirror(sessionId, { agentLocked: locked }),
    onRunStateChange: (sessionId, state) => writeSessionMirror(sessionId, { runState: state }),
    openStorage: openSessionStorage,
    storageExists: sessionStorageExists,
    deleteStorage: deleteSessionStorage,
    isEphemeral: (sessionId) => sessionRecords.isEphemeral(sessionId),
    isPinned: (sessionId) => taskRegistry.runningCount(sessionId) > 0,
    eventSink: electronEventSink,
    beforeAbort: beforeSessionAbort,
    onDrivenSettled: onSubSessionDrivenSettled,
    onInputsReopened: (sessionId) => reopenSessionReviews(sessionId),
    interruptedSendPolicy: INTERRUPTED_SEND_POLICY,
    autoResume: () => settingsService.get(AUTO_RESUME_KEY),
    today: () => localDate(),
    onReport: (sessionId, error) =>
      log.warn(`durable report session=${sessionId}: ${errorText(error)}`),
    logger: runtimeLog,
    ...overrides
  }
}

/** 建一个桌面宿主（ToolHost 的 `sessionOf` 指向它自己） */
export function createDesktopSessionHost(overrides: Partial<SessionHostDeps> = {}): SessionHost {
  // sessionOf 只在之后的工具调用里读它（构造期不调），所以引用自己的初始化值是安全的
  const host: SessionHost = createSessionHost(
    buildSessionHostDeps(overrides, (sessionId) => host.get(sessionId))
  )
  return host
}

// ─── 单例 ───────────────────────────────────────────────

let singleton: SessionHost | undefined
let testOverrides: Partial<SessionHostDeps> | undefined

/** 主进程唯一的 SessionHost（懒建） */
export function getSessionHost(): SessionHost {
  singleton ??= createDesktopSessionHost(testOverrides)
  return singleton
}

/**
 * 内置 MCP 服务器认调用方用的解析器（main 启动时交给 `setBuiltinMcpAgentResolver`）：按会话**同步**
 * 取打开着的 durable 会话（`get`，从不 open / peek —— 没开的会话认不出，主体按 root），再按对话问它的
 * `agentIdentity`。宿主每次调用现取（缺省 = 单例，第一次真用时才建）。
 */
export function sessionAgentResolver(
  hostOf: () => Pick<SessionHost, 'get'> = getSessionHost
): (sessionId: string, conversationId: number) => ToolAgentIdentity | undefined {
  return (sessionId, conversationId) => hostOf().get(sessionId)?.agentIdentity(conversationId)
}

/** 单例建了没有（退出钩子据此判断有没有要关的东西）；不建 */
export function peekSessionHost(): SessionHost | undefined {
  return singleton
}

/**
 * 丢掉单例；下一次 `getSessionHost()` 按 `overrides` 新建 —— 仅供单测。不关旧的（测试自己 closeAll）。
 */
export function resetSessionHostForTests(overrides?: Partial<SessionHostDeps>): void {
  singleton = undefined
  testOverrides = overrides
}

// ─── 退出 ───────────────────────────────────────────────

/** 退出钩子要用到的那一点 Electron app 面（测试给假的） */
export interface QuitHookApp {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}

/**
 * 第一次 `before-quit`：拦下这次退出，`closeAll()`（最多等 `capMs`，关不完也照样退），再 `app.quit()`。
 * 之后的 `before-quit` 直接放行。从没建过宿主就什么都不拦。
 *
 * 返回的 `ready` 在会话都关完（或不必关）之后为 true —— 其余退出清理（断 MCP、杀后台任务……）据此
 * 等到第二次 `before-quit` 再做：关停中的 run 还可能在用它们。
 */
export function installSessionHostQuitHook(
  app: QuitHookApp,
  options: { capMs?: number; host?: () => SessionHost | undefined } = {}
): { readonly ready: boolean } {
  const capMs = options.capMs ?? QUIT_CLOSE_CAP_MS
  const hostOf = options.host ?? peekSessionHost
  let state: 'idle' | 'closing' | 'done' = 'idle'
  app.on('before-quit', (event) => {
    if (state === 'done') return
    if (state === 'closing') {
      event.preventDefault()
      return
    }
    const host = hostOf()
    if (!host) {
      state = 'done'
      return
    }
    event.preventDefault()
    state = 'closing'
    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn(`退出时会话 ${capMs}ms 内没有全部关停，照样退出`)
        resolve()
      }, capMs)
    })
    const closing = host.closeAll().catch((err: unknown) => {
      log.warn(`退出时关停会话失败: ${errorText(err)}`)
    })
    void Promise.race([closing, capped]).finally(() => {
      clearTimeout(timer)
      state = 'done'
      app.quit()
    })
  })
  return {
    get ready() {
      return state === 'done'
    }
  }
}
