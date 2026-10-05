/**
 * P3-03 · 队列、询问与显示侧车（设计稿 P3-03-19..27）：
 *
 *   19 队列的一生：两条用户输入进队列；被放下时在同一份修订里离开队列、成为消息（id = 落下的条目 id）
 *   20 queueDisplay（PIN-22）：排队的内联 Token 输入显示芯片文字；freshMount / reopenMount 一样（证明挂载时
 *      按 submission 查到了它）
 *   21 撤回的排队输入：离开队列、不加消息；逐帧身份
 *   22 询问：没有提交的一次修订；同 id 重发只留新的；应答 → []；中止 → []，重开窗口后再问又出现
 *   23 挂载时已经挂着的询问
 *   24 多钩子（PIN-02）：宿主级监听与投影各收到恰好一次；抛错的一方不影响别的、不影响询问
 *   25 每一份实时修订都没有 payload：用户消息第一次出现时就是显示侧车的内容
 *   26 重开一致：重开之后 = 之前的值
 *   27 落不到条目的显示侧车：不影响消息，= freshMount
 */
import type { ConversationId, SubmissionId } from '@earendil-works/pi-durable'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { DisplayDoc } from '../../docs'
import type { DurableSession } from '../../durableSession'
import { answer, callTool, held, stalled } from '../../__tests__/support/faux'
import { makeHost, primeRoot, registerHostCleanup } from '../../__tests__/support/host'
import { allEntries } from '../../__tests__/support/transcript'
import { waitFor, withTimeout } from '../../__tests__/support/wait'
import {
  attachOracle,
  freshMount,
  opsOf,
  readTool,
  reopenMount,
  settleFrames,
  throwingSubscriber,
  withoutAsks
} from './projectorSupport'

registerHostCleanup()

const TIMEOUT = 25000

const K = { k1: { type: 'cmd', id: 'cmd', displayText: '/cmd', payload: 'EXPANDED-PAYLOAD' } }
const DISPLAY = { content: 'run {{shuvixInlineToken:k1}}', tokens: K }

const ask = (id: string, question: string): InputRequest =>
  ({ id, kind: 'ask', toolName: 'ask', question, createdAt: 0 }) as unknown as InputRequest

async function userEntryIds(session: DurableSession): Promise<Map<string, number>> {
  const ids = new Map<string, number>()
  for (const entry of await allEntries(await session.currentConversation())) {
    const message = entry.model?.[0]
    if (
      entry.kind === 'pi.user' &&
      message?.role === 'user' &&
      typeof message.content === 'string'
    ) {
      ids.set(message.content, entry.id)
    }
  }
  return ids
}

describe('P3-03 · queue', () => {
  it(
    'P3-03-19 queue lifecycle: followUp then steer queue in order; each leaves the queue in the revision that adds its user message',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      await primeRoot(session)
      const proj = await session.projector()
      const h = proj.acquire()
      const ops = opsOf(h.state)
      const run = held(answer('a1'))
      t.kit.queue(run.step, answer('a2'), answer('a3'))
      const sending = session.submitUser('go')
      await withTimeout(run.reached, 5000, 'first request')
      const s1 = (await session.followUp('a')).submissionId!
      const s2 = (await session.steer('b')).submissionId!
      await settleFrames()
      expect(h.state.value.queue).toStrictEqual([
        { submissionId: s1, mode: 'followUp', text: 'a', imageCount: 0 },
        { submissionId: s2, mode: 'steer', text: 'b', imageCount: 0 }
      ])
      run.release()
      expect(await withTimeout(sending, 8000, 'send')).toEqual({})
      await waitFor(
        () => session.runState === 'idle' && h.state.value.queue.length === 0,
        8000,
        'drained'
      )
      await settleFrames()
      const ids = await userEntryIds(session)
      for (const [submissionId, text] of [
        [s1, 'a'],
        [s2, 'b']
      ] as const) {
        const leaves = ops.revisions.findIndex(
          (r, i) =>
            i > 0 &&
            !r.value.queue.some((q) => q.submissionId === submissionId) &&
            ops.revisions[i - 1]!.value.queue.some((q) => q.submissionId === submissionId)
        )
        expect(leaves, text).toBeGreaterThan(0)
        const message = ops.revisions[leaves]!.value.messages.find((m) => m.content === text)
        expect(message?.id).toBe(String(ids.get(text)))
        expect(ops.revisions[leaves - 1]!.value.messages.some((m) => m.content === text)).toBe(
          false
        )
      }
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-20 queueDisplay live and after reload (PIN-22): the chip text, no expanded payload; freshMount and reopenMount agree',
    async () => {
      const t = await makeHost()
      const session = await t.open()
      await primeRoot(session)
      const stall = stalled()
      t.kit.queue(stall.step)
      void session.submitUser('busy')
      await withTimeout(stall.reached, 5000, 'stalled')
      const proj = await session.projector()
      const h = proj.acquire()
      void session.submitUser('run EXPANDED-PAYLOAD', { whenBusy: 'followUp', display: DISPLAY })
      await waitFor(() => h.state.value.queue.length === 1, 3000, 'queued')
      expect(h.state.value.queue[0]!.text).toBe('run /cmd')
      expect(JSON.stringify(h.state.value)).not.toContain('EXPANDED-PAYLOAD')
      expect((await freshMount(session)).queue).toStrictEqual(h.state.value.queue)
      h.release()
      const { view } = await reopenMount(t, 's1')
      expect(view.queue.map((q) => [q.mode, q.text])).toEqual([['followUp', 'run /cmd']])
      expect(JSON.stringify(view)).not.toContain('EXPANDED-PAYLOAD')
    },
    TIMEOUT
  )

  it(
    'P3-03-21 a withdrawn queue item leaves the queue, adds no user message; identity at every frame',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      await primeRoot(session)
      const proj = await session.projector()
      const h = proj.acquire()
      const oracle = await attachOracle(session, h.state)
      const stall = stalled()
      t.kit.queue(stall.step)
      void session.submitUser('busy')
      await withTimeout(stall.reached, 5000, 'stalled')
      const { submissionId } = await session.followUp('later')
      await waitFor(() => h.state.value.queue.length === 1, 3000, 'queued')
      const outcome = await session.harness.abortSubmission(
        submissionId as SubmissionId,
        BG,
        1 as ConversationId
      )
      expect(outcome).toBe('aborted')
      await waitFor(() => h.state.value.queue.length === 0, 3000, 'withdrawn')
      expect(h.state.value.messages.some((m) => m.content === 'later')).toBe(false)
      expect(await oracle.verify()).toBeGreaterThan(0)
      await oracle.stop()
      await session.abort()
      h.release()
    },
    TIMEOUT
  )
})

describe('P3-03 · asks', () => {
  it(
    'P3-03-22 asks feed: a revision with no commit; re-request replaces; respond clears; abort clears; asks again after the window reopens',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      await primeRoot(session)
      const proj = await session.projector()
      const h = proj.acquire()
      const ops = opsOf(h.state)
      const publications: unknown[] = []
      const stop = session.harness.subscribeCommits((p) => publications.push(p))
      const first = session.requestUserInput(ask('R1', 'first?'))
      expect(h.state.value.asks).toStrictEqual([
        { id: 'R1', kind: 'ask', toolName: 'ask', question: 'first?', createdAt: 0 }
      ])
      expect(ops.revisions).toHaveLength(1)
      expect(publications).toEqual([])
      const second = session.requestUserInput(ask('R1', 'second?'))
      expect(await first).toEqual({ kind: 'cancel', reason: 'superseded' })
      expect(h.state.value.asks).toHaveLength(1)
      expect(h.state.value.asks[0]).toMatchObject({ id: 'R1', question: 'second?' })
      expect(session.respondToInput('R1', { kind: 'allow' } as never)).toBe(true)
      await second
      expect(h.state.value.asks).toEqual([])

      const pending = session.requestUserInput(ask('R2', 'during?'))
      expect(h.state.value.asks).toHaveLength(1)
      await session.abort()
      expect(await pending).toMatchObject({ kind: 'cancel' })
      expect(h.state.value.asks).toEqual([])
      // 窗口关着：当场取消，不出现
      expect(await session.requestUserInput(ask('R3', 'closed?'))).toMatchObject({ kind: 'cancel' })
      expect(h.state.value.asks).toEqual([])
      // 下一个起跑路径重开窗口
      t.kit.queue(answer('ok'))
      expect(await session.submitUser('go')).toEqual({})
      const again = session.requestUserInput(ask('R4', 'again?'))
      expect(h.state.value.asks.map((a) => a.id)).toEqual(['R4'])
      session.respondToInput('R4', { kind: 'allow' } as never)
      await again
      stop()
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it('P3-03-23 asks at mount: an ask pending before the projector exists is in the first value', async () => {
    const t = await makeHost({ ephemeral: ['s1'] })
    const session = await t.open('s1')
    const pending = session.requestUserInput(ask('R1', 'before?'))
    const proj = await session.projector()
    const h = proj.acquire()
    expect(h.state.value.asks.map((a) => a.id)).toEqual(['R1'])
    session.respondToInput('R1', { kind: 'allow' } as never)
    await pending
    expect(h.state.value.asks).toEqual([])
    h.release()
  })

  it(
    'P3-03-24 fan-out (PIN-02): the host-level listener and the projector each see every request/resolution once; throwing listeners affect nothing',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      const proj = await session.projector()
      const h = proj.acquire()
      // 下游（SyncHub 的角色）抛错：投影记日志，询问照常
      const unsubscribe = throwingSubscriber(h.state)
      const throwing = session.subscribeInputs({
        onRequest: () => {
          throw new Error('listener boom')
        },
        onResolved: () => {
          throw new Error('listener boom')
        }
      })
      const seen: string[] = []
      const host = session.subscribeInputs({
        onRequest: (request) => seen.push(`request:${request.id}`),
        onResolved: (id) => seen.push(`resolved:${id}`)
      })
      const a = session.requestUserInput(ask('A', 'a?'))
      const b = session.requestUserInput(ask('B', 'b?'))
      expect(h.state.value.asks.map((x) => x.id)).toEqual(['A', 'B'])
      session.respondToInput('A', { kind: 'allow' } as never)
      session.respondToInput('B', { kind: 'allow' } as never)
      expect(await a).toEqual({ kind: 'allow' })
      expect(await b).toEqual({ kind: 'allow' })
      expect(seen).toEqual(['request:A', 'request:B', 'resolved:A', 'resolved:B'])
      expect(h.state.value.asks).toEqual([])
      expect(t.warnings.some((w) => w.includes('listener boom'))).toBe(true)
      expect(t.warnings.some((w) => w.includes('downstream boom'))).toBe(true)
      throwing()
      host()
      unsubscribe()
      h.release()
    },
    TIMEOUT
  )
})

describe('P3-03 · display, live versus reload', () => {
  it(
    'P3-03-25 every live frame is display-clean: the first revision with the user message already has D; PAYLOAD in no op payload',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      await primeRoot(session)
      const proj = await session.projector()
      const h = proj.acquire()
      const ops = opsOf(h.state)
      t.kit.queue(answer('ok'))
      expect(await session.submitUser('run EXPANDED-PAYLOAD', { display: DISPLAY })).toEqual({})
      await settleFrames()
      const first = ops.revisions.find((r) => r.value.messages.some((m) => m.role === 'user'))!
      const user = first.value.messages.find((m) => m.role === 'user')!
      expect(user.content).toBe(DISPLAY.content)
      expect(user.metadata).toStrictEqual({ inlineTokens: K })
      // 展开后的模型文本从不出现在任何操作里；payload 只在 inlineTokens 里（P3-02-02 的 Token 形状本来就带
      // payload —— 设计稿「PAYLOAD 不出现在任何操作里」按「不出现在任何文字字段里」理解，已报告）
      for (const { op } of ops.allOps()) {
        expect(JSON.stringify(op)).not.toContain('run EXPANDED-PAYLOAD')
      }
      for (const revision of ops.revisions) {
        for (const message of revision.value.messages) {
          expect(message.content).not.toContain('EXPANDED-PAYLOAD')
        }
      }
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-26 reload parity: after a display send and a tool round, reopenMount deep-equals the live value',
    async () => {
      const t = await makeHost({ tools: [readTool()] })
      const session = await t.open()
      await primeRoot(session)
      const proj = await session.projector()
      const h = proj.acquire()
      t.kit.queue(answer('ok'))
      expect(await session.submitUser('run EXPANDED-PAYLOAD', { display: DISPLAY })).toEqual({})
      t.kit.queue(callTool('read', { path: 'z' }, 'c1'), answer('done'))
      expect(await session.submitUser('read z')).toEqual({})
      await settleFrames()
      const v = h.state.value
      h.release()
      const { view } = await reopenMount(t, 's1')
      expect(view).toStrictEqual(withoutAsks(v))
    },
    TIMEOUT
  )

  it('P3-03-27 a display item that never lands: no effect on the messages; = freshMount', async () => {
    const t = await makeHost({ ephemeral: ['s1'] })
    const session = await t.open('s1')
    await primeRoot(session)
    const proj = await session.projector()
    const h = proj.acquire()
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('plain')).toEqual({})
    const conversation = await session.currentConversation()
    await conversation.commit(async (tx) => {
      ;(await tx.doc(DisplayDoc, conversation.id)).items.orphan = DISPLAY as never
    }, BG)
    await settleFrames()
    expect(h.state.value.messages.map((m) => m.content)).toEqual(['plain', 'ok'])
    expect(h.state.value).toStrictEqual(await freshMount(session))
    h.release()
  })
})
