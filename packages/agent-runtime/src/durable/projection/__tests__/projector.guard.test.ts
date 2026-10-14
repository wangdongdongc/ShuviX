/**
 * 投影状态订阅的守卫（`ProjectorCore.guardSubscribers`，pi 1.2）—— chord 1.2 起可变复制状态不再把监听器的错误抛给
 * 写入方，而是在微任务里重抛（没人接 = 主进程的未捕获异常）。投影在源头换掉自己状态的 `subscribe`：同步抛错、
 * 返回被拒绝的 Promise 都只记一条日志。编号对着测试设计的用例清单第 4 节：
 *
 *   PG-1 订阅方的异步监听器每次更新都返回被拒绝的 Promise → 每次拒绝恰好记一条「projector listener failed」，
 *        没有未处理的拒绝 / 未捕获的异常，别的订阅方照样拿到每个修订，提交照常成功
 *   PG-2 一个同步抛错的订阅方 → 排在它**后面**登记的订阅方照样按序拿到每个修订（日志本身由 P3-03-52 覆盖）
 *   PG-3 身份：两次 acquire 同一个状态对象、同一个 `subscribe`（自有属性，不是原型上的那个）；守卫过的
 *        `subscribe` 交回的退订函数确实停止投递；换挂载（`["r"]`）之后守卫还在（同一个函数、同一个对象，照样兜住）
 *   PG-4 PG-1 / PG-2 在 AgentProjector 上同样成立（两者都走 ProjectorCore）
 *   PG-5 守卫过的监听器拿到的 `(value, context, delivery)` 与原型上未守卫的订阅一模一样（hydrate / update）
 *
 * 「没有未处理的错误」两头都看：vitest 自己遇到未处理的拒绝 / 未捕获异常会让这次运行失败；用例里另外在
 * process 上挂监听器记下来、断言为空，失败时能看到是哪一条。
 */
import type { MutableReplicatedState, ReplicatedStateDelivery } from '@earendil-works/chord'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { AgentView } from '@shuvix/chat-protocol/types/sessionView'
import { afterEach, describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { noticeEntryDraft, SessionStateDoc } from '../../docs'
import type { DurableSession } from '../../durableSession'
import { answer } from '../../__tests__/support/faux'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost
} from '../../__tests__/support/host'
import { allEntries } from '../../__tests__/support/transcript'
import { hookRec, hostD, seedAgent } from '../../__tests__/support/spawn'
import { waitFor } from '../../__tests__/support/wait'
import { opsOf, settleFrames, throwingSubscriber } from './projectorSupport'

registerHostCleanup()

const TIMEOUT = 20000

// ─── 未处理的错误 ──────────────────────────────────────

let stopUnhandled: (() => void) | undefined

afterEach(() => {
  stopUnhandled?.()
  stopUnhandled = undefined
})

/** process 上的 `unhandledRejection` / `uncaughtException`（用例结束时摘掉） */
function recordUnhandled(): unknown[] {
  const errors: unknown[] = []
  const onError = (error: unknown): void => {
    errors.push(error)
  }
  process.on('unhandledRejection', onError)
  process.on('uncaughtException', onError)
  stopUnhandled = () => {
    process.off('unhandledRejection', onError)
    process.off('uncaughtException', onError)
  }
  return errors
}

// ─── 订阅方 ────────────────────────────────────────────

interface Delivered<V> {
  readonly kind: ReplicatedStateDelivery['kind']
  readonly sequence: number
  readonly value: V
}

/** 记下每次投递（种类、序号、值） */
function recorder<V extends object>(
  state: MutableReplicatedState<V>
): { readonly got: Delivered<V>[]; readonly updates: () => Delivered<V>[]; stop(): void } {
  const got: Delivered<V>[] = []
  const stop = state.subscribe((value, _context, delivery) => {
    got.push({ kind: delivery.kind, sequence: delivery.sequence, value })
  })
  return { got, updates: () => got.filter((entry) => entry.kind === 'update'), stop }
}

/** 一个异步监听器：每次更新都返回被拒绝的 Promise（第 n 次的错误是 `async boom #n`） */
function rejectingSubscriber<V extends object>(
  state: MutableReplicatedState<V>
): { readonly count: () => number; stop(): void } {
  let count = 0
  const stop = state.subscribe((_value, _context, delivery) => {
    if (delivery.kind !== 'update') return undefined
    count++
    return Promise.reject(new Error(`async boom #${count}`))
  })
  return { count: () => count, stop }
}

/** 每次更新恰好一份、按序：hydrate 之后的序号连续递增，最后一个值就是状态此刻的值 */
function expectEveryRevisionInOrder<V extends object>(
  got: readonly Delivered<V>[],
  state: MutableReplicatedState<V>
): void {
  expect(got[0]?.kind).toBe('hydrate')
  const hydrated = got[0]!.sequence
  const updates = got.slice(1)
  expect(updates.every((entry) => entry.kind === 'update')).toBe(true)
  expect(updates.map((entry) => entry.sequence)).toEqual(
    updates.map((_entry, index) => hydrated + index + 1)
  )
  expect(updates.at(-1)?.value).toBe(state.value)
}

function listenerFailures(t: TestHost, marker: string): string[] {
  return t.warnings.filter(
    (warning) => warning.includes('projector listener failed') && warning.includes(marker)
  )
}

// ─── 修订的来源 ────────────────────────────────────────

/** 在某个对话上追加一条后台通知（一个提交 → 投影的一个修订） */
async function notice(
  session: DurableSession,
  conversationId: ConversationId,
  text: string
): Promise<void> {
  await session.harness.commit(async (tx) => {
    await tx.appendEntry(conversationId, noticeEntryDraft({ text, kind: 'background' }, 0))
  }, BG)
}

async function rootSession(): Promise<{ t: TestHost; session: DurableSession }> {
  const t = await makeHost({ ephemeral: ['s1'] })
  const session = await t.open('s1')
  await primeRoot(session)
  return { t, session }
}

/** 一个派生 agent（hook agent，只读可看）的投影 + 它的对话 */
async function agentProjectorRig(): Promise<{
  t: TestHost
  session: DurableSession
  conversationId: ConversationId
  state: MutableReplicatedState<AgentView>
  release(): void
}> {
  const d = await hostD()
  const seeded = await seedAgent(d.session, { record: hookRec(), settle: true })
  const agent = await d.session.agentProjector('sub-h1')
  expect(agent).toBeDefined()
  const handle = agent!.acquire()
  return {
    t: d.t,
    session: d.session,
    conversationId: seeded.conversationId,
    state: handle.state,
    release: () => handle.release()
  }
}

describe('PG · projector listener guard', () => {
  it(
    'PG-1 an async listener rejecting on every update: each rejection logged once, nothing unhandled, other subscribers get every revision, commits succeed',
    async () => {
      const unhandled = recordUnhandled()
      const { t, session } = await rootSession()
      const proj = await session.projector()
      const h = proj.acquire()
      const before = recorder(h.state)
      const bad = rejectingSubscriber(h.state)
      const after = recorder(h.state)
      t.kit.queue(answer('one'), answer('two'))
      expect(await session.submitUser('u1')).toEqual({})
      expect(await session.submitUser('u2')).toEqual({})
      await waitFor(() => session.runState === 'idle', 3000, 'idle')
      await settleFrames()

      expect(h.state.value.messages.map((m) => m.content)).toEqual(['u1', 'one', 'u2', 'two'])
      expect(h.state.value.run).toStrictEqual({ state: 'idle' })
      expectEveryRevisionInOrder(before.got, h.state)
      expectEveryRevisionInOrder(after.got, h.state)
      // 坏订阅方也拿到了每一个修订（它的投递排在自己的 Promise 后面，照样接着走）
      expect(bad.count()).toBe(after.updates().length)
      expect(bad.count()).toBeGreaterThan(1)
      // 每次拒绝恰好一条日志
      for (let n = 1; n <= bad.count(); n++) {
        expect(listenerFailures(t, `async boom #${n}`), `rejection #${n}`).toHaveLength(1)
      }
      expect(listenerFailures(t, 'async boom #')).toHaveLength(bad.count())
      expect(unhandled).toEqual([])

      // 之后的提交照常（坏订阅方还挂着）
      await notice(session, 1 as ConversationId, 'later')
      await settleFrames()
      expect(h.state.value.messages.at(-1)?.content).toContain('later')
      expect(bad.count()).toBe(after.updates().length)
      expect(listenerFailures(t, 'async boom #')).toHaveLength(bad.count())
      expect(unhandled).toEqual([])
      before.stop()
      bad.stop()
      after.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'PG-2 a synchronously throwing subscriber: a subscriber registered after it still gets every revision, in order',
    async () => {
      const unhandled = recordUnhandled()
      const { t, session } = await rootSession()
      const proj = await session.projector()
      const h = proj.acquire()
      const stopThrowing = throwingSubscriber(h.state)
      const after = recorder(h.state)
      t.kit.queue(answer('one'), answer('two'))
      expect(await session.submitUser('u1')).toEqual({})
      expect(await session.submitUser('u2')).toEqual({})
      await notice(session, 1 as ConversationId, 'n1')
      await waitFor(() => session.runState === 'idle', 3000, 'idle')
      await settleFrames()

      expectEveryRevisionInOrder(after.got, h.state)
      expect(after.updates().length).toBeGreaterThan(2)
      expect(h.state.value.messages.slice(0, 4).map((m) => m.content)).toEqual([
        'u1',
        'one',
        'u2',
        'two'
      ])
      expect(listenerFailures(t, 'downstream boom')).toHaveLength(after.updates().length)
      expect(unhandled).toEqual([])
      stopThrowing()
      after.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'PG-3 identity: one state and one guarded subscribe for every handle; its unsubscribe stops deliveries; the guard survives a remount',
    async () => {
      const unhandled = recordUnhandled()
      const { t, session } = await rootSession()
      t.kit.queue(answer('A1'), answer('A2'))
      expect(await session.submitUser('U1')).toEqual({})
      expect(await session.submitUser('U2')).toEqual({})
      const proj = await session.projector()
      const h1 = proj.acquire()
      const h2 = proj.acquire()
      expect(h1.state).toBe(h2.state)
      expect(h1.state.subscribe).toBe(h2.state.subscribe)
      // 守卫装在状态自己身上（自有属性），不是原型上的那个
      const guarded = h1.state.subscribe
      const prototypeSubscribe = (Object.getPrototypeOf(h1.state) as { subscribe: unknown })
        .subscribe
      expect(Object.prototype.hasOwnProperty.call(h1.state, 'subscribe')).toBe(true)
      expect(guarded).not.toBe(prototypeSubscribe)

      // 退订停止投递（对照的订阅方照样收到）
      const control = recorder(h1.state)
      const leaving = recorder(h1.state)
      await notice(session, 1 as ConversationId, 'first')
      await settleFrames()
      expect(leaving.updates()).toHaveLength(1)
      leaving.stop()
      await notice(session, 1 as ConversationId, 'second')
      await settleFrames()
      expect(control.updates()).toHaveLength(2)
      expect(leaving.updates()).toHaveLength(1)

      // 换挂载：fork + 指针 → 一条 `["r"]`；守卫还是同一个函数，照样兜住抛错的订阅方
      const throwingBefore = throwingSubscriber(h1.state)
      const ops = opsOf(h1.state)
      const entries = await allEntries(await session.currentConversation())
      const forkId = await session.harness.commit(async (tx) => {
        const fork = await tx.forkConversation(1 as ConversationId, entries[1]!.id as never, {
          ownership: { kind: 'ownerless' }
        })
        ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
        return fork.id
      }, BG)
      await waitFor(() => h1.state.value.conversationId === forkId, 3000, 'remounted')
      await settleFrames()
      expect(ops.revisions.some((revision) => revision.ops.some((op) => op[0] === 'r'))).toBe(true)
      expect(h1.state.subscribe).toBe(guarded)
      expect(h2.state).toBe(h1.state)
      const h3 = (await session.projector()).acquire()
      expect(h3.state).toBe(h1.state)
      h3.release()
      const failuresAtRemount = listenerFailures(t, 'downstream boom').length
      expect(failuresAtRemount).toBeGreaterThan(0)

      const throwingAfter = throwingSubscriber(h1.state)
      const afterRemount = recorder(h1.state)
      await notice(session, forkId, 'on the fork')
      await settleFrames()
      expect(afterRemount.updates()).toHaveLength(1)
      expect(afterRemount.updates()[0]!.value.messages.at(-1)?.content).toContain('on the fork')
      // 两个抛错的订阅方各记一条
      expect(listenerFailures(t, 'downstream boom')).toHaveLength(failuresAtRemount + 2)
      expect(unhandled).toEqual([])

      ops.stop()
      throwingBefore()
      throwingAfter()
      control.stop()
      afterRemount.stop()
      h1.release()
      h2.release()
    },
    TIMEOUT
  )

  it(
    'PG-4 the same holds on an AgentProjector: rejecting / throwing subscribers are logged, later subscribers get every revision',
    async () => {
      const unhandled = recordUnhandled()
      const agent = await agentProjectorRig()
      const { t, session, conversationId, state } = agent
      expect(Object.prototype.hasOwnProperty.call(state, 'subscribe')).toBe(true)
      const bad = rejectingSubscriber(state)
      const stopThrowing = throwingSubscriber(state)
      const after = recorder(state)
      for (const text of ['a1', 'a2', 'a3']) await notice(session, conversationId, text)
      await settleFrames()

      expectEveryRevisionInOrder(after.got, state)
      expect(after.updates()).toHaveLength(3)
      expect(state.value.messages.map((m) => m.content)).toEqual([
        expect.stringContaining('a1'),
        expect.stringContaining('a2'),
        expect.stringContaining('a3')
      ])
      expect(bad.count()).toBe(3)
      for (let n = 1; n <= 3; n++) {
        expect(listenerFailures(t, `async boom #${n}`), `rejection #${n}`).toHaveLength(1)
      }
      expect(listenerFailures(t, 'downstream boom')).toHaveLength(3)
      expect(unhandled).toEqual([])
      bad.stop()
      stopThrowing()
      after.stop()
      agent.release()
    },
    TIMEOUT
  )

  it(
    'PG-5 the guarded listener gets (value, context, delivery) exactly as an unguarded one does (hydrate and update)',
    async () => {
      const { session } = await rootSession()
      const proj = await session.projector()
      const h = proj.acquire()
      type Call = unknown[]
      const raw: Call[] = []
      const guarded: Call[] = []
      const prototypeSubscribe = (
        Object.getPrototypeOf(h.state) as { subscribe: typeof h.state.subscribe }
      ).subscribe
      const stopRaw = prototypeSubscribe.call(h.state, (...args: unknown[]) => {
        raw.push(args)
      })
      const stopGuarded = h.state.subscribe((...args: unknown[]) => {
        guarded.push(args)
      })
      await notice(session, 1 as ConversationId, 'one')
      await notice(session, 1 as ConversationId, 'two')
      await settleFrames()

      expect(guarded).toHaveLength(raw.length)
      expect(guarded.length).toBe(3)
      for (const [index, args] of guarded.entries()) {
        const [value, context, delivery] = args as [unknown, unknown, ReplicatedStateDelivery]
        const [rawValue, rawContext, rawDelivery] = raw[index] as [
          unknown,
          unknown,
          ReplicatedStateDelivery
        ]
        expect(args, `call ${index}`).toHaveLength(3)
        expect(value, `value ${index}`).toBe(rawValue)
        expect(context, `context ${index}`).toBe(rawContext)
        expect(delivery, `delivery ${index}`).toEqual(rawDelivery)
        expect(delivery.kind).toBe(index === 0 ? 'hydrate' : 'update')
      }
      // 更新的投递对象是同一个（chord 每次发布建一份，交给每个订阅方）
      expect(guarded[1]![2]).toBe(raw[1]![2])
      expect(guarded.at(-1)![0]).toBe(h.state.value)
      expect(guarded[0]![1]).toBe(BG)
      stopRaw()
      stopGuarded()
      h.release()
    },
    TIMEOUT
  )
})
