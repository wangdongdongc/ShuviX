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
 *   LO-6 摘要的字段恰是 7 个（没有 iconMtime）；目录里放个 icon.svg 什么都不变
 *   LO-7 账目损坏（不是 JSON）→ listActive 照样按 createdAt 倒序列；open / setArchived 不覆盖它（字节不变）
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
      name: 'setDbSchema (setSchemaHash)',
      touches: 'cc-c',
      run: () => widgetService.setDbSchema('cc-c', 'create table t (id int);')
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

  it('LO-6 摘要恰是 7 个字段（没有 iconMtime）；icon.svg 什么都不变', () => {
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
