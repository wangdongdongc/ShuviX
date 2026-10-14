/**
 * 复制状态的精确操作流（测试用，`projectorSupport.opsOf` 与 `sharingSupport.revisionsOf` 共用）。
 *
 * chord 1.2 删掉了服务提供方（`RemoteServiceProvider`）—— 以前拿精确操作流的唯一通道；`ReplicatedState`
 * 的 `subscribe` 只交值（排队溢出时还会合并），可变状态内部 tracker 算出的操作不再交给任何人。这里在状态实例
 * 上拦下 `change` / `replace`：真状态先写（它抛错就什么都不记，错误照常抛给调用方），再把同一个 mutate
 * （`replace` 则是同一个值的拷贝）在一个影子 tracker 上重放一遍，记下它准备出的操作。影子用的是 chord 自己
 * 的 `track`（可变复制状态内部就是它），起点是挂上那一刻的值，所以记下的就是真状态那次修订产生的操作。
 * 每次之后核对影子与真状态深相等，不等记成分歧（`problems`）；没有操作的写不算修订（真状态也不发布）。
 *
 * 重放期间 `inShadowReplay()` 为真：mutate 里有副作用的测试辅助（`recordingDraft` 的访问记录）据此不记
 * 第二遍。同一个状态上可以挂多个记录器（共用一个影子）；最后一个摘掉时恢复原方法。
 */
import { isDeepStrictEqual } from 'node:util'
import type { Context, MutableReplicatedState } from '@earendil-works/chord'
import { track, type Draft, type Op, type Tracker } from '@earendil-works/chord/delta'

export interface StateRevision<V> {
  /** 挂上影子以来的修订序号（快照是挂上那一刻的序号） */
  readonly sequence: number
  readonly ops: readonly Op[]
  /** 这次修订之后状态的值（在 `change` / `replace` 里同步记下） */
  readonly value: V
}

export interface OpTap<V> {
  /** 挂上那一刻状态的值 */
  readonly snapshot: { readonly sequence: number; readonly value: V }
  /** 影子与真状态的分歧（每条一句话）；正常为空 */
  readonly problems: readonly string[]
  stop(): void
}

type Listener = (revision: StateRevision<object>) => void

interface Shadow {
  tracker: Tracker<object>
  sequence: number
  readonly listeners: Set<Listener>
  readonly problems: string[]
  restore(): void
}

const shadows = new WeakMap<object, Shadow>()
let replaying = 0

/** 正在影子上重放 mutate（有副作用的测试辅助据此跳过第二遍） */
export function inShadowReplay(): boolean {
  return replaying > 0
}

const copy = <T>(value: T): T => structuredClone(value)

function attachShadow<V extends object>(state: MutableReplicatedState<V>): Shadow {
  const target = state as unknown as {
    change: (context: Context, mutate: (draft: Draft<V>) => void) => void
    replace: (context: Context, value: V) => void
  }
  const realChange = state.change.bind(state)
  const realReplace = state.replace.bind(state)
  const shadow: Shadow = {
    tracker: track(copy(state.value)),
    sequence: 0,
    listeners: new Set(),
    problems: [],
    restore: () => {
      delete (target as { change?: unknown }).change
      delete (target as { replace?: unknown }).replace
    }
  }

  const publish = (ops: readonly Op[], what: string): void => {
    if (!isDeepStrictEqual(shadow.tracker.value, state.value)) {
      shadow.problems.push(`${what}: the shadow tracker diverged from the state`)
      shadow.tracker = track(copy(state.value))
      return
    }
    if (ops.length === 0) return
    shadow.sequence++
    const revision = { sequence: shadow.sequence, ops, value: state.value }
    for (const listener of [...shadow.listeners]) listener(revision)
  }

  target.change = (context, mutate) => {
    realChange(context, mutate)
    const change = shadow.tracker.beginChange()
    let ops: readonly Op[]
    replaying++
    try {
      mutate(change.state as Draft<V>)
      const prepared = change.prepare()
      shadow.tracker.adopt(prepared)
      ops = prepared.ops
    } catch (error) {
      change.abort()
      shadow.problems.push(`change: replaying on the shadow tracker threw: ${String(error)}`)
      shadow.tracker = track(copy(state.value))
      return
    } finally {
      replaying--
    }
    publish(ops, 'change')
  }
  target.replace = (context, value) => {
    realReplace(context, value)
    const prepared = shadow.tracker.prepareReplace(copy(value))
    shadow.tracker.adopt(prepared)
    publish(prepared.ops, 'replace')
  }
  return shadow
}

/** 挂一个操作流记录器：此后每次产生操作的 `change` / `replace` 都同步交给 `listener` */
export function tapOps<V extends object>(
  state: MutableReplicatedState<V>,
  listener: (revision: StateRevision<V>) => void
): OpTap<V> {
  let shadow = shadows.get(state)
  if (shadow === undefined) {
    shadow = attachShadow(state)
    shadows.set(state, shadow)
  }
  const own = shadow
  const wrapped = listener as unknown as Listener
  own.listeners.add(wrapped)
  let stopped = false
  return {
    snapshot: { sequence: own.sequence, value: state.value },
    problems: own.problems,
    stop: () => {
      if (stopped) return
      stopped = true
      own.listeners.delete(wrapped)
      if (own.listeners.size === 0 && shadows.get(state) === own) {
        own.restore()
        shadows.delete(state)
      }
    }
  }
}
