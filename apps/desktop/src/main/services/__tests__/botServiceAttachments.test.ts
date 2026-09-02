/**
 * `botService.resolveAttachments` —— 附件句柄 → 派生 agent 上下文里的真实图片消息。
 *
 * **刻意打真文件**：v2 起字节在盘上（`chat-attachments/<会话>/`），行里只留描述符 ——
 * 这一层的全部风险都在「到底回读了什么」（第几张、哪条消息、哪条会话），把落盘换成假的
 * 就一条也测不到。目录跑在临时目录里（paths 被 mock），字节由 `saveChatAttachments`
 * 真写进去；消息行走内存版 DAO（真 DAO 一经导入就开 sqlite）。
 *
 * 为什么这些用例值得单独摆一层：句柄来自**脚本**，而脚本是用户写的 md。它是「宿主相信
 * 谁」的一条边界 —— 每一格都对应一种坏句柄（形状不对、指向别的会话、下标越界、消息
 * 不存在），而它们的正确行为**全是同一个**：跳过那一张，不抛。带图的消息本来就少，
 * 一次带图的失败会被当成偶发，可它其实是这条路径每次都会走的那一条。
 *
 * mock 面沿用其它 botService 用例那套（botService 是模块级单例，构造时就读 paths）。
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
// v2：聊天会话转写在 chat_messages 表里。真 DAO 一经导入就会打开 sqlite
// （DatabaseManager 构造即开库，而原生绑定是 Electron ABI 的），故整个替换成内存版
vi.mock('../../dao/chatMessageDao', async () => await import('./fakeChatMessageDao'))
vi.mock('../../utils/paths', () => ({
  // v2 起 botService 经 chatMessageDao 触到 DatabaseManager，它的构造读 getDataDir
  getDataDir: () => `${dirs.base}/data`,
  // 真件是 ensureDir(...)：建目录后才返回。替身不建目录的话 saveChatAttachments
  // 会逐张写失败（它只丢那一张，不抛），用例看到的就是「一张图也没回读到」
  getChatAttachmentsDir: (sid: string) => {
    const dir = `${dirs.base}/data/chat-attachments/${sid}`
    mkdirSync(dir, { recursive: true })
    return dir
  },
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
// botService 经 settingsService 读两道循环护栏。真件一经导入就把 settingsDao →
// dao/database 拉进模块图，而 DatabaseManager 构造即开 sqlite（原生绑定是 Electron ABI 的）
vi.mock('../settingsService', () => ({ settingsService: { get: () => undefined } }))

import { botService } from '../botService'
import { clearSessionTreeCacheForTests } from '../sessionStorage'
import { saveChatAttachments } from '../chatAttachments'
import { chatMessageDao, __reset as resetRows } from './fakeChatMessageDao'

const SID = 'att-sess'
const OTHER = 'att-other'

/**
 * 图片字节必须是**真 base64**：落盘那一步是 `Buffer.from(data,'base64')`，回读再编回去。
 * 拿一个不合法的 base64 当哨兵，它会在这次往返里被悄悄改写，用例便去比对一个被 base64
 * 规范化过的串 —— 那是夹具的假象，不是被测行为
 */
const b64 = (tag: string): string => Buffer.from(`BYTES-${tag}`).toString('base64')

const png = (tag: string): { type: 'image'; data: string; mimeType: string } => ({
  type: 'image',
  data: b64(tag),
  mimeType: 'image/png'
})

let seeded = 0

/**
 * 落一条带 n 张图的 user 消息：字节真写盘，描述符进行里 —— 与 handleUserMessage 同序。
 * 返回消息 id（句柄里的 `messageId`）。
 */
function seedImageMessage(
  sid: string,
  tags: string[],
  images = tags.map(png),
  text = '看看这些图'
): string {
  const id = `seed-${++seeded}`
  const refs = saveChatAttachments(
    sid,
    id,
    images.map((i) => ({ data: i.data, mimeType: i.mimeType }))
  )
  chatMessageDao.append({
    id,
    sessionId: sid,
    authorKind: 'user',
    content: text,
    hop: 0,
    ...(refs.length ? { attachments: refs } : {})
  })
  return id
}

/** 一条纯文本消息（没有任何图） */
function seedTextMessage(sid: string): string {
  const id = `seed-${++seeded}`
  chatMessageDao.append({ id, sessionId: sid, authorKind: 'user', content: '没有图', hop: 0 })
  return id
}

const handle = (
  over: Partial<{ sessionId: unknown; messageId: unknown; index: unknown; mimeType: unknown }> = {}
): Record<string, unknown> => ({
  sessionId: SID,
  messageId: 'PLACEHOLDER',
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
  resetRows()
  seeded = 0
  mocks.warn.mockReset()
  mocks.getById.mockReset()
  mocks.getById.mockReturnValue({ workingDirectory: dirs.sessions, settings: { bots: ['scout'] } })
})

afterAll(() => {
  rmSync(dirs.base, { recursive: true, force: true })
})

describe('RA —— 正常回读', () => {
  it('RA-1 单张图：按 (会话, 消息, 第几张) 取回字节，装进一条 user 消息', async () => {
    const messageId = seedImageMessage(SID, ['a'])
    const out = await botService.resolveAttachments([handle({ messageId })], SID)

    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    expect(imagesOf(out)).toEqual([png('a')])
  })

  it('RA-2 多张图装进**同一条** user 消息（拆成多条会让上下文里凭空多出几轮对话）', async () => {
    const messageId = seedImageMessage(SID, ['a', 'b', 'c'])
    const out = await botService.resolveAttachments(
      [handle({ messageId, index: 0 }), handle({ messageId, index: 2 })],
      SID
    )
    expect(out).toHaveLength(1)
    expect(imagesOf(out).map((i) => i.data)).toEqual([b64('a'), b64('c')])
  })

  it('RA-3 下标是**图片序号**而不是 content 块序号（文本块不占位）', async () => {
    // 句柄由 handleUserMessage 按 images 数组的下标生成，而消息正文里的文本不占附件位
    const messageId = seedImageMessage(SID, ['first', 'second'])
    const out = await botService.resolveAttachments([handle({ messageId, index: 1 })], SID)
    expect(imagesOf(out)).toEqual([png('second')])
  })

  it('RA-4 跨消息的句柄各自回读，合并成一条消息', async () => {
    const m1 = seedImageMessage(SID, ['x'])
    const m2 = seedImageMessage(SID, ['y'])
    const out = await botService.resolveAttachments(
      [handle({ messageId: m1 }), handle({ messageId: m2 })],
      SID
    )
    expect(out).toHaveLength(1)
    expect(
      imagesOf(out)
        .map((i) => i.data)
        .sort()
    ).toEqual([b64('x'), b64('y')].sort())
  })

  it('RA-5 mimeType 取自行里的描述符而不是句柄（句柄那份只给提示词用，不参与回读）', async () => {
    const messageId = seedImageMessage(
      SID,
      ['jpg'],
      [{ type: 'image', data: b64('jpg'), mimeType: 'image/jpeg' }]
    )
    const out = await botService.resolveAttachments(
      [handle({ messageId, mimeType: 'image/png' })],
      SID
    )
    expect(imagesOf(out)[0]).toMatchObject({ mimeType: 'image/jpeg' })
  })
})

describe('RA —— 坏句柄一律跳过，不抛', () => {
  it('RA-6 空句柄列表 → 空数组（连行都不读）', async () => {
    expect(await botService.resolveAttachments([], SID)).toEqual([])
  })

  it.each([
    ['非对象', 'nope'],
    ['null', null],
    ['数字', 42],
    ['缺 sessionId', { messageId: 'e', index: 0 }],
    ['sessionId 非字符串', { sessionId: 1, messageId: 'e', index: 0 }],
    ['sessionId 空串', { sessionId: '', messageId: 'e', index: 0 }],
    ['缺 messageId', { sessionId: SID, index: 0 }],
    ['messageId 空串', { sessionId: SID, messageId: '', index: 0 }],
    ['index 非整数', { sessionId: SID, messageId: 'e', index: 1.5 }],
    ['index 为负', { sessionId: SID, messageId: 'e', index: -1 }],
    ['index 缺席', { sessionId: SID, messageId: 'e' }],
    ['index 是字符串', { sessionId: SID, messageId: 'e', index: '0' }]
  ])('RA-7 形状不合法（%s）→ 整条句柄被忽略，不抛', async (_n, raw) => {
    seedImageMessage(SID, ['a'])
    expect(await botService.resolveAttachments([raw], SID)).toEqual([])
  })

  it('RA-8 消息不存在 → 跳过（不抛，也不留半条消息）', async () => {
    seedImageMessage(SID, ['a'])
    expect(
      await botService.resolveAttachments([handle({ messageId: 'no-such-message' })], SID)
    ).toEqual([])
  })

  it('RA-9 消息存在但没有附件 → 跳过', async () => {
    const messageId = seedTextMessage(SID)
    expect(await botService.resolveAttachments([handle({ messageId })], SID)).toEqual([])
  })

  it('RA-10 下标越界 → 只丢那一张，其余照常回读', async () => {
    // 「少一张图的回答好过没有回答」在单张粒度上的样子
    const messageId = seedImageMessage(SID, ['a'])
    const out = await botService.resolveAttachments(
      [handle({ messageId, index: 0 }), handle({ messageId, index: 9 })],
      SID
    )
    expect(imagesOf(out)).toEqual([png('a')])
  })

  it('RA-11 会话根本没有任何消息 → 空数组，不抛', async () => {
    expect(
      await botService.resolveAttachments([handle({ sessionId: 'ghost', messageId: 'e' })], 'ghost')
    ).toEqual([])
  })

  it('RA-12 【跨会话闸】句柄指向别的会话 → 忽略并留一条 warn', async () => {
    // 句柄来自脚本，而脚本是用户写的 md。不设这道闸，任何工作流都能写一个指向别的会话的
    // 句柄，把那边的图片拉进本次上下文 —— 不是越权（都是同一个用户的会话），但「附件」
    // 这个词不该悄悄含有跨会话读取的意思
    const foreign = seedImageMessage(OTHER, ['secret'])
    const own = seedImageMessage(SID, ['mine'])

    const out = await botService.resolveAttachments(
      [handle({ sessionId: OTHER, messageId: foreign }), handle({ messageId: own })],
      SID
    )
    expect(imagesOf(out)).toEqual([png('mine')])
    expect(mocks.warn.mock.calls.some((c) => String(c[0]).includes(OTHER))).toBe(true)
  })

  it('RA-13 不传 ownerSessionId → 闸不生效（宿主没说归属就不替它做主）', async () => {
    // 引擎在 invoke 漏传 sessionId 时就是这条路径。它已经是一串更严的静默降级
    // （会话授权恒空、ask 变工具错误），附件这一格不额外加严，也不额外放宽
    const foreign = seedImageMessage(OTHER, ['loose'])
    const out = await botService.resolveAttachments([
      handle({ sessionId: OTHER, messageId: foreign })
    ])
    expect(imagesOf(out)).toEqual([png('loose')])
  })

  it('RA-14 全是坏句柄 → 空数组而不是一条空的 user 消息', async () => {
    // 铺一条 content 为空的 user 消息会让模型看到一轮「用户什么都没说」的对话
    const out = await botService.resolveAttachments([handle({ messageId: 'ghost' }), 'nope'], SID)
    expect(out).toEqual([])
  })
})
