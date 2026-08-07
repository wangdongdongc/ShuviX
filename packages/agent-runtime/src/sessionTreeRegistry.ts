/**
 * SessionTreeRegistry —— 进程内「sessionId → 共享 Session 实例」缓存（跨端共享内核）。
 *
 * 动机：pi 的快照型存储（JsonlSessionStorage：open 即全量加载进内存，之后零 I/O）
 * 要求**单写者单实例** —— 多处各自 open 会得到互相分叉的内存快照。而一次会话切换
 * 往往有多路并发读取（message.list / agent.init / countArchived），Agent 运行时也要
 * 与读取端共用同一棵树。本 registry 把它们收敛到同一次加载：
 *
 *  - 在途 Promise 去重：并发 get/ensure 共享同一次 open；
 *  - 打开失败的槽自我清除，不缓存死 Promise（坏文件修复后可重试）；
 *  - 逐出：宿主删除会话时显式 evict；无 Agent 钉住的旁观会话按 LRU 限量
 *    （重图会话一棵树可达几十 MB）；钉住判定经 setPinned 注入
 *    （宿主接 SessionManager.tracked —— 含创建中，见其文档）。
 *
 * 一致性前提：宿主的**所有** Session 构造路径都必须经过本 registry。
 * 存储后端经 deps 注入（桌面 = JSONL 文件，扩展 = OPFS 上的 JSONL）。
 */
import type { Session } from '@earendil-works/pi-agent-core'

export interface SessionTreeRegistryDeps {
  /** 打开已存在的会话树（仅在 exists 为真或槽曾建立时调用） */
  open: (sessionId: string) => Promise<Session>
  /** 创建新会话树。cwd 写进 header 仅作记录（注意 pi open() 校验其非空，宿主须兜底） */
  create: (sessionId: string, cwd: string) => Promise<Session>
  /** 会话存储是否已存在 */
  exists: (sessionId: string) => boolean | Promise<boolean>
  /** 无钉住会话的 LRU 缓存上限（默认 8） */
  maxUnpinned?: number
}

export interface SessionTreeRegistry {
  /** 取共享会话树；存储不存在时返回 null（不创建） */
  get(sessionId: string): Promise<Session | null>
  /** 取共享会话树，不存在则创建（写路径） */
  ensure(sessionId: string, cwd?: string): Promise<Session>
  /** 逐出缓存槽（宿主删除会话时调用；不负责删底层存储） */
  evict(sessionId: string): void
  /** 注入钉住判定（= 该会话的 Agent 运行时存在或创建中，LRU 不得回收） */
  setPinned(fn: (sessionId: string) => boolean): void
  /** 清空缓存 —— 仅供单测隔离 */
  clearForTests(): void
}

interface CacheSlot {
  promise: Promise<Session>
  lastUsed: number
}

export function createSessionTreeRegistry(deps: SessionTreeRegistryDeps): SessionTreeRegistry {
  const maxUnpinned = deps.maxUnpinned ?? 8
  const cache = new Map<string, CacheSlot>()
  let isPinned: (sessionId: string) => boolean = () => false

  /** 取（或建立）缓存槽。open 失败的槽自我清除，下次调用重试而非缓存死 Promise。 */
  function slotFor(sessionId: string, open: () => Promise<Session>): Promise<Session> {
    const hit = cache.get(sessionId)
    if (hit) {
      hit.lastUsed = Date.now()
      return hit.promise
    }
    const slot: CacheSlot = { promise: open(), lastUsed: Date.now() }
    cache.set(sessionId, slot)
    slot.promise.catch(() => {
      if (cache.get(sessionId) === slot) cache.delete(sessionId)
    })
    trim()
    return slot.promise
  }

  /** LRU 限量：只逐出未钉住的槽（有 Agent 的会话树与运行时共享，不可回收） */
  function trim(): void {
    if (cache.size <= maxUnpinned) return
    const evictable = [...cache.entries()]
      .filter(([id]) => !isPinned(id))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [id] of evictable) {
      if (cache.size <= maxUnpinned) break
      cache.delete(id)
    }
  }

  return {
    async get(sessionId) {
      if (!cache.has(sessionId) && !(await deps.exists(sessionId))) return null
      return await slotFor(sessionId, () => deps.open(sessionId))
    },

    async ensure(sessionId, cwd = '') {
      return await slotFor(sessionId, async () => {
        if (await deps.exists(sessionId)) return await deps.open(sessionId)
        return await deps.create(sessionId, cwd)
      })
    },

    evict(sessionId) {
      cache.delete(sessionId)
    },

    setPinned(fn) {
      isPinned = fn
    },

    clearForTests() {
      cache.clear()
    }
  }
}
