/**
 * 「ShuviX 设置」条的写入队列（md 扩展元数据，chat-protocol mdMeta.ts）。
 *
 * **对象 id 不需要用户分配**（用户裁决 2026-10-10：没有「分配 id」按钮）：一份还没有 `shuvix-id` 的文件，
 * 用户第一次改设置时，这里先给它分配一个 —— 往编辑器缓冲区写一行 id（卡片给的 setObjectId，随即落盘），
 * 等主进程在**磁盘上**看到它（mdMeta:setFill 只认磁盘上的 id），再把这次设置写进数据库。
 *
 * 为什么放在组件外面：写 id 会改 frontmatter，卡片 widget 随之重建，挂在里面的设置条整个卸载重挂 ——
 * 「等 id 落盘、再写设置」不能跟着某一个组件实例走。这里按会话记一份在途写入，设置条（不论哪个实例）
 * 订阅它：控件先显示在途的值、标出「正在保存」，写完再重查。同一会话的写入排成一队：id 落盘之前
 * 又改了别的键，排在同一个 id 后面，不会再分配第二个。「换新 id」走同一条路（只是没有要写的设置）。
 */
import { v7 as uuidv7 } from 'uuid'
import { getChatApi } from '@shuvix/chat-ui'
import type { MdMetaWriteResult } from '@shuvix/chat-protocol/mdMeta'

/** 等磁盘追上缓冲区的轮询：间隔与次数（约 6 秒后放弃） */
const POLL_MS = 300
const POLL_LIMIT = 20

/** 最近一次失败：分配不了 id / id 迟迟没落盘 / 主进程拒绝（MdMetaWriteResult 的 reason 与 message） */
export type MetaWriteError =
  | { kind: 'cannot-assign' }
  | { kind: 'not-saved' }
  | { kind: 'rejected'; reason: string; message?: string }

export interface MetaWriteState {
  /** 在途（等 id 落盘或正在写）的设置：键 → 值（null = 删除）；没有在途写入时为 null */
  pending: ReadonlyMap<string, string | null> | null
  /**
   * 本轮任务已经写进数据库的设置（下一轮任务开始时清空）。设置条重查数据库要一次 IPC 往返，这期间拿它
   * 盖在旧视图上 —— 否则一项写完、在途里删掉它的那一刻，控件会闪回旧值
   */
  written: ReadonlyMap<string, string | null>
  /** 最近一次失败；下一次写入开始时清掉 */
  error: MetaWriteError | null
  /** 每次变化递增 —— 订阅方据此重查数据库里的设置 */
  version: number
}

interface Job {
  objectId: string
  /** 还没写进数据库的设置；同一键后写的覆盖先写的 */
  writes: Map<string, string | null>
}

const EMPTY: MetaWriteState = { pending: null, written: new Map(), error: null, version: 0 }
const states = new Map<string, MetaWriteState>()
const jobs = new Map<string, Job>()
const listeners = new Map<string, Set<() => void>>()

function emit(sessionId: string, patch: Partial<Omit<MetaWriteState, 'version'>>): void {
  const prev = states.get(sessionId) ?? EMPTY
  states.set(sessionId, { ...prev, ...patch, version: prev.version + 1 })
  for (const listener of listeners.get(sessionId) ?? []) listener()
}

/** 当前状态（同一引用直到下一次变化 —— 供 useSyncExternalStore） */
export function metaWriteState(sessionId: string): MetaWriteState {
  return states.get(sessionId) ?? EMPTY
}

export function subscribeMetaWrites(sessionId: string, listener: () => void): () => void {
  let set = listeners.get(sessionId)
  if (!set) {
    set = new Set()
    listeners.set(sessionId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 等主进程在磁盘上看到这个 id（第一次不等，之后每 POLL_MS 再问） */
async function waitForDisk(sessionId: string, objectId: string): Promise<boolean> {
  const api = getChatApi().mdMeta
  if (!api) return false
  for (let i = 0; i < POLL_LIMIT; i++) {
    if (i > 0) await sleep(POLL_MS)
    const view = await api.get({ sessionId }).catch(() => null)
    if (view?.objectId === objectId) return true
  }
  return false
}

async function writeOne(
  sessionId: string,
  objectId: string,
  key: string,
  value: string | null
): Promise<MdMetaWriteResult> {
  const api = getChatApi().mdMeta
  if (!api) return { success: false, reason: 'not-registry-note' }
  try {
    return value === null
      ? await api.unsetFill({ sessionId, objectId, key })
      : await api.setFill({ sessionId, objectId, key, value })
  } catch (e) {
    return {
      success: false,
      reason: 'invalid-value',
      message: e instanceof Error ? e.message : String(e)
    }
  }
}

/**
 * 跑一个会话的在途任务：等 id 落盘，再把排队的设置依次写进去（写的过程中新来的也在 writes 里）。
 * 每一步先确认自己还是这个会话的当前任务 —— 不是了（只有测试的 reset 会造成这种情况）就悄悄退出，
 * 不去删别人的任务、也不往别人的状态里发通知。
 */
async function run(sessionId: string, job: Job): Promise<void> {
  const current = (): boolean => jobs.get(sessionId) === job
  if (!(await waitForDisk(sessionId, job.objectId))) {
    if (!current()) return
    jobs.delete(sessionId)
    emit(sessionId, { pending: null, error: { kind: 'not-saved' } })
    return
  }
  let error: MetaWriteError | null = null
  const written = new Map<string, string | null>()
  while (job.writes.size > 0) {
    if (!current()) return
    const [key, value] = job.writes.entries().next().value as [string, string | null]
    job.writes.delete(key)
    const result = await writeOne(sessionId, job.objectId, key, value)
    if (!current()) return
    if (result.success) {
      written.set(key, value)
    } else {
      error = { kind: 'rejected', reason: result.reason, message: result.message }
    }
    emit(sessionId, { pending: new Map(job.writes), written: new Map(written) })
  }
  jobs.delete(sessionId)
  emit(sessionId, { pending: null, error })
}

/**
 * 开一个任务：缓冲区里已有合法 id 就沿用它（等它落盘即可），否则分配一个新的写进缓冲区。
 * `forceNewId`：「换新 id」—— 不论缓冲区里有没有都换一个新的。
 */
function start(
  sessionId: string,
  bufferId: string | null,
  setObjectId: (id: string) => boolean,
  writes: Map<string, string | null>,
  forceNewId: boolean
): void {
  let objectId = forceNewId ? null : bufferId
  if (!objectId) {
    objectId = uuidv7()
    if (!setObjectId(objectId)) {
      emit(sessionId, { pending: null, error: { kind: 'cannot-assign' } })
      return
    }
  }
  const job: Job = { objectId, writes }
  jobs.set(sessionId, job)
  emit(sessionId, { pending: new Map(writes), written: new Map(), error: null })
  void run(sessionId, job)
}

export interface MetaWriteRequest {
  sessionId: string
  /** 缓冲区里当前的合法 id；没有或写错为 null（这时先自动分配一个） */
  bufferId: string | null
  key: string
  /** null = 删除这项设置 */
  value: string | null
  /** 往缓冲区写 shuvix-id 并落盘（卡片给的）；frontmatter 改不了一行时返回 false */
  setObjectId: (id: string) => boolean
}

/** 改一项设置。没有 id 的文件先自动分配；同一会话已有在途任务时排进去 */
export function requestMetaWrite(req: MetaWriteRequest): void {
  const job = jobs.get(req.sessionId)
  if (job) {
    job.writes.set(req.key, req.value)
    emit(req.sessionId, { pending: new Map(job.writes), error: null })
    return
  }
  start(req.sessionId, req.bufferId, req.setObjectId, new Map([[req.key, req.value]]), false)
}

/**
 * 换新 id：给文件写一个新的对象 id —— 从此不再与副本共用设置，旧 id 下的设置原样留着（撤销能换回旧 id）。
 * 有在途任务时不做（那个任务还在等它的 id 落盘）。
 */
export function requestNewObjectId(sessionId: string, setObjectId: (id: string) => boolean): void {
  if (jobs.has(sessionId)) return
  start(sessionId, null, setObjectId, new Map(), true)
}

/** 仅供测试：清空全部会话的状态 */
export function resetMetaWritesForTests(): void {
  states.clear()
  jobs.clear()
  listeners.clear()
}
