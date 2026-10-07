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
 *    完成通知回来时它还开着。忙碌的会话本来就不会被关。有前端正订阅着它的视图（SyncHub 的
 *    `hasSubscribers`，P3-05）同样钉住。
 *  - **开 / 关钩子**（P3-05）：`onSessionOpened` / `onSessionClosed` 接 `frontend/sync/syncWiring` 的扇出，
 *    SyncHub 经它登记监听器。
 *  - **镜像**（PIN-06）：值没变就不写（每次写都会 bump `updatedAt`），也不发会话配置变更广播。
 *  - **退出**（PIN-11）：`installSessionHostQuitHook` —— 第一次 `before-quit` 先拦下，`closeAll()`
 *    （最多等 5 秒），再在下一个任务里重新 quit（不能在 closeAll 的回调里直接调，见那里）；其余退出清理
 *    在被放行的那次 `before-quit` 里跑一次。正忙的会话被关停时不报运行状态，DB 里的 busy 标记熬过退出，
 *    下次打开报 interrupted。退出半途没了、主窗口又被建出来时 `resume()` 撤销封存。
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
// 仅在函数体内读（buildSessionHostDeps / isPinned）：syncWiring 也 import 本模块，ESM 活绑定下无初始化环
import { peekSyncHub, sessionHostHooks } from '../frontend/sync/syncWiring'
import type { ToolAgentIdentity } from './toolAgent'
import { electronEventSink } from './agentRuntimeAdapters'
import { installSessionSignals } from './sessionSignals'
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
    // 还有活着的后台任务，或有前端正看着它（视图同步的订阅，P3-05）；hub 没建过就只数任务（不建 hub）。
    // hasSubscribers 抛错照样抛出去 —— 宿主的 evictable 把它当钉住
    isPinned: (sessionId) =>
      taskRegistry.runningCount(sessionId) > 0 ||
      (peekSyncHub()?.hasSubscribers(sessionId) ?? false),
    eventSink: electronEventSink,
    beforeAbort: beforeSessionAbort,
    onDrivenSettled: onSubSessionDrivenSettled,
    onInputsReopened: (sessionId) => reopenSessionReviews(sessionId),
    // 开 / 关钩子经扇出交给 SyncHub（P3-05）：hub 换视图实现
    onSessionOpened: sessionHostHooks.opened,
    onSessionClosed: sessionHostHooks.closed,
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

/** 主进程唯一的 SessionHost（懒建）；建出来之前先装上会话信号接线（P3-08：生命周期 / 询问钩子） */
export function getSessionHost(): SessionHost {
  if (singleton === undefined) {
    installSessionSignals()
    singleton = createDesktopSessionHost(testOverrides)
  }
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

export interface SessionHostQuitHookOptions {
  /** 等会话关停的上限（缺省 `QUIT_CLOSE_CAP_MS`） */
  capMs?: number
  /** 取宿主（缺省 `peekSessionHost`：从不建） */
  host?: () => SessionHost | undefined
  /**
   * 其余退出清理（拆浏览器、杀后台任务、断 MCP……）：**每次退出恰好一次**，在被放行的那次 `before-quit`
   * 里跑 —— 也就是会话都关完（或不必关）之后：关停中的 run 还可能在用它们。抛错只记日志。
   */
  teardown?: () => void
  /** 把重新发起的 quit 排进它自己的任务（缺省 `setImmediate`；单测换掉） */
  defer?: (task: () => void) => void
}

export interface SessionHostQuitHook {
  /**
   * 退出之后应用又照常跑下去了（主窗口被重新建出来）：撤销宿主的封存，下一次退出重新关会话、重新清理。
   * 退出走完了进程就没了，走不到这里 —— 只有退出半途没了（任何原因）才会；不撤销的话，之后打开的会话
   * 只剩配置、一条消息都没有。会话还在关停（退出正在进行）时调用无效，那次退出照常走完。
   */
  resume(): void
}

/**
 * 第一次 `before-quit`：拦下这次退出，`closeAll()`（最多等 `capMs`，关不完也照样退），再重新 quit。
 * 之后的 `before-quit` 放行，并在其中跑 `teardown`（每次退出一次）。从没建过宿主就不拦，直接放行 + 清理。
 *
 * **重新 quit 必须在它自己的任务里（`defer`），绝不能在 closeAll 落定的那个 promise 回调里直接调**：
 * Cmd+Q / Dock 的「退出」/ SIGTERM 从原生事件循环进 Electron 的 `Browser::Quit()`，那里
 * `is_quitting_ = HandleBeforeQuit()` —— 发 `before-quit` 时这是最外层的 JS 回调，Node 在把控制交回
 * 原生之前**清空 microtask / nextTick 队列**。会话全是同步 SQLite，closeAll 往往就在这段清空里落定；
 * 此时调 `app.quit()` 是**重入**：内层那次放行、开始关窗（`is_quitting_ = true`），外层随后把自己被拦下的
 * 结果写回 `is_quitting_ = false`。最后一个窗口关掉时 Electron 以为没在退出，只发 `window-all-closed`
 * （macOS 上不退）—— 窗口没了、进程还在，宿主已封存；点 Dock 重开的主窗口里会话全是空的，第二次 Cmd+Q
 * 才真退（v0.2.0 的实测 bug）。放进下一个任务，外层 `Browser::Quit()` 早已返回，重新发起的 quit 是一次
 * 完整的新退出。
 */
export function installSessionHostQuitHook(
  app: QuitHookApp,
  options: SessionHostQuitHookOptions = {}
): SessionHostQuitHook {
  const capMs = options.capMs ?? QUIT_CLOSE_CAP_MS
  const hostOf = options.host ?? peekSessionHost
  const defer = options.defer ?? ((task: () => void) => void setImmediate(task))
  let state: 'idle' | 'closing' | 'done' = 'idle'
  let tornDown = false
  /** 这次退出的其余清理（一次） */
  const teardown = (): void => {
    if (tornDown) return
    tornDown = true
    try {
      options.teardown?.()
    } catch (err) {
      log.warn(`退出清理失败: ${errorText(err)}`)
    }
  }
  app.on('before-quit', (event) => {
    if (state === 'done') {
      teardown()
      return
    }
    if (state === 'closing') {
      event.preventDefault()
      return
    }
    const host = hostOf()
    if (!host) {
      state = 'done'
      teardown()
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
      defer(() => app.quit())
    })
  })
  return {
    resume() {
      if (state !== 'done') return
      log.warn('退出没有走完，应用继续运行：撤销会话宿主的封存')
      state = 'idle'
      tornDown = false
      hostOf()?.reopen()
    }
  }
}
