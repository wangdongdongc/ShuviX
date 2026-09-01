/**
 * 回退目标解析对**侧车**的逐条跨越（`messageService.resolveRollbackTarget`）。
 *
 * 为什么非测不可：叶子若停在一条无主侧车上，它就会被下一条到达的消息当成自己的侧车
 * 消费掉 —— 署名张冠李戴。所以判据是「逐条跨越 SIDECAR_CUSTOM_TYPES 白名单里的 custom」，
 * 既不是「跨一条」（旧的 if），也不是「跨所有 custom」（那会吞掉未知 custom entry）。
 *
 * 真树（临时目录 + 真 JsonlSessionStorage），只 mock 路径/日志与 botService 的宿主依赖。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  const base = `${tmp}/shuvix-rollback-${process.pid}`
  return { base, sessions: `${base}/sessions`, bots: `${base}/bots` }
})
const mocks = vi.hoisted(() => ({ broadcast: vi.fn(), getById: vi.fn() }))

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
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../agentRuntimeAdapters', () => ({ electronEventSink: { broadcast: mocks.broadcast } }))
// botService 会拉进埋点的事实构造器（sessionDao / messageService / i18n）——
// 这份用例测的是侧车回退，桩掉即可
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: vi.fn(async () => null),
  isDefaultTitle: vi.fn(() => false)
}))
vi.mock('../sessionService', () => ({
  // noteUnreadBotReply：A4 起 appendBotMessage 每次落树都记未读账 —— 本组用例不关心它,给 no-op
  sessionService: { getById: mocks.getById, noteUnreadBotReply: () => {} }
}))

import { BOT_SENDER_CUSTOM_TYPE, INLINE_TOKENS_CUSTOM_TYPE } from '@shuvix/agent-runtime'
import { messageService } from '../messageService'
import { botService } from '../botService'
import { clearSessionTreeCacheForTests, ensureSessionTree } from '../sessionStorage'

const SID = 'rollback-sess'

const userMsg = (text: string): AgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }) as AgentMessage

/** 往树上追加一串「消息 / 侧车」，返回按追加顺序的 id 数组 */
async function appendChain(
  items: Array<{ kind: 'msg'; text: string } | { kind: 'custom'; type: string }>
): Promise<string[]> {
  const tree = await ensureSessionTree(SID, dirs.sessions)
  const ids: string[] = []
  for (const item of items) {
    ids.push(
      item.kind === 'msg'
        ? await tree.appendMessage(userMsg(item.text))
        : await tree.appendCustomEntry(item.type, { botName: 'b', displayName: 'B' })
    )
  }
  return ids
}

const INLINE = { kind: 'custom' as const, type: INLINE_TOKENS_CUSTOM_TYPE }
const SENDER = { kind: 'custom' as const, type: BOT_SENDER_CUSTOM_TYPE }

beforeEach(() => {
  rmSync(dirs.base, { recursive: true, force: true })
  mkdirSync(dirs.sessions, { recursive: true })
  mkdirSync(dirs.bots, { recursive: true })
  clearSessionTreeCacheForTests()
  mocks.broadcast.mockReset()
  mocks.getById.mockReturnValue({ workingDirectory: dirs.sessions, settings: { bots: ['scout'] } })
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  rmSync(dirs.base, { recursive: true, force: true })
})

describe('resolveRollbackTarget —— 逐条跨越侧车', () => {
  it('跨过一条内联 Token 侧车（旧行为不回归）', async () => {
    const [anchor, , target] = await appendChain([
      { kind: 'msg', text: '锚点' },
      INLINE,
      { kind: 'msg', text: '要回退的' }
    ])
    expect(await messageService.resolveRollbackTarget(SID, target)).toEqual({ targetId: anchor })
  })

  it('跨过一条署名侧车', async () => {
    const [anchor, , target] = await appendChain([
      { kind: 'msg', text: '锚点' },
      SENDER,
      { kind: 'msg', text: '要回退的' }
    ])
    expect(await messageService.resolveRollbackTarget(SID, target)).toEqual({ targetId: anchor })
  })

  it.each([
    ['inline 在前、sender 在后', [INLINE, SENDER]],
    ['sender 在前、inline 在后', [SENDER, INLINE]]
  ])('逐条跨过连续两条侧车（%s）—— `if` 写法只会跨一条', async (_n, mid) => {
    const ids = await appendChain([
      { kind: 'msg', text: '锚点' },
      ...mid,
      { kind: 'msg', text: '要回退的' }
    ])
    const [anchor] = ids
    const target = ids[ids.length - 1]
    expect(await messageService.resolveRollbackTarget(SID, target)).toEqual({ targetId: anchor })
  })

  it('越过侧车后遇到非 custom entry 即停，不越界到更早的消息', async () => {
    const [older, anchor, , target] = await appendChain([
      { kind: 'msg', text: '更早的' },
      { kind: 'msg', text: '锚点' },
      SENDER,
      { kind: 'msg', text: '要回退的' }
    ])
    const res = await messageService.resolveRollbackTarget(SID, target)
    expect(res).toEqual({ targetId: anchor })
    expect(res!.targetId).not.toBe(older)
  })

  it('一路越到树根（前面全是侧车）→ targetId 为 null', async () => {
    const ids = await appendChain([SENDER, INLINE, { kind: 'msg', text: '要回退的' }])
    expect(await messageService.resolveRollbackTarget(SID, ids[2])).toEqual({ targetId: null })
  })

  it('未知 customType 不被跨过（白名单，不是「所有 custom」）', async () => {
    const [, unknownId, target] = await appendChain([
      { kind: 'msg', text: '锚点' },
      { kind: 'custom', type: 'shuvix:not-a-sidecar' },
      { kind: 'msg', text: '要回退的' }
    ])
    expect(await messageService.resolveRollbackTarget(SID, target)).toEqual({
      targetId: unknownId
    })
  })

  it('回退之后再落一条 bot 消息，署名不被上一段的孤儿侧车错挂（E1–E6 存在的理由）', async () => {
    const first = await botService.appendBotMessage(
      SID,
      { botName: 'botA', displayName: 'A' },
      { content: 'A 的旧消息' }
    )
    const target = await messageService.resolveRollbackTarget(SID, first!)
    await messageService.applyRollback(SID, target!.targetId)
    // 跨过署名侧车 → 回到树根，旧的那条侧车不再在分支上
    expect(target).toEqual({ targetId: null })

    await botService.appendBotMessage(
      SID,
      { botName: 'botB', displayName: 'B' },
      { content: 'B 的新消息' }
    )
    const msgs = await messageService.listBySession(SID)
    expect(msgs).toHaveLength(1)
    expect((msgs[0].metadata as { sender?: { name: string } }).sender).toMatchObject({
      name: 'botB'
    })
  })
})

/**
 * 两端同构的源码看守 —— 粗糙但便宜。
 *
 * 桌面 `messageService.resolveRollbackTarget` 与扩展 `messageStore.moveTo` 前置逻辑
 * 是逐字同构的两份实现；`sessionEntryStore` 的钉住叠加同理。真正的修法是把这两段抽成
 * agent-runtime 的共享函数（届时这个 describe 可以整块删掉，换成一次真单测）。
 */
describe('桌面 / 扩展两端逐字同构（源码看守，权宜之计）', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(__dirname, '../../../../../..', rel), 'utf-8')

  it.each([
    ['桌面 messageService', 'apps/desktop/src/main/services/messageService.ts'],
    ['扩展 messageStore', 'apps/extension/src/storage/messageStore.ts']
  ])('%s 用白名单常量 + while 循环跨越侧车', (_n, rel) => {
    const src = read(rel)
    expect(src).toContain('SIDECAR_CUSTOM_TYPES')
    expect(src).toMatch(/while\s*\(targetId\)/)
    // 单条 if 的旧写法必须已经消失
    expect(src).not.toMatch(/if\s*\(targetId\)\s*\{[\s\S]{0,200}INLINE_TOKENS_CUSTOM_TYPE/)
  })

  it.each([
    ['桌面 sessionStorage', 'apps/desktop/src/main/services/sessionStorage.ts'],
    ['扩展 sessionEntryStore', 'apps/extension/src/storage/sessionEntryStore.ts']
  ])('%s 的钉住是可叠加的（addSessionTreePin + pinPredicates.some）', (_n, rel) => {
    const src = read(rel)
    expect(src).toContain('export function addSessionTreePin')
    expect(src).toMatch(/pinPredicates\.some/)
    // 覆盖式 setter 不得再存在
    expect(src).not.toContain('export function setSessionTreePinned')
  })
})
