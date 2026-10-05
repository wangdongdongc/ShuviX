/**
 * P3-03 · 身份性质（设计稿 P3-03-53..55；PIN-10 修订版）—— 录下来的 faux 场景 S1–S14，加 200 个种子的
 * 随机步骤：
 *
 *   53 每一帧之后纯投影（独立的 watch + `resolveDisplayItems` + 独立的排队侧车查询）= 投影的状态；每个静止点
 *      = freshMount；最后 reopenMount = 它（询问随进程消失，不比）
 *   54 操作流完整且最小：从订阅快照起 applyImmutable 逐条重放 = 每一次修订的值；`r` 只在换挂载时出现；
 *      `["live"]` 上的 `s` 只在实时卡出现 / 清空时，`["messages"]` 上从没有 `s`；纯流式的修订只有 `a` / `t`
 *   55 每一份修订都是严格 JSON、JSON 往返深相等
 *
 * 失败时用例名里带着种子。随机步骤每一步都把会话带回静止（空闲、队列空）。
 */
import type { Op } from '@earendil-works/chord/delta'
import type { SubmissionId } from '@earendil-works/pi-durable'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { SessionStateDoc } from '../../docs'
import type { DurableSession } from '../../durableSession'
import {
  answer,
  callTool,
  callTools,
  fauxKit,
  held,
  modelError,
  stalled
} from '../../__tests__/support/faux'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost,
  type TestHostOptions
} from '../../__tests__/support/host'
import { allEntries } from '../../__tests__/support/transcript'
import { waitFor, withTimeout } from '../../__tests__/support/wait'
import {
  attachOracle,
  expectJsonRevisions,
  freshMount,
  opsOf,
  readTool,
  reopenMount,
  settleFrames,
  spillTool,
  streamTool,
  withoutAsks,
  type OpsRecorder
} from './projectorSupport'

registerHostCleanup()

const TIMEOUT = 30000
const SID = 's1'

type Tokens = Record<string, { type: string; id: string; displayText: string; payload: string }>
const display = (n: number): { content: string; tokens: Tokens } => ({
  content: `d${n} {{shuvixInlineToken:k${n}}}`,
  tokens: { [`k${n}`]: { type: 'cmd', id: `c${n}`, displayText: `/c${n}`, payload: `P${n}` } }
})
const ask = (id: string): InputRequest =>
  ({
    id,
    kind: 'ask',
    toolName: 'ask',
    question: `${id}?`,
    createdAt: 0
  }) as unknown as InputRequest

// ─────────────────────────── 场景框架 ───────────────────────────

interface Ctx {
  t: TestHost
  session: DurableSession
  /** 静止点：= freshMount */
  quiescent(): Promise<void>
}

interface Rig extends Ctx {
  view(): SessionView
  ops: OpsRecorder<SessionView>
  finish(options: { reopen: boolean }): Promise<void>
}

const FAST_RETRY: TestHostOptions['settingsOverrides'] = {
  retry: { enabled: true, baseDelayMs: 5, maxRetries: 2 },
  compaction: { enabled: false, keepRecentTokens: 200 }
}

async function rig(options: TestHostOptions & { memory?: boolean } = {}): Promise<Rig> {
  const { memory, ...hostOptions } = options
  const t = await makeHost({
    tools: [readTool(), spillTool(), streamTool(['x\n', 'y\n'], 60)],
    ...(memory === true ? { ephemeral: [SID] } : {}),
    ...hostOptions
  })
  const session = await t.open(SID)
  await primeRoot(session)
  return attach(t, session)
}

async function attach(t: TestHost, session: DurableSession): Promise<Rig> {
  const proj = await session.projector()
  const h = proj.acquire()
  const oracle = await attachOracle(session, h.state)
  const ops = opsOf(h.state)
  const quiescent = async (): Promise<void> => {
    await waitFor(() => session.runState !== 'busy', 8000, 'quiescent')
    await settleFrames()
    expect(h.state.value, 'quiescent = freshMount').toStrictEqual(await freshMount(session))
  }
  return {
    t,
    session,
    ops,
    view: () => h.state.value,
    quiescent,
    finish: async ({ reopen }) => {
      await quiescent()
      expect(await oracle.verify()).toBeGreaterThan(0)
      checkOps(ops)
      expectJsonRevisions(ops)
      const value = h.state.value
      await oracle.stop()
      ops.stop()
      h.release()
      if (reopen) {
        const { view } = await reopenMount(t, SID)
        expect(view, 'reopenMount').toStrictEqual(withoutAsks(value))
      }
    }
  }
}

/** P3-03-54 的操作形状 */
function checkOps(ops: OpsRecorder<SessionView>): void {
  ops.replay()
  let previous = ops.snapshot.value
  for (const [index, revision] of ops.revisions.entries()) {
    const next = revision.value
    const remount = previous.conversationId !== next.conversationId
    for (const op of revision.ops) {
      if (op[0] === 'r') expect(remount, `r only on a remount (revision ${index})`).toBe(true)
      if (op[0] === 's' && pathIs(op, ['messages'])) {
        throw new Error(`s at ["messages"] in revision ${index}`)
      }
      if (op[0] === 's' && pathIs(op, ['live'])) {
        const start = previous.live === null && op[2] !== null
        const clear = op[2] === null
        expect(start || clear, `s at ["live"] only on start / clear (revision ${index})`).toBe(true)
      }
    }
    if (!remount && streamingOnly(previous, next)) {
      for (const op of revision.ops) {
        expect(['a', 't'], `streaming-only revision ${index}`).toContain(op[0])
      }
    }
    previous = next
  }
}

function pathIs(op: Op, path: readonly (string | number)[]): boolean {
  if (op[0] === 'r') return false
  const actual = op[1] as readonly (string | number)[]
  return actual.length === path.length && actual.every((s, i) => s === path[i])
}

/** 只有实时卡的文字在长：同一张卡、同样的块（种类与工具参数都不变），其余一切不变 */
function streamingOnly(previous: SessionView, next: SessionView): boolean {
  const a = previous.live
  const b = next.live
  if (a === null || b === null || a.id !== b.id) return false
  if (a.message.blocks.length !== b.message.blocks.length) return false
  for (const [i, block] of a.message.blocks.entries()) {
    const other = b.message.blocks[i]!
    if (block.type !== other.type) return false
    if (block.type === 'tool' && JSON.stringify(block) !== JSON.stringify(other)) return false
  }
  if (JSON.stringify(a.argsText ?? null) !== JSON.stringify(b.argsText ?? null)) return false
  if (JSON.stringify(a.message.metadata) !== JSON.stringify(b.message.metadata)) return false
  const rest = (view: SessionView): string => JSON.stringify({ ...view, live: null })
  return rest(previous) === rest(next)
}

async function idleAndDrained(session: DurableSession, view: () => SessionView): Promise<void> {
  await waitFor(
    () => session.runState !== 'busy' && view().queue.length === 0,
    8000,
    'idle and drained'
  )
}

// ─────────────────────────── 录下来的场景 S1–S14 ───────────────────────────

describe('P3-03-53/54/55 · identity over the recorded faux scenarios', () => {
  const corpus: [string, TestHostOptions, (r: Rig) => Promise<void>, boolean?][] = [
    [
      'S1 plain answer (streamed token by token)',
      { kit: fauxKit({ tokensPerSecond: 80 }) },
      async (r) => {
        r.t.kit.queue(answer(`a1 ${'streamed '.repeat(40)}`))
        expect(await r.session.submitUser('u1')).toEqual({})
        const streaming = r.ops.revisions.filter((rev, i) =>
          streamingOnly(i === 0 ? r.ops.snapshot.value : r.ops.revisions[i - 1]!.value, rev.value)
        )
        expect(streaming.length).toBeGreaterThan(1)
      }
    ],
    [
      'S2 two tool rounds',
      {},
      async (r) => {
        r.t.kit.queue(
          callTool('bash', {}, 'c1'),
          callTool('read', { path: 'p' }, 'c2'),
          answer('a')
        )
        expect(await r.session.submitUser('u')).toEqual({})
      }
    ],
    [
      'S3 parallel tools',
      {},
      async (r) => {
        r.t.kit.queue(
          callTools([
            ['read', { path: 'a' }, 'c1'],
            ['dump', {}, 'c2']
          ]),
          answer('a')
        )
        expect(await r.session.submitUser('u')).toEqual({})
      }
    ],
    [
      'S4 retry then success',
      { settingsOverrides: FAST_RETRY },
      async (r) => {
        r.t.kit.queue(modelError('503 once'), answer('a'))
        expect(await r.session.submitUser('u')).toEqual({})
      }
    ],
    [
      'S5 final failure',
      { settingsOverrides: FAST_RETRY },
      async (r) => {
        r.t.kit.queue(modelError('503 a'), modelError('503 b'), modelError('503 c'))
        expect((await r.session.submitUser('u')).code).toBe('model_error')
      }
    ],
    [
      'S6 abort while streaming',
      {},
      async (r) => {
        const stall = stalled()
        r.t.kit.queue(stall.step)
        const sending = r.session.submitUser('u')
        await withTimeout(stall.reached, 5000, 'stalled')
        await r.session.abort()
        await sending
      }
    ],
    [
      'S7 abort during the backoff',
      {
        settingsOverrides: {
          retry: { enabled: true, baseDelayMs: 2000 },
          compaction: { enabled: false }
        }
      },
      async (r) => {
        r.t.kit.queue(modelError('503 x'))
        const sending = r.session.submitUser('u')
        await waitFor(() => r.view().run.retry !== undefined, 5000, 'backoff')
        await r.session.abort()
        await sending
      }
    ],
    [
      'S8 compaction, then a run',
      { settingsOverrides: FAST_RETRY },
      async (r) => {
        r.t.kit.queue(answer('a1'), answer('a2'))
        expect(await r.session.submitUser('u1')).toEqual({})
        expect(await r.session.submitUser(`u2 ${'details '.repeat(150)}`)).toEqual({})
        await r.quiescent()
        r.t.kit.queue(answer('SUMMARY'))
        const conversation = await r.session.currentConversation()
        await r.session.harness.waitForTask(await conversation.compact(undefined, BG), BG)
        await r.quiescent()
        r.t.kit.queue(answer('a3'))
        expect(await r.session.submitUser('u3')).toEqual({})
      }
    ],
    [
      'S9 queued followUp and steer',
      {},
      async (r) => {
        const run = held(answer('a1'))
        r.t.kit.queue(run.step, answer('a2'), answer('a3'))
        const sending = r.session.submitUser('go')
        await withTimeout(run.reached, 5000, 'held')
        await r.session.followUp('F')
        await r.session.steer('S')
        run.release()
        await sending
        await idleAndDrained(r.session, r.view)
      }
    ],
    [
      'S10 inline-token sends (idle and queued)',
      {},
      async (r) => {
        r.t.kit.queue(answer('a1'))
        expect(await r.session.submitUser('P1 expanded', { display: display(1) })).toEqual({})
        const run = held(answer('a2'))
        r.t.kit.queue(run.step, answer('a3'))
        const sending = r.session.submitUser('go')
        await withTimeout(run.reached, 5000, 'held')
        const queued = r.session.submitUser('P2 expanded', {
          whenBusy: 'followUp',
          display: display(2)
        })
        await waitFor(() => r.view().queue.length === 1, 3000, 'queued')
        expect(r.view().queue[0]!.text).toBe('d2 /c2')
        run.release()
        await sending
        await queued
        await idleAndDrained(r.session, r.view)
      }
    ],
    [
      'S11 notice write and a notice steered into a busy run',
      { noticeCoalesceMs: 10 },
      async (r) => {
        expect((await r.session.writeNotice({ text: 'written', kind: 'background' })).status).toBe(
          'submitted'
        )
        const run = held(answer('a1'))
        r.t.kit.queue(run.step, answer('a2'))
        const sending = r.session.submitUser('go')
        await withTimeout(run.reached, 5000, 'held')
        await r.session.notify('<background-task id="t1">done</background-task>')
        run.release()
        await sending
        await idleAndDrained(r.session, r.view)
      }
    ],
    [
      'S12 fork, then a send on the fork',
      {},
      async (r) => {
        r.t.kit.queue(answer('A1'), answer('A2'))
        expect(await r.session.submitUser('U1')).toEqual({})
        expect(await r.session.submitUser('U2')).toEqual({})
        await r.quiescent()
        const entries = await allEntries(await r.session.currentConversation())
        await forkAt(r.session, entries[1]!.id)
        await waitFor(() => r.view().conversationId !== 1, 3000, 'remounted')
        await r.session.destroyAgent()
        r.t.kit.queue(answer('A3'))
        expect(await r.session.submitUser('U3')).toEqual({})
      }
    ],
    [
      'S13 an ask pending, then answered',
      {},
      async (r) => {
        const pending = r.session.requestUserInput(ask('R1'))
        await r.quiescent()
        // 询问挂着时的帧也带着它
        r.t.kit.queue(answer('a1'))
        expect(await r.session.submitUser('u1')).toEqual({})
        await r.quiescent()
        r.session.respondToInput('R1', { kind: 'allow' } as never)
        await pending
      }
    ]
  ]

  for (const [name, options, scenario] of corpus) {
    it(
      name,
      async () => {
        const r = await rig(options)
        await scenario(r)
        await r.finish({ reopen: true })
      },
      TIMEOUT
    )
  }

  it(
    'S14 crash, reopen (a deferred notice), continue',
    async () => {
      const first = await makeHost({ tools: [readTool()] })
      const original = await first.open(SID)
      await primeRoot(original)
      const stall = stalled()
      first.kit.queue(stall.step)
      void original.submitUser('go')
      await withTimeout(stall.reached, 5000, 'stalled')
      const t = await first.restart()
      const session = await t.open(SID)
      expect(session.isInterrupted()).toBe(true)
      const r = await attach(t, session)
      expect((await session.writeNotice({ text: 'later', kind: 'background' })).status).toBe(
        'deferred'
      )
      await r.quiescent()
      t.kit.queue(answer('resumed'))
      expect(await withTimeout(session.continue(), 8000, 'continue')).toEqual({})
      await r.finish({ reopen: true })
    },
    TIMEOUT
  )
})

async function forkAt(session: DurableSession, at: number): Promise<number> {
  const current = (await session.currentConversation()).id
  return session.harness.commit(async (tx) => {
    const fork = await tx.forkConversation(current, at as never, {
      ownership: { kind: 'ownerless' }
    })
    ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
    return fork.id
  }, BG)
}

// ─────────────────────────── 随机步骤（200 个种子） ───────────────────────────

/** mulberry32 */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = a
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

const STEPS = [
  'send',
  'send+display',
  'followUp',
  'steer',
  'abort',
  'tool',
  'modelError',
  'notice',
  'ask',
  'withdraw',
  'fork'
] as const
type Step = (typeof STEPS)[number]

async function runStep(r: Rig, step: Step, n: number, random: () => number): Promise<void> {
  const { session, t } = r
  switch (step) {
    case 'send':
      t.kit.queue(answer(`a${n}`))
      expect(await session.submitUser(`u${n}`)).toEqual({})
      return
    case 'send+display':
      t.kit.queue(answer(`a${n}`))
      expect(await session.submitUser(`P${n} expanded`, { display: display(n) })).toEqual({})
      return
    case 'followUp':
    case 'steer': {
      const run = held(answer(`a${n}`))
      t.kit.queue(run.step, answer(`b${n}`))
      const sending = session.submitUser(`u${n}`)
      await withTimeout(run.reached, 5000, 'held')
      if (step === 'followUp') {
        if (random() < 0.5) await session.followUp(`f${n}`)
        else void session.submitUser(`P${n} q`, { whenBusy: 'followUp', display: display(n) })
      } else {
        await session.steer(`s${n}`)
      }
      await waitFor(() => r.view().queue.length === 1, 3000, 'queued')
      run.release()
      await sending
      await idleAndDrained(session, r.view)
      return
    }
    case 'abort': {
      const stall = stalled()
      t.kit.queue(stall.step)
      const sending = session.submitUser(`u${n}`)
      await withTimeout(stall.reached, 5000, 'stalled')
      await session.abort()
      await sending
      return
    }
    case 'tool':
      t.kit.queue(
        callTool(random() < 0.5 ? 'read' : 'dump', { path: `p${n}` }, `c${n}`),
        answer(`a${n}`)
      )
      expect(await session.submitUser(`u${n}`)).toEqual({})
      return
    case 'modelError':
      t.kit.queue(modelError(`400 bad ${n}`))
      expect((await session.submitUser(`u${n}`)).code).toBe('model_error')
      return
    case 'notice':
      expect((await session.writeNotice({ text: `notice ${n}`, kind: 'background' })).status).toBe(
        'submitted'
      )
      return
    case 'ask': {
      const pending = session.requestUserInput(ask(`R${n}`))
      await settleFrames(1)
      session.respondToInput(`R${n}`, { kind: 'allow' } as never)
      await pending
      return
    }
    case 'withdraw': {
      const stall = stalled()
      t.kit.queue(stall.step)
      const sending = session.submitUser(`u${n}`)
      await withTimeout(stall.reached, 5000, 'stalled')
      const { submissionId } = await session.followUp(`w${n}`)
      await waitFor(() => r.view().queue.length === 1, 3000, 'queued')
      const conversation = await session.currentConversation()
      await session.harness.abortSubmission(submissionId as SubmissionId, BG, conversation.id)
      await session.abort()
      await sending
      return
    }
    case 'fork': {
      const entries = (await allEntries(await session.currentConversation())).filter(
        (e) => e.kind === 'pi.assistant' || e.kind === 'pi.user'
      )
      if (entries.length === 0) return
      const at = entries[Math.floor(random() * entries.length)]!
      const before = r.view().conversationId
      await forkAt(session, at.id)
      await waitFor(() => r.view().conversationId !== before, 3000, 'remounted')
      await session.destroyAgent()
      return
    }
  }
}

describe('P3-03-53/54/55 · seeded fuzz (200 seeds)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const reopen = seed % 25 === 0
    it(
      `seed ${seed}`,
      async () => {
        const random = prng(seed)
        const count = 3 + Math.floor(random() * 6)
        const steps: Step[] = []
        for (let i = 0; i < count; i++) steps.push(STEPS[Math.floor(random() * STEPS.length)]!)
        const r = await rig({ memory: !reopen })
        try {
          for (const [n, step] of steps.entries()) {
            await runStep(r, step, n, random)
            await r.quiescent()
          }
          await r.finish({ reopen })
        } catch (error) {
          throw new Error(`seed ${seed} steps [${steps.join(', ')}]: ${String(error)}`, {
            cause: error
          })
        }
      },
      TIMEOUT
    )
  }
})
