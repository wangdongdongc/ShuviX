/**
 * 会话的存储类型 —— 一条会话的对话内容存成哪一种格式。
 *
 * 原则：**永不迁移会话数据**。存储格式换代时，新会话用新类型，旧会话保留它原来的类型，
 * 由各类型自己的适配器按能力提供兼容（退役的类型至少保留只读查看）；会话表上的这一列
 * 就是分流的依据。见 docs/reports/pi 1.0 升级与架构对齐调研.md §5.10。
 *
 *  - `harness-v3-jsonl`：pi 0.80 AgentHarness 的会话树，`sessions/<id>.jsonl`（v3 头 + 树条目）。
 *  - `durable-sqlite-1`：pi-durable 的存储，`sessions/<id>.sqlite`。
 *
 * 只追加，不改名、不删除：一个值一旦落过库，就永远指那一种格式。
 */
import type { SessionViewCapabilities } from './types/sessionView'

export const SESSION_STORAGE_KINDS = ['harness-v3-jsonl', 'durable-sqlite-1'] as const

export type SessionStorageKind = (typeof SESSION_STORAGE_KINDS)[number]

/** pi 0.80 harness 的 v3 JSONL 会话树（只读：P1-01 起不再新建） */
export const HARNESS_V3_JSONL: SessionStorageKind = 'harness-v3-jsonl'

/** pi-durable 的 SQLite 存储，`sessions/<id>.sqlite` */
export const DURABLE_SQLITE_1: SessionStorageKind = 'durable-sqlite-1'

/**
 * 当前版本新建会话所用的存储类型。
 *
 * 换存储时只改这一个值：之前建的会话保持原类型，不迁移。pi-durable 切换（P1-01）把它从
 * `harness-v3-jsonl` 换成了 `durable-sqlite-1`。
 */
export const CURRENT_SESSION_STORAGE_KIND: SessionStorageKind = DURABLE_SQLITE_1

/** 是否是本版本认识的存储类型（更新版本写下的值在旧版本里不认识） */
export function isKnownStorageKind(value: unknown): value is SessionStorageKind {
  return (SESSION_STORAGE_KINDS as readonly unknown[]).includes(value)
}

/**
 * 读一条会话的存储类型。
 *
 * 缺省（手工构造、尚未落库的会话对象）视为 `harness-v3-jsonl`：表上这一列带默认值，
 * v30 之前的行在加列时就补成了它。不认识的值原样返回，交给调用方拒绝 —— 那是更新的
 * 版本写下的格式，旧版本不能拿自己的格式去读写它。
 */
export function storageKindOf(session: { storageKind?: string | null }): string {
  return session.storageKind ?? HARNESS_V3_JSONL
}

/**
 * 每种存储类型能做什么 —— 「各类型按能力提供兼容」落成的一张表（决策 #10、Q-P4-05）。新加一种类型，
 * 类型检查会要求在这里补一行。
 *
 *  - `harness-v3-jsonl`：只读 —— 三项都关（永不再写）。
 *  - `durable-sqlite-1`：能发、能回退、能继续被打断的运行。
 */
const STORAGE_KIND_CAPABILITIES: Record<SessionStorageKind, Readonly<SessionViewCapabilities>> = {
  'harness-v3-jsonl': { send: false, rollback: false, continue: false },
  'durable-sqlite-1': { send: true, rollback: true, continue: true }
}

/** 还没有存储的新会话：能发第一条消息；没有可回退的消息、没有可继续的运行 */
const NO_STORAGE_CAPABILITIES: Readonly<SessionViewCapabilities> = {
  send: true,
  rollback: false,
  continue: false
}

/** 不认识的存储类型（更新的版本写的）：三项都关，旧版本不碰它 */
const UNKNOWN_KIND_CAPABILITIES: Readonly<SessionViewCapabilities> = {
  send: false,
  rollback: false,
  continue: false
}

/**
 * 一种存储类型的能力位 —— 界面视图的 `capabilities` 从这里取：durable 视图读 `DURABLE_SQLITE_1`、
 * 旧格式视图读 `HARNESS_V3_JSONL`、还没有存储的新会话（`source: 'none'`）读 `null`；不认识的值三项都关。
 *
 * 只是能力位；完整的按类型适配器对象（打开 / 读 / 删）是 phase 5 的事，路由仍在桌面端的 sessionStorage。
 * 每次调用交回一份新对象，调用方可以放心放进视图。
 */
export function capabilitiesOfStorageKind(kind: string | null): SessionViewCapabilities {
  if (kind === null) return { ...NO_STORAGE_CAPABILITIES }
  if (!isKnownStorageKind(kind)) return { ...UNKNOWN_KIND_CAPABILITIES }
  return { ...STORAGE_KIND_CAPABILITIES[kind] }
}
