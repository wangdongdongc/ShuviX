/**
 * 系统通知（`shuvix.notice`）：空闲直接写、忙时在边界落下（写入先于用户消息）、空闲但留着失败
 * 输入时推迟（R1）、被中断时推迟（Q3），以及推迟的通知何时、以何种顺序、恰好一次地送达。
 */
import { InboxDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc, type DeferredNotice } from '../docs'
import type { DurableSession } from '../durableSession'
import { answer, callTool, held, modelError, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import { holdTool } from './support/tools'
import { allEntries, requestTexts, transcript } from './support/transcript'
import { deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

async function deferredNotices(session: DurableSession): Promise<DeferredNotice[]> {
  return (await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices ?? []
}

async function noticeLines(session: DurableSession, conversation?: number): Promise<string[]> {
  const target =
    conversation === undefined
      ? await session.currentConversation()
      : (await session.harness.conversation(conversation as never, BG))!
  return (await transcript(target)).filter((line) => line.startsWith('shuvix.notice'))
}

/** 进程 1 在请求途中退出；返回进程 2 里重新打开的（被中断的）会话 */
async function interruptedSession(): Promise<{ t: TestHost; session: DurableSession }> {
  const first = await makeHost()
  const session = await first.open()
  await primeRoot(session, first.kit)
  const stall = stalled()
  first.kit.queue(stall.step)
  void session.submitUser('hello')
  await stall.reached
  const t = await first.restart()
  const reopened = await t.open()
  expect(reopened.isInterrupted()).toBe(true)
  return { t, session: reopened }
}

/** 一轮失败后在收件箱里留下一条 follow-up 'F'（包一层对象：直接返回 Promise 会被 async 展平） */
async function leftoverInput(
  t: TestHost,
  session: DurableSession
): Promise<{ leftover: Promise<unknown> }> {
  const run = held(modelError('boom'))
  t.kit.queue(run.step)
  const first = session.submitUser('u-fail')
  await run.reached
  const leftover = session.submitUser('F', { whenBusy: 'followUp' })
  await waitFor(async () => {
    const inbox = await session.harness.snapshot(InboxDoc, ROOT_CONVERSATION_ID, BG)
    return (inbox?.items.length ?? 0) === 1
  })
  run.release()
  expect(await first).toEqual({ error: 'boom', code: 'model_error' })
  return { leftover }
}

describe('notices', () => {
  it('N-01 an idle write appends a shuvix.notice at once without a run; the next request carries it first', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const result = await session.writeNotice({ text: 'N1', kind: 'background' })
    expect(result).toMatchObject({ status: 'submitted', submissionId: expect.any(Number) })
    expect(await transcript(await session.currentConversation())).toEqual(['shuvix.notice:N1'])
    expect(t.kit.callCount).toBe(0)
    expect(session.isBusy()).toBe(false)
    t.kit.queue(answer('ok'))
    await session.submitUser('u')
    expect(requestTexts(t.kit, 0)).toEqual(['user:N1', 'user:u'])
  })

  it('N-02 the same requestId twice while idle → one entry', async () => {
    const t = await makeHost()
    const session = await t.open()
    const first = await session.writeNotice({ text: 'N', kind: 'date', requestId: 'r1' })
    const second = await session.writeNotice({ text: 'N', kind: 'date', requestId: 'r1' })
    expect(second.submissionId).toBe(first.submissionId)
    expect(await noticeLines(session)).toEqual(['shuvix.notice:N'])
  })

  it('N-03 postTools boundary: a steer and a notice during a held tool round land after the tool result, notice first', async () => {
    const gate = deferred()
    const running = deferred()
    const t = await makeHost({
      tools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
    })
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(callTool('hold'), answer('done'))
    const result = session.submitUser('go')
    await running.promise
    await session.steer('S')
    expect((await session.writeNotice({ text: 'N', kind: 'background' })).status).toBe('submitted')
    gate.resolve()
    expect(await result).toEqual({})
    expect(await transcript(await session.currentConversation())).toEqual([
      'pi.user:go',
      'pi.assistant:[tool:hold]',
      'pi.tool-result:hold done',
      'shuvix.notice:N',
      'pi.user:S',
      'pi.assistant:done'
    ])
    expect(requestTexts(t.kit, 1).slice(-3)).toEqual(['toolResult:hold done', 'user:N', 'user:S'])
  })

  it('N-04 final boundary: a notice during a held text answer lands after the answer, without a new run', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const run = held(answer('a1'))
    t.kit.queue(run.step)
    const result = session.submitUser('u1')
    await run.reached
    await session.writeNotice({ text: 'N', kind: 'background' })
    run.release()
    expect(await result).toEqual({})
    await sleep(30)
    expect(t.kit.callCount).toBe(1)
    expect(await transcript(await session.currentConversation())).toEqual([
      'pi.user:u1',
      'pi.assistant:a1',
      'shuvix.notice:N'
    ])
    t.kit.queue(answer('a2'))
    await session.submitUser('u2')
    expect(requestTexts(t.kit, 1).slice(-2)).toEqual(['user:N', 'user:u2'])
  })

  it('N-05 idle with a leftover queued input: no run starts; the notice is deferred and goes right before the next send (R1)', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const { leftover } = await leftoverInput(t, session)
    const calls = t.kit.callCount
    const result = await session.writeNotice({ text: 'N', kind: 'background', requestId: 'rN' })
    expect(result.status).toBe('deferred')
    await sleep(30)
    expect(t.kit.callCount).toBe(calls)
    expect(session.isBusy()).toBe(false)
    expect(await deferredNotices(session)).toEqual([
      { requestId: 'rN', text: 'N', kind: 'background' }
    ])
    expect(await noticeLines(session)).toEqual([])
    t.kit.queue(answer('both'))
    expect(await session.submitUser('next')).toEqual({})
    expect(await leftover).toEqual({})
    expect(requestTexts(t.kit, 1).slice(-3)).toEqual(['user:N', 'user:F', 'user:next'])
    expect(await deferredNotices(session)).toEqual([])
    expect(await noticeLines(session)).toEqual(['shuvix.notice:N'])
  })

  it('N-06 interrupted session: the notice is deferred; nothing resumes', async () => {
    const { t, session } = await interruptedSession()
    const result = await session.writeNotice({ text: 'N', kind: 'background', requestId: 'r1' })
    expect(result).toMatchObject({ status: 'deferred', requestId: 'r1' })
    await sleep(50)
    expect(await noticeLines(session)).toEqual([])
    expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
    expect(session.isInterrupted()).toBe(true)
    expect(t.kit.callCount).toBe(0)
    expect(await deferredNotices(session)).toEqual([
      { requestId: 'r1', text: 'N', kind: 'background' }
    ])
  })

  it('N-07 the same requestId deferred twice is stored once', async () => {
    const { session } = await interruptedSession()
    await session.writeNotice({ text: 'N', kind: 'background', requestId: 'r1' })
    await session.writeNotice({ text: 'N', kind: 'background', requestId: 'r1' })
    expect(await deferredNotices(session)).toHaveLength(1)
  })

  it('N-08 continue() delivers deferred notices once each, in order; the next request carries both', async () => {
    const { t, session } = await interruptedSession()
    await session.writeNotice({ text: 'N1', kind: 'background', requestId: 'r1' })
    await session.writeNotice({ text: 'N2', kind: 'background', requestId: 'r2' })
    t.kit.queue(answer('resumed'))
    expect(await withTimeout(session.continue(), 5000, 'continue')).toEqual({})
    expect(await deferredNotices(session)).toEqual([])
    expect(await transcript(await session.currentConversation())).toEqual([
      'pi.user:hello',
      'pi.assistant:resumed',
      'shuvix.notice:N1',
      'shuvix.notice:N2'
    ])
    t.kit.queue(answer('next'))
    await session.submitUser('next')
    expect(requestTexts(t.kit, 1).slice(-3)).toEqual(['user:N1', 'user:N2', 'user:next'])
  })

  it('N-09 deferred notices survive a restart; continue delivers them once', async () => {
    const { t, session } = await interruptedSession()
    await session.writeNotice({ text: 'N1', kind: 'background', requestId: 'r1' })
    const next = await t.restart()
    const reopened = await next.open()
    expect(reopened.isInterrupted()).toBe(true)
    expect(await deferredNotices(reopened)).toHaveLength(1)
    next.kit.queue(answer('resumed'))
    expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
    expect(await noticeLines(reopened)).toEqual(['shuvix.notice:N1'])
    expect(await deferredNotices(reopened)).toEqual([])
  })

  it('N-10 a flush interrupted between submit and clear is idempotent (requestId dedupe)', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const conversation = await session.currentConversation()
    // 像是上一次送达已经提交了写入、却没来得及清掉待送达
    await conversation.submit(
      {
        type: 'write',
        requestId: 'r1',
        entry: {
          kind: 'shuvix.notice',
          model: [{ role: 'user', content: 'N1', timestamp: 1 }],
          data: { kind: 'background' }
        }
      },
      BG
    )
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).deferredNotices.push(
        { requestId: 'r1', text: 'N1', kind: 'background' },
        { requestId: 'r2', text: 'N2', kind: 'background' }
      )
    }, BG)
    // 「放下」那条路径（abort 送达；空闲时 continue 是无操作，P3-10a 裁定）
    await withTimeout(session.abort(), 5000, 'abort')
    expect(await noticeLines(session)).toEqual(['shuvix.notice:N1', 'shuvix.notice:N2'])
    expect(await deferredNotices(session)).toEqual([])

    // 发送前的那条路径（收进收件箱）同样去重
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).deferredNotices.push({
        requestId: 'r2',
        text: 'N2',
        kind: 'background'
      })
    }, BG)
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('u')).toEqual({})
    expect(await noticeLines(session)).toEqual(['shuvix.notice:N1', 'shuvix.notice:N2'])
    expect(await deferredNotices(session)).toEqual([])
  })

  it('N-11 requestId idempotency holds across an idle restart', async () => {
    const t = await makeHost()
    const session = await t.open()
    await session.writeNotice({ text: 'N', kind: 'date', requestId: 'r1' })
    const next = await t.restart()
    const reopened = await next.open()
    expect(reopened.isInterrupted()).toBe(false)
    const again = await reopened.writeNotice({ text: 'N', kind: 'date', requestId: 'r1' })
    expect(again.status).toBe('submitted')
    expect(await noticeLines(reopened)).toEqual(['shuvix.notice:N'])
  })

  it('N-12 interrupted + abort-then-send: deferred notices land right before the user input', async () => {
    const { t, session } = await interruptedSession()
    await session.writeNotice({ text: 'N', kind: 'background', requestId: 'r1' })
    t.kit.queue(answer('fresh'))
    expect(await withTimeout(session.submitUser('new'), 5000, 'send')).toEqual({})
    expect((await transcript(await session.currentConversation())).slice(-3)).toEqual([
      'shuvix.notice:N',
      'pi.user:new',
      'pi.assistant:fresh'
    ])
    expect(await deferredNotices(session)).toEqual([])
    expect(await noticeLines(session)).toEqual(['shuvix.notice:N'])
  })

  it('N-13 abort() on an interrupted session delivers deferred notices exactly once', async () => {
    const { t, session } = await interruptedSession()
    await session.writeNotice({ text: 'N', kind: 'background', requestId: 'r1' })
    await withTimeout(session.abort(), 5000, 'abort')
    expect(await noticeLines(session)).toEqual(['shuvix.notice:N'])
    expect(await deferredNotices(session)).toEqual([])
    expect(t.kit.callCount).toBe(0)
    await withTimeout(session.abort(), 5000, 'second abort')
    expect(await noticeLines(session)).toEqual(['shuvix.notice:N'])
  })

  it('N-14 deferred notices go to the conversation that is current when they are delivered', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')
    await leftoverInput(t, session)
    expect((await session.writeNotice({ text: 'N', kind: 'background' })).status).toBe('deferred')
    const root = await session.currentConversation()
    const userEntry = (await allEntries(root)).find((entry) => entry.kind === 'pi.user')!
    const fork = await root.fork(userEntry.id, { ownership: { kind: 'ownerless' } }, BG)
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
    }, BG)
    t.kit.queue(answer('on fork'))
    expect(await session.submitUser('next')).toEqual({})
    expect(await transcript(fork)).toEqual([
      'pi.user:u1',
      'shuvix.notice:N',
      'pi.user:next',
      'pi.assistant:on fork'
    ])
    expect(await noticeLines(session, ROOT_CONVERSATION_ID)).toEqual([])
  })
})
