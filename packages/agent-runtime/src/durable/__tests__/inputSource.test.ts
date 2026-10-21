/**
 * WP2 · 用户输入的来源（`inputSource.ts`，docs/sub-session-design.md §19.7）：一条 `pi.user` 不是人亲手打的
 * 时候它是谁写的 —— 父会话代用户发进子会话的消息与引导。发送时随提交写进 `SourceDoc[requestId]`，读的时候
 * 按 requestId 找 submission、再落到活上下文里的那条条目上。「没有记录」不等于「人打的」—— 谁写的由 `authorsOf`
 * 判（2026-10-17 裁决）；文档里有这一项、形状却认不出 → 照样算有记录（失败闭合，sessionId 补空串）。
 *
 *   SRC-01 (WP2-33)       `inputSourceOf` 的形状判别
 *   SRC-02..05 (34..38)   submitUser：键是条目 id 的字符串形；只有带来源的那条；不补种；自动生成 requestId 的边界
 *   SRC-06 / 07 (39 / 40) 手写侧车：形状不对的照样算来源（失败闭合）；不在活上下文里的不出现
 *   SRC-08 (41)           忙时被拒的发送不出现
 *   SRC-09..13 (42..46)   steer / followUp：放下之后才出现；自动生成 requestId；不带来源时形状不变；幂等
 *   SRC-14 / 15 (47 / 48) 重新挂上不再写；撤回的排队输入不出现
 *   SRC-16..18 (49..51)   压缩切点之前、fork 的旧分支、别的对话都不出现；fork 继承前缀（asOf），重开照旧
 *   SRC-19 / 20 (52 / 53) 显示侧车与来源记在同一个 requestId 下；title: undefined 不落盘
 *   SRC-21 / 22 (54 / 55) 关掉的句柄；只读（零发布、不建 agent、不送达推迟的通知、被中断的照样停着）
 *   SRC-23 (56)           不依赖 Node、从包入口导出
 *   AUTH-01..07           `authorsOf`：第一条有记录的之前 / 之后，大纲、审查、`user-intervened` 共用的那一份判法
 *   XS-08                 `kind: 'session'`（经会话权限表被授权的别的会话发进来的，2026-10-20）：形状判别与父会话同一套
 *   SRC-24..27            每条输入都记来源之后（`InputOrigin`，2026-10-21）：人打的来源（本机 / 远程 / Chrome / Telegram）
 *                         读者一律跳过 —— 与「没有记录」一样；形状不对的人打来源照样失败闭合；真发送上人打的来源写进了
 *                         SourceDoc，读出来却与不带来源的同一串一模一样；显示侧车与来源同一个提交、同一个 requestId
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type EntryRecord,
  type JsonObject
} from '@earendil-works/pi-durable'
import type { InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import { describe, expect, it } from 'vitest'
import * as runtime from '../../index'
import { backgroundContext as BG } from '../context'
import { DisplayDoc, SessionStateDoc, SourceDoc, type DeferredNotice } from '../docs'
import type { AdmitResult, DurableSession } from '../durableSession'
import { SessionClosedError } from '../durableSession'
import {
  authorsOf,
  inputSourceOf,
  readInputSources,
  resolveInputSources,
  type MessageAuthor
} from '../inputSource'
import { readTranscriptDigest } from '../transcriptDigest'
import { recordPublications } from './support/commits'
import { appendEntries, assistantDraft, bg, compactionDraft, userDraft } from './support/digest'
import { answer, callTool, held, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import { forkedId } from './support/rollback'
import { holdTool } from './support/tools'
import { allEntries, messageText } from './support/transcript'
import { deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 15000
const SID = 'source'
const PARENT = { kind: 'parent-session', sessionId: 'P1', title: '重构 parser' } as const
const P1 = { kind: 'parent-session', sessionId: 'P1' } as const
/** 人在某个前端里打的（宿主按连接盖的章，chat-protocol `inputOrigin.ts`） */
const LOCAL = { kind: 'local' } as const
const REMOTE = {
  kind: 'remote',
  clientId: 'ws:4',
  address: '192.168.1.20',
  userAgent: 'UA'
} as const
const CHROME = { kind: 'chrome', installId: 'inst-1' } as const
const TELEGRAM = { kind: 'telegram', botId: 'b1', userId: 'u1', chatId: 'c1' } as const

async function openSession(): Promise<{ t: TestHost; session: DurableSession }> {
  const t = await makeHost({ ephemeral: [SID] })
  const session = await t.open(SID)
  await primeRoot(session)
  return { t, session }
}

/** 来源表：键 = 条目 id 的字符串形 */
function sources(session: DurableSession): Promise<Map<string, unknown>> {
  return readInputSources(session)
}

/** 当前对话里文本恰为 `text` 的那条 user 条目 */
async function userEntry(session: DurableSession, text: string): Promise<EntryRecord> {
  const found = (await allEntries(await session.currentConversation())).filter(
    (entry) => entry.kind === 'pi.user' && messageText(entry.model?.[0]) === text
  )
  expect(found, `user entry ${text}`).toHaveLength(1)
  return found[0]!
}

async function sourceDoc(
  session: DurableSession,
  conversationId?: ConversationId
): Promise<{ items: Record<string, JsonObject> } | undefined> {
  const id = conversationId ?? (await session.currentConversation()).id
  return session.harness.snapshot(SourceDoc, id, BG)
}

/** 一轮在工具上被扣住的会话：`release()` 之后这一轮跑完 */
async function heldRound(): Promise<{
  t: TestHost
  session: DurableSession
  sending: Promise<unknown>
  release: () => void
}> {
  const gate = deferred()
  const running = deferred()
  const t = await makeHost({
    ephemeral: [SID],
    tools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
  })
  const session = await t.open(SID)
  await primeRoot(session)
  t.kit.queue(callTool('hold'), answer('done'))
  const sending = session.submitUser('go')
  await running.promise
  return { t, session, sending, release: () => gate.resolve() }
}

describe('SRC · inputSourceOf（WP2-33）', () => {
  it.each([
    ['父会话（三键）', PARENT, PARENT],
    ['没有 title（两键）', P1, P1],
    ['title 不是字符串 → 丢掉 title', { ...P1, title: 7 }, P1],
    ['额外字段 → 只留三键', { ...PARENT, trusted: true, evil: 'x' }, PARENT],
    ['kind user', { kind: 'user', sessionId: 'P1' }, undefined],
    ['sessionId 空串', { kind: 'parent-session', sessionId: '' }, undefined],
    ['sessionId 是数字', { kind: 'parent-session', sessionId: 42 }, undefined],
    ['缺 sessionId', { kind: 'parent-session' }, undefined],
    ['null', null, undefined],
    ['字符串', 'str', undefined],
    ['数组', [], undefined],
    ['undefined', undefined, undefined]
  ] as const)('SRC-01 WP2-33 %s', (_label, item, expected) => {
    expect(inputSourceOf(item)).toStrictEqual(expected)
  })

  it.each([
    ['local', LOCAL],
    ['local 带 sessionId（伪装不成会话）', { kind: 'local', sessionId: 'P1' }],
    ['remote', REMOTE],
    ['chrome（光秃秃）', { kind: 'chrome' }],
    ['chrome 带 installId', CHROME],
    ['telegram', TELEGRAM],
    ['形状不对的 remote', { kind: 'remote' }],
    ['形状不对的 telegram', { kind: 'telegram', botId: 'b' }],
    ['remote 带 sessionId', { ...REMOTE, sessionId: 'P1', title: 'T' }]
  ] as const)(
    'SRC-24 人打的来源（含形状不对的）不是驱动它的会话 → undefined：%s',
    (_label, item) => {
      expect(inputSourceOf(item)).toBeUndefined()
    }
  )
})

/**
 * XS-08 别的会话（不是父会话）发进来的消息：来源 `kind: 'session'`。形状判别与 `parent-session` 同一套 ——
 * 三键原样、非字符串 title 丢掉、空 sessionId 认不出；真发送上记下的就是这三键。
 */
describe('XS-08 · inputSourceOf × kind session', () => {
  const OTHER = { kind: 'session', sessionId: 'X', title: 'T' } as const
  it.each([
    ['三键原样', OTHER, OTHER],
    [
      '没有 title（两键）',
      { kind: 'session', sessionId: 'X' },
      { kind: 'session', sessionId: 'X' }
    ],
    ['title 是数字 → 丢掉 title', { ...OTHER, title: 5 }, { kind: 'session', sessionId: 'X' }],
    ['额外字段 → 只留三键', { ...OTHER, trusted: true }, OTHER],
    ['sessionId 空串', { kind: 'session', sessionId: '' }, undefined],
    ['sessionId 不是字符串', { kind: 'session', sessionId: 7 }, undefined],
    ['kind 大小写不对', { kind: 'Session', sessionId: 'X' }, undefined]
  ] as const)('XS-08 %s', (_label, item, expected) => {
    expect(inputSourceOf(item)).toStrictEqual(expected)
  })

  it('XS-08 真发送：带 kind session 来源的那条落进来源表，原样三键', async () => {
    const { t, session } = await openSession()
    t.kit.queue(answer('a1'), answer('a2'))
    expect(await session.submitUser('typed')).toEqual({})
    expect(await session.submitUser('from X', { source: OTHER })).toEqual({})
    expect([...(await sources(session)).entries()]).toStrictEqual([
      [String((await userEntry(session, 'from X')).id), OTHER]
    ])
  })
})

describe('SRC · submitUser', () => {
  it('SRC-02 WP2-34 a driven send with a source: exactly one item, keyed by the user entry id as a string', async () => {
    const { t, session } = await openSession()
    t.kit.queue(answer('A1'))
    expect(
      await session.submitUser('task', {
        requestId: 'subsession:P1:7',
        driven: { parentId: 'P1', background: false },
        source: P1
      })
    ).toEqual({})
    const user = await userEntry(session, 'task')
    const map = await sources(session)
    expect([...map.keys()]).toStrictEqual([String(user.id)])
    for (const key of map.keys()) expect(typeof key).toBe('string')
    expect(map.get(String(user.id))).toStrictEqual(P1)
  })

  it('SRC-03 WP2-35 human / parent / human: only the parent’s entry is in the map', async () => {
    const { t, session } = await openSession()
    t.kit.queue(answer('a1'), answer('a2'), answer('a3'))
    expect(await session.submitUser('h1')).toEqual({})
    expect(await session.submitUser('p1', { source: PARENT })).toEqual({})
    expect(await session.submitUser('h2')).toEqual({})
    const map = await sources(session)
    expect([...map.entries()]).toStrictEqual([
      [String((await userEntry(session, 'p1')).id), PARENT]
    ])
  })

  it('SRC-04 WP2-36 a session that never recorded a source: empty map, no throw, and no SourceDoc is seeded (not by creating the conversation, not by sends without a source)', async () => {
    const { t, session } = await openSession()
    expect(await sources(session)).toEqual(new Map())
    expect(await sourceDoc(session)).toBeUndefined()
    t.kit.queue(answer('a1'), answer('a2'))
    expect(await session.submitUser('typed')).toEqual({})
    expect(await session.submitUser('typed again', { requestId: 'r-human' })).toEqual({})
    expect(await sources(session)).toEqual(new Map())
    expect(await sourceDoc(session)).toBeUndefined()
  })

  it('SRC-05a WP2-37 a source without a requestId gets one generated: two sends, two distinct non-empty keys, both entries in the map', async () => {
    const { t, session } = await openSession()
    t.kit.queue(answer('a1'), answer('a2'))
    expect(await session.submitUser('p-one', { source: PARENT })).toEqual({})
    expect(await session.submitUser('p-two', { source: PARENT })).toEqual({})
    const keys = Object.keys((await sourceDoc(session))!.items)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
    for (const key of keys) expect(key).not.toBe('')
    const records = await session.harness.commit(
      async (tx) =>
        Promise.all(keys.map((key) => tx.submissionByRequest(ROOT_CONVERSATION_ID, key))),
      BG
    )
    const one = await userEntry(session, 'p-one')
    const two = await userEntry(session, 'p-two')
    expect(records.map((record) => record?.entry).sort()).toEqual([one.id, two.id].sort())
    expect(await sources(session)).toStrictEqual(
      new Map([
        [String(one.id), PARENT],
        [String(two.id), PARENT]
      ])
    )
  })

  it('SRC-05b WP2-38 no source → no SourceDoc write; a plain send keeps having no requestId (generation only happens for a source / display)', async () => {
    const { t, session } = await openSession()
    t.kit.queue(answer('a1'))
    expect(await session.submitUser('x', { requestId: 'r1' })).toEqual({})
    expect(await sourceDoc(session)).toBeUndefined()

    const run = held(answer('a2'))
    t.kit.queue(run.step)
    const sending = session.submitUser('y')
    await run.reached
    const live = (await session.harness.inspect(BG)).submissions
    expect(live).toHaveLength(1)
    expect(live[0]!.requestId).toBeUndefined()
    run.release()
    expect(await sending).toEqual({})
    expect(await sourceDoc(session)).toBeUndefined()
    expect(await sources(session)).toEqual(new Map())
  })
})

describe('SRC · hand-written sidecars', () => {
  /** 往当前对话写 SourceDoc 项 + user 条目 + 放下的 submission（按 requestId → 条目） */
  async function writeSourced(
    session: DurableSession,
    items: Record<string, unknown>,
    drafts: { requestId: string; text: string }[]
  ): Promise<Map<string, EntryRecord>> {
    const conversation = await session.currentConversation()
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(SourceDoc, conversation.id)
      for (const [key, value] of Object.entries(items)) doc.items[key] = value as JsonObject
    }, BG)
    const records = await appendEntries(
      session,
      drafts.map(({ text }) => userDraft(text, 1))
    )
    await session.harness.commit(async (tx) => {
      for (const [index, { requestId }] of drafts.entries()) {
        await tx.createSubmission({
          conversationId: conversation.id,
          requestId,
          type: 'input',
          status: 'placed',
          entry: records[index]!.id
        })
      }
    }, BG)
    return new Map(drafts.map(({ requestId }, index) => [requestId, records[index]!]))
  }

  it('SRC-06 WP2-39 malformed items still count as sources (fail-closed, 2026-10-17 ruling): an empty-sessionId parent source on their entries — never the bad item’s own fields; r-ok keeps its shape; no throw', async () => {
    const t = await makeHost({ ephemeral: [SID] })
    const session = await t.open(SID)
    const bad = {
      'r-no-session': { kind: 'parent-session' },
      'r-other-kind': { kind: 'other', sessionId: 'P' },
      'r-newer-kind': { kind: 'hook', sessionId: 'H1', title: 'from a newer version' },
      'r-numeric': { kind: 'parent-session', sessionId: 42 },
      'r-empty': { kind: 'parent-session', sessionId: '' }
    }
    const byRequest = await writeSourced(session, { ...bad, 'r-ok': PARENT }, [
      ...Object.keys(bad).map((requestId) => ({ requestId, text: requestId })),
      { requestId: 'r-ok', text: 'ok' }
    ])
    const unknown = { kind: 'parent-session', sessionId: '' }
    expect(await sources(session)).toStrictEqual(
      new Map<string, unknown>([
        ...Object.keys(bad).map((requestId): [string, unknown] => [
          String(byRequest.get(requestId)!.id),
          unknown
        ]),
        [String(byRequest.get('r-ok')!.id), PARENT]
      ])
    )
  })

  it('SRC-07 WP2-40 items that do not land on a live user entry never show: no submission / never placed / placed on a non-user entry', async () => {
    const t = await makeHost({ ephemeral: [SID] })
    const session = await t.open(SID)
    const conversation = await session.currentConversation()
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(SourceDoc, conversation.id)
      doc.items['r-orphan'] = PARENT
      doc.items['r-unplaced'] = PARENT
      doc.items['r-assistant'] = PARENT
    }, BG)
    const [, reply] = await appendEntries(session, [
      userDraft('typed by hand', 1),
      assistantDraft('reply', 2)
    ])
    await session.harness.commit(async (tx) => {
      await tx.createSubmission({
        conversationId: conversation.id,
        requestId: 'r-unplaced',
        type: 'input',
        status: 'unanswered',
        reason: 'aborted'
      })
      await tx.createSubmission({
        conversationId: conversation.id,
        requestId: 'r-assistant',
        type: 'input',
        status: 'placed',
        entry: reply!.id
      })
    }, BG)
    expect(await sources(session)).toEqual(new Map())
  })

  it('SRC-25 human origins are skipped like “no record”; a malformed human origin or an unknown kind still fails closed; a parent source keeps its shape', async () => {
    const t = await makeHost({ ephemeral: [SID] })
    const session = await t.open(SID)
    const skipped = {
      'r-local': LOCAL,
      'r-remote': REMOTE,
      'r-chrome': { kind: 'chrome' },
      'r-telegram': TELEGRAM,
      'r-local-extra': { kind: 'local', sessionId: 'P1' }
    }
    const failClosed = {
      'r-remote-bare': { kind: 'remote' },
      'r-telegram-partial': { kind: 'telegram', botId: 'b' },
      'r-hook': { kind: 'hook', sessionId: 'H1', title: 'from a newer version' }
    }
    const byRequest = await writeSourced(
      session,
      { ...skipped, ...failClosed, 'r-parent': PARENT },
      [...Object.keys(skipped), ...Object.keys(failClosed), 'r-parent'].map((requestId) => ({
        requestId,
        text: requestId
      }))
    )
    const unknown = { kind: 'parent-session', sessionId: '' }
    const map = await sources(session)
    expect(map).toStrictEqual(
      new Map<string, unknown>([
        ...Object.keys(failClosed).map((requestId): [string, unknown] => [
          String(byRequest.get(requestId)!.id),
          unknown
        ]),
        [String(byRequest.get('r-parent')!.id), PARENT]
      ])
    )
    for (const requestId of Object.keys(skipped)) {
      expect(map.has(String(byRequest.get(requestId)!.id)), requestId).toBe(false)
    }
  })
})

describe('SRC · refused sends', () => {
  it('SRC-08 WP2-41 a send refused as busy (requestId + source, whenBusy reject) never shows in the map', async () => {
    const { t, session } = await openSession()
    const run = held(answer('a1'))
    t.kit.queue(run.step)
    const first = session.submitUser('u1')
    await run.reached
    expect(
      await session.submitUser('refused', {
        requestId: 'subsession:P1:8',
        whenBusy: 'reject',
        source: P1
      })
    ).toMatchObject({ code: 'busy' })
    run.release()
    expect(await first).toEqual({})
    // SourceDoc 里可能留着一条孤儿项（可疑点 6，接受）—— 解析时过滤掉，这里只钉住它不出现
    expect(await sources(session)).toEqual(new Map())
  })
})

describe('SRC · steer / followUp', () => {
  it(
    'SRC-09 WP2-42 a steer with a source: absent while it waits in the inbox, present once placed',
    async () => {
      const { session, sending, release } = await heldRound()
      const steer = await session.steer('go left', {
        requestId: 'subsession-steer:P1:9',
        source: PARENT
      })
      expect(steer.submissionId).toBeDefined()
      expect(await sources(session)).toEqual(new Map())
      release()
      expect(await withTimeout(sending, 5000, 'round')).toEqual({})
      const entry = await userEntry(session, 'go left')
      expect(await sources(session)).toStrictEqual(new Map([[String(entry.id), PARENT]]))
    },
    TIMEOUT
  )

  it(
    'SRC-10 WP2-43 a steer with a source and no requestId gets one generated; placed → in the map',
    async () => {
      const { session, sending, release } = await heldRound()
      const steer = await session.steer('x', { source: PARENT })
      expect(steer.submissionId).toBeDefined()
      const record = await (await session.harness.submission(steer.submissionId!, BG))!.status(BG)
      expect(typeof record.requestId).toBe('string')
      expect(record.requestId).not.toBe('')
      expect(Object.keys((await sourceDoc(session))!.items)).toEqual([record.requestId])
      release()
      expect(await withTimeout(sending, 5000, 'round')).toEqual({})
      const entry = await userEntry(session, 'x')
      expect(await sources(session)).toStrictEqual(new Map([[String(entry.id), PARENT]]))
    },
    TIMEOUT
  )

  it(
    'SRC-11 WP2-44 a plain steer (the UI’s shape) writes no SourceDoc and carries no requestId',
    async () => {
      const { session, sending, release } = await heldRound()
      const steer = await session.steer('x')
      const record = await (await session.harness.submission(steer.submissionId!, BG))!.status(BG)
      expect(record.requestId).toBeUndefined()
      release()
      expect(await withTimeout(sending, 5000, 'round')).toEqual({})
      expect(await sourceDoc(session)).toBeUndefined()
      expect(await sources(session)).toEqual(new Map())
    },
    TIMEOUT
  )

  it(
    'SRC-12 WP2-45 a follow-up with a source shares the admit options: in the map once placed',
    async () => {
      const { t, session } = await openSession()
      const run = held(answer('a1'))
      t.kit.queue(run.step, answer('a2'))
      const first = session.submitUser('u1')
      await run.reached
      const followUp = await session.followUp('later', { source: PARENT })
      expect(followUp.submissionId).toBeDefined()
      run.release()
      expect(await first).toEqual({})
      const submission = await session.harness.submission(followUp.submissionId!, BG)
      expect((await withTimeout(submission!.wait(BG), 5000, 'follow-up')).status).toBe('done')
      const entry = await userEntry(session, 'later')
      expect(await sources(session)).toStrictEqual(new Map([[String(entry.id), PARENT]]))
    },
    TIMEOUT
  )

  it(
    'SRC-13 WP2-46 the same requestId + source steered twice: one submission, one entry, one item',
    async () => {
      const { session, sending, release } = await heldRound()
      const options = { requestId: 'subsession-steer:P1:10', source: PARENT }
      const a = await session.steer('twice', options)
      const b = await session.steer('twice', options)
      expect(a.submissionId).toBeDefined()
      expect(b.submissionId).toBe(a.submissionId)
      release()
      expect(await withTimeout(sending, 5000, 'round')).toEqual({})
      const entry = await userEntry(session, 'twice')
      expect(Object.keys((await sourceDoc(session))!.items)).toEqual(['subsession-steer:P1:10'])
      expect(await sources(session)).toStrictEqual(new Map([[String(entry.id), PARENT]]))
    },
    TIMEOUT
  )
})

describe('SRC · reattach and withdraw', () => {
  it('SRC-14 WP2-47 reattaching a settled driven send writes nothing: no new entry, the stored source keeps its value', async () => {
    const { t, session } = await openSession()
    t.kit.queue(answer('A1'))
    const options = {
      requestId: 'subsession:P1:11',
      driven: { parentId: 'P1', background: true },
      source: P1
    }
    expect(await session.submitUser('task', options)).toEqual({})
    const before = await sources(session)
    const entries = (await allEntries(await session.currentConversation())).length
    expect(
      await session.submitUser('task', {
        ...options,
        source: { kind: 'parent-session', sessionId: 'P1', title: 'renamed' }
      })
    ).toEqual({})
    expect((await allEntries(await session.currentConversation())).length).toBe(entries)
    expect((await sourceDoc(session))!.items).toStrictEqual({ 'subsession:P1:11': P1 })
    expect(await sources(session)).toStrictEqual(before)
  })

  it(
    'SRC-15 WP2-48 a queued steer with a source that is withdrawn never shows',
    async () => {
      const { t, session } = await openSession()
      const run = held(answer('a1'))
      t.kit.queue(run.step)
      const first = session.submitUser('u1')
      await run.reached
      const queued = await session.steer('never mind', { source: PARENT })
      expect(await session.withdrawQueued(queued.submissionId!)).toBe('aborted')
      run.release()
      expect(await first).toEqual({})
      expect(await sources(session)).toEqual(new Map())
    },
    TIMEOUT
  )
})

describe('SRC · compaction, forks, other conversations', () => {
  it('SRC-16 WP2-49 after a compaction only the kept window’s sourced entry shows', async () => {
    const { t, session } = await openSession()
    t.kit.queue(answer('a-old'), answer('a-kept'))
    expect(await session.submitUser('old', { source: PARENT })).toEqual({})
    expect(await session.submitUser('kept', { source: PARENT })).toEqual({})
    const kept = await userEntry(session, 'kept')
    await appendEntries(session, [compactionDraft(kept.id, 'S', 9)])
    expect(await sources(session)).toStrictEqual(new Map([[String(kept.id), PARENT]]))
  })

  it(
    'SRC-17 WP2-50 a rollback fork inherits the prefix’s sources (asOf), not the old branch’s; a new sourced send on the fork shows; a reopen reads the same',
    async () => {
      const t = await makeHost()
      const session = await t.open('s1')
      await primeRoot(session)
      t.kit.queue(answer('A1'), answer('A2'), answer('A3'), answer('A4'))
      expect(await session.submitUser('U1')).toEqual({})
      expect(await session.submitUser('U2', { source: PARENT })).toEqual({})
      expect(await session.submitUser('U3', { source: PARENT })).toEqual({})
      const u2 = await userEntry(session, 'U2')
      const u3 = await userEntry(session, 'U3')

      const fork = forkedId(await session.rollbackTo(u3.id))
      expect((await session.currentConversation()).id).toBe(fork)
      expect(await sources(session)).toStrictEqual(new Map([[String(u2.id), PARENT]]))

      expect(await session.submitUser('U4', { source: P1 })).toEqual({})
      const u4 = await userEntry(session, 'U4')
      const expected = new Map<string, unknown>([
        [String(u2.id), PARENT],
        [String(u4.id), P1]
      ])
      expect(await sources(session)).toStrictEqual(expected)
      expect((await sources(session)).has(String(u3.id))).toBe(false)

      await t.host.close('s1')
      const reopened = await t.open('s1')
      expect(await sources(reopened)).toStrictEqual(expected)
    },
    TIMEOUT
  )

  it('SRC-18 WP2-51 another conversation in the same storage (a spawned agent’s) stays out: neither its own SourceDoc nor a root item whose submission lives there', async () => {
    const { t, session } = await openSession()
    t.kit.queue(answer('a1'))
    expect(await session.submitUser('root human')).toEqual({})
    const other = await session.harness.createConversation({ ownership: { kind: 'ownerless' } }, BG)
    const [task] = await appendEntries(session, [userDraft('child task', 5)], other.id)
    const root = await session.currentConversation()
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(SourceDoc, other.id)).items['r-other'] = PARENT
      ;(await tx.doc(SourceDoc, root.id)).items['r-elsewhere'] = PARENT
      await tx.createSubmission({
        conversationId: other.id,
        requestId: 'r-other',
        type: 'input',
        status: 'placed',
        entry: task!.id
      })
      await tx.createSubmission({
        conversationId: other.id,
        requestId: 'r-elsewhere',
        type: 'input',
        status: 'placed',
        entry: task!.id
      })
    }, BG)
    expect(await sources(session)).toEqual(new Map())
    // 对照：直接解析那条对话自己的条目，它的来源是读得到的（证明上面的空不是写错了）
    const view = await other.context(BG)
    const resolved = await resolveInputSources(session.harness, other.id, view.entries)
    expect([...resolved.entries()]).toStrictEqual([[task!.id, PARENT]])
  })
})

describe('SRC · sidecars together, stored shape', () => {
  it('SRC-19 WP2-52 display + source in one send: both sidecars under one requestId; the digest shows the display text, the source map points at the same entry', async () => {
    const { t, session } = await openSession()
    t.kit.queue(answer('a1'))
    const display = {
      content: 'run {{shuvixInlineToken:k1}}',
      tokens: { k1: { type: 'cmd', id: 'x', displayText: '/x', payload: 'PAYLOAD' } }
    }
    expect(await session.submitUser('run PAYLOAD', { display, source: PARENT })).toEqual({})
    const conversation = await session.currentConversation()
    const displayKeys = Object.keys(
      (await session.harness.snapshot(DisplayDoc, conversation.id, BG))!.items
    )
    expect(displayKeys).toHaveLength(1)
    expect(Object.keys((await sourceDoc(session))!.items)).toEqual(displayKeys)
    const entry = await userEntry(session, 'run PAYLOAD')
    const digest = (await readTranscriptDigest(session)).items
    // RSRC-30：摘要项的形状逐键钉住 —— 侧车原文 + 来源，展开后的 payload 不在任何一处
    expect(digest[0]).toStrictEqual({
      kind: 'user',
      ts: expect.any(Number),
      text: display.content,
      source: PARENT
    })
    expect(JSON.stringify(digest)).not.toContain('PAYLOAD')
    expect(await sources(session)).toStrictEqual(new Map([[String(entry.id), PARENT]]))
  })

  it('SRC-20 WP2-53 a source with title: undefined is stored without a title key', async () => {
    const { t, session } = await openSession()
    t.kit.queue(answer('a1'))
    expect(
      await session.submitUser('p', {
        requestId: 'r-untitled',
        source: { kind: 'parent-session', sessionId: 'P1', title: undefined }
      })
    ).toEqual({})
    const stored = (await sourceDoc(session))!.items['r-untitled']!
    expect(stored).not.toHaveProperty('title')
    expect(stored).toStrictEqual(P1)
    const entry = await userEntry(session, 'p')
    expect((await sources(session)).get(String(entry.id))).toStrictEqual(P1)
    // RSRC-30：摘要项上的来源同样没有 title 键
    const [item] = (await readTranscriptDigest(session)).items
    expect(item).toStrictEqual({ kind: 'user', ts: expect.any(Number), text: 'p', source: P1 })
    expect((item as { source?: object }).source).not.toHaveProperty('title')
  })
})

describe('SRC · human origins on real sends (2026-10-21)', () => {
  /** 一条 steer / followUp 的提交跑完 */
  async function settled(session: DurableSession, admitted: AdmitResult): Promise<void> {
    expect(admitted.submissionId).toBeDefined()
    const submission = await session.harness.submission(admitted.submissionId!, BG)
    expect((await withTimeout(submission!.wait(BG), 5000, 'admitted input')).status).toBe('done')
  }

  /**
   * h1 / p1 / h2 用 submitUser，再在空闲时各来一条 steer、一条 followUp（各自起一轮）；`stamp` = 人打的那几条带不带
   * 宿主盖的章。返回当前对话里用户条目的 id（字符串形，旧 → 新）
   */
  async function sendFive(t: TestHost, session: DurableSession, stamp: boolean): Promise<string[]> {
    const human = (origin: InputOrigin): { source?: InputOrigin } =>
      stamp ? { source: origin } : {}
    t.kit.queue(answer('a1'), answer('a2'), answer('a3'), answer('a4'), answer('a5'))
    expect(await session.submitUser('h1', human(LOCAL))).toEqual({})
    expect(await session.submitUser('p1', { source: PARENT })).toEqual({})
    expect(await session.submitUser('h2', human(REMOTE))).toEqual({})
    await settled(session, await session.steer('s-idle', human(CHROME)))
    await settled(session, await session.followUp('f-idle', human(TELEGRAM)))
    const users = (await allEntries(await session.currentConversation())).filter(
      (entry) => entry.kind === 'pi.user'
    )
    expect(users.map((entry) => messageText(entry.model?.[0]))).toStrictEqual([
      'h1',
      'p1',
      'h2',
      's-idle',
      'f-idle'
    ])
    return users.map((entry) => String(entry.id))
  }

  it(
    'SRC-26 human origins are written to SourceDoc yet read exactly like sends without a source: the map is {p1 → PARENT}, authorsOf gives the same answers with and without topLevel, identical to a twin whose human sends carry no source',
    async () => {
      const t = await makeHost({ ephemeral: [SID, 'twin'] })
      const stamped = await t.open(SID)
      await primeRoot(stamped)
      const twin = await t.open('twin')
      await primeRoot(twin)
      const users = await sendFive(t, stamped, true)
      const twinUsers = await sendFive(t, twin, false)

      // 人打的来源都写进去了（每条输入都记，2026-10-21），原样
      expect(Object.values((await sourceDoc(stamped))!.items)).toStrictEqual([
        LOCAL,
        PARENT,
        REMOTE,
        CHROME,
        TELEGRAM
      ])
      expect(Object.values((await sourceDoc(twin))!.items)).toStrictEqual([PARENT])

      const read = async (
        session: DurableSession,
        ids: string[]
      ): Promise<{
        map: [number, unknown][]
        authors: (MessageAuthor | undefined)[]
        topLevel: (MessageAuthor | undefined)[]
      }> => {
        const map = await sources(session)
        const plain = authorsOf(ids, (id) => map.has(id))
        const top = authorsOf(ids, (id) => map.has(id), { topLevel: true })
        return {
          map: [...map].map(([id, source]): [number, unknown] => [ids.indexOf(id), source]),
          authors: ids.map((id) => plain.get(id)),
          topLevel: ids.map((id) => top.get(id))
        }
      }
      const got = await read(stamped, users)
      expect([...(await sources(stamped))]).toStrictEqual([[users[1], PARENT]])
      expect(got).toStrictEqual({
        map: [[1, PARENT]],
        authors: ['unknown', 'parent', 'human', 'human', 'human'],
        topLevel: ['human', 'parent', 'human', 'human', 'human']
      })
      expect(await read(twin, twinUsers)).toStrictEqual(got)
    },
    TIMEOUT
  )

  it(
    'SRC-27 the display sidecar and the origin go in one commit under the submission’s requestId; a source-only send touches no DisplayDoc; a steer’s item is keyed by its submission’s requestId',
    async () => {
      const { t, session } = await openSession()
      const conversation = await session.currentConversation()
      const SOURCE = `shuvix.source#${conversation.id}`
      const DISPLAY = `shuvix.display#${conversation.id}`
      const display = {
        content: 'run {{shuvixInlineToken:k1}}',
        tokens: { k1: { type: 'cmd', id: 'x', displayText: '/x', payload: 'PAYLOAD' } }
      }
      t.kit.queue(answer('a1'), answer('a2'))

      const both = recordPublications(session.harness)
      expect(await session.submitUser('run PAYLOAD', { display, source: LOCAL })).toEqual({})
      both.stop()
      const touching = both.touching(SOURCE)
      expect(touching).toHaveLength(1)
      expect(touching[0]!.docs).toContain(DISPLAY)
      expect(both.touching(DISPLAY)).toStrictEqual(touching)
      const sourceKeys = Object.keys((await sourceDoc(session))!.items)
      const displayKeys = Object.keys(
        (await session.harness.snapshot(DisplayDoc, conversation.id, BG))!.items
      )
      expect(sourceKeys).toHaveLength(1)
      expect(displayKeys).toStrictEqual(sourceKeys)
      const record = await session.harness.commit(
        (tx) => tx.submissionByRequest(conversation.id, sourceKeys[0]!),
        BG
      )
      expect(record?.entry).toBe((await userEntry(session, 'run PAYLOAD')).id)

      const sourceOnly = recordPublications(session.harness)
      expect(await session.submitUser('plain', { source: REMOTE })).toEqual({})
      sourceOnly.stop()
      expect(sourceOnly.touching(SOURCE)).toHaveLength(1)
      expect(sourceOnly.touching(DISPLAY)).toEqual([])
      expect(Object.keys((await sourceDoc(session))!.items)).toHaveLength(2)

      // 引导（steer）：键 = 这次提交的 requestId
      const held = await heldRound()
      const steer = await held.session.steer('x', { source: LOCAL })
      const steerRecord = await (await held.session.harness.submission(
        steer.submissionId!,
        BG
      ))!.status(BG)
      expect(typeof steerRecord.requestId).toBe('string')
      expect(Object.keys((await sourceDoc(held.session))!.items)).toStrictEqual([
        steerRecord.requestId
      ])
      held.release()
      expect(await withTimeout(held.sending, 5000, 'round')).toEqual({})
      // 人打的：读者看不见
      expect(await sources(held.session)).toEqual(new Map())
    },
    TIMEOUT
  )
})

describe('SRC · closed handles and read-only', () => {
  it('SRC-21 WP2-54 a stale handle after host.close rejects with SessionClosedError and reopens nothing', async () => {
    const { t, session } = await openSession()
    t.kit.queue(answer('a1'))
    expect(await session.submitUser('p', { source: PARENT })).toEqual({})
    await t.host.close(SID)
    const open = t.host.openSessionIds()
    await expect(readInputSources(session)).rejects.toBeInstanceOf(SessionClosedError)
    expect(t.host.openSessionIds()).toEqual(open)
  })

  describe('SRC-22 WP2-55 read-only', () => {
    it('(a) an idle locked session: zero publications around the read, runState stays idle', async () => {
      const { t, session } = await openSession()
      t.kit.queue(answer('a1'))
      expect(await session.submitUser('p', { source: PARENT })).toEqual({})
      expect(session.lock).toBeDefined()
      const recorder = recordPublications(session.harness)
      expect((await sources(session)).size).toBe(1)
      await sleep(20)
      recorder.stop()
      expect(recorder.publications).toEqual([])
      expect(session.runState).toBe('idle')
    })

    it(
      '(b) an interrupted session stays interrupted: no request, no publication',
      async () => {
        const first = await makeHost()
        const crashed = await first.open()
        await primeRoot(crashed)
        const stall = stalled()
        first.kit.queue(stall.step)
        void crashed.submitUser('hello', { source: PARENT })
        await stall.reached
        const t = await first.restart()
        const session = await t.open()
        expect(session.isInterrupted()).toBe(true)

        const recorder = recordPublications(session.harness)
        const map = await sources(session)
        expect([...map.values()]).toStrictEqual([PARENT])
        await sleep(100)
        recorder.stop()
        expect(recorder.publications).toEqual([])
        expect(session.isInterrupted()).toBe(true)
        expect(session.runState).toBe('interrupted')
        expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
        expect(t.kit.callCount).toBe(0)
      },
      TIMEOUT
    )

    it('(c) an unlocked session with a deferred notice and a new day: no agent, nothing written, the notice stays deferred', async () => {
      let day = '2026-10-04'
      const t = await makeHost({ ephemeral: [SID], today: () => day })
      const session = await t.open(SID)
      const [typed] = await appendEntries(session, [userDraft('written by the parent', 1)])
      const conversation = await session.currentConversation()
      await session.harness.commit(async (tx) => {
        ;(await tx.doc(SourceDoc, conversation.id)).items['r1'] = PARENT
        await tx.createSubmission({
          conversationId: conversation.id,
          requestId: 'r1',
          type: 'input',
          status: 'placed',
          entry: typed!.id
        })
        ;(await tx.doc(SessionStateDoc)).deferredNotices.push({
          requestId: 'n1',
          text: bg('t1', 'done'),
          kind: 'background'
        })
      }, BG)
      day = '2026-10-05'
      const notices = async (): Promise<DeferredNotice[]> => [
        ...((await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices ?? [])
      ]
      const before = await notices()
      const recorder = recordPublications(session.harness)

      expect(await sources(session)).toStrictEqual(new Map([[String(typed!.id), PARENT]]))
      await sleep(20)
      recorder.stop()
      expect(recorder.publications).toEqual([])
      expect(session.lock).toBeUndefined()
      expect(t.configCalls).toEqual([])
      expect(await notices()).toEqual(before)
      const written = (await allEntries(await session.currentConversation())).map((e) => e.kind)
      expect(written).not.toContain('shuvix.notice')
      await waitFor(() => session.runState === 'idle', 500, 'still idle')
    })
  })

  it('SRC-23 WP2-56 Node-free source, exported from @shuvix/agent-runtime', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../inputSource.ts'), 'utf8')
    const specifiers = [...source.matchAll(/(?:from|import)\s+'([^']+)'/g)].map(
      (match) => match[1]!
    )
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/^node:/)
      expect(specifier).not.toMatch(/^(fs|path|os|electron)(\/|$)/)
      expect(specifier).not.toMatch(/^@earendil-works\/pi-durable\/(storage|env\/node)/)
    }
    expect(runtime.inputSourceOf).toBe(inputSourceOf)
    expect(runtime.readInputSources).toBe(readInputSources)
    expect(runtime.resolveInputSources).toBe(resolveInputSources)
    expect(runtime.SourceDoc).toBe(SourceDoc)
    expect(runtime.authorsOf).toBe(authorsOf)
  })
})

describe('AUTH · authorsOf（§19.7 2026-10-17 裁决：审查、大纲、user-intervened 共用的判法）', () => {
  /** 一条用户消息：`p` = 有来源记录 */
  interface Msg {
    id: string
    p?: true
  }
  const m = (id: string, sourced = false): Msg => (sourced ? { id, p: true } : { id })
  const run = (items: Msg[]): Array<[string, MessageAuthor | undefined]> => {
    const authors = authorsOf(items, (item) => item.p === true)
    return items.map((item) => [item.id, authors.get(item)])
  }

  it('AUTH-01 空串 → 空表', () => {
    expect(authorsOf([], () => true)).toStrictEqual(new Map())
  })

  it('AUTH-02 整串都没有记录（升级之前的子会话 / 旧格式）→ 全是 unknown，一条 human 都没有', () => {
    expect(run([m('a'), m('b'), m('c')])).toStrictEqual([
      ['a', 'unknown'],
      ['b', 'unknown'],
      ['c', 'unknown']
    ])
  })

  it('AUTH-03 第一条有记录的之前 → unknown；它本身与之后有记录的 → parent；之后没有记录的 → human', () => {
    expect(
      run([m('u1'), m('u2'), m('p1', true), m('h1'), m('h2'), m('p2', true), m('h3')])
    ).toStrictEqual([
      ['u1', 'unknown'],
      ['u2', 'unknown'],
      ['p1', 'parent'],
      ['h1', 'human'],
      ['h2', 'human'],
      ['p2', 'parent'],
      ['h3', 'human']
    ])
  })

  it('AUTH-04 第一条就有记录（新开的子会话：create 之后 prompt）→ 从头起就可靠', () => {
    expect(run([m('p', true), m('h')])).toStrictEqual([
      ['p', 'parent'],
      ['h', 'human']
    ])
  })

  it('AUTH-05 全都有记录 → 全是 parent', () => {
    expect(run([m('a', true), m('b', true)])).toStrictEqual([
      ['a', 'parent'],
      ['b', 'parent']
    ])
  })

  it('AUTH-06 每一项都在表里（次序即输入次序），按项本身认（不是按内容）；不改输入', () => {
    const items = Object.freeze([m('x'), m('x', true), m('x')])
    const authors = authorsOf(items, (item) => item.p === true)
    expect(authors.size).toBe(3)
    expect([...authors.keys()]).toStrictEqual([...items])
    expect([...authors.values()]).toStrictEqual(['unknown', 'parent', 'human'])
    expect(items).toStrictEqual([{ id: 'x' }, { id: 'x', p: true }, { id: 'x' }])
  })

  it('AUTH-07 「有没有记录」只问调用方给的判断，每项恰问一次、按次序', () => {
    const items = [m('a'), m('b', true), m('c')]
    const asked: string[] = []
    authorsOf(items, (item) => {
      asked.push(item.id)
      return item.p === true
    })
    expect(asked).toStrictEqual(['a', 'b', 'c'])
  })
})
