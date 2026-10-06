/**
 * 测试用会话宿主：mkdtemp 目录里每会话一个 SQLite 文件（临时会话给 MemoryStorage —— 关掉的
 * MemoryStorage 不能再开，需要关了再开的用例都用 SQLite）。
 *
 * 事件日志：`open:<id>`（打开存储）、`close:<id>`（存储真正关闭）、`delete:<id>`（删除存储）。
 * `restart()` = closeAll + 同一目录上的新宿主 / 新 faux 套件 / 新 ToolHost（新的调用记录、新的假 MCP
 * 服务器）—— 模拟换了一个进程；会话配置、provider 行、人设变量表这些「DB 里的东西」沿用同一份。
 *
 * 锁（P1-09）：每会话一个注册表（`registryOf(id)`，K1）；`mirror` 记 onLockChange；缺省配置（K15）
 * 是空档案 + faux/faux-1，ToolHost 没有内置工具，按 agent 的工具 = `tools`（创建 / 重建那一刻现读）。
 * `primeRoot()` = `session.createAgent()`。
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRegistry,
  MemoryStorage,
  type Extension,
  type Registry,
  type Storage,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import { afterEach } from 'vitest'
import type { FakePort } from '../../../models/__tests__/fakePort'
import type { PromptVars, PromptVarsCtx } from '../../../agentProfile/promptVars'
import type { DurableSession } from '../../durableSession'
import type { Models } from '@earendil-works/pi-ai'
import type {
  AgentConfig,
  InterruptedSendPolicy,
  ModelCatalog,
  PromptHost,
  RunState,
  SessionHostDeps,
  ToolHost
} from '../../seams'
import { createSessionHost, type SessionHost } from '../../sessionHost'
import type { ShuviXSettingsOverrides } from '../../settings'
import { defaultAgentConfig, fauxCatalog, fauxPort } from './agentConfig'
import { fauxKit, type FauxKit } from './faux'
import { makeTestToolHost, type TestToolHost, type TestToolHostOptions } from './toolHost'
import { withTimeout } from './wait'

export const TEST_SETTINGS_OVERRIDES: ShuviXSettingsOverrides = {
  retry: { enabled: false },
  compaction: { enabled: false }
}

/** 会话配置的来源：一份可变对象（所有会话共用）或按会话给 */
export type AgentConfigSource = AgentConfig | ((sessionId: string) => AgentConfig)

export interface TestHostOptions {
  /** 复用目录（restart 用）；缺省新建 */
  dir?: string
  kit?: FauxKit
  /** 没给 kit 时每个进程用它造一个（restart 沿用；缺省 `fauxKit()`） */
  makeKit?: () => FauxKit
  /**
   * 每次打开（重启也一样）都预装进每个会话注册表的扩展 —— 测试任务定义（`support/spawn.ts` 的
   * `test.spawn`：锚任务、扣住的任务）要在重开之后照样解析得到
   */
  extensions?: readonly Extension[]
  /** 按 agent 的测试工具（缺省 ToolHost 的 agentTools；同一份数组可在 makeHost 之后再 push） */
  tools?: ToolRegistration[]
  /** ToolHost 选项（每个进程据此新建一个）；缺省 = 没有内置工具、agentTools = tools */
  toolHost?: TestToolHostOptions
  /**
   * 整份替换会话宿主用的 ToolHost（集成用例：真工具 + 真 McpManager）；每个进程调用一次。
   * 给了它，`toolHost` 选项造的测试 ToolHost 照样建（`TestHost.toolHost`），只是不接给宿主。
   */
  makeToolHost?: () => ToolHost
  /** 会话配置（缺省 K15：空档案 + faux/faux-1） */
  agentConfig?: AgentConfigSource
  /** provider 行（缺省一条内置行 faux） */
  port?: FakePort
  /** 整份替换生成用的 Models 与模型目录（缺省 = faux 套件 + `fauxCatalog`）—— 真注册表的集成用例 */
  models?: Models
  modelCatalog?: ModelCatalog
  promptHost?: PromptHost
  promptVars?: (ctx: PromptVarsCtx) => PromptVars | Promise<PromptVars>
  /** onLockChange 抛错（LR-09） */
  onLockChange?: (sessionId: string, locked: boolean) => void
  maxIdleOpen?: number
  /** 额外的钉住判断（与 `pinned` 集合取或；视图同步的 `hub.hasSubscribers`） */
  isPinned?: (sessionId: string) => boolean
  /** 会话真正打开 / 关掉时（P3-03 PIN-09；`restart()` 沿用） */
  onSessionOpened?: SessionHostDeps['onSessionOpened']
  onSessionClosed?: SessionHostDeps['onSessionClosed']
  /** 临时会话 id（MemoryStorage） */
  ephemeral?: readonly string[]
  /** 整份替换缺省的测试覆盖（关重试 / 关自动压缩） */
  settingsOverrides?: ShuviXSettingsOverrides
  interruptedSendPolicy?: InterruptedSendPolicy
  autoResume?: (sessionId: string) => unknown
  noticeCoalesceMs?: number
  beforeAbort?: (sessionId: string) => void
  onInputsReopened?: (sessionId: string) => void
  onRunStateChange?: (sessionId: string, state: RunState) => void
  /** durable 的时钟（条目时间戳 / 日期通知的间隔 / 锁的 createdAt）；缺省 Date.now */
  now?: () => number
  /** 今天的日期（给了才发日期通知） */
  today?: () => string
  /**
   * 子会话 driven 落定的 seam（P2-09）。`restart()` 沿用；`restart({ onDrivenSettled: undefined })`
   * 模拟一个没接它的进程
   */
  onDrivenSettled?: SessionHostDeps['onDrivenSettled']
  /** 派生 agent 档案模型的 seam（P2-03；`restart()` 沿用） */
  resolveProfileModel?: SessionHostDeps['resolveProfileModel']
  /** 派生层级上限（P2-03；`restart()` 沿用） */
  maxAgentDepth?: number
}

/**
 * 一条询问的挂起 / 落定，经会话的 `subscribeInputs` 记下（P3-08：询问不再广播，主进程的消费方挂钩子）。
 * 形状沿用旧事件，好让既有断言只换一个数据源。
 */
export type AskRecord =
  | { type: 'input_request'; sessionId: string; request: InputRequest }
  | { type: 'input_request_resolved'; sessionId: string; requestId: string; clientId?: string }

export interface TestHost {
  readonly host: SessionHost
  readonly kit: FauxKit
  readonly dir: string
  readonly options: TestHostOptions
  /** open:<id> / close:<id> / delete:<id> */
  readonly events: string[]
  /** onRunStateChange 的调用（按顺序） */
  readonly states: [string, RunState][]
  /** onLockChange 的调用（按顺序） */
  readonly mirror: [string, boolean][]
  /** resolveAgentConfig 的调用（会话 id，按顺序；本进程） */
  readonly configCalls: string[]
  readonly toolHost: TestToolHost
  readonly port: FakePort
  readonly pinned: Set<string>
  /** 广播给前端的 ChatEvent（agent_created / agent_closing、ToolHost 的 MCP 错误） */
  readonly broadcasts: ChatEvent[]
  /** 每条打开着的会话的询问挂起 / 落定（`subscribeInputs`，按顺序；本进程） */
  readonly asks: AskRecord[]
  /** 有没有前端能展示询问面板 */
  capability: boolean
  /** 下一次打开这些会话时失败 */
  readonly failNextOpen: Set<string>
  readonly memory: Map<string, MemoryStorage>
  readonly warnings: string[]
  /** 这个进程里某会话最近一次打开时造的注册表（K1） */
  registryOf(sessionId: string): Registry<ToolRegistration> | undefined
  /** 某会话打开过几次注册表（每次打开一个新的） */
  registriesOf(sessionId: string): Registry<ToolRegistration>[]
  open(sessionId?: string): Promise<DurableSession>
  file(sessionId: string): string
  statesOf(sessionId: string): RunState[]
  /** 某类广播（按顺序） */
  broadcastsOf(type: ChatEvent['type']): ChatEvent[]
  /** 某类询问记录（按顺序） */
  asksOf<T extends AskRecord['type']>(type: T): Extract<AskRecord, { type: T }>[]
  /** closeAll + 新进程（同一目录） */
  restart(options?: Partial<TestHostOptions>): Promise<TestHost>
}

const liveHosts = new Set<TestHost>()
const directories = new Set<string>()

/** 在测试文件顶层调用：每个用例之后先 closeAll 再删目录 */
export function registerHostCleanup(): void {
  afterEach(async () => {
    for (const testHost of [...liveHosts]) {
      await withTimeout(testHost.host.closeAll(), 15000, 'closeAll in afterEach').catch((error) => {
        console.error(error)
      })
    }
    liveHosts.clear()
    for (const directory of directories) await rm(directory, { recursive: true, force: true })
    directories.clear()
  })
}

/** 深拷贝一份配置（创建那一刻读到的就是那一刻的值，之后改测试对象不影响它） */
function snapshotConfig(config: AgentConfig): AgentConfig {
  return structuredClone(config)
}

export async function makeHost(options: TestHostOptions = {}): Promise<TestHost> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'shuvix-durable-')))
  directories.add(dir)
  const kit = options.kit ?? options.makeKit?.() ?? fauxKit()
  const tools = options.tools ?? []
  const port = options.port ?? fauxPort()
  const configSource: AgentConfigSource = options.agentConfig ?? defaultAgentConfig()
  const events: string[] = []
  const states: [string, RunState][] = []
  const mirror: [string, boolean][] = []
  const configCalls: string[] = []
  const pinned = new Set<string>()
  const broadcasts: ChatEvent[] = []
  const asks: AskRecord[] = []
  const failNextOpen = new Set<string>()
  const memory = new Map<string, MemoryStorage>()
  const warnings: string[] = []
  const registries = new Map<string, Registry<ToolRegistration>[]>()
  const ephemeral = new Set(options.ephemeral ?? [])
  const file = (sessionId: string): string => join(dir, `${sessionId}.sqlite`)
  const toolHost = makeTestToolHost(options.toolHost ?? { agentTools: tools }, (event) =>
    broadcasts.push(event)
  )
  const hostToolHost: ToolHost = options.makeToolHost?.() ?? toolHost

  const testHost: TestHost = {
    host: undefined as unknown as SessionHost,
    kit,
    dir,
    options,
    events,
    states,
    mirror,
    configCalls,
    toolHost,
    port,
    pinned,
    broadcasts,
    asks,
    capability: true,
    failNextOpen,
    memory,
    warnings,
    registryOf: (sessionId) => registries.get(sessionId)?.at(-1),
    registriesOf: (sessionId) => [...(registries.get(sessionId) ?? [])],
    open: (sessionId = 's1') => testHost.host.open(sessionId),
    file,
    statesOf: (sessionId) => states.filter(([id]) => id === sessionId).map(([, state]) => state),
    broadcastsOf: (type) => broadcasts.filter((event) => event.type === type),
    asksOf: <T extends AskRecord['type']>(type: T) =>
      asks.filter((record): record is Extract<AskRecord, { type: T }> => record.type === type),
    restart: async (overrides = {}) => {
      await withTimeout(testHost.host.closeAll(), 15000, 'closeAll in restart')
      liveHosts.delete(testHost)
      return makeHost({
        ...options,
        kit: undefined,
        port,
        agentConfig: configSource,
        ...overrides,
        dir
      })
    }
  }

  const deps: SessionHostDeps = {
    models: options.models ?? kit.models,
    createRegistry: (sessionId) => {
      const registry = createRegistry<ToolRegistration>()
      for (const extension of options.extensions ?? []) registry.install(extension)
      const list = registries.get(sessionId) ?? []
      list.push(registry)
      registries.set(sessionId, list)
      return registry
    },
    toolHost: hostToolHost,
    resolveAgentConfig: (sessionId) => {
      configCalls.push(sessionId)
      return snapshotConfig(
        typeof configSource === 'function' ? configSource(sessionId) : configSource
      )
    },
    modelCatalog: options.modelCatalog ?? fauxCatalog(kit, port),
    ...(options.promptHost === undefined ? {} : { promptHost: options.promptHost }),
    ...(options.promptVars === undefined ? {} : { promptVars: options.promptVars }),
    onLockChange: (sessionId, locked) => {
      mirror.push([sessionId, locked])
      options.onLockChange?.(sessionId, locked)
    },
    openStorage: async (sessionId) => {
      if (failNextOpen.delete(sessionId)) throw new Error(`injected open failure for ${sessionId}`)
      events.push(`open:${sessionId}`)
      let storage: Storage
      if (ephemeral.has(sessionId)) {
        let existing = memory.get(sessionId)
        if (existing === undefined) {
          existing = new MemoryStorage()
          memory.set(sessionId, existing)
        }
        storage = existing
      } else {
        storage = await openNodeSqliteStorage(file(sessionId))
      }
      const close = storage.close.bind(storage)
      storage.close = async (context) => {
        events.push(`close:${sessionId}`)
        return close(context)
      }
      return storage
    },
    storageExists: (sessionId) =>
      ephemeral.has(sessionId) ? memory.has(sessionId) : existsSync(file(sessionId)),
    deleteStorage: async (sessionId) => {
      events.push(`delete:${sessionId}`)
      if (ephemeral.has(sessionId)) {
        memory.delete(sessionId)
        return
      }
      for (const suffix of ['', '-wal', '-shm']) {
        await rm(`${file(sessionId)}${suffix}`, { force: true })
      }
    },
    isEphemeral: (sessionId) => ephemeral.has(sessionId),
    isPinned: (sessionId) => pinned.has(sessionId) || (options.isPinned?.(sessionId) ?? false),
    onSessionOpened: (session) => {
      const sessionId = session.sessionId
      session.subscribeInputs({
        onRequest: (request) => asks.push({ type: 'input_request', sessionId, request }),
        onResolved: (requestId, _response, clientId) =>
          asks.push({
            type: 'input_request_resolved',
            sessionId,
            requestId,
            ...(clientId === undefined ? {} : { clientId })
          })
      })
      options.onSessionOpened?.(session)
    },
    ...(options.onSessionClosed === undefined ? {} : { onSessionClosed: options.onSessionClosed }),
    ...(options.maxIdleOpen === undefined ? {} : { maxIdleOpen: options.maxIdleOpen }),
    settingsOverrides: options.settingsOverrides ?? TEST_SETTINGS_OVERRIDES,
    eventSink: {
      broadcast: (event) => broadcasts.push(event),
      hasUserInputCapability: () => testHost.capability
    },
    onRunStateChange: (sessionId, state) => {
      states.push([sessionId, state])
      options.onRunStateChange?.(sessionId, state)
    },
    ...(options.beforeAbort === undefined ? {} : { beforeAbort: options.beforeAbort }),
    ...(options.onInputsReopened === undefined
      ? {}
      : { onInputsReopened: options.onInputsReopened }),
    ...(options.interruptedSendPolicy === undefined
      ? {}
      : { interruptedSendPolicy: options.interruptedSendPolicy }),
    ...(options.autoResume === undefined ? {} : { autoResume: options.autoResume }),
    ...(options.noticeCoalesceMs === undefined
      ? {}
      : { noticeCoalesceMs: options.noticeCoalesceMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.today === undefined ? {} : { today: options.today }),
    ...(options.onDrivenSettled === undefined ? {} : { onDrivenSettled: options.onDrivenSettled }),
    ...(options.resolveProfileModel === undefined
      ? {}
      : { resolveProfileModel: options.resolveProfileModel }),
    ...(options.maxAgentDepth === undefined ? {} : { maxAgentDepth: options.maxAgentDepth }),
    logger: {
      info: () => {},
      warn: (message) => warnings.push(message),
      error: (message) => warnings.push(message)
    }
  }
  ;(testHost as { host: SessionHost }).host = createSessionHost(deps)
  liveHosts.add(testHost)
  return testHost
}

/** K15：给会话创建 agent（缺省配置下 = faux 模型 + 测试工具）。`kit` 只为保持旧签名 */
export async function primeRoot(session: DurableSession, _kit?: FauxKit): Promise<void> {
  await session.createAgent()
}
