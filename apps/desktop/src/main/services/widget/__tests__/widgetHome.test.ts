/**
 * Widget 主屏顺序（`.config.json` 的 `homeOrder`）与图标文件（`icon.svg`）——
 * 真的 widgetRegistry + widgetService，widgets 根目录是临时目录（`utils/paths` 顶掉）；
 * widgetServer（打包）、widgetDb（pglite）换成空壳；appEventBus.publish 是间谍。
 *
 *   HO-1 没有 homeOrder → listActive 按 createdAt 升序、同时间按 id；归档的不列
 *   HO-2 setHomeOrder([c,a]) → c、a 在前，其余按 createdAt；账目里 homeOrder 是 [c,a]，其余账目不动
 *   HO-3 setHomeOrder 丢掉不合法 id 与重复；合法但不存在的 id 照存不列；整份替换
 *   HO-4 setHomeOrder 发布一次 widget.changed
 *   HO-5 homeOrder 里的归档 id 不列；归档再取消归档 → 排最后、不在 homeOrder 里；listArchived 按 archivedAt 倒序
 *   HO-6 delete 把 id 从 homeOrder 拿掉（账目里没有它的 state 也一样）；两处都没有 → 账目字节不变
 *   HO-7 账目损坏 → setHomeOrder 什么都不写；listActive 照样按 createdAt 列
 *   HO-8 homeOrder 不是数组 → 忽略；数组里的非字符串项丢掉
 *   HO-9 markOpened（open）、取消归档、setSchemaHash（setDbSchema）、insert（init）都不动 homeOrder
 *   IC-1 readIcon：没有 / id 不合法 / icon.svg 是目录 → null；恰好 64 KiB 读出、多一字节 → null；原文照给（不清洗）
 *   IC-2 iconMtime：没有图标或 icon.svg 是目录 → 0；等于 statSync 的 mtimeMs；utimes 后跟着变；超大图标也 > 0
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
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

vi.mock('../../../utils/paths', () => ({ getWidgetsDir: () => state.root }))
vi.mock('../widgetServer', () => ({ widgetServer: serverMock }))
vi.mock('../widgetDb', () => ({
  applyWidgetSchema: vi.fn(async () => {}),
  dropWidgetSchema: vi.fn(async () => {}),
  WidgetDbError: class WidgetDbError extends Error {}
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { widgetService } from '../widgetService'
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

const activeIds = (): string[] => widgetService.listActive().map((w) => w.id)

let publish: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'shuvix-widget-home-'))
  serverMock.hasWidget.mockReset().mockReturnValue(false)
  serverMock.unregisterWidget.mockClear()
  publish = vi.spyOn(appEventBus, 'publish')
})

afterEach(() => {
  publish.mockRestore()
  rmSync(state.root, { recursive: true, force: true })
})

describe('主屏顺序 homeOrder（HO）', () => {
  it('HO-1 没有 homeOrder → 按 createdAt 升序，同时间按 id；归档的不列', () => {
    seed('cc-one', 30)
    seed('bb-two', 10)
    seed('aa-two', 10)
    seed('dd-arch', 5)
    writeConfig({ state: { 'dd-arch': { archivedAt: 100 } } })

    expect(activeIds()).toEqual(['aa-two', 'bb-two', 'cc-one'])
  })

  it('HO-2 setHomeOrder([c,a]) → c、a 在前，其余按 createdAt；其余账目不动', () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    seed('cc-c', 3)
    seed('dd-d', 4)
    writeConfig({
      state: {
        'aa-a': { updatedAt: 7, lastOpenedAt: 8, archivedAt: 0, schemaHash: 'h1' },
        'zz-arch': { updatedAt: 1, lastOpenedAt: 2, archivedAt: 99, schemaHash: '' }
      }
    })
    const before = readConfig().state

    widgetService.setHomeOrder(['cc-c', 'aa-a'])

    expect(activeIds()).toEqual(['cc-c', 'aa-a', 'bb-b', 'dd-d'])
    const after = readConfig()
    expect(after.homeOrder).toEqual(['cc-c', 'aa-a'])
    expect(after.state).toEqual(before)
  })

  it('HO-3 丢掉不合法 id 与重复；合法但不存在的照存不列；整份替换', () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    writeConfig({ state: {}, homeOrder: ['aa-a', 'bb-b'] })

    widgetService.setHomeOrder(['../x', '', 'Bad', 'nodash', 'bb-b', 'ghost-id', 'bb-b'])

    expect(readConfig().homeOrder).toEqual(['bb-b', 'ghost-id'])
    expect(activeIds()).toEqual(['bb-b', 'aa-a'])
  })

  it('HO-4 setHomeOrder 发布一次 widget.changed', () => {
    seed('aa-a', 1)
    widgetService.setHomeOrder(['aa-a'])
    const changed = publish.mock.calls.filter(
      ([e]) => (e as { type: string }).type === 'widget.changed'
    )
    expect(changed).toHaveLength(1)
  })

  it('HO-5 homeOrder 里的归档 id 不列；归档再取消归档 → 排最后且不在 homeOrder；listArchived 按 archivedAt 倒序', () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    seed('cc-c', 3)
    seed('old-arch', 0)
    seed('new-arch', 0)
    writeConfig({
      state: { 'old-arch': { archivedAt: 100 }, 'new-arch': { archivedAt: 200 } },
      homeOrder: ['old-arch', 'cc-c', 'aa-a', 'bb-b']
    })

    expect(activeIds()).toEqual(['cc-c', 'aa-a', 'bb-b'])
    expect(widgetService.listArchived().map((w) => w.id)).toEqual(['new-arch', 'old-arch'])

    widgetService.setArchived('cc-c', true)
    expect(activeIds()).toEqual(['aa-a', 'bb-b'])
    expect(readConfig().homeOrder).not.toContain('cc-c')
    expect(widgetService.listArchived()[0].id).toBe('cc-c')

    widgetService.setArchived('cc-c', false)
    expect(activeIds()).toEqual(['aa-a', 'bb-b', 'cc-c'])
    expect(readConfig().homeOrder).not.toContain('cc-c')
  })

  it('HO-6 delete 把 id 从 homeOrder 拿掉（有 / 没有 state 都一样）', async () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    seed('cc-c', 3)
    writeConfig({ state: { 'aa-a': { updatedAt: 1 } }, homeOrder: ['cc-c', 'aa-a', 'bb-b'] })

    await widgetService.delete('aa-a') // 有 state
    let cfg = readConfig()
    expect(cfg.homeOrder).toEqual(['cc-c', 'bb-b'])
    expect(cfg.state['aa-a']).toBeUndefined()

    await widgetService.delete('cc-c') // 没有 state
    cfg = readConfig()
    expect(cfg.homeOrder).toEqual(['bb-b'])
    expect(existsSync(join(state.root, 'cc-c'))).toBe(false)
  })

  it('HO-6 两处都没有 → 账目字节不变', async () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    writeConfig({ state: { 'bb-b': { updatedAt: 1 } }, homeOrder: ['bb-b'] })
    const bytes = readFileSync(configFile())

    await widgetService.delete('aa-a')

    expect(readFileSync(configFile()).equals(bytes)).toBe(true)
  })

  it('HO-7 账目损坏 → setHomeOrder 什么都不写；listActive 照样按 createdAt', () => {
    seed('bb-b', 2)
    seed('aa-a', 1)
    writeFileSync(configFile(), '{ not json')

    widgetService.setHomeOrder(['bb-b', 'aa-a'])

    expect(readFileSync(configFile(), 'utf-8')).toBe('{ not json')
    expect(activeIds()).toEqual(['aa-a', 'bb-b'])
  })

  it('HO-8 homeOrder 不是数组 → 忽略', () => {
    seed('bb-b', 2)
    seed('aa-a', 1)
    writeConfig({ state: {}, homeOrder: 'bb-b' })
    expect(activeIds()).toEqual(['aa-a', 'bb-b'])
  })

  it('HO-8 数组里的非字符串项丢掉', () => {
    seed('bb-b', 2)
    seed('aa-a', 1)
    writeConfig({ state: {}, homeOrder: [1, 'bb-b', null] })
    expect(activeIds()).toEqual(['bb-b', 'aa-a'])
  })

  it('HO-9 open / 取消归档 / setDbSchema / init 都不动 homeOrder', async () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    writeConfig({ state: { 'bb-b': { archivedAt: 50 } }, homeOrder: ['bb-b', 'aa-a'] })
    const order = (): unknown => readConfig().homeOrder

    await widgetService.open('aa-a')
    expect(readConfig().state['aa-a'].lastOpenedAt).toBeGreaterThan(0)
    expect(order()).toEqual(['bb-b', 'aa-a'])

    widgetService.setArchived('bb-b', false)
    expect(order()).toEqual(['bb-b', 'aa-a'])

    await widgetService.setDbSchema('aa-a', 'create table t (id int);')
    expect(readConfig().state['aa-a'].schemaHash).not.toBe('')
    expect(order()).toEqual(['bb-b', 'aa-a'])

    await widgetService.init({ id: 'new-one', name: 'New', description: '', template: 'blank' })
    expect(readConfig().state['new-one']).toBeDefined()
    expect(order()).toEqual(['bb-b', 'aa-a'])
  })
})

describe('图标 icon.svg（IC）', () => {
  const iconPath = (id: string): string => join(state.root, id, 'icon.svg')

  it('IC-1 没有图标 → null', () => {
    seed('aa-a', 1)
    expect(widgetService.readIcon('aa-a')).toBeNull()
  })

  it('IC-1 id 不合法 → null', () => {
    mkdirSync(join(state.root, 'etc'), { recursive: true })
    writeFileSync(join(state.root, 'etc', 'icon.svg'), '<svg/>')
    expect(widgetService.readIcon('../etc')).toBeNull()
  })

  it('IC-1 icon.svg 是目录 → null', () => {
    seed('aa-a', 1)
    mkdirSync(iconPath('aa-a'))
    expect(widgetService.readIcon('aa-a')).toBeNull()
  })

  it('IC-1 恰好 65536 字节读出，65537 → null', () => {
    seed('aa-a', 1)
    const head = '<svg>'
    const exact = head + 'x'.repeat(65536 - head.length)
    writeFileSync(iconPath('aa-a'), exact)
    expect(widgetService.readIcon('aa-a')).toBe(exact)

    writeFileSync(iconPath('aa-a'), exact + 'x')
    expect(widgetService.readIcon('aa-a')).toBeNull()
  })

  it('IC-1 原文照给（script 还在）', () => {
    seed('aa-a', 1)
    const svg = '<svg viewBox="0 0 10 10"><script>alert(1)</script><rect onload="x()"/></svg>'
    writeFileSync(iconPath('aa-a'), svg)
    expect(widgetService.readIcon('aa-a')).toBe(svg)
  })

  const mtimeOf = (id: string): number => {
    const w = widgetService.listActive().find((x) => x.id === id)
    if (!w) throw new Error(`no ${id}`)
    return w.iconMtime
  }

  it('IC-2 没有图标 / icon.svg 是目录 → 0', () => {
    seed('aa-a', 1)
    seed('bb-b', 2)
    mkdirSync(iconPath('bb-b'))
    expect(mtimeOf('aa-a')).toBe(0)
    expect(mtimeOf('bb-b')).toBe(0)
  })

  it('IC-2 等于 statSync 的 mtimeMs，utimes 后跟着变', () => {
    seed('aa-a', 1)
    writeFileSync(iconPath('aa-a'), '<svg/>')
    expect(mtimeOf('aa-a')).toBe(statSync(iconPath('aa-a')).mtimeMs)

    const before = mtimeOf('aa-a')
    const later = new Date(before + 60_000)
    utimesSync(iconPath('aa-a'), later, later)
    const after = mtimeOf('aa-a')
    expect(after).not.toBe(before)
    expect(after).toBe(statSync(iconPath('aa-a')).mtimeMs)
  })

  it('IC-2 超大图标（读不出来）iconMtime 仍 > 0', () => {
    seed('aa-a', 1)
    writeFileSync(iconPath('aa-a'), 'x'.repeat(65537))
    expect(widgetService.readIcon('aa-a')).toBeNull()
    expect(mtimeOf('aa-a')).toBeGreaterThan(0)
  })
})
