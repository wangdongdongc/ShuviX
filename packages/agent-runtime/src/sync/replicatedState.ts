/**
 * Lightweight in-process replicated state backed by `@earendil-works/chord/delta`'s transactional JSON tracker.
 *
 * Replaces the `replicatedState()` / `ReplicatedState` / `MutableReplicatedState` helper removed in Chord v2 (1.6.1),
 * preserving exact immutable-ownership, draft-change, whole-replace, and subscriber-notification semantics for
 * `SessionProjector`, `AgentProjector`, `viewServer`, and tests.
 */
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { track, type Draft, type Op, type Tracker } from '@earendil-works/chord/delta'

/** Metadata for a single state delivery to subscribers. */
export interface ReplicatedStateDelivery {
  readonly kind: 'hydrate' | 'update'
  readonly sequence: number
  readonly ops: readonly Op[]
}

export type ReplicatedStateListener<T> = (
  value: T,
  context: Context,
  delivery: ReplicatedStateDelivery
) => unknown

/** Read-only view of a replicated JSON state. */
export interface ReplicatedState<T> {
  readonly value: T
  subscribe(listener: ReplicatedStateListener<T>): () => void
}

/** Mutable replicated JSON state owned by a single writer (e.g. a projector). */
export interface MutableReplicatedState<T extends object> extends ReplicatedState<T> {
  change(context: Context, mutate: (draft: Draft<T>) => void): void
  replace(context: Context, value: T): void
}

class MutableReplicatedStateImpl<T extends object> implements MutableReplicatedState<T> {
  readonly #tracker: Tracker<T>
  readonly #listeners = new Set<ReplicatedStateListener<T>>()
  #sequence = 0

  constructor(initial: T) {
    this.#tracker = track(initial)
  }

  get value(): T {
    return this.#tracker.value
  }

  subscribe(listener: ReplicatedStateListener<T>): () => void {
    const entry: ReplicatedStateListener<T> = (value, context, delivery) =>
      listener(value, context, delivery)
    this.#listeners.add(entry)
    let active = true
    const unsubscribe = (): void => {
      if (!active) return
      active = false
      this.#listeners.delete(entry)
    }
    this.#deliverOne(entry, this.#tracker.value, BACKGROUND_CONTEXT, {
      kind: 'hydrate',
      sequence: this.#sequence,
      ops: []
    })
    return unsubscribe
  }

  change(context: Context, mutate: (draft: Draft<T>) => void): void {
    const change = this.#tracker.beginChange()
    let prepared: ReturnType<typeof change.prepare>
    try {
      mutate(change.state)
      prepared = change.prepare()
    } catch (error) {
      change.abort()
      throw error
    }
    if (prepared.ops.length === 0) {
      prepared.abort()
      return
    }
    this.#tracker.adopt(prepared)
    this.#notify(prepared.value, context, {
      kind: 'update',
      sequence: ++this.#sequence,
      ops: prepared.ops
    })
  }

  replace(context: Context, value: T): void {
    const prepared = this.#tracker.prepareReplace(value)
    this.#tracker.adopt(prepared)
    this.#notify(prepared.value, context, {
      kind: 'update',
      sequence: ++this.#sequence,
      ops: prepared.ops
    })
  }

  #notify(value: T, context: Context, delivery: ReplicatedStateDelivery): void {
    for (const listener of [...this.#listeners]) {
      this.#deliverOne(listener, value, context, delivery)
    }
  }

  #deliverOne(
    listener: ReplicatedStateListener<T>,
    value: T,
    context: Context,
    delivery: ReplicatedStateDelivery
  ): void {
    try {
      const result = listener(value, context, delivery)
      if (result instanceof Promise) {
        void result.catch((error: unknown) => {
          queueMicrotask(() => {
            throw error
          })
        })
      }
    } catch (error) {
      queueMicrotask(() => {
        throw error
      })
    }
  }
}

/** Creates a mutable replicated JSON state taking ownership of `initial`. */
export function replicatedState<T extends object>(initial: T): MutableReplicatedState<T> {
  return new MutableReplicatedStateImpl(initial)
}
