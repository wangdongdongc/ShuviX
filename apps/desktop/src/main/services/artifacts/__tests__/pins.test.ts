/**
 * 回复里 ```artifact 引用钉下的版本 —— 宿主这一侧（services/artifacts/pins.ts）：什么时候钉、名字落到哪个文件、
 * 内容存进哪个仓库，以及读的时候按钉取回当时那一版。
 *
 * 真的产物目录（tmp 下，`getSessionArtifactsDir` 顶到那里）+ 真的 isomorphic-git（history.ts）+ 真的 durable
 * 会话（agent-runtime 测试宿主的 MemoryStorage 会话，`appendEntries` 手写条目，不起模型）。只换掉会话表
 * （`findChildren`）与 logger；`history` 的两个 blob 入口是**穿透到真实现**的 spy（数次数、个别用例让它交回 null）。
 *
 *   PN-1  自己目录里的一件：钉 `{ file, oid }`（不带会话 id），blob 在本会话仓库里读得回，一个 `artifacts.changed`
 *   PN-2  围栏里写的是标题：键是标题，file 是真实文件名
 *   PN-3  子会话的产物：带 `subSessionId`，blob 进子会话的仓库；同名时本会话那件赢
 *   PN-4  找得到 / 找不到 / 标题重名的混在一起：只钉找得到的；全找不到 → 不写文档、不发事件
 *   PN-5  第二个 text 块里的围栏、只有拼起来才闭合的围栏都钉；没闭合的不钉
 *   PN-6  只钉一次：文件改了再来 → 不变；模块重载（进程内的表没了）再来 → 照旧不变
 *   PN-7  同一条回复的两个调用并发：每个名字只存一次，一次写，一个事件
 *   PN-8  发起者不是最新那条 → 不钉；调用不在会话的当前对话里 → 不钉
 *   PN-9  一个产物目录都没有 → 不读转写就返回；会话 undefined / 宿主抛错 / blob 存不进 → 照常 resolve
 *   PN-10 第一次写文档失败（已记 warn）→ 下一次调用重试并写成；pinFinalReply 的规则（终答 = 最新的助手条目不带调用）
 *   PN-11 readArtifactForRef：没有 messageId → 当前；钉了没改 → latest true；钉了又改 → 旧内容、latest false、标题按
 *         旧内容；钉了又删 → 旧内容、latest true；名字 trim；现在标题重名了照样凭钉取到；子会话的 → sessionId 是子会话；
 *         fork：不带 subSessionId 的钉按读的那场会话（fork）的目录取，与 fork 自己的文件比
 *   PN-12 messageId 不是十进制数字串（"abc"、""、"1.5"、"-3"、"1e2"、" 5 " …）→ 当前内容；blob 没了 → 当前；
 *         currentConversation 抛错 → 当前；哪里都没有 → null
 *
 * 每条用例一个新的产物会话 id（进程内「处理过的回复」按 `<会话>#<条目>` 记，换 id 就互不相干）；只有 PN-6 的后半
 * `vi.resetModules()` 后重新 import pins。漏顶 `getSessionArtifactsDir` 会往真实 home 写，文件末尾有哨兵。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationId, EntryDraft, EntryRecord } from '@earendil-works/pi-durable'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'

const state = vi.hoisted(() => ({
  root: '',
  warns: [] as string[],
  children: new Map<string, Array<{ id: string }>>()
}))

vi.mock('../../../utils/paths', () => ({
  getSessionArtifactsDir: (sessionId: string) => `${state.root}/${sessionId}`,
  isSafeSessionId: (id: string) =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..')
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (msg: string) => {
      state.warns.push(String(msg))
    }
  })
}))
vi.mock('../../sessionRecords', () => ({
  sessionRecords: { findChildren: (id: string) => state.children.get(id) ?? [] }
}))
vi.mock('../history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../history')>()
  return {
    ...actual,
    storeArtifactBlob: vi.fn(actual.storeArtifactBlob),
    readArtifactBlob: vi.fn(actual.readArtifactBlob)
  }
})

import {
  backgroundContext as BG,
  readArtifactPins,
  type DurableSession
} from '@shuvix/agent-runtime'
import { appEventBus } from '../../../utils/appEventBus'
import * as historyMod from '../history'
import {
  pinCallingReply,
  pinFinalReply,
  readArtifactForRef,
  readCurrentArtifact,
  type PinSession
} from '../pins'
import {
  appendEntries,
  assistantDraft,
  call,
  resultDraft,
  text,
  userDraft
} from '../../../../../../../packages/agent-runtime/src/durable/__tests__/support/digest'
import {
  makeHost,
  registerHostCleanup
} from '../../../../../../../packages/agent-runtime/src/durable/__tests__/support/host'

registerHostCleanup()

const storeBlob = vi.mocked(historyMod.storeArtifactBlob)
const readBlob = vi.mocked(historyMod.readArtifactBlob)

// ── 产物目录 ─────────────────────────────────────────────────────────────────

const HOME_ARTIFACTS = join(homedir(), '.shuvix', 'artifacts')
const homeSnapshot = (): string[] | null => {
  try {
    return readdirSync(HOME_ARTIFACTS).sort()
  } catch {
    return null
  }
}
let homeBefore: string[] | null = null

let seq = 0
const newSid = (): string => `p${++seq}`
const dirOf = (sid: string): string => join(state.root, sid)

function put(sid: string, name: string, content: string): void {
  mkdirSync(dirOf(sid), { recursive: true })
  writeFileSync(join(dirOf(sid), name), content, 'utf-8')
}

/** 系统 git 读一个 blob（不经被测实现）；读不到 → null */
function catBlob(dir: string, oid: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'cat-file', 'blob', oid], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
}

/** 系统 git 的 blob 哈希 */
const hashOf = (content: string): string =>
  execFileSync('git', ['hash-object', '--stdin'], { input: content, encoding: 'utf8' }).trim()

const svg = (label: string, rects = 1): string =>
  `<svg viewBox="0 0 4 4" aria-label="${label}">${'<rect/>'.repeat(rects)}</svg>`

// ── durable 会话 ─────────────────────────────────────────────────────────────

const DURABLE = 'pn'

async function openDurable(): Promise<DurableSession> {
  const t = await makeHost({ ephemeral: [DURABLE] })
  return t.open(DURABLE)
}

async function currentId(session: DurableSession): Promise<ConversationId> {
  return (await session.currentConversation()).id
}

/** 一条用户消息 + 一条助手回复（给定的块），交回回复的记录 */
async function reply(
  session: DurableSession,
  blocks: Parameters<typeof assistantDraft>[0],
  extra: EntryDraft[] = []
): Promise<EntryRecord> {
  const [, entry] = await appendEntries(session, [
    userDraft('go', 1),
    assistantDraft(blocks, 2),
    ...extra
  ])
  return entry!
}

const fence = (name: string): string => `\`\`\`artifact\n${name}\n\`\`\``

/** 钉在某条回复上的（经 runtime 读，按当前对话） */
async function pinsOf(session: DurableSession, entry: EntryRecord): Promise<unknown> {
  return readArtifactPins(session.harness, await currentId(session), entry.id as number)
}

// ── 事件 ────────────────────────────────────────────────────────────────────

let events: AppEvent[] = []
let off: (() => void) | undefined
const changed = (sid: string): AppEvent => ({ type: 'artifacts.changed', sessionIds: [sid] })

beforeAll(() => {
  homeBefore = homeSnapshot()
  state.root = join(realpathSync(mkdtempSync(join(tmpdir(), 'shuvix-artifact-pins-'))), 'artifacts')
  mkdirSync(state.root, { recursive: true })
  const unsubscribe = appEventBus.subscribe((e) => {
    events.push(e)
  })
  off = () => {
    unsubscribe()
  }
})

beforeEach(() => {
  events = []
  state.warns = []
  state.children.clear()
  storeBlob.mockClear()
  readBlob.mockClear()
})

afterAll(() => {
  off?.()
  expect(homeSnapshot()).toEqual(homeBefore)
  rmSync(join(state.root, '..'), { recursive: true, force: true })
})

// ── 钉 ─────────────────────────────────────────────────────────────────────

describe('pinCallingReply —— 工具执行之前钉住发起它的那条回复', () => {
  it('PN-1 自己目录里的一件：{ file, oid } 不带会话 id，blob 读得回，一个事件', async () => {
    const sid = newSid()
    const content = svg('Bar chart')
    put(sid, 'bar-chart.svg', content)
    const session = await openDurable()
    const entry = await reply(session, [
      text(`Here:\n${fence('bar-chart.svg')}`),
      call('edit', { path: 'x' }, 'c1')
    ])

    await pinCallingReply(session, sid, { conversationId: await currentId(session), callId: 'c1' })

    const oid = hashOf(content)
    const pins = (await pinsOf(session, entry)) as Record<string, Record<string, unknown>>
    expect(pins).toStrictEqual({ 'bar-chart.svg': { file: 'bar-chart.svg', oid } })
    expect(Object.keys(pins['bar-chart.svg'])).toEqual(['file', 'oid'])
    expect(catBlob(dirOf(sid), oid)).toBe(content)
    expect(storeBlob.mock.calls).toEqual([[sid, content]])
    expect(events).toEqual([changed(sid)])
    expect(state.warns).toEqual([])
  })

  it('PN-2 围栏里写的是标题：键是标题，file 是真实文件名', async () => {
    const sid = newSid()
    const content = svg('Requests by tier')
    put(sid, 'requests-by-tier.svg', content)
    const session = await openDurable()
    const entry = await reply(session, [text(fence('Requests by tier')), call('read', {}, 'c1')])
    await pinCallingReply(session, sid, { conversationId: await currentId(session), callId: 'c1' })
    expect(await pinsOf(session, entry)).toStrictEqual({
      'Requests by tier': { file: 'requests-by-tier.svg', oid: hashOf(content) }
    })
  })

  it('PN-3 子会话的产物：带 subSessionId、blob 进子会话仓库；同名时本会话那件赢', async () => {
    const sid = newSid()
    const child = `${sid}-child`
    state.children.set(sid, [{ id: child }])
    const kid = svg('Kid')
    put(child, 'kid.svg', kid)
    put(sid, 'shared.svg', svg('Mine'))
    put(child, 'shared.svg', svg('Child'))
    const session = await openDurable()
    const entry = await reply(session, [
      text(`${fence('kid.svg')}\n${fence('shared.svg')}`),
      call('read', {}, 'c1')
    ])
    await pinCallingReply(session, sid, { conversationId: await currentId(session), callId: 'c1' })

    expect(await pinsOf(session, entry)).toStrictEqual({
      'kid.svg': { file: 'kid.svg', oid: hashOf(kid), subSessionId: child },
      'shared.svg': { file: 'shared.svg', oid: hashOf(svg('Mine')) }
    })
    expect(catBlob(dirOf(child), hashOf(kid))).toBe(kid)
    expect(catBlob(dirOf(sid), hashOf(svg('Mine')))).toBe(svg('Mine'))
    // 子会话那件同名的没被存（本会话的赢了，没去下探）
    expect(catBlob(dirOf(child), hashOf(svg('Child')))).toBeNull()
    expect(storeBlob.mock.calls.map(([owner]) => owner).sort()).toEqual([child, sid].sort())
    // 事件点的是发起调用的那场会话
    expect(events).toEqual([changed(sid)])
  })

  it('PN-4 找得到 / 找不到 / 标题重名混在一起：只钉找得到的；全找不到 → 不写、不发事件', async () => {
    const sid = newSid()
    put(sid, 'a.svg', svg('A'))
    put(sid, 'dup-1.svg', svg('Dup'))
    put(sid, 'dup-2.svg', svg('Dup'))
    const session = await openDurable()
    const conv = await currentId(session)
    const entry = await reply(session, [
      text([fence('nope.svg'), fence('a.svg'), fence('Dup')].join('\n')),
      call('read', {}, 'c1')
    ])
    await pinCallingReply(session, sid, { conversationId: conv, callId: 'c1' })
    expect(await pinsOf(session, entry)).toStrictEqual({
      'a.svg': { file: 'a.svg', oid: hashOf(svg('A')) }
    })
    expect(events).toEqual([changed(sid)])

    // 下一条回复的引用全都找不到
    events = []
    const [, second] = await appendEntries(session, [
      userDraft('more', 3),
      assistantDraft([text(`${fence('nope.svg')}\n${fence('Dup')}`), call('read', {}, 'c2')], 4)
    ])
    await pinCallingReply(session, sid, { conversationId: conv, callId: 'c2' })
    expect(await pinsOf(session, second!)).toBeUndefined()
    expect(events).toEqual([])
  })

  it('PN-5 第二个 text 块里的、只有拼起来才闭合的都钉；没闭合的不钉', async () => {
    const sid = newSid()
    for (const n of ['second', 'joined', 'unclosed']) put(sid, `${n}.svg`, svg(n))
    const session = await openDurable()
    const conv = await currentId(session)
    const entry = await reply(session, [
      // 终答把几个 text 块拼起来渲染：这一个只有拼起来才闭合（各块单看都没闭合）
      text('\n```artifact\n'),
      text('joined.svg\n```\n'),
      // 过程区按块各自渲染：这一块自己就是一个闭合的引用（拼起来时前面粘着 `Intro`，反而认不出）
      text('Intro'),
      text(fence('second.svg')),
      call('read', {}, 'c1'),
      text('\n```artifact\nunclosed.svg')
    ])
    await pinCallingReply(session, sid, { conversationId: conv, callId: 'c1' })
    const pins = (await pinsOf(session, entry)) as Record<string, unknown>
    expect(Object.keys(pins).sort()).toEqual(['joined.svg', 'second.svg'])

    // 一条回复里只有没闭合的引用：什么都不写
    const [, only] = await appendEntries(session, [
      userDraft('more', 3),
      assistantDraft([text('```artifact\nunclosed.svg'), call('read', {}, 'c2')], 4)
    ])
    events = []
    await pinCallingReply(session, sid, { conversationId: conv, callId: 'c2' })
    expect(await pinsOf(session, only!)).toBeUndefined()
    expect(events).toEqual([])
  })

  it('PN-6 只钉一次：文件改了再来 → 不变；模块重载之后再来 → 仍不变', async () => {
    const sid = newSid()
    put(sid, 'a.svg', svg('v1'))
    const session = await openDurable()
    const conv = await currentId(session)
    const entry = await reply(session, [
      text(fence('a.svg')),
      call('edit', {}, 'c1'),
      call('read', {}, 'c2')
    ])
    await pinCallingReply(session, sid, { conversationId: conv, callId: 'c1' })
    const first = { 'a.svg': { file: 'a.svg', oid: hashOf(svg('v1')) } }
    expect(await pinsOf(session, entry)).toStrictEqual(first)

    // 第一个调用（edit）改了文件，同一条回复的第二个调用才来
    put(sid, 'a.svg', svg('v2', 2))
    await pinCallingReply(session, sid, { conversationId: conv, callId: 'c2' })
    expect(await pinsOf(session, entry)).toStrictEqual(first)
    expect(storeBlob).toHaveBeenCalledTimes(1)

    // 「处理过的回复」只在进程内：重载之后从文档看出钉过，照旧不改
    vi.resetModules()
    const fresh = await import('../pins')
    await fresh.pinCallingReply(session, sid, { conversationId: conv, callId: 'c2' })
    await fresh.pinFinalReply(session, sid)
    expect(await pinsOf(session, entry)).toStrictEqual(first)
    expect(catBlob(dirOf(sid), hashOf(svg('v2', 2)))).toBeNull()
    expect(events).toEqual([changed(sid)])
  })

  it('PN-7 同一条回复的两个调用并发：每个名字只存一次、一次写、一个事件', async () => {
    const sid = newSid()
    put(sid, 'a.svg', svg('A'))
    put(sid, 'b.md', '# B')
    const session = await openDurable()
    const conv = await currentId(session)
    const entry = await reply(session, [
      text(`${fence('a.svg')}\n${fence('b.md')}`),
      call('read', {}, 'c1'),
      call('read', {}, 'c2')
    ])
    const commits: number[] = []
    const stop = session.harness.subscribeCommits((p) => {
      if (p.changes.some((c) => c.type === 'document' && c.record.kind === 'shuvix.artifact-pins'))
        commits.push(1)
    })
    try {
      await Promise.all([
        pinCallingReply(session, sid, { conversationId: conv, callId: 'c1' }),
        pinCallingReply(session, sid, { conversationId: conv, callId: 'c2' })
      ])
    } finally {
      stop()
    }
    expect(storeBlob.mock.calls.map(([, content]) => content).sort()).toEqual(
      ['# B', svg('A')].sort()
    )
    expect(commits).toHaveLength(1)
    expect(events).toEqual([changed(sid)])
    expect(Object.keys((await pinsOf(session, entry)) as object).sort()).toEqual(['a.svg', 'b.md'])
  })

  it('PN-8 发起者不是最新那条 → 不钉；调用不在当前对话里 → 不钉', async () => {
    const sid = newSid()
    put(sid, 'a.svg', svg('A'))
    const session = await openDurable()
    const conv = await currentId(session)
    const [, older, , newer] = await appendEntries(session, [
      userDraft('go', 1),
      assistantDraft([text(fence('a.svg')), call('read', {}, 'old')], 2),
      resultDraft('old', 'ok', { toolName: 'read' }),
      assistantDraft([text('no refs here'), call('read', {}, 'new')], 3)
    ])
    await pinCallingReply(session, sid, { conversationId: conv, callId: 'old' })
    expect(await pinsOf(session, older!)).toBeUndefined()
    expect(newer).toBeDefined()

    // 别的对话（派生 agent 的）：那里最新的助手条目确实发起了这个调用，但它不在会话的当前对话里
    const other = await session.harness.commit(
      async (tx) => (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id,
      BG
    )
    const [spawned] = await appendEntries(
      session,
      [assistantDraft([text(fence('a.svg')), call('read', {}, 'sp1')], 4)],
      other
    )
    await pinCallingReply(session, sid, { conversationId: other, callId: 'sp1' })
    expect(await readArtifactPins(session.harness, other, spawned!.id as number)).toBeUndefined()
    expect(storeBlob).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('PN-9 没有产物目录 → 不读转写；会话 undefined / 宿主抛错 / blob 存不进 → 照常 resolve', async () => {
    // 本会话与子会话都没有产物目录：连 currentConversation 都不调
    const bare = newSid()
    state.children.set(bare, [{ id: `${bare}-child` }])
    const spy = {
      harness: new Proxy(
        {},
        {
          get: () => {
            throw new Error('harness touched')
          }
        }
      ),
      currentConversation: vi.fn(async () => {
        throw new Error('transcript read')
      })
    } as unknown as PinSession
    await pinCallingReply(spy, bare, { conversationId: 1 as ConversationId, callId: 'c1' })
    await pinFinalReply(spy, bare)
    expect(vi.mocked(spy.currentConversation)).not.toHaveBeenCalled()
    expect(state.warns).toEqual([])

    // 只有子会话有产物目录：照样去读
    const parent = newSid()
    state.children.set(parent, [{ id: `${parent}-kid` }])
    put(`${parent}-kid`, 'k.svg', svg('K'))
    await pinFinalReply(spy, parent)
    expect(vi.mocked(spy.currentConversation)).toHaveBeenCalledTimes(1)
    expect(state.warns.join('\n')).toContain('transcript read')

    // 会话 undefined
    const sid = newSid()
    put(sid, 'a.svg', svg('A'))
    await expect(
      pinCallingReply(undefined, sid, { conversationId: 1 as ConversationId, callId: 'c1' })
    ).resolves.toBeUndefined()
    await expect(pinFinalReply(undefined, sid)).resolves.toBeUndefined()

    // 宿主抛错（转写读不了）
    state.warns = []
    const real = await openDurable()
    const broken = {
      harness: {
        conversation: async () => {
          throw new Error('storage closed')
        },
        snapshot: async () => {
          throw new Error('storage closed')
        },
        commit: async () => {
          throw new Error('storage closed')
        }
      },
      currentConversation: () => real.currentConversation()
    } as unknown as PinSession
    await expect(
      pinCallingReply(broken, sid, { conversationId: await currentId(real), callId: 'c1' })
    ).resolves.toBeUndefined()
    await expect(pinFinalReply(broken, sid)).resolves.toBeUndefined()
    expect(state.warns.length).toBeGreaterThan(0)

    // blob 存不进（仓库坏了之类，store 交回 null）：不写、不发事件
    const entry = await reply(real, [text(fence('a.svg')), call('read', {}, 'c9')])
    storeBlob.mockResolvedValueOnce(null)
    await expect(
      pinCallingReply(real, sid, { conversationId: await currentId(real), callId: 'c9' })
    ).resolves.toBeUndefined()
    expect(storeBlob).toHaveBeenCalledTimes(1)
    expect(await pinsOf(real, entry)).toBeUndefined()
    expect(events).toEqual([])
  })

  it('PN-10 写文档失败（记 warn）→ 下一次调用重试并写成', async () => {
    const sid = newSid()
    put(sid, 'a.svg', svg('A'))
    const session = await openDurable()
    const conv = await currentId(session)
    const entry = await reply(session, [
      text(fence('a.svg')),
      call('read', {}, 'c1'),
      call('read', {}, 'c2')
    ])
    let failures = 1
    const real = session.harness
    const flaky = {
      harness: new Proxy(real, {
        get(target, key) {
          if (key === 'commit' && failures > 0) {
            return async () => {
              failures--
              throw new Error('database is locked')
            }
          }
          const value = Reflect.get(target, key, target) as unknown
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value
        }
      }),
      currentConversation: () => session.currentConversation()
    } as unknown as PinSession

    await pinCallingReply(flaky, sid, { conversationId: conv, callId: 'c1' })
    expect(await pinsOf(session, entry)).toBeUndefined()
    expect(state.warns.join('\n')).toContain('database is locked')
    expect(events).toEqual([])

    await pinCallingReply(flaky, sid, { conversationId: conv, callId: 'c2' })
    expect(await pinsOf(session, entry)).toStrictEqual({
      'a.svg': { file: 'a.svg', oid: hashOf(svg('A')) }
    })
    expect(events).toEqual([changed(sid)])
  })
})

describe('pinFinalReply —— 一轮结束时钉住终答', () => {
  it('PN-10b 终答 = 最新的助手条目且不带调用（后面排进别的条目也算）；带调用 → 不钉', async () => {
    const sid = newSid()
    put(sid, 'a.svg', svg('A'))
    const session = await openDurable()
    // 最新的助手条目带调用：那条在工具执行前已经钉过，这里不管
    const working = await reply(
      session,
      [text(fence('a.svg')), call('read', {}, 'c1')],
      [resultDraft('c1', 'ok', { toolName: 'read' })]
    )
    await pinFinalReply(session, sid)
    expect(await pinsOf(session, working)).toBeUndefined()
    expect(events).toEqual([])

    // 终答，后面已经排进了一条追加的消息
    const [answer] = await appendEntries(session, [
      assistantDraft([text('Done:\n'), text(fence('a.svg'))], 5),
      userDraft('thanks', 6)
    ])
    await pinFinalReply(session, sid)
    expect(await pinsOf(session, answer!)).toStrictEqual({
      'a.svg': { file: 'a.svg', oid: hashOf(svg('A')) }
    })
    expect(events).toEqual([changed(sid)])
  })
})

// ── 读 ─────────────────────────────────────────────────────────────────────

/** 钉住一条终答（引用这些名字），交回它的条目 id 串 */
async function pinnedAnswer(
  session: DurableSession,
  sid: string,
  names: string[]
): Promise<string> {
  const [, answer] = await appendEntries(session, [
    userDraft('show', 1),
    assistantDraft(names.map(fence).join('\n'), 2)
  ])
  await pinFinalReply(session, sid)
  return String(answer!.id)
}

describe('readArtifactForRef —— 按钉取回当时那一版', () => {
  it('PN-11 当前 / 没改 / 改了 / 删了 / trim / 标题重名 / 子会话 / fork', async () => {
    const sid = newSid()
    const v1 = svg('Bar chart')
    put(sid, 'bar-chart.svg', v1)
    const session = await openDurable()
    const mid = await pinnedAnswer(session, sid, ['bar-chart.svg', 'Bar chart'])

    // 没有 messageId：当前内容
    expect(await readArtifactForRef(session, sid, 'bar-chart.svg')).toStrictEqual({
      sessionId: sid,
      name: 'bar-chart.svg',
      title: 'Bar chart',
      content: v1,
      pinned: false,
      latest: true
    })
    expect(readCurrentArtifact(sid, 'bar-chart.svg')).toStrictEqual(
      await readArtifactForRef(session, sid, 'bar-chart.svg')
    )
    // 钉了、没改
    const pinnedV1 = {
      sessionId: sid,
      name: 'bar-chart.svg',
      title: 'Bar chart',
      content: v1,
      pinned: true,
      latest: true
    }
    expect(await readArtifactForRef(session, sid, 'bar-chart.svg', mid)).toStrictEqual(pinnedV1)
    // 名字 trim
    expect(await readArtifactForRef(session, sid, '  bar-chart.svg \n', mid)).toStrictEqual(
      pinnedV1
    )

    // 改了（标题也改了）：旧内容、旧标题、latest false
    const v2 = svg('Bar chart v2', 2)
    put(sid, 'bar-chart.svg', v2)
    expect(await readArtifactForRef(session, sid, 'bar-chart.svg', mid)).toStrictEqual({
      ...pinnedV1,
      latest: false
    })
    // 按标题钉的那个键也一样（现在的文件已经不叫这个标题了，照样凭钉取到）
    expect(await readArtifactForRef(session, sid, 'Bar chart', mid)).toStrictEqual({
      ...pinnedV1,
      latest: false
    })
    expect((await readArtifactForRef(session, sid, 'bar-chart.svg'))?.content).toBe(v2)

    // 现在又多了一件同标题的：当前读按标题是重名（null），凭钉照样取到
    put(sid, 'bar-chart.svg', v1)
    put(sid, 'another.svg', svg('Bar chart'))
    expect(await readArtifactForRef(session, sid, 'Bar chart')).toBeNull()
    expect(await readArtifactForRef(session, sid, 'Bar chart', mid)).toStrictEqual(pinnedV1)

    // 删了：钉下的那一版，latest true（没有更新的可看）
    rmSync(join(dirOf(sid), 'bar-chart.svg'))
    expect(await readArtifactForRef(session, sid, 'bar-chart.svg', mid)).toStrictEqual(pinnedV1)
    expect(await readArtifactForRef(session, sid, 'bar-chart.svg')).toBeNull()
  })

  it('PN-11b 子会话的钉 → sessionId 是子会话、与子会话的文件比', async () => {
    const sid = newSid()
    const child = `${sid}-c`
    state.children.set(sid, [{ id: child }])
    const k1 = svg('Kid')
    put(child, 'kid.svg', k1)
    const session = await openDurable()
    const mid = await pinnedAnswer(session, sid, ['kid.svg'])
    const pinned = {
      sessionId: child,
      name: 'kid.svg',
      title: 'Kid',
      content: k1,
      pinned: true,
      latest: true
    }
    expect(await readArtifactForRef(session, sid, 'kid.svg', mid)).toStrictEqual(pinned)
    put(child, 'kid.svg', svg('Kid', 3))
    expect(await readArtifactForRef(session, sid, 'kid.svg', mid)).toStrictEqual({
      ...pinned,
      latest: false
    })
    // 子会话的目录不随 fork 拷：钉里记着它的 id，换一场会话来读也落在它上面
    expect(readBlob.mock.calls.every(([owner]) => owner === child)).toBe(true)
  })

  it('PN-11c fork：不带 subSessionId 的钉按读的那场会话（fork）的目录取，与 fork 自己的文件比', async () => {
    const source = newSid()
    const fork = `${source}-fork`
    const v1 = svg('Forked')
    put(source, 'f.svg', v1)
    const session = await openDurable()
    const mid = await pinnedAnswer(session, source, ['f.svg'])
    // 宿主 fork：存储与产物目录整拷（含 .git）
    cpSync(dirOf(source), dirOf(fork), { recursive: true })
    // 源会话之后改了它、再把源会话的仓库整个拿掉：fork 读到的只能是自己那份
    put(source, 'f.svg', svg('Source moved on', 2))
    rmSync(join(dirOf(source), '.git'), { recursive: true, force: true })

    readBlob.mockClear()
    expect(await readArtifactForRef(session, fork, 'f.svg', mid)).toStrictEqual({
      sessionId: fork,
      name: 'f.svg',
      title: 'Forked',
      content: v1,
      pinned: true,
      latest: true
    })
    expect(readBlob.mock.calls.map(([owner]) => owner)).toEqual([fork])
    // fork 自己的文件改了 → latest false
    put(fork, 'f.svg', svg('Fork moved on', 3))
    expect(await readArtifactForRef(session, fork, 'f.svg', mid)).toMatchObject({
      sessionId: fork,
      content: v1,
      pinned: true,
      latest: false
    })
    // 源会话这边仓库没了：读不回 blob → 当前内容
    expect(await readArtifactForRef(session, source, 'f.svg', mid)).toMatchObject({
      sessionId: source,
      content: svg('Source moved on', 2),
      pinned: false,
      latest: true
    })
  })

  it('PN-12 messageId 不是十进制数字串 → 当前；blob 没了 → 当前；currentConversation 抛错 → 当前；哪里都没有 → null', async () => {
    const sid = newSid()
    const v1 = svg('V1')
    put(sid, 'a.svg', v1)
    const session = await openDurable()
    const mid = await pinnedAnswer(session, sid, ['a.svg'])
    const v2 = svg('V2', 2)
    put(sid, 'a.svg', v2)
    const current = {
      sessionId: sid,
      name: 'a.svg',
      title: 'V2',
      content: v2,
      pinned: false,
      latest: true
    }
    // 对照：这个 id 的确钉着 v1
    expect((await readArtifactForRef(session, sid, 'a.svg', mid))?.content).toBe(v1)
    const n = Number(mid)
    for (const bad of [
      'abc',
      '',
      '1.5',
      '-3',
      '1e2',
      ' 5 ',
      ` ${mid}`,
      `${mid} `,
      `${mid}.0`,
      `+${mid}`,
      `0x${n.toString(16)}`,
      `${n / 10}e1`
    ]) {
      expect(
        await readArtifactForRef(session, sid, 'a.svg', bad),
        JSON.stringify(bad)
      ).toStrictEqual(current)
    }
    // 没有这条回复 / 回复没钉这个名字
    expect(await readArtifactForRef(session, sid, 'a.svg', '99999')).toStrictEqual(current)
    put(sid, 'other.svg', svg('Other'))
    expect((await readArtifactForRef(session, sid, 'other.svg', mid))?.pinned).toBe(false)

    // currentConversation 抛错 → 当前内容（记 warn）
    const throwing = {
      harness: session.harness,
      currentConversation: async () => {
        throw new Error('closed')
      }
    } as unknown as PinSession
    expect(await readArtifactForRef(throwing, sid, 'a.svg', mid)).toStrictEqual(current)
    expect(state.warns.join('\n')).toContain('closed')
    // 会话不在（没打开）→ 当前内容
    expect(await readArtifactForRef(undefined, sid, 'a.svg', mid)).toStrictEqual(current)

    // 钉下的那份 blob 没了（松散对象被删）→ 当前内容
    const oid = hashOf(v1)
    const objectFile = join(dirOf(sid), '.git', 'objects', oid.slice(0, 2), oid.slice(2))
    nodeFs.chmodSync(objectFile, 0o644)
    rmSync(objectFile)
    expect(await readArtifactForRef(session, sid, 'a.svg', mid)).toStrictEqual(current)

    // 哪里都没有
    expect(await readArtifactForRef(session, sid, 'nope.svg', mid)).toBeNull()
    expect(await readArtifactForRef(session, sid, 'nope.svg')).toBeNull()
    expect(await readArtifactForRef(session, newSid(), 'a.svg', mid)).toBeNull()
    expect(existsSync(dirOf(`p${seq}`))).toBe(false)
  })
})
