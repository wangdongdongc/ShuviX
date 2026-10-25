/**
 * 回复里 ```artifact 引用钉下的版本（durable/artifactPins.ts）—— 宿主无关的那一半：文档（`ArtifactPinsDoc`）
 * 的读写，与「这次工具调用是哪条回复发起的」「这一轮的终答是哪条」两个转写查找。真宿主（MemoryStorage
 * 会话）上用 `appendEntries` 手写条目，不起模型。
 *
 *   AP-1 findCallingReply：最新的助手条目、toolCall 里有这个 callId → 正文按块序、hasToolCalls、条目所在对话；
 *        并行调用的结果已经排在它后面、后面跟着 >32 条非助手条目（翻页）也找得到
 *   AP-2 callId 属于更早的那条助手条目（最新的不是它）/ 没有这个 callId → undefined
 *   AP-3 不存在的对话 → undefined（两个查找都是）
 *   AP-4 findFinalReply：最新的助手条目不带工具调用 → 它（后面已经排进用户消息 / 通知也一样，>32 条也翻得到）；
 *        最新的助手条目带工具调用 → undefined；一条助手条目都没有 → undefined
 *   AP-5 writeArtifactPins 只写一次：再写不改、返回 false；同一条回复并发写两份 → 恰一份落下
 *   AP-6 文档里的形状：自己目录的 `{ file, oid }`（**没有** subSessionId 键），子会话的 `{ file, oid, subSessionId }`
 *   AP-7 没有这份文档（从没钉过）：hasArtifactPins false、readArtifactPins undefined、文档不补种
 *   AP-8 readArtifactPins 拒绝 0 / 负数 / 非整数 / 用户条目 / 别的对话里的条目 / 不存在的 id；认不出形状的项略过
 *   AP-9 回退（fork 出的对话）：C1 里钉的、C2 前缀里看得见的回复经 C2 读得到；被放弃分支上的回复 → undefined；
 *        C2 里新写的回复钉在 C2 自己的文档里，C2 的文档不继承 C1 的；文档定义（kind / scope / history / fork）
 */
import type { ConversationId, EntryId, EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import {
  findCallingReply,
  findFinalReply,
  hasArtifactPins,
  readArtifactPins,
  writeArtifactPins,
  type ArtifactPin
} from '../artifactPins'
import { backgroundContext as BG } from '../context'
import { ArtifactPinsDoc, noticeEntryDraft } from '../docs'
import type { DurableSession } from '../durableSession'
import { appendEntries, assistantDraft, call, resultDraft, text, userDraft } from './support/digest'
import { makeHost, registerHostCleanup } from './support/host'

registerHostCleanup()

const SID = 'pins'

async function openSession(): Promise<DurableSession> {
  const t = await makeHost({ ephemeral: [SID] })
  return t.open(SID)
}

const OWN: ArtifactPin = { file: 'bar-chart.svg', oid: 'a'.repeat(40) }
const CHILD: ArtifactPin = { file: 'kid.svg', oid: 'b'.repeat(40), subSessionId: 'child-1' }

async function current(session: DurableSession): Promise<ConversationId> {
  return (await session.currentConversation()).id
}

/** 一条助手条目落下后的 id（数字） */
const idOf = (entry: EntryRecord | undefined): number => entry!.id as number

/** 一个新的空对话（ownerless），交回 id */
async function newConversation(session: DurableSession): Promise<ConversationId> {
  return session.harness.commit(
    async (tx) => (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id,
    BG
  )
}

describe('findCallingReply', () => {
  it('AP-1 最新的助手条目发起了它：正文按块序、hasToolCalls、所在对话；后面的结果与 >32 条翻页', async () => {
    const session = await openSession()
    const conv = await current(session)
    const [, reply] = await appendEntries(session, [
      userDraft('draw it', 1),
      assistantDraft(
        [
          text('Here is the chart:\n'),
          call('artifact', { action: 'create' }, 'c1'),
          text('```artifact\nbar-chart.svg\n```'),
          call('read', { path: 'x' }, 'c2'),
          call('read', { path: 'y' }, 'c3')
        ],
        2
      ),
      // 并行调用里先完成的两个，结果已经排在它后面
      resultDraft('c1', 'ok', { toolName: 'artifact' }),
      resultDraft('c2', 'ok', { toolName: 'read' })
    ])
    const expected = {
      entryId: reply!.id,
      conversationId: conv,
      texts: ['Here is the chart:\n', '```artifact\nbar-chart.svg\n```'],
      hasToolCalls: true
    }
    for (const callId of ['c1', 'c2', 'c3']) {
      expect(await findCallingReply(session.harness, conv, callId), callId).toEqual(expected)
    }

    // 后面再排进 40 条非助手条目（一页 32 条）：照样翻得到
    await appendEntries(
      session,
      Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0
          ? resultDraft(`late-${i}`, 'x', { toolName: 'read' })
          : noticeEntryDraft({ text: `notice ${i}`, kind: 'background' }, 10 + i)
      )
    )
    expect(await findCallingReply(session.harness, conv, 'c3')).toEqual(expected)
  })

  it('AP-2 callId 属于更早的那条助手条目、或根本没有 → undefined', async () => {
    const session = await openSession()
    const conv = await current(session)
    const [, a1, , a2] = await appendEntries(session, [
      userDraft('go', 1),
      assistantDraft([call('read', {}, 'old')], 2),
      resultDraft('old', 'ok', { toolName: 'read' }),
      assistantDraft([text('next step'), call('read', {}, 'new')], 3)
    ])
    expect(a1).toBeDefined()
    // 调用总是由最新那条发起的：认不出就不猜
    expect(await findCallingReply(session.harness, conv, 'old')).toBeUndefined()
    expect(await findCallingReply(session.harness, conv, 'nope')).toBeUndefined()
    expect((await findCallingReply(session.harness, conv, 'new'))?.entryId).toBe(a2!.id)
  })

  it('AP-3 不存在的对话 → undefined（两个查找都是）', async () => {
    const session = await openSession()
    await appendEntries(session, [userDraft('go', 1), assistantDraft('done', 2)])
    const missing = 9999 as ConversationId
    expect(await findCallingReply(session.harness, missing, 'c1')).toBeUndefined()
    expect(await findFinalReply(session.harness, missing)).toBeUndefined()
  })
})

describe('findFinalReply', () => {
  it('AP-4 最新的助手条目不带工具调用 → 它（后面有用户消息 / 通知也一样）；带工具调用 / 没有助手条目 → undefined', async () => {
    const session = await openSession()
    const conv = await current(session)
    // 一条助手条目都没有
    await appendEntries(session, [userDraft('hello', 1)])
    expect(await findFinalReply(session.harness, conv)).toBeUndefined()

    // 最新的助手条目带工具调用（它在工具执行前已钉过）
    await appendEntries(session, [assistantDraft([text('working'), call('read', {}, 'r1')], 2)])
    expect(await findFinalReply(session.harness, conv)).toBeUndefined()
    await appendEntries(session, [resultDraft('r1', 'ok', { toolName: 'read' })])
    expect(await findFinalReply(session.harness, conv)).toBeUndefined()

    // 终答：两个 text 块
    const [answer] = await appendEntries(session, [
      assistantDraft([text('Done:\n'), text('```artifact\nchart.svg\n```')], 3)
    ])
    const expected = {
      entryId: answer!.id,
      conversationId: conv,
      texts: ['Done:\n', '```artifact\nchart.svg\n```'],
      hasToolCalls: false
    }
    expect(await findFinalReply(session.harness, conv)).toEqual(expected)

    // 后面已经排进了追加的消息与通知：文件只能被更新的助手条目发起的工具改，终答照旧是它
    await appendEntries(session, [
      userDraft('follow-up', 4),
      noticeEntryDraft({ text: 'bg done', kind: 'background' }, 5)
    ])
    expect(await findFinalReply(session.harness, conv)).toEqual(expected)
    // 再多（>32 条，翻页）
    await appendEntries(
      session,
      Array.from({ length: 40 }, (_, i) => userDraft(`more ${i}`, 10 + i))
    )
    expect(await findFinalReply(session.harness, conv)).toEqual(expected)
  })
})

describe('writeArtifactPins / readArtifactPins / hasArtifactPins', () => {
  it('AP-5 只写一次：再写不改；并发写两份恰落下一份', async () => {
    const session = await openSession()
    const conv = await current(session)
    const [, a1, , a2] = await appendEntries(session, [
      userDraft('go', 1),
      assistantDraft('```artifact\nbar-chart.svg\n```', 2),
      userDraft('again', 3),
      assistantDraft('```artifact\nbar-chart.svg\n```', 4)
    ])
    const h = session.harness

    expect(await writeArtifactPins(h, conv, a1!.id, { 'bar-chart.svg': OWN })).toBe(true)
    expect(await hasArtifactPins(h, conv, a1!.id)).toBe(true)
    const other: ArtifactPin = { file: 'bar-chart.svg', oid: 'c'.repeat(40) }
    expect(await writeArtifactPins(h, conv, a1!.id, { 'bar-chart.svg': other, x: OWN })).toBe(false)
    expect(await readArtifactPins(h, conv, idOf(a1))).toEqual({ 'bar-chart.svg': OWN })

    // 同一条回复的并行调用各来一次：先到的算
    const results = await Promise.all([
      writeArtifactPins(h, conv, a2!.id, { 'bar-chart.svg': OWN }),
      writeArtifactPins(h, conv, a2!.id, { 'bar-chart.svg': other })
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = results[0] ? OWN : other
    expect(await readArtifactPins(h, conv, idOf(a2))).toEqual({ 'bar-chart.svg': winner })
  })

  it('AP-6 形状：自己目录的不带 subSessionId 键，子会话的带', async () => {
    const session = await openSession()
    const conv = await current(session)
    const [, a1] = await appendEntries(session, [userDraft('go', 1), assistantDraft('x', 2)])
    // 交进来的对象上多带的字段不进文档
    const noisy = { ...OWN, extra: 'ignored' } as ArtifactPin
    expect(
      await writeArtifactPins(session.harness, conv, a1!.id, {
        'Bar chart': noisy,
        'kid.svg': CHILD
      })
    ).toBe(true)
    const doc = await session.harness.snapshot(ArtifactPinsDoc, conv, BG)
    expect(doc).toStrictEqual({
      items: {
        [String(a1!.id)]: {
          'Bar chart': { file: OWN.file, oid: OWN.oid },
          'kid.svg': { file: CHILD.file, oid: CHILD.oid, subSessionId: 'child-1' }
        }
      }
    })
    const pins = await readArtifactPins(session.harness, conv, idOf(a1))
    expect(pins).toStrictEqual({
      'Bar chart': { file: OWN.file, oid: OWN.oid },
      'kid.svg': CHILD
    })
    expect(Object.keys(pins!['Bar chart'])).toEqual(['file', 'oid'])
  })

  it('AP-7 从没钉过：has false、read undefined、文档不补种', async () => {
    const session = await openSession()
    const conv = await current(session)
    const [, a1] = await appendEntries(session, [userDraft('go', 1), assistantDraft('x', 2)])
    expect(await session.harness.snapshot(ArtifactPinsDoc, conv, BG)).toBeUndefined()
    expect(await hasArtifactPins(session.harness, conv, a1!.id)).toBe(false)
    expect(await readArtifactPins(session.harness, conv, idOf(a1))).toBeUndefined()
    // 文档在了、这条没钉：同样
    const [, a2] = await appendEntries(session, [userDraft('more', 3), assistantDraft('y', 4)])
    await writeArtifactPins(session.harness, conv, a2!.id, { a: OWN })
    expect(await hasArtifactPins(session.harness, conv, a1!.id)).toBe(false)
    expect(await readArtifactPins(session.harness, conv, idOf(a1))).toBeUndefined()
  })

  it('AP-8 读：拒绝 0 / 负数 / 非整数 / 用户条目 / 别的对话 / 不存在的 id；认不出形状的项略过', async () => {
    const session = await openSession()
    const conv = await current(session)
    const h = session.harness
    const [u1, a1] = await appendEntries(session, [userDraft('go', 1), assistantDraft('x', 2)])

    // 用户条目上也写了一份（证明拒绝它的是种类判断，而不是没文档）
    await writeArtifactPins(h, conv, u1!.id, { a: OWN })
    expect(await readArtifactPins(h, conv, idOf(u1))).toBeUndefined()

    // 手写一份带坏项的
    await h.commit(async (tx) => {
      const doc = await tx.doc(ArtifactPinsDoc, conv)
      doc.items[String(a1!.id)] = {
        good: { file: 'good.svg', oid: 'd'.repeat(40) },
        child: { file: 'kid.svg', oid: 'e'.repeat(40), subSessionId: 'child-2' },
        noOid: { file: 'x.svg' },
        oidNumber: { file: 'x.svg', oid: 5 },
        badSub: { file: 'x.svg', oid: 'f'.repeat(40), subSessionId: 7 },
        nullSub: { file: 'x.svg', oid: 'f'.repeat(40), subSessionId: null },
        noFile: { oid: 'f'.repeat(40) }
      } as never
    }, BG)
    expect(await readArtifactPins(h, conv, idOf(a1))).toStrictEqual({
      good: { file: 'good.svg', oid: 'd'.repeat(40) },
      child: { file: 'kid.svg', oid: 'e'.repeat(40), subSessionId: 'child-2' }
    })

    for (const bad of [0, -1, -idOf(a1), 1.5, idOf(a1) + 0.5, Number.NaN, Infinity, 99999]) {
      expect(await readArtifactPins(h, conv, bad), String(bad)).toBeUndefined()
    }
    // 不存在的当前对话
    expect(await readArtifactPins(h, 9999 as ConversationId, idOf(a1))).toBeUndefined()

    // 别的对话里的回复：经它自己的对话读得到，经当前对话读不到
    const other = await newConversation(session)
    const [b1] = await appendEntries(session, [assistantDraft('elsewhere', 3)], other)
    expect(await writeArtifactPins(h, other, b1!.id, { b: OWN })).toBe(true)
    expect(await readArtifactPins(h, other, idOf(b1))).toEqual({ b: OWN })
    expect(await readArtifactPins(h, conv, idOf(b1))).toBeUndefined()
  })
})

describe('回退：钉记在条目自己的对话里', () => {
  it('AP-9 C1 的钉经 C2 读得到（前缀里的回复）；被放弃分支 → undefined；C2 的新回复记在 C2；文档定义', async () => {
    const session = await openSession()
    const h = session.harness
    const c1 = await current(session)
    const [, a1, , a2] = await appendEntries(session, [
      userDraft('U1', 1),
      assistantDraft('A1 ```artifact\nchart.svg\n```', 2),
      userDraft('U2', 3),
      assistantDraft('A2', 4)
    ])
    const pinA1: ArtifactPin = { file: 'chart.svg', oid: '1'.repeat(40) }
    const pinA2: ArtifactPin = { file: 'chart.svg', oid: '2'.repeat(40) }
    await writeArtifactPins(h, c1, a1!.id, { 'chart.svg': pinA1 })
    await writeArtifactPins(h, c1, a2!.id, { 'chart.svg': pinA2 })

    // 回退到 U2 之前：C2 = fork(C1 @ A1)
    const c2 = await h.commit(
      async (tx) =>
        (await tx.forkConversation(c1, a1!.id as EntryId, { ownership: { kind: 'ownerless' } })).id,
      BG
    )
    expect(c2).not.toBe(c1)
    // 前缀里的 A1：经 C2 找到条目、再去它自己的对话（C1）读
    expect(await readArtifactPins(h, c2, idOf(a1))).toEqual({ 'chart.svg': pinA1 })
    // A2 只在被放弃的分支上
    expect(await readArtifactPins(h, c2, idOf(a2))).toBeUndefined()
    // C1 里照旧看得见两条
    expect(await readArtifactPins(h, c1, idOf(a2))).toEqual({ 'chart.svg': pinA2 })

    // C2 里新写的回复：查找报的是 C2，钉记在 C2 自己的文档里
    const [, a3] = await appendEntries(
      session,
      [userDraft('U2 again', 5), assistantDraft('A3 ```artifact\nchart.svg\n```', 6)],
      c2
    )
    const final = await findFinalReply(h, c2)
    expect(final).toEqual({
      entryId: a3!.id,
      conversationId: c2,
      texts: ['A3 ```artifact\nchart.svg\n```'],
      hasToolCalls: false
    })
    const pinA3: ArtifactPin = { file: 'chart.svg', oid: '3'.repeat(40) }
    expect(await writeArtifactPins(h, final!.conversationId, a3!.id, { 'chart.svg': pinA3 })).toBe(
      true
    )
    expect(await readArtifactPins(h, c2, idOf(a3))).toEqual({ 'chart.svg': pinA3 })
    expect(await readArtifactPins(h, c1, idOf(a3))).toBeUndefined()
    // C2 的文档只有它自己的回复（fork: 'initial'，不继承 C1 的）
    expect(Object.keys((await h.snapshot(ArtifactPinsDoc, c2, BG))?.items ?? {})).toEqual([
      String(a3!.id)
    ])
    expect(Object.keys((await h.snapshot(ArtifactPinsDoc, c1, BG))?.items ?? {}).sort()).toEqual(
      [String(a1!.id), String(a2!.id)].sort()
    )
    // 前缀回复在 C2 的文档里没有：has 按条目自己的对话（C1）问才是 true
    expect(await hasArtifactPins(h, c2, a1!.id)).toBe(false)
    expect(await hasArtifactPins(h, c1, a1!.id)).toBe(true)

    const { kind, version, scope, history, fork } = ArtifactPinsDoc.definition as unknown as Record<
      string,
      unknown
    >
    expect({ kind, version, scope, history, fork }).toEqual({
      kind: 'shuvix.artifact-pins',
      version: 1,
      scope: 'conversation',
      history: 'latest',
      fork: 'initial'
    })
  })
})
