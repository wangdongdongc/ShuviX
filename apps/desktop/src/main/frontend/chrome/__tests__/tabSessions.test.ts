/**
 * Chrome 标签页会话的生命周期（frontend/chrome/tabSessions.ts）—— 开、找、关、清孤儿，以及
 * 「这条会话归不归这条连接」的判定。
 *
 * 契约：
 *   - 标题 `Chrome · <页面标题>`（去首尾空白、60 字截断，空标题就是 `Chrome`）—— 不是默认标题，
 *     自动标题 hook 因此不会为它跑一次模型；
 *   - `openTabSession`：同一浏览器（installId）、同一轮运行（runId）、同一标签页 → 同一条会话；
 *     没有就经 `sessionService.create({title, chromeTab})` 建一条；并发的 open 只建一次；
 *     连接没握手 → `not-ready`；tabId 不是非负整数 → 拒绝，什么也不建；
 *   - `closeTabSession`：只删这一轮运行里挂在这个标签页上的会话，先 `forgetSession` 再删；
 *     删失败吞掉；
 *   - `sweepTabSessions`（握手时）：同一浏览器名下，别的运行留下的、或标签页已不在 openTabIds 里
 *     的会话删掉；openTabIds 为空时只按运行清；别的浏览器的一条不碰；
 *   - `connectionOwnsSession`：会话的绑定与连接的 installId + runId 都对上才算。
 *
 * sessionDao 是一张内存行表（findAll / pickSettings 按 DAO 声明的形状返回），sessionService 的
 * create / delete 落在同一张表上。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeHello } from '@shuvix/chat-protocol/chromeBridge'
import type { BridgeConnection } from '../../../services/chromeBridge'

interface Row {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  settings: Record<string, unknown>
  createdAt: number
  updatedAt: number
  lastActiveAt: number
}

const mocks = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  timeline: [] as string[],
  create: vi.fn(),
  del: vi.fn(),
  updateTitle: vi.fn(),
  forgetSession: vi.fn(),
  existingState: vi.fn()
}))

vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: {
    findAll: () => [...mocks.rows.values()].map((r) => structuredClone(r)),
    pickSettings: (id: string, keys: string[]) => {
      const row = mocks.rows.get(id)
      if (!row) return undefined
      return Object.fromEntries(keys.map((k) => [k, structuredClone(row.settings[k])]))
    }
  }
}))
vi.mock('../../../services/sessionService', () => ({
  sessionService: { create: mocks.create, delete: mocks.del, updateTitle: mocks.updateTitle }
}))
vi.mock('../../../services/chromeBridge', () => ({
  existingChromeBrowserState: mocks.existingState
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  closeTabSession,
  connectionOwnsSession,
  openTabSession,
  sweepTabSessions,
  tabSessionTitle,
  tabSessionsOf
} from '../tabSessions'

const TAB_ID_ERROR = '"tabId" must be a Chrome tab id (a non-negative integer).'

/** 一条握过手的连接（只有 info 被读） */
function conn(installId = 'i1', runId = 'r1'): BridgeConnection {
  return {
    id: `conn-${installId}-${runId}`,
    info: { installId, runId, browser: 'Chrome 140', extensionVersion: '0.1.0', connectedAt: 1 }
  } as unknown as BridgeConnection
}

/** 还没握手的连接 */
const unready = { id: 'conn-unready', info: undefined } as unknown as BridgeConnection

function seed(id: string, settings: Record<string, unknown>, title = id): void {
  mocks.rows.set(id, {
    id,
    title,
    projectId: null,
    parentId: null,
    settings,
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0
  })
}

/** 种一条标签页会话 */
function seedTab(id: string, installId: string, runId: string, tabId: unknown): void {
  seed(id, { chromeTab: { installId, runId, tabId }, enabledTools: [] })
}

function hello(installId: string, runId: string, openTabIds: number[]): BridgeHello {
  return {
    type: 'hello',
    protocol: 1,
    extensionVersion: '0.1.0',
    installId,
    runId,
    browser: 'Chrome 140',
    openTabIds
  }
}

let created = 0

beforeEach(() => {
  mocks.rows.clear()
  mocks.timeline.length = 0
  for (const m of [mocks.create, mocks.del, mocks.updateTitle, mocks.forgetSession]) m.mockReset()
  mocks.existingState.mockReset()
  mocks.create.mockImplementation((params: { title: string; chromeTab: unknown }) => {
    created += 1
    const id = `created-${created}`
    seed(id, { chromeTab: structuredClone(params.chromeTab), enabledTools: [] }, params.title)
    return structuredClone(mocks.rows.get(id))
  })
  mocks.del.mockImplementation(async (id: string) => {
    mocks.timeline.push(`delete:${id}`)
    mocks.rows.delete(id)
  })
  mocks.forgetSession.mockImplementation((id: string) => {
    mocks.timeline.push(`forget:${id}`)
  })
  mocks.existingState.mockReturnValue({ forgetSession: mocks.forgetSession })
})

// ─── 标题 ───────────────────────────────────────────────────────────────────

describe('TS-1 tabSessionTitle', () => {
  it.each([
    ['undefined', undefined],
    ['空串', ''],
    ['纯空白', '  \t ']
  ])('TS-1 页面标题为 %s → `Chrome`', (_label, title) => {
    expect(tabSessionTitle(title)).toBe('Chrome')
  })

  it('TS-1 去首尾空白后拼上前缀', () => {
    expect(tabSessionTitle(' Inbox ')).toBe('Chrome · Inbox')
  })

  it('TS-1 恰 60 字原样；61 字截成前 59 字 + …', () => {
    const sixty = 'a'.repeat(60)
    expect(tabSessionTitle(sixty)).toBe(`Chrome · ${sixty}`)
    const sixtyOne = `${'b'.repeat(59)}XY`
    expect(tabSessionTitle(sixtyOne)).toBe(`Chrome · ${'b'.repeat(59)}…`)
  })
})

// ─── 开 ─────────────────────────────────────────────────────────────────────

describe('TS-2 … TS-6 openTabSession', () => {
  it('TS-2 没有现成的 → create 恰收到 {title, chromeTab} 两个键，回新会话 id', async () => {
    const sid = await openTabSession(conn(), { tabId: 5, title: 'Page' })
    expect(mocks.create.mock.calls).toStrictEqual([
      [{ title: 'Chrome · Page', chromeTab: { installId: 'i1', runId: 'r1', tabId: 5 } }]
    ])
    expect(sid).toBe(`created-${created}`)
  })

  it('TS-3 同一标签页再开 → 同一个 id；不再建，标题也不改', async () => {
    const first = await openTabSession(conn(), { tabId: 5, title: 'Page' })
    const second = await openTabSession(conn(), { tabId: 5, title: 'Another title' })
    expect(second).toBe(first)
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.updateTitle).not.toHaveBeenCalled()
    expect(mocks.rows.get(first)!.title).toBe('Chrome · Page')
  })

  it('TS-3 库里原有的会话（桌面重启后）同样被找回', async () => {
    seedTab('existing', 'i1', 'r1', 5)
    expect(await openTabSession(conn(), { tabId: 5, title: 'Page' })).toBe('existing')
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it.each([
    ['同浏览器、同标签页，但是别的运行（浏览器重启过）', 'i1', 'r0', 5],
    ['别的浏览器的同号标签页', 'i2', 'r1', 5],
    ['同一轮运行的另一个标签页', 'i1', 'r1', 6]
  ])('TS-4 只有 %s 的会话 → 新建一条', async (_label, installId, runId, tabId) => {
    seedTab('other', installId, runId, tabId)
    const sid = await openTabSession(conn(), { tabId: 5, title: 'Page' })
    expect(sid).not.toBe('other')
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it('TS-4 绑定不合法的旧行不算现成会话', async () => {
    seedTab('broken', 'i1', 'r1', '5')
    expect(await openTabSession(conn(), { tabId: 5 })).not.toBe('broken')
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it('TS-5 同一标签页的并发 open 只建一次、回同一个 id；不同标签页各建各的', async () => {
    const [a, b] = await Promise.all([
      openTabSession(conn(), { tabId: 5, title: 'A' }),
      openTabSession(conn(), { tabId: 5, title: 'B' })
    ])
    expect(a).toBe(b)
    expect(mocks.create).toHaveBeenCalledTimes(1)

    const [c, d] = await Promise.all([
      openTabSession(conn(), { tabId: 7 }),
      openTabSession(conn(), { tabId: 8 })
    ])
    expect(c).not.toBe(d)
    expect(mocks.create).toHaveBeenCalledTimes(3)
  })

  it('TS-5b 建会话失败只让这一次失败：下一次 open 照常建', async () => {
    mocks.create.mockImplementationOnce(() => {
      throw new Error('db down')
    })
    await expect(openTabSession(conn(), { tabId: 5 })).rejects.toThrow('db down')
    const sid = await openTabSession(conn(), { tabId: 5 })
    expect(mocks.rows.has(sid)).toBe(true)
    expect(mocks.create).toHaveBeenCalledTimes(2)
  })

  it('TS-5c 没给页面标题 → 标题就是 `Chrome`', async () => {
    await openTabSession(conn(), { tabId: 5 })
    expect(mocks.create.mock.calls[0][0].title).toBe('Chrome')
  })

  it('TS-6 连接还没握手 → not-ready，什么也不建', async () => {
    await expect(openTabSession(unready, { tabId: 5 })).rejects.toThrow('not-ready')
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it.each([
    ['字符串 "5"', '5'],
    ['小数', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['undefined', undefined],
    ['-1（Chrome 的 TAB_ID_NONE）', -1]
  ])('TS-6 tabId 是 %s → 拒绝，什么也不建', async (_label, tabId) => {
    await expect(openTabSession(conn(), { tabId: tabId as number })).rejects.toThrow(TAB_ID_ERROR)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('TS-6 参数整个缺失 → 同样按 tabId 不合法拒绝', async () => {
    await expect(openTabSession(conn(), undefined as unknown as { tabId: number })).rejects.toThrow(
      TAB_ID_ERROR
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('TS-6 tabId 0 是合法的标签页', async () => {
    await openTabSession(conn(), { tabId: 0 })
    expect(mocks.create.mock.calls[0][0].chromeTab).toEqual({
      installId: 'i1',
      runId: 'r1',
      tabId: 0
    })
  })
})

// ─── 关 ─────────────────────────────────────────────────────────────────────

describe('TS-7 closeTabSession', () => {
  beforeEach(() => {
    seedTab('i1-r1-5', 'i1', 'r1', 5)
    seedTab('i1-r1-6', 'i1', 'r1', 6)
    seedTab('i1-r0-5', 'i1', 'r0', 5)
    seedTab('i2-r1-5', 'i2', 'r1', 5)
    seed('desktop', { enabledTools: [] })
  })

  it('TS-7 只删这一轮运行里挂在这个标签页上的那条；先 forgetSession 再删', async () => {
    await closeTabSession(conn('i1', 'r1'), 5)
    expect(mocks.del.mock.calls).toEqual([['i1-r1-5']])
    expect(mocks.timeline).toEqual(['forget:i1-r1-5', 'delete:i1-r1-5'])
    expect(mocks.existingState).toHaveBeenCalledWith('i1')
    expect([...mocks.rows.keys()].sort()).toEqual(['desktop', 'i1-r0-5', 'i1-r1-6', 'i2-r1-5'])
  })

  it('TS-7 删除失败被吞掉，不向上抛', async () => {
    mocks.del.mockRejectedValueOnce(new Error('busy'))
    await expect(closeTabSession(conn('i1', 'r1'), 5)).resolves.toBeUndefined()
    expect(mocks.del).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['字符串 tabId', '5'],
    ['小数 tabId', 5.5],
    ['undefined', undefined]
  ])('TS-7 %s → 什么也不做', async (_label, tabId) => {
    await closeTabSession(conn('i1', 'r1'), tabId as number)
    expect(mocks.del).not.toHaveBeenCalled()
    expect(mocks.forgetSession).not.toHaveBeenCalled()
  })

  it('TS-7 连接没握手 → 什么也不做', async () => {
    await closeTabSession(unready, 5)
    expect(mocks.del).not.toHaveBeenCalled()
    expect(mocks.existingState).not.toHaveBeenCalled()
  })

  it('TS-7 这个浏览器还没有状态（没用过工具）→ 照删', async () => {
    mocks.existingState.mockReturnValue(undefined)
    await closeTabSession(conn('i1', 'r1'), 5)
    expect(mocks.del.mock.calls).toEqual([['i1-r1-5']])
  })

  it('TS-7 没有匹配的会话 → 什么也不删', async () => {
    await closeTabSession(conn('i1', 'r1'), 42)
    expect(mocks.del).not.toHaveBeenCalled()
    expect(mocks.forgetSession).not.toHaveBeenCalled()
  })
})

// ─── 握手时清孤儿 ───────────────────────────────────────────────────────────

describe('TS-8 / TS-9 sweepTabSessions', () => {
  beforeEach(() => {
    seedTab('i1-r1-5', 'i1', 'r1', 5)
    seedTab('i1-r1-8', 'i1', 'r1', 8)
    seedTab('i1-r2-5', 'i1', 'r2', 5)
    seedTab('i1-r2-7', 'i1', 'r2', 7)
    seedTab('i1-r2-9', 'i1', 'r2', 9)
    seedTab('i2-r1-5', 'i2', 'r1', 5)
    seedTab('i2-r2-9', 'i2', 'r2', 9)
    seedTab('i1-broken', 'i1', 'r1', '5')
    seed('desktop', { enabledTools: [] })
  })

  it('TS-8 删掉别的运行留下的与标签页已不在的；留下还开着的；不碰别的浏览器；每条都先 forget', async () => {
    await sweepTabSessions(hello('i1', 'r2', [5, 7]))
    const deleted = mocks.del.mock.calls.map((c) => c[0]).sort()
    expect(deleted).toEqual(['i1-r1-5', 'i1-r1-8', 'i1-r2-9'])
    expect(mocks.forgetSession.mock.calls.map((c) => c[0]).sort()).toEqual(deleted)
    for (const id of deleted) {
      expect(mocks.timeline.indexOf(`forget:${id}`)).toBeLessThan(
        mocks.timeline.indexOf(`delete:${id}`)
      )
    }
    expect([...mocks.rows.keys()].sort()).toEqual([
      'desktop',
      'i1-broken',
      'i1-r2-5',
      'i1-r2-7',
      'i2-r1-5',
      'i2-r2-9'
    ])
  })

  it('TS-9 openTabIds 为空（浏览器刚启动还没报上来）→ 只按运行清', async () => {
    await sweepTabSessions(hello('i1', 'r2', []))
    expect(mocks.del.mock.calls.map((c) => c[0]).sort()).toEqual(['i1-r1-5', 'i1-r1-8'])
  })

  it('TS-9b 一条删不掉不影响其余', async () => {
    mocks.del.mockImplementationOnce(async () => {
      throw new Error('busy')
    })
    await expect(sweepTabSessions(hello('i1', 'r2', [5, 7]))).resolves.toBeUndefined()
    expect(mocks.del).toHaveBeenCalledTimes(3)
  })

  it('TS-9c 这个浏览器还没有状态 → 照清', async () => {
    mocks.existingState.mockReturnValue(undefined)
    await sweepTabSessions(hello('i1', 'r2', [5, 7]))
    expect(mocks.del).toHaveBeenCalledTimes(3)
  })
})

// ─── 归属 ───────────────────────────────────────────────────────────────────

describe('TS-10 connectionOwnsSession', () => {
  beforeEach(() => {
    seedTab('mine-5', 'i1', 'r1', 5)
    seedTab('mine-9', 'i1', 'r1', 9)
    seedTab('other-run', 'i1', 'r0', 5)
    seedTab('other-install', 'i2', 'r1', 5)
    seedTab('broken', 'i1', 'r1', '5')
    seed('desktop', { enabledTools: [] })
  })

  it('TS-10 installId 与 runId 都对上才算（这一轮运行的每个标签页会话都算）', () => {
    expect(connectionOwnsSession(conn('i1', 'r1'), 'mine-5')).toBe(true)
    expect(connectionOwnsSession(conn('i1', 'r1'), 'mine-9')).toBe(true)
  })

  it.each([
    ['别的运行的会话', 'other-run'],
    ['别的浏览器的会话', 'other-install'],
    ['桌面自己的会话（没有 chromeTab）', 'desktop'],
    ['绑定不合法的会话', 'broken'],
    ['不存在的会话', 'no-such-session'],
    ['空串', ''],
    ['数字', 42],
    ['undefined', undefined],
    ['对象', { id: 'mine-5' }]
  ])('TS-10 %s → false', (_label, sid) => {
    expect(connectionOwnsSession(conn('i1', 'r1'), sid)).toBe(false)
  })

  it('TS-10 没握手的连接 → false', () => {
    expect(connectionOwnsSession(unready, 'mine-5')).toBe(false)
  })
})

describe('TS-11 tabSessionsOf', () => {
  it('TS-11 只回这个浏览器、绑定合法的；绑定归一成三个键', () => {
    seed('mine', { chromeTab: { installId: 'i1', runId: 'r1', tabId: 5, extra: 1 } })
    seedTab('other-install', 'i2', 'r1', 5)
    seedTab('broken-tab', 'i1', 'r1', 1.5)
    seed('broken-run', { chromeTab: { installId: 'i1', runId: '', tabId: 5 } })
    seed('not-object', { chromeTab: 'i1:r1:5' })
    seed('desktop', { enabledTools: [] })
    expect(tabSessionsOf('i1')).toStrictEqual([
      { id: 'mine', binding: { installId: 'i1', runId: 'r1', tabId: 5 } }
    ])
    expect(tabSessionsOf('nobody')).toEqual([])
  })
})
