/**
 * `botService.resolveAttachments` —— 附件句柄 → 派生 agent 上下文里的真实图片消息。
 *
 * **刻意打真会话树**（与 botServiceMessages 同一立场）：这一层的全部风险都在「从树上
 * 到底读回了什么」—— 第几张、哪条 entry、哪条会话，换成假树就一条也测不到。真树跑在
 * 临时目录里（paths 被 mock），字节由 `withSessionTreeLock` 真写进去。
 *
 * 为什么这些用例值得单独摆一层：句柄来自**脚本**，而脚本是用户写的 md。它是「宿主相信
 * 谁」的一条边界 —— 每一格都对应一种坏句柄（形状不对、指向别的会话、下标越界、entry
 * 不存在），而它们的正确行为**全是同一个**：跳过那一张，不抛。带图的消息本来就少，
 * 一次带图的失败会被当成偶发，可它其实是这条路径每次都会走的那一条。
 *
 * mock 面沿用 botServiceMessages 那套（botService 是模块级单例，构造时就读 paths）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  const base = `${tmp}/shuvix-botatt-${process.pid}`
  return { base, sessions: `${base}/sessions`, bots: `${base}/bots` }
})
const mocks = vi.hoisted(() => ({ warn: vi.fn(), getById: vi.fn() }))

vi.mock('../workflowService', () => ({
  workflowService: {
    invoke: vi.fn(async () => ({ started: false, reason: 'not-found' })),
    abortSessionRuns: vi.fn(() => 0),
    hasWorkflow: vi.fn(() => false),
    registerRunJournalSink: vi.fn()
  },
  workflowTriggers: { fire: vi.fn() }
}))
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../../utils/paths', () => ({
  getSessionsDir: () => dirs.sessions,
  getDefaultBotsDir: () => dirs.bots,
  // botService → agentService 的模块作用域构造器在 import 阶段就要它
  getDefaultAgentsDir: () => `${dirs.base}/agents`
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {} })
}))
vi.mock('../agentRuntimeAdapters', () => ({ electronEventSink: { broadcast: vi.fn() } }))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: vi.fn(async () => null),
  isDefaultTitle: vi.fn(() => false)
}))
vi.mock('../sessionService', () => ({ sessionService: { getById: mocks.getById } }))

import { botService } from '../botService'
import { clearSessionTreeCacheForTests, withSessionTreeLock } from '../sessionStorage'

const SID = 'att-sess'
const OTHER = 'att-other'

const png = (tag: string): { type: 'image'; data: string; mimeType: string } => ({
  type: 'image',
  data: `BYTES-${tag}`,
  mimeType: 'image/png'
})

/** 往会话树上落一条带 n 张图的 user 消息，返回 entry id */
async function seedImageMessage(sid: string, tags: string[], text = '看看这些图'): Promise<string> {
  return await withSessionTreeLock(
    sid,
    async (tree) =>
      await tree.appendMessage({
        role: 'user',
        content: [{ type: 'text', text }, ...tags.map(png)]
      } as AgentMessage),
    dirs.sessions
  )
}

/** 一条纯文本消息（没有任何图） */
async function seedTextMessage(sid: string): Promise<string> {
  return await withSessionTreeLock(
    sid,
    async (tree) =>
      await tree.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: '没有图' }]
      } as AgentMessage),
    dirs.sessions
  )
}

const handle = (
  over: Partial<{ sessionId: unknown; entryId: unknown; index: unknown; mimeType: unknown }> = {}
): Record<string, unknown> => ({
  sessionId: SID,
  entryId: 'PLACEHOLDER',
  index: 0,
  mimeType: 'image/png',
  ...over
})

/** 回读产物里的图片块（一条 user 消息装全部图） */
const imagesOf = (out: AgentMessage[]): Array<{ data: string; mimeType: string }> =>
  out.flatMap((m) =>
    (
      (m as { content?: unknown }).content as Array<{
        type: string
        data: string
        mimeType: string
      }>
    ).filter((c) => c.type === 'image')
  )

beforeEach(() => {
  rmSync(dirs.base, { recursive: true, force: true })
  mkdirSync(dirs.sessions, { recursive: true })
  mkdirSync(dirs.bots, { recursive: true })
  clearSessionTreeCacheForTests()
  mocks.warn.mockReset()
  mocks.getById.mockReset()
  mocks.getById.mockReturnValue({ workingDirectory: dirs.sessions, settings: { bots: ['scout'] } })
})

afterAll(() => {
  rmSync(dirs.base, { recursive: true, force: true })
})

describe('RA —— 正常回读', () => {
  it('RA-1 单张图：按 (会话, entry, 第几张) 取回字节，装进一条 user 消息', async () => {
    const entryId = await seedImageMessage(SID, ['a'])
    const out = await botService.resolveAttachments([handle({ entryId })], SID)

    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    expect(imagesOf(out)).toEqual([png('a')])
  })

  it('RA-2 多张图装进**同一条** user 消息（拆成多条会让上下文里凭空多出几轮对话）', async () => {
    const entryId = await seedImageMessage(SID, ['a', 'b', 'c'])
    const out = await botService.resolveAttachments(
      [handle({ entryId, index: 0 }), handle({ entryId, index: 2 })],
      SID
    )
    expect(out).toHaveLength(1)
    expect(imagesOf(out).map((i) => i.data)).toEqual(['BYTES-a', 'BYTES-c'])
  })

  it('RA-3 下标是**图片序号**而不是 content 块序号（文本块不占位）', async () => {
    // 句柄由 handleUserMessage 按 images 数组的下标生成，而树上的 content 里第 0 块是文本
    const entryId = await seedImageMessage(SID, ['first', 'second'])
    const out = await botService.resolveAttachments([handle({ entryId, index: 1 })], SID)
    expect(imagesOf(out)).toEqual([png('second')])
  })

  it('RA-4 跨 entry 的句柄各自回读，合并成一条消息', async () => {
    const e1 = await seedImageMessage(SID, ['x'])
    const e2 = await seedImageMessage(SID, ['y'])
    const out = await botService.resolveAttachments(
      [handle({ entryId: e1 }), handle({ entryId: e2 })],
      SID
    )
    expect(out).toHaveLength(1)
    expect(
      imagesOf(out)
        .map((i) => i.data)
        .sort()
    ).toEqual(['BYTES-x', 'BYTES-y'])
  })

  it('RA-5 mimeType 取自树上的字节而不是句柄（句柄那份只给提示词用，不参与回读）', async () => {
    const entryId = await withSessionTreeLock(
      SID,
      async (tree) =>
        await tree.appendMessage({
          role: 'user',
          content: [{ type: 'image', data: 'BYTES-jpg', mimeType: 'image/jpeg' }]
        } as AgentMessage),
      dirs.sessions
    )
    const out = await botService.resolveAttachments(
      [handle({ entryId, mimeType: 'image/png' })],
      SID
    )
    expect(imagesOf(out)[0]).toMatchObject({ mimeType: 'image/jpeg' })
  })
})

describe('RA —— 坏句柄一律跳过，不抛', () => {
  it('RA-6 空句柄列表 → 空数组（连树都不读）', async () => {
    expect(await botService.resolveAttachments([], SID)).toEqual([])
  })

  it.each([
    ['非对象', 'nope'],
    ['null', null],
    ['数字', 42],
    ['缺 sessionId', { entryId: 'e', index: 0 }],
    ['sessionId 非字符串', { sessionId: 1, entryId: 'e', index: 0 }],
    ['sessionId 空串', { sessionId: '', entryId: 'e', index: 0 }],
    ['缺 entryId', { sessionId: SID, index: 0 }],
    ['entryId 空串', { sessionId: SID, entryId: '', index: 0 }],
    ['index 非整数', { sessionId: SID, entryId: 'e', index: 1.5 }],
    ['index 为负', { sessionId: SID, entryId: 'e', index: -1 }],
    ['index 缺席', { sessionId: SID, entryId: 'e' }],
    ['index 是字符串', { sessionId: SID, entryId: 'e', index: '0' }]
  ])('RA-7 形状不合法（%s）→ 整条句柄被忽略，不抛', async (_n, raw) => {
    await seedImageMessage(SID, ['a'])
    expect(await botService.resolveAttachments([raw], SID)).toEqual([])
  })

  it('RA-8 entry 不存在 / 不是消息 → 跳过（不抛，也不留半条消息）', async () => {
    await seedImageMessage(SID, ['a'])
    expect(
      await botService.resolveAttachments([handle({ entryId: 'no-such-entry' })], SID)
    ).toEqual([])
  })

  it('RA-9 entry 存在但没有图 → 跳过', async () => {
    const entryId = await seedTextMessage(SID)
    expect(await botService.resolveAttachments([handle({ entryId })], SID)).toEqual([])
  })

  it('RA-10 下标越界 → 只丢那一张，其余照常回读', async () => {
    // 「少一张图的回答好过没有回答」在单张粒度上的样子
    const entryId = await seedImageMessage(SID, ['a'])
    const out = await botService.resolveAttachments(
      [handle({ entryId, index: 0 }), handle({ entryId, index: 9 })],
      SID
    )
    expect(imagesOf(out)).toEqual([png('a')])
  })

  it('RA-11 会话文件根本不存在 → 空数组，不抛', async () => {
    expect(
      await botService.resolveAttachments([handle({ sessionId: 'ghost', entryId: 'e' })], 'ghost')
    ).toEqual([])
  })

  it('RA-12 【跨会话闸】句柄指向别的会话 → 忽略并留一条 warn', async () => {
    // 句柄来自脚本，而脚本是用户写的 md。不设这道闸，任何工作流都能写一个指向别的会话的
    // 句柄，把那边的图片拉进本次上下文 —— 不是越权（都是同一个用户的会话），但「附件」
    // 这个词不该悄悄含有跨会话读取的意思
    const foreign = await seedImageMessage(OTHER, ['secret'])
    const own = await seedImageMessage(SID, ['mine'])

    const out = await botService.resolveAttachments(
      [handle({ sessionId: OTHER, entryId: foreign }), handle({ entryId: own })],
      SID
    )
    expect(imagesOf(out)).toEqual([png('mine')])
    expect(mocks.warn.mock.calls.some((c) => String(c[0]).includes(OTHER))).toBe(true)
  })

  it('RA-13 不传 ownerSessionId → 闸不生效（宿主没说归属就不替它做主）', async () => {
    // 引擎在 invoke 漏传 sessionId 时就是这条路径。它已经是一串更严的静默降级
    // （会话授权恒空、ask 变工具错误），附件这一格不额外加严，也不额外放宽
    const foreign = await seedImageMessage(OTHER, ['loose'])
    const out = await botService.resolveAttachments([
      handle({ sessionId: OTHER, entryId: foreign })
    ])
    expect(imagesOf(out)).toEqual([png('loose')])
  })

  it('RA-14 全是坏句柄 → 空数组而不是一条空的 user 消息', async () => {
    // 铺一条 content 为空的 user 消息会让模型看到一轮「用户什么都没说」的对话
    const out = await botService.resolveAttachments([handle({ entryId: 'ghost' }), 'nope'], SID)
    expect(out).toEqual([])
  })
})
