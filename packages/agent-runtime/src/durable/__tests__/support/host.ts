/**
 * 测试用会话宿主：mkdtemp 目录里每会话一个 SQLite 文件（临时会话给 MemoryStorage —— 关掉的
 * MemoryStorage 不能再开，需要关了再开的用例都用 SQLite）。
 *
 * 事件日志：`open:<id>`（打开存储）、`close:<id>`（存储真正关闭）、`delete:<id>`（删除存储）。
 * `restart()` = closeAll + 同一目录上的新注册表 / 新 faux 套件 / 新宿主 —— 模拟换了一个进程。
 * `primeRoot()` 给当前对话配上 faux 模型（P1-09 之后由锁接手）。
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRegistry,
  MemoryStorage,
  type Registry,
  type Storage,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { afterEach } from 'vitest'
import { backgroundContext as BG } from '../../context'
import type { DurableSession } from '../../durableSession'
import type { InterruptedSendPolicy, RunState, SessionHostDeps } from '../../seams'
import { createSessionHost, type SessionHost } from '../../sessionHost'
import type { ShuviXSettingsOverrides } from '../../settings'
import { fauxKit, type FauxKit } from './faux'
import { toolsExtension } from './tools'
import { withTimeout } from './wait'

export const TEST_SETTINGS_OVERRIDES: ShuviXSettingsOverrides = {
  retry: { enabled: false },
  compaction: { enabled: false }
}

export interface TestHostOptions {
  /** 复用目录（restart 用）；缺省新建 */
  dir?: string
  kit?: FauxKit
  /** 每次打开时安装进注册表的工具（同一份数组可在 makeHost 之后再 push） */
  tools?: ToolRegistration[]
  maxIdleOpen?: number
  /** 临时会话 id（MemoryStorage） */
  ephemeral?: readonly string[]
  /** 整份替换缺省的测试覆盖（关重试 / 关自动压缩） */
  settingsOverrides?: ShuviXSettingsOverrides
  contextWindow?: (sessionId: string) => number | undefined
  interruptedSendPolicy?: InterruptedSendPolicy
  autoResume?: (sessionId: string) => unknown
  noticeCoalesceMs?: number
  beforeAbort?: (sessionId: string) => void
  onInputsReopened?: (sessionId: string) => void
  onRunStateChange?: (sessionId: string, state: RunState) => void
  /** durable 的时钟（条目时间戳 / 日期通知的间隔）；缺省 Date.now */
  now?: () => number
  /** 今天的日期（给了才发日期通知） */
  today?: () => string
}

export interface TestHost {
  readonly host: SessionHost
  readonly kit: FauxKit
  readonly registry: Registry
  readonly dir: string
  readonly options: TestHostOptions
  /** open:<id> / close:<id> / delete:<id> */
  readonly events: string[]
  /** onRunStateChange 的调用（按顺序） */
  readonly states: [string, RunState][]
  readonly pinned: Set<string>
  /** 广播给前端的 ChatEvent（询问卡片） */
  readonly broadcasts: ChatEvent[]
  /** 有没有前端能展示询问面板 */
  capability: boolean
  /** 下一次打开这些会话时失败 */
  readonly failNextOpen: Set<string>
  readonly memory: Map<string, MemoryStorage>
  readonly warnings: string[]
  open(sessionId?: string): Promise<DurableSession>
  file(sessionId: string): string
  statesOf(sessionId: string): RunState[]
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

export async function makeHost(options: TestHostOptions = {}): Promise<TestHost> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'shuvix-durable-')))
  directories.add(dir)
  const kit = options.kit ?? fauxKit()
  const registry = createRegistry()
  const tools = options.tools ?? []
  // 工具数组可在宿主建好之后再补（例如需要拿到会话句柄的询问工具）：首次打开时再安装
  let installed = false
  const ensureTools = (): void => {
    if (installed || tools.length === 0) return
    installed = true
    registry.install(toolsExtension(tools))
  }
  const events: string[] = []
  const states: [string, RunState][] = []
  const pinned = new Set<string>()
  const broadcasts: ChatEvent[] = []
  const failNextOpen = new Set<string>()
  const memory = new Map<string, MemoryStorage>()
  const warnings: string[] = []
  const ephemeral = new Set(options.ephemeral ?? [])
  const file = (sessionId: string): string => join(dir, `${sessionId}.sqlite`)

  const testHost: TestHost = {
    host: undefined as unknown as SessionHost,
    kit,
    registry,
    dir,
    options,
    events,
    states,
    pinned,
    broadcasts,
    capability: true,
    failNextOpen,
    memory,
    warnings,
    open: (sessionId = 's1') => testHost.host.open(sessionId),
    file,
    statesOf: (sessionId) => states.filter(([id]) => id === sessionId).map(([, state]) => state),
    restart: async (overrides = {}) => {
      await withTimeout(testHost.host.closeAll(), 15000, 'closeAll in restart')
      liveHosts.delete(testHost)
      return makeHost({ ...options, kit: undefined, ...overrides, dir })
    }
  }

  const deps: SessionHostDeps = {
    models: kit.models,
    registry,
    openStorage: async (sessionId) => {
      ensureTools()
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
    isPinned: (sessionId) => pinned.has(sessionId),
    ...(options.maxIdleOpen === undefined ? {} : { maxIdleOpen: options.maxIdleOpen }),
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
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

/** 给当前对话配上 faux 模型 */
export async function primeRoot(session: DurableSession, kit: FauxKit): Promise<void> {
  const conversation = await session.currentConversation()
  await conversation.configure({ model: kit.model }, BG)
}
