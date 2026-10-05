/**
 * 会话存储的桌面端入口 —— 按存储类型分流的路由（SessionHost 的 openStorage / storageExists /
 * deleteStorage 三个 seam 就是这里的三个函数）。
 *
 * 会话的对话内容按 `sessions.storageKind` 分流（见 chat-protocol 的 sessionStorageKind.ts）：
 *  - `durable-sqlite-1`（新会话）：pi-durable 自带的 `node:sqlite` 存储，`<sessionsDir>/<id>.sqlite`
 *    （WAL 旁带 -wal / -shm）。适配器经**动态 import** 加载 —— `node:sqlite` 只在第一次真要打开会话时
 *    才加载，加载之前先装上实验特性警告的过滤（Q20）。打开 / 关闭 / LRU 归 SessionHost（services/sessionHost）。
 *  - **内存会话**（ephemeral，sessionRecords 认得它）：durable 的 `MemoryStorage`，存在这里的表里直到
 *    会话被删除。SessionHost 关它时只是放手（关闭是空操作），再打开拿到的还是同一份内容 —— 与磁盘上的
 *    文件同一语义；删除才真的丢掉。
 *  - `harness-v3-jsonl`（切换前的会话）：pi 0.80 的 v3 JSONL 会话树，`<sessionsDir>/<id>.jsonl`，
 *    **只读**：经 agent-runtime 的 legacy 读取器（不依赖 pi）渲染成界面消息（`readLegacyTranscript`），
 *    永不再写，SessionHost 也从不打开它（`openSessionStorage` 拒绝、`sessionStorageExists` 答 false）。
 *
 * **运行配置（模型 / 思考档位）存会话设置**：`sessions.settings.model`（`{provider, modelId}`）与
 * `settings.thinkingLevel`。选择器无需为一个下拉框打开会话存储；会话是懒创建的 —— 从未发过消息的
 * 会话上照样能切模型。旧 v3 会话树里的 model_change / thinking_level_change 不再读。
 *
 * 分工与代价不变：`sessions` 表存业务字段，存储文件存对话。两处没有共同事务 —— 删除会话是
 * 「关掉存储 + unlink 文件 + 删表行」几步，中途崩溃会留下孤儿文件；刻意不做启动扫描兜底。
 */
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { unlink } from 'fs/promises'
import { MemoryStorage, type Storage } from '@earendil-works/pi-durable'
import {
  backgroundContext,
  harnessV3TextToChatMessages,
  type LegacyTranscriptView
} from '@shuvix/agent-runtime'
import {
  DURABLE_SQLITE_1,
  HARNESS_V3_JSONL,
  storageKindOf
} from '@shuvix/chat-protocol/sessionStorageKind'
import { getSessionsDir } from '../utils/paths'
import { installSqliteWarningFilter } from '../utils/nodeWarnings'
import { createLogger } from '../logger'
import { sessionRecords } from './sessionRecords'

const log = createLogger('SessionStorage')

/** 旧格式（harness-v3-jsonl）会话的转写文件绝对路径 */
export function sessionFilePath(sessionId: string): string {
  // sessionId 是 uuidv7，本身按时间有序 —— 无需时间戳前缀，也无需按 cwd 分目录
  return join(getSessionsDir(), `${sessionId}.jsonl`)
}

/** pi-durable 会话的 SQLite 存储文件绝对路径 */
export function durableStoragePath(sessionId: string): string {
  return join(getSessionsDir(), `${sessionId}.sqlite`)
}

// ─── 打开 / 存在 / 删除（SessionHost 的存储 seam） ─────────────────

/** 打不开的原因：旧格式（只读）、不认识的格式（更新的版本写的）、没有这一行、内存会话已删 */
export type SessionStorageRefusal = 'legacy' | 'unknown_kind' | 'no_row' | 'retired_ephemeral'

/** 这条会话的存储不能由 SessionHost 打开（见 `SessionStorageRefusal`） */
export class SessionStorageUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reason: SessionStorageRefusal
  ) {
    super(`Session ${sessionId} has no openable storage (${reason})`)
    this.name = 'SessionStorageUnavailableError'
  }
}

/** 活着的内存会话的存储：会话 id → MemoryStorage（删除会话时才丢弃） */
const memoryStorages = new Map<string, MemoryStorage>()

/**
 * 交给 SessionHost 的内存存储视图：关闭是空操作（存储归这里管、活到会话删除为止），其余原样转发。
 * 这样被关掉（closeAll / 显式 close）再打开的内存会话拿到的还是原来那份内容。
 */
function retainedView(storage: MemoryStorage): Storage {
  return new Proxy(storage, {
    get(target, prop) {
      if (prop === 'close') return async () => {}
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    }
  })
}

/**
 * 这条会话的存储归哪一种：内存会话 → memory；新格式 → durable；其余（旧格式 / 不认识 / 没有这一行 /
 * 已删的内存会话）→ 打不开的原因。
 */
function storageRoute(
  sessionId: string
):
  | { kind: 'memory' }
  | { kind: 'durable' }
  | { kind: 'unavailable'; reason: SessionStorageRefusal } {
  if (sessionRecords.isEphemeral(sessionId)) return { kind: 'memory' }
  if (sessionRecords.wasEphemeral(sessionId)) {
    return { kind: 'unavailable', reason: 'retired_ephemeral' }
  }
  const row = sessionRecords.pick(sessionId, ['storageKind'])
  if (!row) return { kind: 'unavailable', reason: 'no_row' }
  const kind = storageKindOf(row)
  if (kind === DURABLE_SQLITE_1) return { kind: 'durable' }
  return { kind: 'unavailable', reason: kind === HARNESS_V3_JSONL ? 'legacy' : 'unknown_kind' }
}

/** 这条会话能不能由 SessionHost 打开（新格式或内存会话；旧格式只读，不能） */
export function isDurableSession(sessionId: string): boolean {
  return storageRoute(sessionId).kind !== 'unavailable'
}

/** 这条会话的存储为什么打不开；能打开（新格式 / 内存会话）→ undefined */
export function storageRefusalOf(sessionId: string): SessionStorageRefusal | undefined {
  const route = storageRoute(sessionId)
  return route.kind === 'unavailable' ? route.reason : undefined
}

/**
 * 打开（不存在则创建）这条会话的存储。新格式 → `<sessionsDir>/<id>.sqlite`（动态加载 node:sqlite）；
 * 内存会话 → 它的 MemoryStorage（第一次打开时建）。旧格式 / 不认识的格式 / 会话不存在 → 抛
 * `SessionStorageUnavailableError`，什么文件都不建。
 */
export async function openSessionStorage(sessionId: string): Promise<Storage> {
  const route = storageRoute(sessionId)
  if (route.kind === 'unavailable') throw new SessionStorageUnavailableError(sessionId, route.reason)
  if (route.kind === 'memory') {
    let storage = memoryStorages.get(sessionId)
    if (!storage) {
      storage = new MemoryStorage()
      memoryStorages.set(sessionId, storage)
    }
    return retainedView(storage)
  }
  // 过滤器先于 node:sqlite 的第一次加载（动态 import 正是那一刻）
  installSqliteWarningFilter()
  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node')
  return openNodeSqliteStorage(durableStoragePath(sessionId))
}

/**
 * 这条会话的存储是否存在（SessionHost 的 peek 据此「不创建」）：内存会话 = 它的 MemoryStorage 还在；
 * 新格式 = `.sqlite` 文件在；旧格式 / 不认识的格式一律 false（SessionHost 从不打开它们）。
 */
export function sessionStorageExists(sessionId: string): boolean {
  const route = storageRoute(sessionId)
  if (route.kind === 'memory') return memoryStorages.has(sessionId)
  if (route.kind === 'durable') return existsSync(durableStoragePath(sessionId))
  return false
}

/**
 * 删除这条会话的全部存储（幂等）。调用时 SessionHost 已经把它关掉（经 `sessionHost.delete`，不要绕过它
 * 直接调）。
 *  - 内存会话（活着的、或刚被删掉行的）：丢掉内存存储，**不碰盘** —— 它从来没有盘上的文件，
 *    同名的文件不归它；
 *  - 其余：删 `<id>.sqlite` 连同 WAL 的 `-wal` / `-shm`，以及旧格式的 `<id>.jsonl` —— 哪种都可能存在，
 *    删的是这条会话，不是某一种格式。单个文件删不掉只记日志。
 */
export async function deleteSessionStorage(sessionId: string): Promise<void> {
  const memory = memoryStorages.get(sessionId)
  if (memory) {
    memoryStorages.delete(sessionId)
    await memory.close(backgroundContext).catch(() => undefined)
  }
  if (memory || sessionRecords.isEphemeral(sessionId) || sessionRecords.wasEphemeral(sessionId)) {
    return
  }
  const sqlite = durableStoragePath(sessionId)
  for (const path of [sqlite, `${sqlite}-wal`, `${sqlite}-shm`, sessionFilePath(sessionId)]) {
    try {
      await unlink(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      log.warn(`删除会话文件失败 ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** 丢掉所有内存存储 —— 仅供单测隔离 */
export function clearMemoryStoragesForTests(): void {
  memoryStorages.clear()
}

// ─── 旧格式只读 ─────────────────────────────────────────────

/**
 * 读一条旧格式会话的界面消息（只读，每次现读现解析，不缓存）。
 *
 * 文件不存在（从未发过消息）→ null；会话头读不出来 → 记日志、null（与「没有转写」同样处理，
 * 界面显示空会话而不是报错页）。
 */
export function readLegacyTranscript(sessionId: string): LegacyTranscriptView | null {
  const path = sessionFilePath(sessionId)
  if (!existsSync(path)) return null
  try {
    const view = harnessV3TextToChatMessages(readFileSync(path, 'utf8'), sessionId)
    if (view.issues.length > 0) {
      log.warn(`旧会话 ${sessionId} 读取时跳过了 ${view.issues.length} 处问题`)
    }
    return view
  } catch (err) {
    log.warn(`旧会话 ${sessionId} 读取失败: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// ─── 运行配置：会话设置是唯一事实源 ─────────────────────────────

export interface SessionRunConfig {
  provider: string | null
  model: string | null
  thinkingLevel: string | null
}

/** 从会话设置读出当前运行配置；没设过的项为 null（调用方回落默认） */
export async function readSessionRunConfig(sessionId: string): Promise<SessionRunConfig> {
  const settings = sessionRecords.pickSettings(sessionId, ['model', 'thinkingLevel'])
  return {
    provider: settings?.model?.provider ?? null,
    model: settings?.model?.modelId ?? null,
    thinkingLevel: settings?.thinkingLevel ?? null
  }
}

/** 记下会话选定的模型（选择器 / 子会话继承父会话） */
export async function appendModelChange(
  sessionId: string,
  provider: string,
  modelId: string
): Promise<void> {
  sessionRecords.updateSettings(sessionId, { model: { provider, modelId } })
}

/** 记下会话选定的思考档位 */
export async function appendThinkingLevelChange(
  sessionId: string,
  thinkingLevel: string
): Promise<void> {
  sessionRecords.updateSettings(sessionId, { thinkingLevel })
}
