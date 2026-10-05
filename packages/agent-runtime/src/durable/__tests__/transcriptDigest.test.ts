/**
 * P2-14 · 转写摘要的抽取（手写条目）：MemoryStorage 会话上用 `harness.commit(tx => tx.appendEntry(…))`
 * 直接写条目，再读 `readTranscriptDigest`。faux 驱动的真流程（内联 Token、真 ask、压缩、只读）在
 * transcriptDigest.session.test.ts。
 *
 *   P2-14-01 人发的消息：次序、逐字文本、图片丢掉、pi.system 不产出
 *   P2-14-02 通知从来不算人写的：条目按来源（shuvix.notice 一律），pi.user 按整段形状
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
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import * as runtime from '../../index'
import { imagePlaceholder } from '../../toolResultText'
import { backgroundContext as BG } from '../context'
import { DisplayDoc, noticeEntryDraft } from '../docs'
import { SessionClosedError, type DurableSession } from '../durableSession'
import { digestEntries, readTranscriptDigest, type TranscriptDigestItem } from '../transcriptDigest'
import {
  A,
  AC,
  IMAGE,
  Q,
  U,
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

  it('P2-14-17 Node-free source, exported from @shuvix/agent-runtime', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../transcriptDigest.ts'), 'utf8')
    const specifiers = [...source.matchAll(/(?:from|import)\s+'([^']+)'/g)].map(
      (match) => match[1]!
    )
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/^node:/)
      expect(specifier).not.toMatch(/^(fs|path|os|electron)(\/|$)/)
      expect(specifier).not.toMatch(/^@earendil-works\/pi-durable\/(storage|env\/node)/)
    }
    expect(runtime.readTranscriptDigest).toBe(readTranscriptDigest)
  })
})
