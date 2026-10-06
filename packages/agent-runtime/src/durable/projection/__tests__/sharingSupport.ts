/**
 * P4-09b 用例的共用夹具：
 *
 *  - `legacyReconcile`：P4-09b 之前的 `reconcile`（713dc849 原样拷贝，不带 `prev`、每帧走遍草稿）—— 等价性质的
 *    预言：同一串视图喂给它与新路径，状态与操作流都必须一样；
 *  - `recordingDraft(draft, log)`：把 chord 的草稿再包一层代理，记下对它的每一次读 / 写 / 枚举（路径），
 *    用来证明「同一引用的子树一次都没碰」与「一帧碰的槽数与历史长度无关」；
 *  - `revisionsOf(state)`：精确操作流（同 `projectorSupport.opsOf`，不拖会话夹具进来）。
 */
import {
  RemoteServiceProvider,
  defineService,
  type MutableReplicatedState,
  type ReplicatedState,
  type Service
} from '@earendil-works/chord'
import type { Op } from '@earendil-works/chord/delta'

type JsonRecord = { [key: string]: unknown }

// ─────────────────────────── 预言：旧的 reconcile（713dc849 原样） ───────────────────────────

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function identityOf(value: unknown): string | number | undefined {
  if (!isRecord(value)) return undefined
  const id = value.id ?? value.submissionId
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
}

function reconcileSlot(current: unknown, next: unknown): boolean {
  if (Array.isArray(current) && Array.isArray(next)) {
    reconcileArray(current, next)
    return false
  }
  if (isRecord(current) && isRecord(next)) {
    reconcileRecord(current, next)
    return false
  }
  return current !== next
}

function reconcileRecord(draft: JsonRecord, next: JsonRecord): void {
  for (const key of Object.keys(draft)) {
    if (!Object.hasOwn(next, key)) draft[key] = undefined
  }
  for (const key of Object.keys(next)) {
    const value = next[key]
    if (!Object.hasOwn(draft, key) || reconcileSlot(draft[key], value)) draft[key] = value
  }
}

function reconcileArray(draft: unknown[], next: readonly unknown[]): void {
  const shared = Math.min(draft.length, next.length)
  let keyed = draft.length > 0 && next.length > 0
  for (let index = 0; keyed && index < draft.length; index++) {
    if (identityOf(draft[index]) === undefined) keyed = false
  }
  for (let index = 0; keyed && index < next.length; index++) {
    if (identityOf(next[index]) === undefined) keyed = false
  }
  let prefix = shared
  if (keyed) {
    prefix = 0
    while (prefix < shared && identityOf(draft[prefix]) === identityOf(next[prefix])) prefix++
  }
  for (let index = 0; index < prefix; index++) {
    if (reconcileSlot(draft[index], next[index])) draft[index] = next[index]
  }
  if (prefix === draft.length) {
    if (next.length > prefix) draft.push(...next.slice(prefix))
    return
  }
  if (prefix === next.length) {
    draft.splice(prefix, draft.length - prefix)
    return
  }
  draft.splice(prefix, draft.length - prefix, ...next.slice(prefix))
}

/** P4-09b 之前的 `reconcile`：只看草稿，逐帧走遍整棵树 */
export function legacyReconcile(draft: object, next: object): void {
  reconcileRecord(draft as JsonRecord, next as JsonRecord)
}

// ─────────────────────────── 草稿访问记录 ───────────────────────────

/**
 * 包一层记录代理：`get` / `set` / `deleteProperty` / `has` / `ownKeys` / `getOwnPropertyDescriptor` 都记下
 * 路径（`get:messages/3/blocks`）。读出来的子容器同样包起来，所以整棵子树的访问都看得见。
 */
export function recordingDraft<T extends object>(
  target: T,
  log: string[],
  path: readonly (string | number)[] = []
): T {
  const at = (key: PropertyKey): string => [...path, String(key)].join('/')
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key) as unknown
      if (typeof key === 'symbol') return value
      log.push(`get:${at(key)}`)
      if (typeof value === 'object' && value !== null) {
        return recordingDraft(value, log, [...path, key])
      }
      return value
    },
    set(object, key, value) {
      log.push(`set:${at(key)}`)
      return Reflect.set(object, key, value)
    },
    deleteProperty(object, key) {
      log.push(`delete:${at(key)}`)
      return Reflect.deleteProperty(object, key)
    },
    has(object, key) {
      log.push(`has:${at(key)}`)
      return Reflect.has(object, key)
    },
    ownKeys(object) {
      log.push(`keys:${path.join('/')}`)
      return Reflect.ownKeys(object)
    },
    getOwnPropertyDescriptor(object, key) {
      log.push(`desc:${at(key)}`)
      return Reflect.getOwnPropertyDescriptor(object, key)
    }
  })
}

/** 记录里落在 `prefix` 这条路径（含）之下的访问 */
export function touchedUnder(log: readonly string[], prefix: string): string[] {
  return log.filter((line) => {
    const path = line.slice(line.indexOf(':') + 1)
    return path === prefix || path.startsWith(`${prefix}/`)
  })
}

// ─────────────────────────── 操作流 ───────────────────────────

export interface RevisionLog {
  /** 每次修订的操作（一次 `change` 没产生操作就没有修订） */
  readonly revisions: (readonly Op[])[]
  stop(): void
}

/** 精确操作流：一次性的 `RemoteServiceProvider` 订阅（公共 subscribe 会合并修订） */
export function revisionsOf<V extends object>(state: MutableReplicatedState<V>): RevisionLog {
  const service = (defineService as (id: string) => Service<{ view: ReplicatedState<V> }>)('t')
  const provider = new RemoteServiceProvider([{ id: 't' }])
  provider.provide(service, { view: state as ReplicatedState<V> } as never)
  const revisions: (readonly Op[])[] = []
  const subscription = provider.subscribe('t', 'singleton', (update) => {
    if (update.type === 'state') revisions.push(update.ops)
  })
  subscription.activate()
  return {
    revisions,
    stop: () => {
      void subscription.close()
      provider.dispose()
    }
  }
}
