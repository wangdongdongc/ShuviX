/**
 * 日期通知（裁决 Q14，两通道规则的时间线那一条）：`maybeAnnounceDate` 的判定与写入，以及它接在
 * DurableSession 用户输入之前的那一段 —— 新的一天里第一次输入之前追加一条 `shuvix.notice`（kind
 * `date`）、排在这次输入之前；一天一次；requestId 让重试不重复；被中断时推迟、随后按序送达；
 * 回退 fork 回到 fork 点的日期；没注入日期就什么都不发（测试缺省）。
 */
import { getCurrentSystemPrompt, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai'
import {
  InboxDoc,
  ROOT_CONVERSATION_ID,
  SystemEntry,
  type Conversation,
  type ConversationId,
  type EntryRecord
} from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc, NoticeEntry, SessionStateDoc, noticeEntryDraft } from '../docs'
import type { DurableSession } from '../durableSession'
import { maybeAnnounceDate, renderDateNotice } from '../prompt/dateNotice'
import { createPromptExtensions } from '../prompt/sections'
import { answer, held, modelError, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import { frozenPrompt, lockPrompt } from './support/prompt'
import { allEntries, requestTexts, transcript } from './support/transcript'
import { waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const H = 3_600_000
const D1 = '2026-10-04'
const D2 = '2026-10-05'
const D3 = '2026-10-06'

function answerAt(text: string, timestamp: number): ReturnType<typeof answer> {
  return fauxAssistantMessage([fauxText(text)], { timestamp })
}

async function dateNotices(conversation: Conversation): Promise<EntryRecord[]> {
  return (await allEntries(conversation)).filter(
    (entry) => NoticeEntry.is(entry) && entry.data.kind === 'date'
  )
}

async function lastAnnounced(
  session: DurableSession,
  conversation: ConversationId = ROOT_CONVERSATION_ID
): Promise<string | undefined> {
  return (await session.harness.snapshot(AgentStateDoc, conversation, BG))?.lastAnnouncedDate
}

async function setLastAnnounced(session: DurableSession, date: string | undefined): Promise<void> {
  await session.harness.commit(async (tx) => {
    const state = await tx.doc(AgentStateDoc, ROOT_CONVERSATION_ID)
    if (date === undefined) delete state.lastAnnouncedDate
    else state.lastAnnouncedDate = date
  }, BG)
}

/** 把会话的当前对话指向 `id`（回退 fork 之后的形状） */
async function makeCurrent(session: DurableSession, id: ConversationId): Promise<void> {
  await session.harness.commit(async (tx) => {
    ;(await tx.doc(SessionStateDoc)).currentConversation = id
  }, BG)
}

/** 一轮完成的会话（不发日期通知的宿主） */
async function withOneTurn(): Promise<{ t: TestHost; session: DurableSession }> {
  const t = await makeHost()
  const session = await t.open()
  await primeRoot(session, t.kit)
  t.kit.queue(answer('a1'))
  expect(await session.submitUser('u1')).toEqual({})
  return { t, session }
}

/** 进程 1 在请求途中退出；进程 2 里重新打开的（被中断的）会话 */
async function interruptedSession(
  options: { today?: () => string; interruptedSendPolicy?: 'continue-then-queue' } = {}
): Promise<{ t: TestHost; session: DurableSession }> {
  const first = await makeHost()
  const session = await first.open()
  await primeRoot(session, first.kit)
  const stall = stalled()
  first.kit.queue(stall.step)
  void session.submitUser('hello')
  await stall.reached
  const t = await first.restart(options)
  const reopened = await t.open()
  expect(reopened.isInterrupted()).toBe(true)
  return { t, session: reopened }
}

/** 一个可以拨动的「今天」 */
function calendar(start: string): { today: () => string; set(date: string): void } {
  let current = start
  return {
    today: () => current,
    set: (date) => {
      current = date
    }
  }
}

describe('maybeAnnounceDate', () => {
  it('DA-01 entries + a new day → one shuvix.notice with the Q14 text, date data and the per-day requestId; the date is recorded; no model call', async () => {
    const { t, session } = await withOneTurn()
    await setLastAnnounced(session, D1)
    const now = Date.now()
    const conversation = await session.currentConversation()
    const calls = t.kit.callCount
    const result = await maybeAnnounceDate(session, conversation, {
      today: D2,
      now,
      lastActivityAt: now - 30 * H
    })
    const text = renderDateNotice(D2, now - 30 * H, now)
    expect(result).toEqual({
      status: 'announced',
      requestId: `shuvix:date:${ROOT_CONVERSATION_ID}:${D2}`,
      text
    })
    const notices = await dateNotices(conversation)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.kind).toBe('shuvix.notice')
    expect(notices[0]!.model?.[0]).toMatchObject({ role: 'user', content: text })
    expect(notices[0]!.data).toEqual({ kind: 'date', date: D2 })
    expect(
      await session.harness.commit(
        (tx) =>
          tx.submissionByRequest(ROOT_CONVERSATION_ID, `shuvix:date:${ROOT_CONVERSATION_ID}:${D2}`),
        BG
      )
    ).toBeDefined()
    expect(await lastAnnounced(session)).toBe(D2)
    expect(t.kit.callCount).toBe(calls)

    expect(await maybeAnnounceDate(session, conversation, { today: D2, now })).toEqual({
      status: 'current'
    })
    expect(await dateNotices(conversation)).toHaveLength(1)
  })

  it('DA-02 an empty conversation only records the date (the frozen persona carries it)', async () => {
    const t = await makeHost()
    const session = await t.open()
    const conversation = await session.currentConversation()
    expect(await maybeAnnounceDate(session, conversation, { today: D1, now: Date.now() })).toEqual({
      status: 'recorded'
    })
    expect(await allEntries(conversation)).toEqual([])
    expect(await lastAnnounced(session)).toBe(D1)
  })

  it('DA-03 entries without any recorded date (an older conversation) → announces once', async () => {
    const { session } = await withOneTurn()
    const conversation = await session.currentConversation()
    expect(await lastAnnounced(session)).toBeUndefined()
    const first = await maybeAnnounceDate(session, conversation, { today: D1, now: Date.now() })
    expect(first.status).toBe('announced')
    expect(
      (await maybeAnnounceDate(session, conversation, { today: D1, now: Date.now() })).status
    ).toBe('current')
    expect(await dateNotices(conversation)).toHaveLength(1)
  })

  it('DA-04 several days: one notice per day, in order, each with its own requestId; a date going backwards announces too', async () => {
    const { session } = await withOneTurn()
    await setLastAnnounced(session, D1)
    const conversation = await session.currentConversation()
    for (const today of [D2, D2, D3, D1]) {
      await maybeAnnounceDate(session, conversation, { today, now: Date.now() })
    }
    const notices = await dateNotices(conversation)
    expect(notices.map((entry) => (entry.data as { date: string }).date)).toEqual([D2, D3, D1])
    expect(await lastAnnounced(session)).toBe(D1)
  })

  it('DA-05 the first line of text uses the last message time found in the conversation when none is given', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const t0 = Date.now() - 50 * H
    t.kit.queue(answerAt('a1', t0))
    await session.submitUser('u1')
    await setLastAnnounced(session, D1)
    const result = await maybeAnnounceDate(session, await session.currentConversation(), {
      today: D2,
      now: t0 + 30 * H
    })
    expect(result.status).toBe('announced')
    expect((result as { text: string }).text).toBe(
      `<date-change>Today is ${D2} (Monday). The previous message in this conversation was about 30 hours ago.</date-change>`
    )
  })

  it('DA-06 crash retry: the notice was written but the date not recorded → no second notice, the date is recorded', async () => {
    const { session } = await withOneTurn()
    await setLastAnnounced(session, D1)
    const conversation = await session.currentConversation()
    const now = Date.now()
    await session.writeNotice({
      text: renderDateNotice(D2, undefined, now),
      kind: 'date',
      requestId: `shuvix:date:${ROOT_CONVERSATION_ID}:${D2}`,
      data: { date: D2 }
    })
    expect(await maybeAnnounceDate(session, conversation, { today: D2, now })).toEqual({
      status: 'recorded'
    })
    expect(await dateNotices(conversation)).toHaveLength(1)
    expect(await lastAnnounced(session)).toBe(D2)
  })

  it('DA-07 an interrupted session: the notice is deferred (no entry, no resume, no model call), the date recorded; a second call stores nothing more', async () => {
    const { t, session } = await interruptedSession()
    const conversation = await session.currentConversation()
    const now = Date.now()
    const result = await maybeAnnounceDate(session, conversation, { today: D2, now })
    expect(result.status).toBe('deferred')
    const text = (result as { text: string }).text
    expect((await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual([
      {
        requestId: `shuvix:date:${ROOT_CONVERSATION_ID}:${D2}`,
        text,
        kind: 'date',
        data: { date: D2 }
      }
    ])
    expect(await dateNotices(conversation)).toEqual([])
    expect(session.isInterrupted()).toBe(true)
    expect(t.kit.callCount).toBe(0)
    expect(await lastAnnounced(session)).toBe(D2)
    expect((await maybeAnnounceDate(session, conversation, { today: D2, now })).status).toBe(
      'current'
    )
    expect((await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toHaveLength(1)
  })

  it('DA-08 deferred notices are delivered by continue in arrival order, after the resumed answer', async () => {
    const { t, session } = await interruptedSession()
    const conversation = await session.currentConversation()
    expect((await session.writeNotice({ text: 'N1', kind: 'background' })).status).toBe('deferred')
    const result = await maybeAnnounceDate(session, conversation, { today: D2, now: Date.now() })
    const text = (result as { text: string }).text
    t.kit.queue(answer('resumed'))
    expect(await withTimeout(session.continue(), 5000, 'continue')).toEqual({})
    expect((await transcript(conversation)).slice(-3)).toEqual([
      'pi.assistant:resumed',
      'shuvix.notice:N1',
      `shuvix.notice:${text}`
    ])
    t.kit.queue(answer('next'))
    await session.submitUser('next')
    expect(requestTexts(t.kit, 1).slice(-3)).toEqual(['user:N1', `user:${text}`, 'user:next'])
    expect((await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual([])
  })

  it('DA-09 idle with a leftover failed input: deferred, then placed before the leftover and the next send', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
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
    expect(await first).toMatchObject({ code: 'model_error' })
    await setLastAnnounced(session, D1)
    const result = await maybeAnnounceDate(session, await session.currentConversation(), {
      today: D2,
      now: Date.now()
    })
    expect(result.status).toBe('deferred')
    t.kit.queue(answer('ok'))
    await session.submitUser('next')
    await leftover
    expect(requestTexts(t.kit, 1).slice(-3)).toEqual([
      `user:${(result as { text: string }).text}`,
      'user:F',
      'user:next'
    ])
  })

  it('DA-10 busy: the notice is submitted and lands after the held answer without a new run', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    await setLastAnnounced(session, D1)
    const run = held(answer('a1'))
    t.kit.queue(run.step)
    const sending = session.submitUser('u1')
    await run.reached
    const result = await maybeAnnounceDate(session, await session.currentConversation(), {
      today: D2,
      now: Date.now()
    })
    expect(result.status).toBe('announced')
    run.release()
    expect(await sending).toEqual({})
    await session.harness.waitForIdle(BG)
    const lines = await transcript(await session.currentConversation())
    expect(lines.slice(0, 2)).toEqual(['pi.user:u1', 'pi.assistant:a1'])
    expect(lines[2]).toMatch(/^shuvix\.notice:<date-change>/)
    expect(t.kit.callCount).toBe(1)
    expect(await lastAnnounced(session)).toBe(D2)
  })

  it('DA-11 per conversation: another conversation announces the same day with its own requestId', async () => {
    const { session } = await withOneTurn()
    const root = await session.currentConversation()
    await maybeAnnounceDate(session, root, { today: D2, now: Date.now() })
    const other = await session.harness.createConversation({ ownership: { kind: 'ownerless' } }, BG)
    await other.submit(
      { type: 'write', entry: noticeEntryDraft({ text: 'x', kind: 'background' }, Date.now()) },
      BG
    )
    // 不是当前对话：拒绝（否则通知会写进当前对话）
    await expect(maybeAnnounceDate(session, other, { today: D2, now: Date.now() })).rejects.toThrow(
      /not the current conversation/
    )
    await makeCurrent(session, other.id)
    const result = await maybeAnnounceDate(session, other, { today: D2, now: Date.now() })
    expect(result).toMatchObject({
      status: 'announced',
      requestId: `shuvix:date:${other.id}:${D2}`
    })
    expect(await dateNotices(root)).toHaveLength(1)
    expect(await dateNotices(other)).toHaveLength(1)
    expect(await lastAnnounced(session, other.id)).toBe(D2)
  })

  it('DA-12 a fork before the notice sees the old date and announces into the fork; the parent is untouched', async () => {
    const { t, session } = await withOneTurn()
    const root = await session.currentConversation()
    await maybeAnnounceDate(session, root, { today: D1, now: Date.now() })
    t.kit.queue(answer('a2'))
    await session.submitUser('u2')
    // a2：D1 的通知与它的日期都已落下，D2 还没有
    const between = (await allEntries(root))
      .filter((entry) => entry.kind === 'pi.assistant')
      .at(-1)!
    await maybeAnnounceDate(session, root, { today: D2, now: Date.now() })
    const parentBefore = await transcript(root)
    const fork = await root.fork(between.id, { ownership: { kind: 'ownerless' } }, BG)
    await makeCurrent(session, fork.id)
    expect(await lastAnnounced(session, fork.id)).toBe(D1)
    const result = await maybeAnnounceDate(session, fork, { today: D2, now: Date.now() })
    expect(result).toMatchObject({ status: 'announced', requestId: `shuvix:date:${fork.id}:${D2}` })
    expect(await transcript(root)).toEqual(parentBefore)
    expect((await dateNotices(fork)).map((entry) => (entry.data as { date: string }).date)).toEqual(
      [D1, D2]
    )
  })

  it('DA-13 a fork at the notice entry itself (rollback to edit the next message) does not announce the same day twice', async () => {
    const { session } = await withOneTurn()
    await setLastAnnounced(session, D1)
    const root = await session.currentConversation()
    await maybeAnnounceDate(session, root, { today: D2, now: Date.now() })
    const notice = (await dateNotices(root))[0]!
    const fork = await root.fork(notice.id, { ownership: { kind: 'ownerless' } }, BG)
    await makeCurrent(session, fork.id)
    // asOf = 通知条目提交时的文档值：日期是在之后的另一个提交里记的
    expect(await lastAnnounced(session, fork.id)).toBe(D1)
    expect(await maybeAnnounceDate(session, fork, { today: D2, now: Date.now() })).toEqual({
      status: 'recorded'
    })
    expect(await dateNotices(fork)).toHaveLength(1)
    expect(await lastAnnounced(session, fork.id)).toBe(D2)
  })
})

describe('date notice before a user input (DurableSession wiring)', () => {
  it('DW-01 off by default: no notices, nothing recorded, requests unchanged', async () => {
    const { t, session } = await withOneTurn()
    t.kit.queue(answer('a2'))
    await session.submitUser('u2')
    expect(await dateNotices(await session.currentConversation())).toEqual([])
    expect(await lastAnnounced(session)).toBeUndefined()
    expect(requestTexts(t.kit, 1)).toEqual(['user:u1', 'assistant:a1', 'user:u2'])
  })

  it('DW-02 the first send of a new day carries the notice right before the user message; the first send of a fresh conversation carries none', async () => {
    const day = calendar(D1)
    const t = await makeHost({ today: day.today })
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')
    t.kit.queue(answer('a1b'))
    await session.submitUser('u1b')
    expect(await dateNotices(await session.currentConversation())).toEqual([])
    expect(await lastAnnounced(session)).toBe(D1)

    day.set(D2)
    t.kit.queue(answer('a2'))
    expect(await session.submitUser('u2')).toEqual({})
    const lines = await transcript(await session.currentConversation())
    expect(lines.slice(-3)).toEqual([
      expect.stringMatching(/^shuvix\.notice:<date-change>Today is 2026-10-05 \(Monday\)\./),
      'pi.user:u2',
      'pi.assistant:a2'
    ])
    const last = requestTexts(t.kit, 2)
    expect(last.slice(-2)).toEqual([expect.stringMatching(/^user:<date-change>/), 'user:u2'])
    expect(t.kit.callCount).toBe(3)
  })

  it('DW-03 the gap is measured from the previous message with the injected clock', async () => {
    const day = calendar(D1)
    let clock = Date.now()
    const t = await makeHost({ today: day.today, now: () => clock })
    const session = await t.open()
    await primeRoot(session, t.kit)
    const t0 = clock
    t.kit.queue(answerAt('a1', t0))
    await session.submitUser('u1')
    day.set(D2)
    clock = t0 + 30 * H
    t.kit.queue(answer('a2'))
    await session.submitUser('u2')
    const [notice] = await dateNotices(await session.currentConversation())
    expect(notice!.model?.[0]).toMatchObject({
      content: `<date-change>Today is ${D2} (Monday). The previous message in this conversation was about 30 hours ago.</date-change>`
    })
  })

  it('DW-04 once per day across sends and a restart', async () => {
    const day = calendar(D1)
    const t = await makeHost({ today: day.today })
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')
    day.set(D2)
    for (const text of ['u2', 'u3']) {
      t.kit.queue(answer(`re:${text}`))
      await session.submitUser(text)
    }
    const t2 = await t.restart({ today: day.today })
    const reopened = await t2.open()
    await primeRoot(reopened, t2.kit)
    t2.kit.queue(answer('re:u4'))
    await reopened.submitUser('u4')
    expect(await dateNotices(await reopened.currentConversation())).toHaveLength(1)
  })

  it('DW-05 interrupted + abort-then-send: an earlier deferred notice, then the date notice, then the user message', async () => {
    const day = calendar(D2)
    const { t, session } = await interruptedSession({ today: day.today })
    expect((await session.writeNotice({ text: 'N', kind: 'background' })).status).toBe('deferred')
    t.kit.queue(answer('fresh'))
    expect(await session.submitUser('new')).toEqual({})
    const lines = await transcript(await session.currentConversation())
    expect(lines.slice(-4)).toEqual([
      'shuvix.notice:N',
      expect.stringMatching(/^shuvix\.notice:<date-change>Today is 2026-10-05/),
      'pi.user:new',
      'pi.assistant:fresh'
    ])
    expect(await dateNotices(await session.currentConversation())).toHaveLength(1)
    expect((await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual([])
  })

  it('DW-06 interrupted + continue-then-queue: the deferred date notice is placed before the queued user message', async () => {
    const day = calendar(D2)
    const { t, session } = await interruptedSession({
      today: day.today,
      interruptedSendPolicy: 'continue-then-queue'
    })
    expect((await session.writeNotice({ text: 'N', kind: 'background' })).status).toBe('deferred')
    t.kit.queue(answer('resumed'), answer('fresh'))
    expect(await withTimeout(session.submitUser('new'), 5000, 'submit')).toEqual({})
    const lines = await transcript(await session.currentConversation())
    const at = (predicate: (line: string) => boolean): number => lines.findIndex(predicate)
    const n = at((line) => line === 'shuvix.notice:N')
    const date = at((line) => line.startsWith('shuvix.notice:<date-change>'))
    const user = at((line) => line === 'pi.user:new')
    expect(n).toBeGreaterThanOrEqual(0)
    expect(n).toBeLessThan(date)
    expect(date).toBeLessThan(user)
  })

  it('DW-07 a busy rejection writes nothing; the next accepted send announces', async () => {
    const day = calendar(D1)
    const t = await makeHost({ today: day.today })
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')
    const run = held(answer('a2'))
    t.kit.queue(run.step)
    const sending = session.submitUser('u2')
    await run.reached
    day.set(D2)
    expect(await session.submitUser('x')).toEqual({
      error: 'The conversation is busy',
      code: 'busy'
    })
    expect((await session.harness.snapshot(InboxDoc, ROOT_CONVERSATION_ID, BG))?.items).toEqual([])
    expect(await lastAnnounced(session)).toBe(D1)
    run.release()
    expect(await sending).toEqual({})
    t.kit.queue(answer('a3'))
    await session.submitUser('u3')
    const lines = await transcript(await session.currentConversation())
    expect(lines.slice(-3)).toEqual([
      expect.stringMatching(/^shuvix\.notice:<date-change>/),
      'pi.user:u3',
      'pi.assistant:a3'
    ])
  })

  it('DW-08 busy with whenBusy followUp: the notice is queued and lands before the follow-up', async () => {
    const day = calendar(D1)
    const t = await makeHost({ today: day.today })
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a0'))
    await session.submitUser('u0')
    const run = held(answer('a1'))
    t.kit.queue(run.step, answer('a2'))
    const sending = session.submitUser('u1')
    await run.reached
    day.set(D2)
    const follow = session.submitUser('f', { whenBusy: 'followUp' })
    await waitFor(async () => {
      const inbox = await session.harness.snapshot(InboxDoc, ROOT_CONVERSATION_ID, BG)
      return (inbox?.items.length ?? 0) === 2
    })
    run.release()
    expect(await sending).toEqual({})
    expect(await follow).toEqual({})
    const lines = await transcript(await session.currentConversation())
    expect(lines.slice(-4)).toEqual([
      'pi.assistant:a1',
      expect.stringMatching(/^shuvix\.notice:<date-change>/),
      'pi.user:f',
      'pi.assistant:a2'
    ])
  })

  it('DW-09 two channels: the date reaches the model as a notice, never through the system prompt', async () => {
    const day = calendar(D1)
    const t = await makeHost({ today: day.today })
    const prompt = createPromptExtensions({ resolveProjectPrompt: () => 'Acme.' })
    for (const extension of prompt.all) t.registry.install(extension)
    const session = await t.open()
    const conversation = await session.currentConversation()
    await lockPrompt(
      conversation,
      t.kit,
      frozenPrompt({ persona: `Today: ${D1}.`, instructionFiles: [] }),
      [prompt.get('shuvix.prompt.persona'), prompt.get('shuvix.prompt.project-prompt')]
    )
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')
    day.set(D2)
    t.kit.queue(answer('a2'))
    await session.submitUser('u2')
    const systems = (await allEntries(conversation)).filter((entry) => SystemEntry.is(entry))
    expect(systems).toHaveLength(1)
    const second = t.kit.requests[1]!.messages
    expect(getCurrentSystemPrompt(second)).toBe(
      `Today: ${D1}.\n\n<project_prompt>\nAcme.\n</project_prompt>`
    )
    expect(requestTexts(t.kit, 1).slice(-2)).toEqual([
      expect.stringContaining(`Today is ${D2}`),
      'user:u2'
    ])
  })

  it('DW-10 the notice goes to the current conversation (a rollback fork), not the root', async () => {
    const day = calendar(D1)
    const t = await makeHost({ today: day.today })
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')
    const root = await session.currentConversation()
    const userEntry = (await allEntries(root)).find((entry) => entry.kind === 'pi.user')!
    const fork = await root.fork(userEntry.id, { ownership: { kind: 'ownerless' } }, BG)
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
    }, BG)
    await fork.configure({ model: t.kit.model }, BG)
    day.set(D2)
    t.kit.queue(answer('a2'))
    await session.submitUser('u2')
    const notices = await dateNotices(fork)
    expect(notices).toHaveLength(1)
    expect(await dateNotices(root)).toEqual([])
    expect(
      await session.harness.commit(
        (tx) => tx.submissionByRequest(fork.id, `shuvix:date:${fork.id}:${D2}`),
        BG
      )
    ).toBeDefined()
  })

  it('DW-11 a date provider that throws: the send goes through without a notice, a warning is logged', async () => {
    const t = await makeHost({
      today: () => {
        throw new Error('clock broke')
      }
    })
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'), answer('a2'))
    expect(await session.submitUser('u1')).toEqual({})
    expect(await session.submitUser('u2')).toEqual({})
    expect(await dateNotices(await session.currentConversation())).toEqual([])
    expect(t.warnings.some((warning) => warning.includes('clock broke'))).toBe(true)
  })

  it('DW-12 an idle followUp / steer starting a turn on a new day is announced too', async () => {
    const day = calendar(D1)
    const t = await makeHost({ today: day.today })
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')
    day.set(D2)
    t.kit.queue(answer('a2'))
    const admitted = await session.followUp('f')
    expect(admitted.submissionId).toBeDefined()
    await session.harness.waitForIdle(BG)
    const lines = await transcript(await session.currentConversation())
    expect(lines.slice(-3)).toEqual([
      expect.stringMatching(/^shuvix\.notice:<date-change>/),
      'pi.user:f',
      'pi.assistant:a2'
    ])
  })
})
