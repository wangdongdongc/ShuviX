/**
 * P2-14 · 转写摘要的抽取（手写条目）：MemoryStorage 会话上用 `harness.commit(tx => tx.appendEntry(…))`
 * 直接写条目，再读 `readTranscriptDigest`。faux 驱动的真流程（内联 Token、真 ask、压缩、只读）在
 * transcriptDigest.session.test.ts。
 *
 *   P2-14-01 人发的消息：次序、逐字文本、图片丢掉、pi.system 不产出
 *   P2-14-02 通知从来不算人写的：条目按来源（shuvix.notice 一律），pi.user 按整段形状
 *   P2-14-02b 空回复追问（写在当前对话里的 onYield 续写）也不算人写的
 *   P2-14-04 显示侧车解析的边角：没 submission / 没放下 / 形状坏 / 侧车胜过形状 / 压缩切点之前
 *   P2-14-05 assistant 正文：文本块拼接，思考永不交出
 *   P2-14-06a 错误与重试（冻结投影口径）：带 errorMessage 的失败轮整条不算，里面的调用不配对
 *   P2-14-07 ask 的内容规则
 *   P2-14-08 ask 的配对与位置
 *   P2-14-10 非有限 / 缺失的时间戳 → 0（真流程的时间戳在 session 用例）
 *   P2-14-11b 外壳对不上的压缩摘要交出整段模型文本
 *   P2-14-12 其它头标记与种类
 *   P2-14-13 只读当前对话
 *   P2-14-16 关掉的句柄
 *   P2-14-17 不依赖 Node、从包入口导出
 *   WP2-21..30 ask 的答题方（§19.5）：结果详情带 `answeredBy` 的 ask 项带上答题方（失败闭合：详情里只要有
 *             一个 answeredBy 对象就不算人答的，认不出的字段补成空串）；取消、非 ask 工具、压缩切点之前不交出
 *   XS-09   答题方是别的会话（`kind: 'session'`，2026-10-20）：原样交出；认不出的 kind 一律记成 `parent-session`
 *             （失败闭合 —— 仍不算人答的）
 *   RSRC-28 / 31 user 项的来源（§19.7）：纯核心按 `sources` 给项带上 `source`（没有的不带这个键）；会话上手写的
 *             SourceDoc —— 认不出的项照样带来源（失败闭合，sessionId 空串），孤儿 / 没放下的不带
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JsonValue } from '@earendil-works/chord'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { PARENT_ANSWERED } from '../../askTool'
import * as runtime from '../../index'
import { imagePlaceholder } from '../../toolResultText'
import { backgroundContext as BG } from '../context'
import { DisplayDoc, SourceDoc, noticeEntryDraft } from '../docs'
import { SessionClosedError, type DurableSession } from '../durableSession'
import { EMPTY_REPLY_NOTICE_TEXT } from '../emptyReply'
import * as display from '../projection/display'
import * as entryText from '../projection/entryText'
import { digestEntries, readTranscriptDigest, type TranscriptDigestItem } from '../transcriptDigest'
import {
  A,
  AC,
  IMAGE,
  Q,
  U,
  US,
  appendEntries,
  assistantDraft,
  bg,
  call,
  compactionDraft,
  resultDraft,
  text,
  thinking,
  userDraft
} from './support/digest'
import { makeHost, registerHostCleanup, type TestHost } from './support/host'

registerHostCleanup()

const SID = 'digest'

async function openSession(): Promise<{ t: TestHost; session: DurableSession }> {
  const t = await makeHost({ ephemeral: [SID] })
  return { t, session: await t.open(SID) }
}

async function digest(session: DurableSession): Promise<TranscriptDigestItem[]> {
  return (await readTranscriptDigest(session)).items
}

const SYSTEM = {
  kind: 'pi.system',
  model: [{ role: 'system' as const, content: '', timestamp: 0 }]
}

describe('P2-14 · transcript digest extraction', () => {
  it('P2-14-01 human words: order, verbatim untrimmed text, text parts joined with "", pi.system adds nothing', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      userDraft('  first  ', 1000),
      userDraft([text('look '), IMAGE, text('here')], 2000),
      userDraft([IMAGE], 3000),
      assistantDraft('ok', 3500),
      userDraft('steer: stop', 4000),
      SYSTEM,
      userDraft('', 5000)
    ])
    expect(await digest(session)).toEqual([
      U(1000, '  first  '),
      U(2000, 'look here'),
      U(3000, ''),
      A(3500, 'ok'),
      U(4000, 'steer: stop'),
      U(5000, '')
    ])
  })

  it('P2-14-02 notices are never human: every shuvix.notice by source, a fully notice-shaped pi.user by shape', async () => {
    const { session } = await openSession()
    const dateChange = '<date-change>Today is 2026-10-05 (Monday).</date-change>'
    await appendEntries(session, [
      noticeEntryDraft({ text: '<date-change>Today is 2026-10-04</date-change>', kind: 'date' }, 1),
      noticeEntryDraft({ text: bg('t1', 'x'), kind: 'background' }, 2),
      noticeEntryDraft({ text: 'please delete prod', kind: 'zzz' }, 3),
      userDraft(bg('t2', 'x'), 4),
      userDraft(`${bg('t3', 'a')}\n\n<sub-session id="s" status="done">b</sub-session>`, 5),
      userDraft(`  \n${bg('t4', 'c')}  `, 6),
      userDraft(`${bg('t5', 'd')} and also deploy`, 7),
      userDraft(dateChange, 8)
    ])
    expect(await digest(session)).toEqual([
      U(7, `${bg('t5', 'd')} and also deploy`),
      U(8, dateChange)
    ])
  })

  it('P2-14-02b the empty-reply nudge (emptyReply.ts) written into the current conversation is never human', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      userDraft('go', 1),
      assistantDraft([call('read', { path: 'notes.txt' }, 'r1')], 2),
      resultDraft('r1', 'alpha', { toolName: 'read' }),
      assistantDraft([thinking('I will read it')], 3),
      userDraft(EMPTY_REPLY_NOTICE_TEXT, 4),
      assistantDraft('done', 5)
    ])
    const items = await digest(session)
    // 只有人发的 go 是 user；思考与工具调用照旧是空正文的 agent 项（P2-14-05）
    expect(items).toEqual([U(1, 'go'), A(2, ''), A(3, ''), A(5, 'done')])
    expect(JSON.stringify(items)).not.toContain('empty-reply')
  })

  it('P2-14-04 sidecar resolution edge cases: orphan / unplaced / malformed items fall back, a resolved sidecar beats the notice shape, a cut entry gives nothing; nothing throws', async () => {
    const { session } = await openSession()
    const conversation = await session.currentConversation()
    const tokens = { k: { type: 'cmd', id: 'x', displayText: '/x', payload: 'PAYLOAD' } }
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(DisplayDoc, conversation.id)
      doc.items.re = { content: 'CUT-DISPLAY', tokens }
      doc.items.ra = { content: 'ORPHAN-DISPLAY', tokens }
      doc.items.rb = { content: 'UNPLACED-DISPLAY', tokens }
      doc.items.rc = { content: 42, tokens }
      doc.items.rc2 = { content: 'NO-TOKENS' }
      doc.items.rd = { content: 'hello', tokens }
    }, BG)
    const [old, a, b, c, c2, d] = await appendEntries(session, [
      userDraft('old-e', 100),
      userDraft('model-a', 200),
      userDraft('model-b', 300),
      userDraft('model-c', 400),
      userDraft('model-c2', 500),
      userDraft(bg('t', 'x'), 600)
    ])
    await session.harness.commit(async (tx) => {
      const id = conversation.id
      await tx.createSubmission({
        conversationId: id,
        requestId: 're',
        type: 'input',
        status: 'placed',
        entry: old!.id
      })
      // (a) ra: no submission at all
      // (b) rb: the submission never got an entry
      await tx.createSubmission({
        conversationId: id,
        requestId: 'rb',
        type: 'input',
        status: 'unanswered',
        reason: 'aborted'
      })
      await tx.createSubmission({
        conversationId: id,
        requestId: 'rc',
        type: 'input',
        status: 'placed',
        entry: c!.id
      })
      await tx.createSubmission({
        conversationId: id,
        requestId: 'rc2',
        type: 'input',
        status: 'placed',
        entry: c2!.id
      })
      await tx.createSubmission({
        conversationId: id,
        requestId: 'rd',
        type: 'input',
        status: 'placed',
        entry: d!.id
      })
    }, BG)
    // (e) the compaction cuts at model-a: old-e (and its sidecar) is before the head
    await appendEntries(session, [compactionDraft(a!.id, 'S', 700)])
    expect(b).toBeDefined()

    expect(await digest(session)).toEqual([
      AC(700, 'S'),
      U(200, 'model-a'),
      U(300, 'model-b'),
      U(400, 'model-c'),
      U(500, 'model-c2'),
      U(600, 'hello')
    ])
  })

  it('P2-14-05 assistant text: text blocks joined with "", thinking never included, aborted / length treated as ordinary', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      assistantDraft(
        [thinking('T'), text('Hel'), call('bash', { command: 'ls' }, 'b1'), text('lo')],
        1
      ),
      assistantDraft([call('ask', { question: 'Q?' }, 'q1')], 2),
      assistantDraft([thinking('only thinking')], 3),
      assistantDraft([text('   ')], 4),
      assistantDraft([text('partial')], 5, { stopReason: 'aborted' }),
      assistantDraft([text('cut')], 6, { stopReason: 'length' })
    ])
    const items = await digest(session)
    expect(items).toEqual([
      A(1, 'Hello'),
      A(2, ''),
      A(3, ''),
      A(4, '   '),
      A(5, 'partial'),
      A(6, 'cut')
    ])
    expect(JSON.stringify(items)).not.toContain('only thinking')
  })

  it('P2-14-06a errors (frozen-projection parity): an error entry with a message yields nothing and its calls never pair; an empty errorMessage is ordinary', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      userDraft('go', 1),
      assistantDraft([text('half'), call('ask', { question: 'Q' }, 'e1')], 2, {
        stopReason: 'error',
        errorMessage: 'rate limited'
      }),
      resultDraft('e1', 'User selected: yes'),
      assistantDraft([text('no message')], 3, { stopReason: 'error', errorMessage: '' }),
      assistantDraft('done', 4)
    ])
    expect(await digest(session)).toEqual([U(1, 'go'), A(3, 'no message'), A(4, 'done')])
  })

  it('P2-14-07 ask content rules: question fallback, feedback text verbatim, cancelled / pending / third-party / non-ask calls give nothing, toolResultText parity for images', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      assistantDraft([call('ask', { question: 'Delete branches?' }, 'c1')], 2000),
      resultDraft('c1', 'User selected: a, b'),
      assistantDraft([call('ask', { question: 'Why?' }, 'c2')], 3000),
      resultDraft(
        'c2',
        'User did not select any option and responded with feedback instead:\nonly stale'
      ),
      assistantDraft([call('ask', {}, 'c3')], 4000),
      resultDraft('c3', 'go'),
      assistantDraft([call('ask', { question: 42 }, 'c4')], 5000),
      resultDraft('c4', 'fine'),
      assistantDraft([call('ask', { question: 'Force?' }, 'c5')], 6000),
      resultDraft('c5', 'Aborted', { isError: true }),
      assistantDraft([call('ask', { question: 'Pending?' }, 'c6')], 7000),
      assistantDraft([call('mcp__x__ask', { question: 'Third?' }, 'c7')], 8000),
      resultDraft('c7', 'yes', { toolName: 'mcp__x__ask' }),
      assistantDraft([call('bash', { command: 'echo' }, 'c8')], 9000),
      resultDraft('c8', 'User responded with feedback instead: ok', { toolName: 'bash' }),
      assistantDraft([call('ask', { question: 'Pic?' }, 'c9')], 10000),
      resultDraft('c9', [text('A'), IMAGE, text('B')])
    ])
    const items = await digest(session)
    expect(items.filter((item) => item.kind === 'ask')).toEqual([
      Q(2000, 'Delete branches?', 'User selected: a, b'),
      Q(
        3000,
        'Why?',
        'User did not select any option and responded with feedback instead:\nonly stale'
      ),
      Q(4000, '', 'go'),
      Q(5000, '', 'fine'),
      Q(10000, 'Pic?', `A\n${imagePlaceholder('image/png')}\nB`)
    ])
    expect(items.filter((item) => item.kind !== 'ask')).toEqual(
      [2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000].map((ts) => A(ts, ''))
    )
  })

  it('P2-14-08 ask pairing: answers in call order at the assistant position, a reused id pairs with the most recent unpaired call, an orphan result is dropped', async () => {
    const { session } = await openSession()
    const [lost, first] = await appendEntries(session, [
      assistantDraft([call('ask', { question: 'lost' }, 'k9')], 1000),
      assistantDraft(
        [call('ask', { question: 'one' }, 'k1'), call('ask', { question: 'two' }, 'k2')],
        2000
      ),
      resultDraft('k2', 'B'),
      resultDraft('k1', 'A'),
      // k9's call lies before the compaction head below: this result is an orphan
      resultDraft('k9', 'ORPHAN'),
      userDraft('next', 3000),
      assistantDraft([call('ask', { question: 'again' }, 'k1')], 4000),
      resultDraft('k1', 'C'),
      // two unpaired calls share k3: the result pairs with the newer one, the older stays unanswered
      assistantDraft([call('ask', { question: 'older' }, 'k3')], 5000),
      assistantDraft([call('ask', { question: 'newer' }, 'k3')], 6000),
      resultDraft('k3', 'D')
    ])
    expect(lost).toBeDefined()
    await appendEntries(session, [compactionDraft(first!.id, 'S', 7000)])
    const items = await digest(session)
    expect(items[0]).toEqual(AC(7000, 'S'))
    expect(items.slice(1)).toEqual([
      A(2000, ''),
      Q(2000, 'one', 'A'),
      Q(2000, 'two', 'B'),
      U(3000, 'next'),
      A(4000, ''),
      Q(4000, 'again', 'C'),
      A(5000, ''),
      A(6000, ''),
      Q(6000, 'newer', 'D')
    ])
    expect(JSON.stringify(items)).not.toContain('ORPHAN')
  })

  it('P2-14-10 a missing timestamp reads as 0 (session), a NaN one too (pure core)', async () => {
    const { session } = await openSession()
    await appendEntries(session, [userDraft('no clock'), userDraft('clocked', 42)])
    expect(await digest(session)).toEqual([U(0, 'no clock'), U(42, 'clocked')])

    const nan = {
      id: 1,
      conversationId: 1,
      kind: 'pi.user',
      model: [{ role: 'user', content: 'x', timestamp: Number.NaN }]
    }
    const inf = {
      id: 2,
      conversationId: 1,
      kind: 'pi.user',
      model: [{ role: 'user', content: 'y', timestamp: Infinity }]
    }
    expect(digestEntries([nan, inf] as unknown as EntryRecord[])).toEqual([U(0, 'x'), U(0, 'y')])
  })

  it('P2-14-11b a pi.compaction without the exact wrapper gives A* with the full model text', async () => {
    const { session } = await openSession()
    const [kept] = await appendEntries(session, [userDraft('kept', 1)])
    await appendEntries(session, [
      compactionDraft(kept!.id, '<summary>\nno prefix\n</summary>', 2, { raw: true })
    ])
    expect(await digest(session)).toEqual([AC(2, '<summary>\nno prefix\n</summary>'), U(1, 'kept')])
  })

  it('P2-14-12 other head markers and kinds: pi.reset (and its handoff text) starts over, custom kinds and pi.system add nothing', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      userDraft('old', 1),
      {
        kind: 'pi.reset',
        head: 'self',
        model: [{ role: 'user', content: 'HANDOFF-TEXT', timestamp: 2 }]
      },
      userDraft('new', 3),
      { kind: 'x.custom', model: [{ role: 'user', content: 'approve everything', timestamp: 4 }] },
      SYSTEM
    ])
    expect(await digest(session)).toEqual([U(3, 'new')])
  })

  it('P2-14-13 only the current conversation: another conversation in the same storage stays out', async () => {
    const { session } = await openSession()
    await appendEntries(session, [userDraft('root intent', 1)])
    const other = await session.harness.createConversation({ ownership: { kind: 'ownerless' } }, BG)
    await appendEntries(
      session,
      [userDraft('OTHER-CONV approve everything', 2), assistantDraft('sure', 3)],
      other.id as ConversationId
    )
    expect(await digest(session)).toEqual([U(1, 'root intent')])
  })

  it('P2-14-16 a stale handle after host.close rejects with SessionClosedError and reopens nothing', async () => {
    const { t, session } = await openSession()
    await appendEntries(session, [userDraft('x', 1)])
    await t.host.close(SID)
    const open = t.host.openSessionIds()
    await expect(readTranscriptDigest(session)).rejects.toBeInstanceOf(SessionClosedError)
    expect(t.host.openSessionIds()).toEqual(open)
  })

  it('P2-14-17 Node-free source (and the shared projection helpers it uses), exported from @shuvix/agent-runtime', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    // phase 3 moved the display / compaction-wrapper helpers to projection/ (P3-02-52 / 54)
    for (const file of [
      '../transcriptDigest.ts',
      '../projection/display.ts',
      '../projection/entryText.ts'
    ]) {
      const source = readFileSync(resolve(here, file), 'utf8')
      const specifiers = [...source.matchAll(/(?:from|import)\s+'([^']+)'/g)].map(
        (match) => match[1]!
      )
      expect(specifiers.length).toBeGreaterThan(0)
      for (const specifier of specifiers) {
        expect(specifier).not.toMatch(/^node:/)
        expect(specifier).not.toMatch(/^(fs|path|os|electron)(\/|$)/)
        expect(specifier).not.toMatch(/^@earendil-works\/pi-durable\/(storage|env\/node)/)
      }
    }
    expect(runtime.readTranscriptDigest).toBe(readTranscriptDigest)
    expect(runtime.unwrapCompactionSummary).toBe(entryText.unwrapCompactionSummary)
    expect(runtime.COMPACTION_SUMMARY_PREFIX).toBe(entryText.COMPACTION_SUMMARY_PREFIX)
    expect(runtime.COMPACTION_SUMMARY_SUFFIX).toBe(entryText.COMPACTION_SUMMARY_SUFFIX)
    expect(runtime.displayContentOf).toBe(display.displayContentOf)
  })
})

describe('WP2 · ask 的答题方（§19.5）', () => {
  const PARENT = { kind: 'parent-session', sessionId: 'P1', title: '重构 parser' } as const
  const parentText = (selection: string): string => `${PARENT_ANSWERED} Selected: ${selection}`
  const askDetails = (
    question: string,
    selections: string[],
    answeredBy?: JsonValue
  ): JsonValue => ({
    type: 'ask',
    question,
    selections,
    ...(answeredBy === undefined ? {} : { answeredBy })
  })

  async function asks(session: DurableSession): Promise<TranscriptDigestItem[]> {
    return (await digest(session)).filter((item) => item.kind === 'ask')
  }

  it('WP2-21 父会话代答的 ask：项照样交出，回答逐字，带上答题方', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      assistantDraft([call('ask', { question: 'Delete it?' }, 'q1')], 1000),
      resultDraft('q1', parentText('Yes'), {
        details: askDetails('Delete it?', ['Yes'], PARENT)
      })
    ])
    expect(await asks(session)).toStrictEqual([
      {
        kind: 'ask',
        ts: 1000,
        question: 'Delete it?',
        answer: parentText('Yes'),
        answeredBy: PARENT
      }
    ])
  })

  it('WP2-22 详情不带答题方 → 人答的，项里没有 answeredBy 键', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      assistantDraft([call('ask', { question: 'Delete it?' }, 'q1')], 1000),
      resultDraft('q1', 'User selected: Yes', { details: askDetails('Delete it?', ['Yes']) })
    ])
    const [item] = await asks(session)
    expect(item).toStrictEqual(Q(1000, 'Delete it?', 'User selected: Yes'))
    expect(item).not.toHaveProperty('answeredBy')
  })

  it('WP2-23 一条 assistant 里两个 ask：按调用次序紧跟其后，只有父会话答的那个带答题方', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      userDraft('go', 900),
      assistantDraft(
        [call('ask', { question: 'one' }, 'q1'), call('ask', { question: 'two' }, 'q2')],
        1000
      ),
      resultDraft('q2', parentText('B'), { details: askDetails('two', ['B'], PARENT) }),
      resultDraft('q1', 'User selected: A', { details: askDetails('one', ['A']) })
    ])
    expect(await digest(session)).toStrictEqual([
      U(900, 'go'),
      A(1000, ''),
      Q(1000, 'one', 'User selected: A'),
      Q(1000, 'two', parentText('B'), PARENT)
    ])
  })

  it.each([
    ['answeredBy null', askDetails('Q?', ['A'], null)],
    ['answeredBy a string', askDetails('Q?', ['A'], 'P1')],
    ['answeredBy a number', askDetails('Q?', ['A'], 42)],
    ['answeredBy true', askDetails('Q?', ['A'], true)],
    ['details null', null],
    ['details a string', 'P1'],
    ['details an array', [{ answeredBy: { ...PARENT } }] as JsonValue],
    ['details missing', undefined]
  ] as const)(
    'WP2-24a 详情里没有 answeredBy 对象（%s）→ 算人答的，不抛',
    async (_label, details) => {
      const { session } = await openSession()
      await appendEntries(session, [
        assistantDraft([call('ask', { question: 'Q?' }, 'q1')], 1000),
        resultDraft('q1', 'User selected: A', details === undefined ? {} : { details })
      ])
      const [item] = await asks(session)
      expect(item).toStrictEqual(Q(1000, 'Q?', 'User selected: A'))
    }
  )

  it.each([
    ['an empty array', [], { kind: 'parent-session', sessionId: '' }],
    ['kind user', { kind: 'user', sessionId: 'P1' }, { kind: 'parent-session', sessionId: 'P1' }],
    ['no sessionId', { kind: 'parent-session' }, { kind: 'parent-session', sessionId: '' }],
    [
      'a numeric sessionId',
      { kind: 'parent-session', sessionId: 42 },
      { kind: 'parent-session', sessionId: '' }
    ],
    ['an empty object', {}, { kind: 'parent-session', sessionId: '' }]
  ] as const)(
    'WP2-24b [guard] 失败闭合：详情带一个形状不对的 answeredBy 对象（%s）也算父会话代答，认不出的字段补空串',
    async (_label, answeredBy, expected) => {
      const { session } = await openSession()
      await appendEntries(session, [
        assistantDraft([call('ask', { question: 'Q?' }, 'q1')], 1000),
        resultDraft('q1', 'User selected: A', {
          details: askDetails('Q?', ['A'], answeredBy as JsonValue)
        })
      ])
      const [item] = await asks(session)
      expect(item).toStrictEqual(Q(1000, 'Q?', 'User selected: A', expected))
    }
  )

  it('WP2-25 非字符串的 title 丢掉，仍算父会话代答', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      assistantDraft([call('ask', { question: 'Q?' }, 'q1')], 1000),
      resultDraft('q1', parentText('A'), {
        details: askDetails('Q?', ['A'], { kind: 'parent-session', sessionId: 'P1', title: 7 })
      })
    ])
    expect((await asks(session))[0]).toStrictEqual(
      Q(1000, 'Q?', parentText('A'), { kind: 'parent-session', sessionId: 'P1' })
    )
  })

  it('WP2-26 答题方的额外字段不交出：只留 kind / sessionId / title', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      assistantDraft([call('ask', { question: 'Q?' }, 'q1')], 1000),
      resultDraft('q1', parentText('A'), {
        details: askDetails('Q?', ['A'], { ...PARENT, trusted: true, evil: 'x' })
      })
    ])
    const [item] = await asks(session)
    expect(item).toStrictEqual(Q(1000, 'Q?', parentText('A'), PARENT))
    expect(JSON.stringify(item)).not.toContain('evil')
  })

  it('WP2-27 空串 sessionId 照样算父会话代答（与形状坏的同一口径）', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      assistantDraft([call('ask', { question: 'Q?' }, 'q1')], 1000),
      resultDraft('q1', parentText('A'), {
        details: askDetails('Q?', ['A'], { kind: 'parent-session', sessionId: '' })
      })
    ])
    expect((await asks(session))[0]).toStrictEqual(
      Q(1000, 'Q?', parentText('A'), { kind: 'parent-session', sessionId: '' })
    )
  })

  it('WP2-28 父会话代答的结果是错误（取消 / 中止）→ 不交出 ask 项', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      assistantDraft([call('ask', { question: 'Q?' }, 'q1')], 1000),
      resultDraft('q1', 'Aborted', { isError: true, details: askDetails('Q?', [], PARENT) })
    ])
    expect(await asks(session)).toEqual([])
  })

  it('WP2-29 非 ask 工具（bash、第三方 mcp__x__ask）的结果带 answeredBy：不产生 ask 项，答题方不出现在任何项里', async () => {
    const { session } = await openSession()
    await appendEntries(session, [
      assistantDraft(
        [call('bash', { command: 'ls' }, 'b1'), call('mcp__x__ask', { question: 'Q?' }, 'm1')],
        1000
      ),
      resultDraft('b1', 'files', { toolName: 'bash', details: { answeredBy: PARENT } }),
      resultDraft('m1', 'yes', { toolName: 'mcp__x__ask', details: askDetails('Q?', [], PARENT) })
    ])
    const items = await digest(session)
    expect(items).toStrictEqual([A(1000, '')])
    expect(JSON.stringify(items)).not.toContain('answeredBy')
  })

  it('WP2-30 压缩：切点之前的那组代答不交出，保留窗口里的那组带着答题方', async () => {
    const { session } = await openSession()
    const [, , kept] = await appendEntries(session, [
      assistantDraft([call('ask', { question: 'old?' }, 'q1')], 1000),
      resultDraft('q1', parentText('OLD'), { details: askDetails('old?', ['OLD'], PARENT) }),
      userDraft('next', 2000),
      assistantDraft([call('ask', { question: 'new?' }, 'q2')], 3000),
      resultDraft('q2', parentText('NEW'), { details: askDetails('new?', ['NEW'], PARENT) })
    ])
    await appendEntries(session, [compactionDraft(kept!.id, 'S', 4000)])
    const items = await digest(session)
    expect(items).toStrictEqual([
      AC(4000, 'S'),
      U(2000, 'next'),
      A(3000, ''),
      Q(3000, 'new?', parentText('NEW'), PARENT)
    ])
    expect(JSON.stringify(items)).not.toContain('OLD')
  })
})

/**
 * XS-09 答题方的 kind：别的会话代答（`session`）原样带出；其余认不出的 kind（缺、大小写不对、别的词、不是字符串）
 * 一律记成 `parent-session` —— 失败闭合，仍不算人答的 [guard]。
 */
describe('XS-09 · ask 的答题方 × kind session', () => {
  const askDetails = (answeredBy: JsonValue): JsonValue => ({
    type: 'ask',
    question: 'Q?',
    selections: ['A'],
    answeredBy
  })

  async function onlyAsk(answeredBy: JsonValue): Promise<TranscriptDigestItem> {
    const { session } = await openSession()
    await appendEntries(session, [
      assistantDraft([call('ask', { question: 'Q?' }, 'q1')], 1000),
      resultDraft('q1', 'Selected: A', { details: askDetails(answeredBy) })
    ])
    const asks = (await digest(session)).filter((item) => item.kind === 'ask')
    expect(asks).toHaveLength(1)
    return asks[0]!
  }

  it('XS-09 别的会话代答：kind session 原样交出（三键）；额外字段丢掉', async () => {
    const OTHER = { kind: 'session', sessionId: 'X', title: 'T' } as const
    expect(await onlyAsk(OTHER)).toStrictEqual(Q(1000, 'Q?', 'Selected: A', OTHER))
    expect(await onlyAsk({ ...OTHER, evil: 'x' })).toStrictEqual(
      Q(1000, 'Q?', 'Selected: A', OTHER)
    )
  })

  it('XS-09 kind session 的其余字段同一口径：非字符串 title 丢掉、坏的 sessionId 补空串 —— kind 保留', async () => {
    expect(await onlyAsk({ kind: 'session', sessionId: 'X', title: 5 })).toStrictEqual(
      Q(1000, 'Q?', 'Selected: A', { kind: 'session', sessionId: 'X' })
    )
    expect(await onlyAsk({ kind: 'session', sessionId: 42 })).toStrictEqual(
      Q(1000, 'Q?', 'Selected: A', { kind: 'session', sessionId: '' })
    )
  })

  it.each([
    ['kind 缺', { sessionId: 'X', title: 'T' }],
    ['kind Session（大小写）', { kind: 'Session', sessionId: 'X', title: 'T' }],
    ['kind bot', { kind: 'bot', sessionId: 'X', title: 'T' }],
    ['kind user', { kind: 'user', sessionId: 'X', title: 'T' }],
    ['kind 是数字', { kind: 1, sessionId: 'X', title: 'T' }]
  ] as const)(
    'XS-09 [guard] 认不出的 kind（%s）→ parent-session（失败闭合），sessionId / title 照常取',
    async (_label, answeredBy) => {
      expect(await onlyAsk(answeredBy as JsonValue)).toStrictEqual(
        Q(1000, 'Q?', 'Selected: A', { kind: 'parent-session', sessionId: 'X', title: 'T' })
      )
    }
  )
})

describe('RSRC · user 项的来源（§19.7）', () => {
  const PARENT = { kind: 'parent-session', sessionId: 'P1', title: '重构 parser' } as const
  /** 认不出的来源记录在摘要里的样子（`resolveInputSources` 失败闭合补的） */
  const UNKNOWN = { kind: 'parent-session', sessionId: '' } as const

  it('RSRC-28 纯核心 digestEntries 的 sources：有的 user 项带 source，没有的不带这个键；指向非 user 条目的键不出现；通知形状照丢；空正文照留；侧车原文带 source；缺省第三参数 = 都不带', async () => {
    const { session } = await openSession()
    const [p, h, a, r, n, empty, shown] = await appendEntries(session, [
      userDraft('p', 1000),
      userDraft('h', 1100),
      assistantDraft([call('ask', { question: 'Q?' }, 'q1')], 1200),
      resultDraft('q1', 'User selected: A'),
      userDraft(bg('n', 'x'), 1300),
      userDraft('', 1400),
      userDraft('run PAYLOAD', 1500)
    ])
    const [cut] = await appendEntries(session, [compactionDraft(p!.id, 'S', 1600)])
    const view = await (await session.currentConversation()).context(BG)
    const sources = new Map([
      [p!.id, PARENT],
      [a!.id, PARENT],
      [r!.id, PARENT],
      [cut!.id, PARENT],
      [n!.id, PARENT],
      [empty!.id, PARENT],
      [shown!.id, PARENT]
    ])
    const displays = new Map([[shown!.id, 'run {{shuvixInlineToken:k}}']])
    expect(h).toBeDefined()
    const items = digestEntries(view.entries, displays, sources)
    expect(items).toStrictEqual([
      AC(1600, 'S'),
      US(1000, 'p', PARENT),
      U(1100, 'h'),
      A(1200, ''),
      Q(1200, 'Q?', 'User selected: A'),
      US(1400, '', PARENT),
      US(1500, 'run {{shuvixInlineToken:k}}', PARENT)
    ])
    expect(JSON.stringify(items)).not.toContain('PAYLOAD')
    // 来源只落在 user 项上：assistant / ask / 压缩摘要项一律没有 source 键
    for (const item of items) {
      if (item.kind !== 'user') expect(item).not.toHaveProperty('source')
    }
    // 旧调用形（不给第三参数，或连侧车也不给）：没有一项带 source
    for (const legacyCall of [digestEntries(view.entries, displays), digestEntries(view.entries)]) {
      expect(legacyCall.filter((item) => 'source' in item)).toStrictEqual([])
    }
  })

  it('RSRC-31 会话上手写的 SourceDoc：认不出的项照样带来源（失败闭合，sessionId 空串、不搬它自己的字段），合法的原样，孤儿 / 没放下的不带；不抛', async () => {
    const { session } = await openSession()
    const conversation = await session.currentConversation()
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(SourceDoc, conversation.id)
      doc.items['r-hook'] = { kind: 'hook', sessionId: 'H1', title: 'newer' }
      doc.items['r-num'] = { kind: 'parent-session', sessionId: 42 }
      doc.items['r-ok'] = PARENT
      doc.items['r-orphan'] = PARENT
      doc.items['r-unplaced'] = PARENT
    }, BG)
    const [hook, num, ok, plain] = await appendEntries(session, [
      userDraft('hook-sourced', 1),
      userDraft('num-sourced', 2),
      userDraft('ok-sourced', 3),
      userDraft('plain', 4)
    ])
    await session.harness.commit(async (tx) => {
      for (const [requestId, entry] of [
        ['r-hook', hook!],
        ['r-num', num!],
        ['r-ok', ok!]
      ] as const) {
        await tx.createSubmission({
          conversationId: conversation.id,
          requestId,
          type: 'input',
          status: 'placed',
          entry: entry.id
        })
      }
      await tx.createSubmission({
        conversationId: conversation.id,
        requestId: 'r-unplaced',
        type: 'input',
        status: 'unanswered',
        reason: 'aborted'
      })
    }, BG)
    expect(plain).toBeDefined()
    expect(await digest(session)).toStrictEqual([
      US(1, 'hook-sourced', UNKNOWN),
      US(2, 'num-sourced', UNKNOWN),
      US(3, 'ok-sourced', PARENT),
      U(4, 'plain')
    ])
  })
})
