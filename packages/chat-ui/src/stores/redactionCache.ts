/**
 * 自动脱敏标记的真值缓存（docs/auto-redaction-design.md §2.3）：界面按会话问主进程「这些占位符是什么、模型收到的是
 * 不是真值」，问到的记下来。对话记录里的消息还要看它的第一个读者照不照发（§15.2）：用到过的读者按会话记下，之后每次
 * 问都一并带上（disclosedTo）。一个占位符永远对应同一个值；「模型收到的是不是真值」（disclosed）随策略、服务商与会话的
 * 模型变，那几样一变（policy.changed / providers.changed / session.configChanged）就把记下的重问一遍 —— 重问期间照旧
 * 显示旧的，不闪。同一轮渲染里要问的攒成一次请求。
 *
 * 没问到的（表里还没有：别的会话带过来的、模型自己编的）记下时间，过 RETRY_MS 之后再有渲染才再问 —— 不设定时器：
 * 内容是先记进对照表、再写进记录的，界面看到占位符时表里通常已经有它了，问不到是少数。
 */
import {
  MAX_RESOLVE_PLACEHOLDERS,
  MAX_RESOLVE_READERS,
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
/** 会话 → 用到过的第一个读者（readerKey） */
const readersOf = new Map<string, Set<string>>()
let flushScheduled = false
let version = 0
const listeners = new Set<() => void>()
let unsubscribeEvents: (() => void) | undefined

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

/** 策略、服务商、会话配置一变，「模型收到的是不是真值」可能跟着变：把记下的重问一遍 */
function watchEvents(): void {
  if (unsubscribeEvents) return
  try {
    unsubscribeEvents = getSessionChannelApi().events?.subscribe((event) => {
      if (event.type === 'policy.changed' || event.type === 'providers.changed') refreshRedactions()
      else if (event.type === 'session.configChanged') refreshRedactions(event.sessionId)
    })
  } catch {
    // 渠道端没有事件流：只能等下次打开会话
  }
}

/** 重问已经记下的占位符（不清掉，重问期间照旧显示）；不给会话 = 全部 */
export function refreshRedactions(sessionId?: string): void {
  const sessions = sessionId === undefined ? [...known.keys()] : [sessionId]
  for (const sid of sessions) {
    const map = known.get(sid)
    if (map && map.size > 0) requestRedactions(sid, map.keys(), true)
  }
}

/** 已经问到、且这几个读者都判过（解不开的没有真值，不用判） */
export function answered(info: RedactionMarkInfo | undefined, readers: readonly string[]): boolean {
  if (info === undefined) return false
  return info.value === undefined || readers.every((key) => info.disclosedTo?.[key] !== undefined)
}

/**
 * 请主进程查这些占位符（已知的、正在问的、刚问过没问到的跳过；force = 已知的也重问）。readers：这几处所在消息的
 * 第一个读者，还没判过的也算没问到。
 */
export function requestRedactions(
  sessionId: string,
  placeholders: Iterable<string>,
  force = false,
  readers: readonly string[] = []
): void {
  watchEvents()
  if (readers.length > 0) {
    let set = readersOf.get(sessionId)
    if (!set) readersOf.set(sessionId, (set = new Set()))
    for (const key of readers) if (set.size < MAX_RESOLVE_READERS) set.add(key)
  }
  const now = Date.now()
  for (const placeholder of placeholders) {
    if (!force && answered(known.get(sessionId)?.get(placeholder), readers)) continue
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
  const readers = [...(readersOf.get(sessionId) ?? [])]
  let result: Record<string, RedactionMarkInfo> = {}
  try {
    // 渠道端不一定接了这一口（旧的侧边栏）：没有就当都没问到
    result =
      (await getSessionChannelApi().redaction?.resolve({
        sessionId,
        placeholders,
        ...(readers.length === 0 ? {} : { readers })
      })) ?? {}
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
      map.set(
        p,
        info.value === undefined
          ? { category: info.category }
          : {
              category: info.category,
              value: info.value,
              disclosed: info.disclosed === true,
              disclosedTo: Object.fromEntries(
                readers.map((key) => [key, info.disclosedTo?.[key] === true])
              )
            }
      )
      missedAt.delete(key)
    } else if (!map.has(p)) {
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
  readersOf.delete(sessionId)
  if (known.delete(sessionId)) notify()
}

export function resetRedactionCacheForTests(): void {
  unsubscribeEvents?.()
  unsubscribeEvents = undefined
  known.clear()
  missedAt.clear()
  inflight.clear()
  queued.clear()
  readersOf.clear()
  flushScheduled = false
  version = 0
}
