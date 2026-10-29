/**
 * Widget 面板卡片列表的顺序（`listActive`：最近打开倒序，没打开过的按创建时间倒序）与 v0.2.16 留下的
 * `homeOrder` —— 真的 widgetRegistry + widgetService，widgets 根目录是临时目录（`utils/paths` 顶掉）；
 * widgetServer（打包）、widgetDb（pglite）、widgetRepo（git）换成空壳。每个种子的 createdAt / lastOpenedAt 都不同
 * （排序没有 id 兜底，相等时落回 readdir 的顺序）。
 *
 *   LO-1 都没打开过 → listActive 按 createdAt 倒序；归档的不列；listArchived 按 archivedAt 倒序
 *   LO-2 打开过的在前（lastOpenedAt 倒序），没打开过的随后（createdAt 倒序）：最新建、没打开过的排在打开过一次的老 widget 之后
 *   LO-3 open(id) → id 到最前；账目里它只有 lastOpenedAt 变了（updatedAt 不动）；startWidget（面板的重新加载）
 *        顺序与账目字节都不变
 *   LO-4 v0.2.16 留下的 homeOrder：(a) 列表与没有它时一样；(b) listActive / listArchived / getById 不写账目；
 *        (c) 宿主的每一种写入之后账目里没有 homeOrder 了、别的 state 条目原样；(d) delete 一个没有 state 条目的
 *        id 什么都不写（homeOrder 留着）—— 「下一次写入时去掉」恰是这个意思
 *   LO-5 打开过的归档再恢复 → lastOpenedAt 留着，回到按它排的位置（不是末尾）
 *   LO-6 摘要的字段恰是 8 个（含 projectIds，没有 iconMtime）；目录里放个 icon.svg 什么都不变
 *   LO-7 账目损坏（不是 JSON）→ listActive 照样按 createdAt 倒序列；open / setArchived 不覆盖它（字节不变）
 *
 * 用过这个组件的会话与项目（`noteSessionUse` / `noteLink`，账目的 `state.<id>.links`；时间一律显式给）：
 *   LK-1  第一次记：links 恰是 {projects:{p1}, sessions:{s1}}，firstAt = lastAt = 那一刻；updatedAt / lastOpenedAt /
 *         schemaHash 与列表顺序都不动；别的组件不碰、没条目的也不给它造一条
 *   LK-2  同一会话同一项目再记：firstAt 留着、lastAt 往前；noteLink 回 false；不广播
 *   LK-3  没有项目（null）：会话行的 projectId 是 null、projects 不变、回 false；没条目的组件记下后 projects 是空的
 *   LK-4  只有给组件添了新项目才广播一次 widget.changed（同一项目 / null 不广播，第二个项目再广播一次）
 *   LK-5  会话上限 50：第 51 条挤掉最久没用的；重新用过的那条不被挤（挤下一条最旧的）；时间全相同时刚记的那条
 *         照样留下、恰剩 50；被挤掉的会话的项目还在 projects 与 projectIds 里
 *   LK-6  同一会话换了项目：会话行跟着换，两个项目都留着
 *   LK-7  摘要的 projectIds：按项目最近一次用的时间倒序；没用过 → []；归档的摘要里也有
 *   LK-8  账目里的 links 坏了（字符串 / null / 数组 / 字段类型不对 / 空 id / projectId 不是字符串）：列表照常、
 *         读出能认的（firstAt 不是数 → 0），数组的下标不当 id；下一次写只写回能认的，一条都没有就不写 links
 *   LK-9  没被会话用过的组件：init / open / 归档 / 恢复 / 改名 / setSchemaHash 之后条目里都没有 links 键
 *   LK-10 用过的组件：同样这些写入之后 links 原样（深相等）
 *   LK-11 什么都不写：没有 widget.json 的 id、空的 sessionId、账目不是 JSON → noteLink 回 false，账目字节不变
 *         （或根本不建），不广播
 *   LK-12 LO-4c 的写入表加一行「会话用过」：同样去掉 homeOrder、别的条目原样
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '' }))

const serverMock = vi.hoisted(() => ({
  hasWidget: vi.fn(() => false),
  registerAndBuild: vi.fn(async () => ({ success: true })),
  rebuild: vi.fn(async () => ({ success: true })),
  ensureStarted: vi.fn(async () => {}),
  unregisterWidget: vi.fn(),
  getUrl: (id: string) => `http://127.0.0.1:1/w/${id}/`
}))

// SQLite 组件的数据根放在临时 widgets 根里（名字不合 widget id 规则，注册表不会把它当 widget 列出来），随根一起删
vi.mock('../../../utils/paths', () => ({
  getWidgetsDir: () => state.root,
  getWidgetsDataDir: () => `${state.root}/.widgets-data`
}))
vi.mock('../widgetServer', () => ({ widgetServer: serverMock }))
vi.mock('../widgetDb', () => ({
  applyWidgetSchema: vi.fn(async () => {}),
  dropWidgetSchema: vi.fn(async () => {}),
  WidgetDbError: class WidgetDbError extends Error {}
}))
vi.mock('../widgetRepo', () => ({
  ensureRepo: vi.fn(async () => {}),
  commitHostChange: vi.fn(async () => undefined),
  commitBuild: vi.fn(async () => undefined),
  defaultBuildMessage: (id: string) => `chore(${id}): build`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { widgetService } from '../widgetService'
import { widgetRegistry, WIDGET_SESSION_LINK_LIMIT } from '../widgetRegistry'
import { appEventBus } from '../../../utils/appEventBus'

const configFile = (): string => join(state.root, '.config.json')

/** 种一个 widget 目录：widget.json 带指定 createdAt */
function seed(id: string, createdAt: number, name = id): void {
  const dir = join(state.root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'widget.json'),
    JSON.stringify({ id, name, description: '', entryFile: 'index.tsx', createdAt })
  )
  writeFileSync(join(dir, 'index.tsx'), 'export {}\n')
}

function writeConfig(config: unknown): void {
  writeFileSync(configFile(), JSON.stringify(config, null, 2) + '\n')
}

function readConfig(): {
  state: Record<string, Record<string, unknown>>
  homeOrder?: unknown
} {
  return JSON.parse(readFileSync(configFile(), 'utf-8'))
}

const bytes = (): Buffer => readFileSync(configFile())
const activeIds = (): string[] => widgetService.listActive().map((w) => w.id)

/** 下一次 Date.now() 的值（只替 Date，promise 照常跑） */
function at(ms: number): void {
  vi.setSystemTime(ms)
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'shuvix-widget-order-'))
  serverMock.hasWidget.mockReset().mockReturnValue(false)
  serverMock.unregisterWidget.mockClear()
  serverMock.registerAndBuild.mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  at(1_000_000)
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(state.root, { recursive: true, force: true })
})

describe('卡片列表的顺序（LO）', () => {
  it('LO-1 都没打开过 → createdAt 倒序；归档的不列；listArchived 按 archivedAt 倒序', () => {
    seed('aa-one', 10)
    seed('bb-two', 30)
    seed('cc-three', 20)
    seed('old-arch', 40)
    seed('new-arch', 5)
    writeConfig({
      state: { 'old-arch': { archivedAt: 100 }, 'new-arch': { archivedAt: 200 } }
    })

    expect(activeIds()).toEqual(['bb-two', 'cc-three', 'aa-one'])
    expect(widgetService.listArchived().map((w) => w.id)).toEqual(['new-arch', 'old-arch'])
  })

  it('LO-2 打开过的在前（lastOpenedAt 倒序），没打开过的随后（createdAt 倒序）', () => {
    seed('old-opened', 1)
    seed('mid-opened', 2)
    seed('old-never', 3)
    seed('newest-never', 900)
    writeConfig({
      state: {
        'old-opened': { lastOpenedAt: 500 },
        'mid-opened': { lastOpenedAt: 700 }
      }
    })

    expect(activeIds()).toEqual(['mid-opened', 'old-opened', 'newest-never', 'old-never'])
  })

  it('LO-3 open(id) 把它挪到最前、只改它的 lastOpenedAt；startWidget 什么都不改', async () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    seed('cc-c', 3)
    writeConfig({
      state: {
        'aa-a': { updatedAt: 11, lastOpenedAt: 0, archivedAt: 0, schemaHash: 'h1' },
        'bb-b': { updatedAt: 22, lastOpenedAt: 600, archivedAt: 0, schemaHash: '' }
      }
    })
    expect(activeIds()).toEqual(['bb-b', 'cc-c', 'aa-a'])
    const before = readConfig().state

    at(2_000_000)
    await widgetService.open('aa-a')

    expect(activeIds()).toEqual(['aa-a', 'bb-b', 'cc-c'])
    const after = readConfig().state
    expect(after['aa-a']).toEqual({ ...before['aa-a'], lastOpenedAt: 2_000_000 })
    expect(after['bb-b']).toEqual(before['bb-b'])
    expect(after['cc-c']).toBeUndefined()

    const opened = bytes()
    at(3_000_000)
    await widgetService.startWidget('cc-c')
    expect(activeIds()).toEqual(['aa-a', 'bb-b', 'cc-c'])
    expect(bytes().equals(opened)).toBe(true)
  })
})

describe('v0.2.16 留下的 homeOrder（LO-4）', () => {
  /** 升序 + 一个不存在的 id + 一个非字符串 —— 与期望的顺序正相反 */
  const LEFTOVER = ['aa-a', 'bb-b', 'cc-c', 'dd-d', 'ghost-id', 7]

  function seedFour(): void {
    seed('aa-a', 1)
    seed('bb-b', 2)
    seed('cc-c', 3)
    seed('dd-d', 4)
  }

  const STATE = {
    'aa-a': { updatedAt: 1, lastOpenedAt: 0, archivedAt: 0, schemaHash: '' },
    'bb-b': { updatedAt: 2, lastOpenedAt: 0, archivedAt: 0, schemaHash: 'h2' },
    'dd-d': { updatedAt: 4, lastOpenedAt: 0, archivedAt: 300, schemaHash: '' }
  }

  it('LO-4a 列表与没有 homeOrder 时一样', () => {
    seedFour()
    writeConfig({ state: STATE })
    const without = activeIds()
    expect(without).toEqual(['cc-c', 'bb-b', 'aa-a'])

    writeConfig({ state: STATE, homeOrder: LEFTOVER })
    expect(activeIds()).toEqual(without)
  })

  it('LO-4b listActive / listArchived / getById 不写账目，homeOrder 还在', () => {
    seedFour()
    writeConfig({ state: STATE, homeOrder: LEFTOVER })
    const original = bytes()

    widgetService.listActive()
    widgetService.listArchived()
    widgetService.getById('aa-a')
    widgetService.getById('dd-d')

    expect(bytes().equals(original)).toBe(true)
    expect(readConfig().homeOrder).toEqual(LEFTOVER)
  })

  /** 一种宿主写入：动了哪个 id 的 state 条目（其余条目要原样） */
  const WRITES: Array<{ name: string; touches: string; run: () => Promise<unknown> | unknown }> = [
    { name: 'open (markOpened)', touches: 'aa-a', run: () => widgetService.open('aa-a') },
    {
      name: 'setArchived(true)',
      touches: 'bb-b',
      run: () => widgetService.setArchived('bb-b', true)
    },
    {
      name: 'setArchived(false)',
      touches: 'dd-d',
      run: () => widgetService.setArchived('dd-d', false)
    },
    {
      name: 'init (insert)',
      touches: 'new-one',
      run: () =>
        widgetService.init({ id: 'new-one', name: 'New', description: '', template: 'blank' })
    },
    {
      name: 'delete (has a state entry)',
      touches: 'aa-a',
      run: () => widgetService.delete('aa-a')
    },
    {
      name: 'noteLink (session use)',
      touches: 'aa-a',
      run: () => widgetService.noteSessionUse('aa-a', 's1', 'p1')
    }
  ]

  it.each(WRITES)('LO-4c $name drops homeOrder and keeps the other state entries', async (w) => {
    seedFour()
    writeConfig({ state: STATE, homeOrder: LEFTOVER })
    const before = readConfig().state

    at(5_000_000)
    await w.run()

    const after = readConfig()
    expect('homeOrder' in after).toBe(false)
    for (const [id, entry] of Object.entries(before)) {
      if (id === w.touches) continue
      expect(after.state[id], id).toEqual(entry)
    }
  })

  it('LO-4d delete 一个没有 state 条目的 id → 账目一个字节都不写，homeOrder 留着', async () => {
    seedFour()
    writeConfig({ state: STATE, homeOrder: LEFTOVER })
    const original = bytes()

    await widgetService.delete('cc-c')

    expect(bytes().equals(original)).toBe(true)
    expect(readConfig().homeOrder).toEqual(LEFTOVER)
  })
})

describe('归档与摘要（LO-5 – LO-7）', () => {
  it('LO-5 打开过的归档再恢复 → lastOpenedAt 留着，回到按它排的位置', async () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    seed('cc-c', 3)
    writeConfig({ state: { 'bb-b': { lastOpenedAt: 400 } } })

    at(2_000_000)
    await widgetService.open('aa-a')
    expect(activeIds()).toEqual(['aa-a', 'bb-b', 'cc-c'])

    at(2_100_000)
    widgetService.setArchived('aa-a', true)
    expect(activeIds()).toEqual(['bb-b', 'cc-c'])
    expect(widgetService.listArchived().map((w) => [w.id, w.lastOpenedAt])).toEqual([
      ['aa-a', 2_000_000]
    ])

    at(2_200_000)
    widgetService.setArchived('aa-a', false)
    expect(activeIds()).toEqual(['aa-a', 'bb-b', 'cc-c'])
    expect(widgetService.listActive()[0].lastOpenedAt).toBe(2_000_000)
  })

  it('LO-6 摘要恰是 8 个字段（含 projectIds，没有 iconMtime）；icon.svg 什么都不变', () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    writeConfig({ state: { 'aa-a': { lastOpenedAt: 50 } } })
    const plain = widgetService.listActive()
    expect(Object.keys(plain[0]).sort()).toEqual([
      'archivedAt',
      'createdAt',
      'description',
      'id',
      'lastOpenedAt',
      'name',
      'projectIds',
      'updatedAt'
    ])

    writeFileSync(
      join(state.root, 'bb-b', 'icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64"/></svg>\n'
    )
    expect(widgetService.listActive()).toEqual(plain)
  })

  it('LO-7 账目损坏 → 照样按 createdAt 倒序列；open / setArchived 不覆盖它', async () => {
    seed('aa-a', 1)
    seed('cc-c', 3)
    seed('bb-b', 2)
    writeFileSync(configFile(), '{ not json')

    expect(activeIds()).toEqual(['cc-c', 'bb-b', 'aa-a'])

    await widgetService.open('aa-a')
    widgetService.setArchived('bb-b', true)

    expect(readFileSync(configFile(), 'utf-8')).toBe('{ not json')
    expect(activeIds()).toEqual(['cc-c', 'bb-b', 'aa-a'])
  })
})

describe('用过这个组件的会话与项目（LK）', () => {
  type Links = {
    projects: Record<string, { firstAt: number; lastAt: number }>
    sessions: Record<string, { projectId: string | null; firstAt: number; lastAt: number }>
  }
  const linksOf = (id: string): Links | undefined =>
    readConfig().state[id]?.links as Links | undefined
  const sessionIds = (id: string): string[] => Object.keys(linksOf(id)?.sessions ?? {})
  const summary = (id: string): { projectIds: string[] } | undefined =>
    widgetService.listActive().find((w) => w.id === id)

  let publish: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    publish = vi.spyOn(appEventBus, 'publish')
  })
  afterEach(() => {
    publish.mockRestore()
  })

  it('LK-1 第一次记：links 恰是一个项目一个会话，别的字段、列表顺序与别的组件都不动', () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    seed('cc-c', 3)
    writeConfig({
      state: {
        'aa-a': { updatedAt: 11, lastOpenedAt: 0, archivedAt: 0, schemaHash: 'h1' },
        'cc-c': { updatedAt: 33, lastOpenedAt: 600, archivedAt: 0, schemaHash: '' }
      }
    })
    const order = activeIds()
    expect(order).toEqual(['cc-c', 'bb-b', 'aa-a'])
    const before = readConfig().state

    at(100)
    widgetService.noteSessionUse('aa-a', 's1', 'p1')

    const after = readConfig().state
    expect(after['aa-a'].links).toEqual({
      projects: { p1: { firstAt: 100, lastAt: 100 } },
      sessions: { s1: { projectId: 'p1', firstAt: 100, lastAt: 100 } }
    })
    expect(after['aa-a']).toEqual({ ...before['aa-a'], links: after['aa-a'].links })
    expect(after['cc-c']).toEqual(before['cc-c'])
    expect('bb-b' in after).toBe(false)
    expect(activeIds()).toEqual(order)
    const aa = widgetService.listActive().find((w) => w.id === 'aa-a')!
    expect([aa.updatedAt, aa.lastOpenedAt]).toEqual([11, 0])
  })

  it('LK-2 同一会话同一项目再记：firstAt 留着、lastAt 往前；回 false；不广播', () => {
    seed('aa-a', 1)
    at(100)
    widgetService.noteSessionUse('aa-a', 's1', 'p1')
    publish.mockClear()

    at(200)
    expect(widgetRegistry.noteLink('aa-a', 's1', 'p1')).toBe(false)
    expect(linksOf('aa-a')).toEqual({
      projects: { p1: { firstAt: 100, lastAt: 200 } },
      sessions: { s1: { projectId: 'p1', firstAt: 100, lastAt: 200 } }
    })

    widgetService.noteSessionUse('aa-a', 's1', 'p1')
    expect(publish).not.toHaveBeenCalled()
  })

  it('LK-3 没有项目（null）：会话行 projectId 为 null、projects 不变、回 false；没条目的组件只记下会话', () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    widgetRegistry.noteLink('aa-a', 's1', 'p1', 100)

    expect(widgetRegistry.noteLink('aa-a', 's2', null, 150)).toBe(false)
    expect(linksOf('aa-a')).toEqual({
      projects: { p1: { firstAt: 100, lastAt: 100 } },
      sessions: {
        s1: { projectId: 'p1', firstAt: 100, lastAt: 100 },
        s2: { projectId: null, firstAt: 150, lastAt: 150 }
      }
    })

    expect(readConfig().state['bb-b']).toBeUndefined()
    expect(widgetRegistry.noteLink('bb-b', 's3', null, 160)).toBe(false)
    expect(linksOf('bb-b')).toEqual({
      projects: {},
      sessions: { s3: { projectId: null, firstAt: 160, lastAt: 160 } }
    })
    expect(summary('bb-b')?.projectIds).toEqual([])
  })

  it('LK-4 只有添了新项目才广播一次 widget.changed', () => {
    seed('aa-a', 1)
    at(100)
    widgetService.noteSessionUse('aa-a', 's1', 'p1')
    expect(publish.mock.calls).toEqual([[{ type: 'widget.changed' }]])

    at(110)
    widgetService.noteSessionUse('aa-a', 's1', 'p1')
    widgetService.noteSessionUse('aa-a', 's4', 'p1')
    widgetService.noteSessionUse('aa-a', 's2', null)
    expect(publish).toHaveBeenCalledTimes(1)

    at(120)
    widgetService.noteSessionUse('aa-a', 's3', 'p2')
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({ type: 'widget.changed' })
  })

  it('LK-5 会话上限 50：挤掉最久没用的；重新用过的不被挤；项目留着', () => {
    expect(WIDGET_SESSION_LINK_LIMIT).toBe(50)
    seed('aa-a', 1)
    for (let i = 1; i <= 50; i++) {
      widgetRegistry.noteLink('aa-a', `s${i}`, i === 1 ? 'p-old' : 'p1', i)
    }
    expect(sessionIds('aa-a')).toHaveLength(50)

    widgetRegistry.noteLink('aa-a', 's51', 'p1', 51)
    let ids = sessionIds('aa-a')
    expect(ids).toHaveLength(50)
    expect(ids).not.toContain('s1')
    expect(ids).toContain('s51')
    // s1 带来的项目不随会话一起走
    expect(linksOf('aa-a')!.projects['p-old']).toEqual({ firstAt: 1, lastAt: 1 })
    expect(summary('aa-a')?.projectIds).toEqual(['p1', 'p-old'])

    // s2 重新用过：下一条挤的是 s3（此刻最旧的），不是 s2
    widgetRegistry.noteLink('aa-a', 's2', 'p1', 52)
    expect(sessionIds('aa-a')).toHaveLength(50)
    widgetRegistry.noteLink('aa-a', 's52', 'p1', 53)
    ids = sessionIds('aa-a')
    expect(ids).toHaveLength(50)
    expect(ids).toContain('s2')
    expect(ids).not.toContain('s3')
    expect(ids).toContain('s52')
    expect(linksOf('aa-a')!.sessions.s2).toEqual({ projectId: 'p1', firstAt: 2, lastAt: 52 })
  })

  it('LK-5 时间全相同：刚记的那条照样留下，恰剩 50', () => {
    seed('bb-b', 2)
    const T = 500
    for (let i = 1; i <= 50; i++) widgetRegistry.noteLink('bb-b', `s${i}`, 'p1', T)
    widgetRegistry.noteLink('bb-b', 's51', 'p2', T)
    const ids = sessionIds('bb-b')
    expect(ids).toHaveLength(50)
    expect(ids).toContain('s51')
    expect(linksOf('bb-b')!.sessions.s51).toEqual({ projectId: 'p2', firstAt: T, lastAt: T })
    expect(Object.keys(linksOf('bb-b')!.projects).sort()).toEqual(['p1', 'p2'])
  })

  it('LK-6 同一会话换了项目：会话行跟着换，两个项目都留着', () => {
    seed('aa-a', 1)
    widgetRegistry.noteLink('aa-a', 's1', 'p1', 100)
    expect(widgetRegistry.noteLink('aa-a', 's1', 'p2', 200)).toBe(true)
    expect(linksOf('aa-a')).toEqual({
      projects: { p1: { firstAt: 100, lastAt: 100 }, p2: { firstAt: 200, lastAt: 200 } },
      sessions: { s1: { projectId: 'p2', firstAt: 100, lastAt: 200 } }
    })
  })

  it('LK-7 projectIds 按最近一次用的时间倒序；没用过 → []；归档的摘要里也有', () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    widgetRegistry.noteLink('aa-a', 's1', 'p1', 100)
    widgetRegistry.noteLink('aa-a', 's2', 'p2', 200)
    expect(summary('aa-a')?.projectIds).toEqual(['p2', 'p1'])
    widgetRegistry.noteLink('aa-a', 's3', 'p1', 300)
    expect(summary('aa-a')?.projectIds).toEqual(['p1', 'p2'])
    expect(summary('bb-b')?.projectIds).toEqual([])

    at(400)
    widgetService.setArchived('aa-a', true)
    const archived = widgetService.listArchived()
    expect(archived.map((w) => [w.id, w.projectIds])).toEqual([['aa-a', ['p1', 'p2']]])
  })

  it('LK-8 坏掉的 links：列表照常、只读出能认的；下一次写只写回能认的，一条都没有就不写 links', async () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    seed('cc-c', 3)
    seed('dd-d', 4)
    writeConfig({
      state: {
        'aa-a': { lastOpenedAt: 0, links: 'x' },
        'bb-b': { links: null },
        'cc-c': {
          links: {
            projects: [{ firstAt: 1, lastAt: 2 }],
            sessions: [{ projectId: 'p9', firstAt: 1, lastAt: 2 }]
          }
        },
        'dd-d': {
          links: {
            projects: {
              p1: { firstAt: '5', lastAt: 7 },
              '': { firstAt: 1, lastAt: 1 },
              bad: 3,
              arr: [1, 2]
            },
            sessions: {
              s1: { projectId: 5, firstAt: 1, lastAt: 2 },
              s2: [1, 2],
              s3: 'x',
              '': { projectId: 'p1', firstAt: 1, lastAt: 1 }
            }
          }
        }
      }
    })

    const list = widgetService.listActive()
    const ids = Object.fromEntries(list.map((w) => [w.id, w.projectIds]))
    expect(ids).toEqual({ 'aa-a': [], 'bb-b': [], 'cc-c': [], 'dd-d': ['p1'] })
    expect(list.flatMap((w) => w.projectIds)).not.toContain('0')

    at(2_000_000)
    for (const id of ['aa-a', 'bb-b', 'cc-c', 'dd-d']) await widgetService.open(id)

    const after = readConfig().state
    for (const id of ['aa-a', 'bb-b', 'cc-c']) {
      expect('links' in after[id], id).toBe(false)
      expect(after[id].lastOpenedAt, id).toBe(2_000_000)
    }
    expect(after['dd-d'].links).toEqual({
      projects: { p1: { firstAt: 0, lastAt: 7 } },
      sessions: { s1: { projectId: null, firstAt: 1, lastAt: 2 } }
    })
  })

  /** 宿主对一个已有组件的几种写入（LK-9 / LK-10 共用）；第一项新建另一个组件 */
  const hostWrites = (id: string): Array<[string, () => Promise<unknown> | unknown]> => [
    [
      'init (another widget)',
      () => widgetService.init({ id: 'zz-new', name: 'New', description: '', template: 'blank' })
    ],
    ['open', () => widgetService.open(id)],
    ['archive', () => widgetService.setArchived(id, true)],
    ['restore', () => widgetService.setArchived(id, false)],
    ['rename (update)', () => widgetService.rename(id, 'Renamed', 'Changed')],
    ['setSchemaHash', () => widgetRegistry.setSchemaHash(id, 'h9')]
  ]

  it('LK-9 没被会话用过的组件：宿主的每一种写入之后条目里都没有 links 键', async () => {
    seed('aa-a', 1)
    let t = 2_000_000
    for (const [name, run] of hostWrites('aa-a')) {
      at((t += 1000))
      await run()
      const entries = readConfig().state
      expect(Object.keys(entries).length, name).toBeGreaterThan(0)
      for (const [id, entry] of Object.entries(entries)) {
        expect('links' in entry, `${name}: ${id}`).toBe(false)
      }
    }
    expect(Object.keys(readConfig().state).sort()).toEqual(['aa-a', 'zz-new'])
    // 写入真的发生了
    expect(readConfig().state['aa-a']).toMatchObject({ schemaHash: 'h9', archivedAt: 0 })
  })

  it('LK-10 用过的组件：同样这些写入之后 links 原样', async () => {
    seed('aa-a', 1)
    widgetRegistry.noteLink('aa-a', 's1', 'p1', 100)
    widgetRegistry.noteLink('aa-a', 's2', null, 150)
    const links = linksOf('aa-a')
    expect(links).toBeDefined()
    let t = 2_000_000
    for (const [name, run] of hostWrites('aa-a')) {
      at((t += 1000))
      await run()
      expect(linksOf('aa-a'), name).toEqual(links)
    }
    expect(summary('aa-a')?.projectIds).toEqual(['p1'])
  })

  it('LK-11 什么都不写：没有 widget.json 的 id / 空 sessionId / 账目不是 JSON', () => {
    // 没有账目文件时：不在的组件不让它冒出账目文件
    mkdirSync(join(state.root, 'yy-y'))
    expect(widgetRegistry.noteLink('zz-z', 's1', 'p1', 100)).toBe(false)
    expect(widgetRegistry.noteLink('yy-y', 's1', 'p1', 100)).toBe(false)
    widgetService.noteSessionUse('zz-z', 's1', 'p1')
    expect(existsSync(configFile())).toBe(false)

    // 有账目：没有清单的 id、空 sessionId 都不动它一个字节
    seed('aa-a', 1)
    writeConfig({ state: { 'aa-a': { lastOpenedAt: 5 } } })
    const original = bytes()
    expect(widgetRegistry.noteLink('zz-z', 's1', 'p1', 100)).toBe(false)
    expect(widgetRegistry.noteLink('yy-y', 's1', 'p1', 100)).toBe(false)
    expect(widgetRegistry.noteLink('aa-a', '', 'p1', 100)).toBe(false)
    widgetService.noteSessionUse('aa-a', '', 'p1')
    widgetService.noteSessionUse('yy-y', 's1', 'p1')
    expect(bytes().equals(original)).toBe(true)

    // 账目不是 JSON：不覆盖
    writeFileSync(configFile(), '{ not json')
    expect(widgetRegistry.noteLink('aa-a', 's1', 'p1', 100)).toBe(false)
    widgetService.noteSessionUse('aa-a', 's1', 'p1')
    expect(readFileSync(configFile(), 'utf-8')).toBe('{ not json')

    expect(publish).not.toHaveBeenCalled()
  })
})
