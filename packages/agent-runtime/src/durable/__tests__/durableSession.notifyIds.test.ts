/**
 * P2-09 · 通知的 requestId 与去重（PIN-09..11）：
 *
 *  - 去重在路由之前：当前对话里已有这个 requestId 的提交（不分类型）、它在待送达里、或在合并窗口里
 *    → 不再送；竞态由 durable 的去重兜底；
 *  - 送达推迟通知时同一 id 已有提交（不论类型）就跳过 —— 类型不符绝不让继续 / 中止 / 送达抛出；
 *  - 合并的一轮：单条沿用自己的 id；多条 = `notices:` + 排序去重的 id；窗口期间已送达的先剔掉；
 *  - 退回写入（窗口内中止）/ 关停保存 / 用户插话都保留每条通知自己的 id。
 *
 * 重启用例都用 SQLite、真实计时器、约 15 秒的超时。
 */
import {
  ROOT_CONVERSATION_ID,
  type CommitPublication,
  type SubmissionRecord
} from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import { crashWith } from './support/crash'
import { answer, callTool } from './support/faux'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost,
  type TestHostOptions
} from './support/host'
import { holdTool } from './support/tools'
import { transcript } from './support/transcript'
import { deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000
const ROOT = ROOT_CONVERSATION_ID
const WINDOW = 20

async function lines(session: DurableSession): Promise<string[]> {
  return transcript(await session.currentConversation())
}

async function byRequest(
  session: DurableSession,
  requestId: string
): Promise<SubmissionRecord | undefined> {
  return session.harness.commit((tx) => tx.submissionByRequest(ROOT, requestId), BG)
}

async function deferredIds(session: DurableSession): Promise<string[]> {
  const state = await session.harness.snapshot(SessionStateDoc, BG)
  return (state?.deferredNotices ?? []).map((notice) => notice.requestId)
}

async function primed(
  options: TestHostOptions = {}
): Promise<{ t: TestHost; session: DurableSession }> {
  const t = await makeHost({ noticeCoalesceMs: WINDOW, ...options })
  const session = await t.open()
  await primeRoot(session)
  return { t, session }
}

/** 记下每条被受理的 input submission（最新状态） */
function inputSubmissions(session: DurableSession): {
  readonly records: Map<number, SubmissionRecord>
  stop(): void
} {
  const records = new Map<number, SubmissionRecord>()
  const stop = session.harness.subscribeCommits((publication: CommitPublication) => {
    for (const change of publication.changes) {
      if (change.type === 'submission' && change.value.type === 'input') {
        records.set(change.value.id, change.value)
      }
    }
  })
  return { records, stop }
}

function noticeWarnings(t: TestHost): string[] {
  return t.warnings.filter((warning) => /notice|notify|auto-resume/.test(warning))
}

describe('notify requestIds · routes', () => {
  it(
    'P2-09-31 write route: the same id twice → one shuvix.notice findable by it; still one after an idle restart',
    async () => {
      const { t, session } = await primed({ autoResume: () => 'false' })
      await session.notify('A', { requestId: 'n1' })
      await session.notify('A', { requestId: 'n1' })
      expect(await lines(session)).toEqual(['shuvix.notice:A'])
      expect(await byRequest(session, 'n1')).toMatchObject({ type: 'write', status: 'done' })

      const t2 = await t.restart()
      const reopened = await t2.open()
      await reopened.notify('A', { requestId: 'n1' })
      await sleep(WINDOW * 3)
      expect(await lines(reopened)).toEqual(['shuvix.notice:A'])
      expect(t2.kit.callCount).toBe(0)
    },
    RESTART_TIMEOUT
  )

  it('P2-09-32 steer route: the same id twice during a tool round → one pi.user in the next request; a later idle notify of it does nothing', async () => {
    const gate = deferred()
    const running = deferred()
    const { t, session } = await primed({
      tools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
    })
    t.kit.queue(callTool('hold'), answer('done'))
    const result = session.submitUser('go')
    await running.promise
    await session.notify('<n1/>', { requestId: 'n1' })
    await session.notify('<n1/>', { requestId: 'n1' })
    gate.resolve()
    expect(await result).toEqual({})
    expect(await lines(session)).toEqual([
      'pi.user:go',
      'pi.assistant:[tool:hold]',
      'pi.tool-result:hold done',
      'pi.user:<n1/>',
      'pi.assistant:done'
    ])
    expect(t.kit.callCount).toBe(2)
    expect(await byRequest(session, 'n1')).toMatchObject({ type: 'input', status: 'done' })

    await session.notify('<n1/>', { requestId: 'n1' })
    await sleep(WINDOW * 3)
    expect(t.kit.callCount).toBe(2)
    expect((await lines(session)).filter((line) => line === 'pi.user:<n1/>')).toHaveLength(1)
  })

  it(
    'P2-09-33 deferred route: the same id twice → one deferred item; continue places it once; a later notify of it does nothing',
    async () => {
      const { t } = await crashWith({ restart: { noticeCoalesceMs: WINDOW } })
      const session = await t.open()
      await session.notify('N1', { requestId: 'n1' })
      await session.notify('N1', { requestId: 'n1' })
      expect(await deferredIds(session)).toEqual(['n1'])
      t.kit.queue(answer('x'))
      expect(await withTimeout(session.continue(), 5000, 'continue')).toEqual({})
      await waitFor(async () => (await lines(session)).includes('shuvix.notice:N1'), 3000, 'placed')
      expect(await deferredIds(session)).toEqual([])
      await session.notify('N1', { requestId: 'n1' })
      await sleep(WINDOW * 3)
      expect((await lines(session)).filter((line) => line === 'shuvix.notice:N1')).toHaveLength(1)
      expect(t.kit.callCount).toBe(1)
    },
    RESTART_TIMEOUT
  )

  it('P2-09-34 mixed types never throw: (a) a write id notified while busy; (b) a deferred notice whose id is an input', async () => {
    // (a)
    const gate = deferred()
    const running = deferred()
    const { t, session } = await primed({
      tools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
    })
    await session.writeNotice({ text: 'W', kind: 'background', requestId: 'n1' })
    t.kit.queue(callTool('hold'), answer('done'))
    const result = session.submitUser('go')
    await running.promise
    await session.notify('W', { requestId: 'n1' })
    gate.resolve()
    expect(await result).toEqual({})
    expect(await lines(session)).toEqual([
      'shuvix.notice:W',
      'pi.user:go',
      'pi.assistant:[tool:hold]',
      'pi.tool-result:hold done',
      'pi.assistant:done'
    ])
    expect(noticeWarnings(t)).toEqual([])

    // (b) 待送达里的通知占了一条 input 的 id：continue / abort 照常，通知被移除、不落条目
    t.kit.queue(answer('a1'))
    expect(await session.submitUser('u1', { requestId: 'in1' })).toEqual({})
    const pushDeferred = (): Promise<void> =>
      session.harness.commit(async (tx) => {
        ;(await tx.doc(SessionStateDoc)).deferredNotices.push({
          requestId: 'in1',
          text: 'X',
          kind: 'background'
        })
      }, BG)
    const before = await lines(session)
    await pushDeferred()
    expect(await withTimeout(session.continue(), 5000, 'continue')).toEqual({})
    expect(await deferredIds(session)).toEqual([])
    expect(await lines(session)).toEqual(before)

    await pushDeferred()
    await withTimeout(session.abort(), 5000, 'abort')
    expect(await deferredIds(session)).toEqual([])
    expect(await lines(session)).toEqual(before)
  })
})

describe('notify requestIds · coalescing', () => {
  it("P2-09-35 coalesced ids: 'notices:<sorted ids>' for several, the own id for one; delivered ids dropped; an all-delivered window runs nothing; a notice without an id still gets one", async () => {
    const { t, session } = await primed({ noticeCoalesceMs: 200 })
    const inputs = inputSubmissions(session)
    const runEnded = async (text: string): Promise<void> =>
      waitFor(async () => (await lines(session)).at(-1) === `pi.assistant:${text}`, 3000, text)

    t.kit.queue(answer('ack1'))
    await session.notify('A', { requestId: 'n2' })
    await session.notify('B', { requestId: 'n1' })
    await runEnded('ack1')
    expect((await lines(session)).slice(-2)).toEqual(['pi.user:A\n\nB', 'pi.assistant:ack1'])
    expect(await byRequest(session, 'notices:n1,n2')).toMatchObject({
      type: 'input',
      status: 'done'
    })

    t.kit.queue(answer('ack2'))
    await session.notify('C', { requestId: 'n3' })
    await runEnded('ack2')
    expect((await lines(session)).slice(-2)).toEqual(['pi.user:C', 'pi.assistant:ack2'])
    expect(await byRequest(session, 'n3')).toMatchObject({ type: 'input', status: 'done' })

    // 窗口期间其中一条已经送达（写入）：它被剔掉，只剩 D
    t.kit.queue(answer('ack3'))
    await session.notify('E', { requestId: 'n6' })
    await session.notify('D', { requestId: 'n4' })
    await session.writeNotice({ text: 'E', kind: 'background', requestId: 'n6' })
    await runEnded('ack3')
    expect((await lines(session)).slice(-3)).toEqual([
      'shuvix.notice:E',
      'pi.user:D',
      'pi.assistant:ack3'
    ])
    expect(await byRequest(session, 'n4')).toMatchObject({ type: 'input', status: 'done' })

    // 窗口里的全都送达了：不起轮
    const calls = t.kit.callCount
    await session.notify('G', { requestId: 'n7' })
    await session.notify('H', { requestId: 'n8' })
    await session.writeNotice({ text: 'G', kind: 'background', requestId: 'n7' })
    await session.writeNotice({ text: 'H', kind: 'background', requestId: 'n8' })
    await sleep(300)
    expect(t.kit.callCount).toBe(calls)
    expect((await lines(session)).slice(-2)).toEqual(['shuvix.notice:G', 'shuvix.notice:H'])

    // 没给 id 的通知也有一个
    t.kit.queue(answer('ack4'))
    const known = new Set(inputs.records.keys())
    await session.notify('Z')
    await runEnded('ack4')
    inputs.stop()
    const fresh = [...inputs.records.values()].filter((record) => !known.has(record.id))
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.requestId).toEqual(expect.any(String))
    expect(fresh[0]!.requestId!.length).toBeGreaterThan(0)
  })

  it(
    'P2-09-36 window fallbacks keep each id: abort → two writes; close → deferred under n1, n2 (process 2 dedupes); a user send → one steer under the combined id',
    async () => {
      // 中止：退回写入，各自的 id
      const { t, session } = await primed({ noticeCoalesceMs: 200 })
      await session.notify('N1', { requestId: 'n1' })
      await session.notify('N2', { requestId: 'n2' })
      await withTimeout(session.abort(), 3000, 'abort in window')
      expect(await lines(session)).toEqual(['shuvix.notice:N1', 'shuvix.notice:N2'])
      expect(await byRequest(session, 'n1')).toMatchObject({ type: 'write' })
      expect(await byRequest(session, 'n2')).toMatchObject({ type: 'write' })
      await sleep(250)
      expect(t.kit.callCount).toBe(0)
      await t.host.closeAll()

      // 关停：存进待送达，沿用 n1 / n2；下个进程同一条再到达不重复
      const { t: first, session: closing } = await primed({ noticeCoalesceMs: 200 })
      await closing.notify('N1', { requestId: 'n1' })
      await closing.notify('N2', { requestId: 'n2' })
      const t2 = await first.restart()
      const reopened = await t2.open()
      expect(await deferredIds(reopened)).toEqual(['n1', 'n2'])
      await reopened.notify('N1', { requestId: 'n1' })
      await sleep(250)
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      const all = await lines(reopened)
      expect(all.filter((line) => line === 'shuvix.notice:N1')).toHaveLength(1)
      expect(all).toEqual(['shuvix.notice:N1', 'shuvix.notice:N2'])
      expect(t2.kit.callCount).toBe(0)
      await t2.host.closeAll()

      // 用户发送：作为一条插话汇入，合并 id
      const gate = deferred()
      const running = deferred()
      const { t: t3, session: sending } = await primed({
        noticeCoalesceMs: 200,
        tools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
      })
      t3.kit.queue(callTool('hold'), answer('done'))
      await sending.notify('N1', { requestId: 'n1' })
      await sending.notify('N2', { requestId: 'n2' })
      const result = sending.submitUser('go')
      await running.promise
      gate.resolve()
      expect(await result).toEqual({})
      expect(await lines(sending)).toEqual([
        'pi.user:go',
        'pi.assistant:[tool:hold]',
        'pi.tool-result:hold done',
        'pi.user:N1\n\nN2',
        'pi.assistant:done'
      ])
      expect(await byRequest(sending, 'notices:n1,n2')).toMatchObject({ type: 'input' })
      await sleep(250)
      expect(t3.kit.callCount).toBe(2)
    },
    RESTART_TIMEOUT * 2
  )
})
