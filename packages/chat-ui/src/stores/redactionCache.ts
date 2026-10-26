/**
 * 自动脱敏标记的真值缓存（docs/auto-redaction-design.md §2.3）：界面按会话问主进程「这些占位符是什么」，问到的
 * 记下来 —— 一个占位符永远对应同一个值，所以不过期。同一轮渲染里要问的攒成一次请求。
 *
 * 没问到的（表里还没有：别的会话带过来的、模型自己编的）记下时间，过 RETRY_MS 之后再有渲染才再问 —— 不设定时器：
 * 内容是先记进对照表、再写进记录的，界面看到占位符时表里通常已经有它了，问不到是少数。
 */
import {
  MAX_RESOLVE_PLACEHOLDERS,
  restorePlaceholders,
  type RedactionMarkInfo
} from '@shuvix/chat-protocol/utils/redactionPlaceholders'
import { getSessionChannelApi } from '../api/chatApi'

const RETRY_MS = 2000

/** 会话 → 占位符 → 类别与真值 */
const known = new Map<string, Map<string, RedactionMarkInfo>>()
/** `会话\0占位符` → 上次没问到的时间 */
const missedAt = new Map<string, number>()
/** 正在问的 `会话\0占位符` */
const inflight = new Set<string>()
/** 攒着待问的：会话 → 占位符 */
const queued = new Map<string, Set<string>>()
let flushScheduled = false
let version = 0
const listeners = new Set<() => void>()

const keyOf = (sessionId: string, placeholder: string): string => `${sessionId}\u0000${placeholder}`

function notify(): void {
  version++
  for (const listener of listeners) listener()
}

export function redactionInfo(
  sessionId: string,
  placeholder: string
): RedactionMarkInfo | undefined {
  return known.get(sessionId)?.get(placeholder)
}

/** 请主进程查这些占位符（已知的、正在问的、刚问过没问到的跳过） */
export function requestRedactions(sessionId: string, placeholders: Iterable<string>): void {
  const now = Date.now()
  for (const placeholder of placeholders) {
    if (known.get(sessionId)?.has(placeholder)) continue
    const key = keyOf(sessionId, placeholder)
    if (inflight.has(key)) continue
    const missed = missedAt.get(key)
    if (missed !== undefined && now - missed < RETRY_MS) continue
    let set = queued.get(sessionId)
    if (!set) queued.set(sessionId, (set = new Set()))
    set.add(placeholder)
  }
  if (queued.size > 0 && !flushScheduled) {
    flushScheduled = true
    queueMicrotask(() => void flush())
  }
}

async function flush(): Promise<void> {
  flushScheduled = false
  const batches = [...queued]
  queued.clear()
  await Promise.all(
    batches.flatMap(([sessionId, set]) => {
      const all = [...set]
      const chunks: string[][] = []
      for (let i = 0; i < all.length; i += MAX_RESOLVE_PLACEHOLDERS) {
        chunks.push(all.slice(i, i + MAX_RESOLVE_PLACEHOLDERS))
      }
      return chunks.map((chunk) => resolveChunk(sessionId, chunk))
    })
  )
}

async function resolveChunk(sessionId: string, placeholders: string[]): Promise<void> {
  for (const p of placeholders) inflight.add(keyOf(sessionId, p))
  let result: Record<string, RedactionMarkInfo> = {}
  try {
    // 渠道端不一定接了这一口（旧的侧边栏）：没有就当都没问到
    result = (await getSessionChannelApi().redaction?.resolve({ sessionId, placeholders })) ?? {}
  } catch {
    result = {}
  }
  const now = Date.now()
  let map = known.get(sessionId)
  if (!map) known.set(sessionId, (map = new Map()))
  for (const p of placeholders) {
    const key = keyOf(sessionId, p)
    inflight.delete(key)
    const info = result[p]
    if (info && typeof info.category === 'string') {
      map.set(p, info.value === undefined ? { category: info.category } : info)
      missedAt.delete(key)
    } else {
      missedAt.set(key, now)
    }
  }
  notify()
}

export function subscribeRedactions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function redactionVersion(): number {
  return version
}

/** 复制出去的是用户看到的样子：查到的占位符换回真值 */
export function restoreForCopy(sessionId: string | null | undefined, text: string): string {
  if (!sessionId) return text
  const map = known.get(sessionId)
  return map ? restorePlaceholders(text, (p) => map.get(p)?.value) : text
}

/** 会话删了：它的真值不再留在内存里 */
export function forgetRedactions(sessionId: string): void {
  if (known.delete(sessionId)) notify()
}

export function resetRedactionCacheForTests(): void {
  known.clear()
  missedAt.clear()
  inflight.clear()
  queued.clear()
  flushScheduled = false
  version = 0
}
