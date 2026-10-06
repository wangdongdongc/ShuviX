/**
 * 启动切换（P4-02，docs/pi-durable/p4-0102-test-design.md §A）—— 编排部分，全部替身：
 *
 *   P4-02-01 重置的编排：逐条 updateStorageKind(当前类型)；不删、不碰宿主 / 存储 / 旧转写
 *   P4-02-02 删除的编排：逐条 sessionService.delete、一条落定才开始下一条（PIN-13）；不直接删行
 *   P4-02-03 子会话不由切换枚举：只删标签页那一行，级联是 sessionService 的事
 *   P4-02-04 既有 notebookPath 又有合法 chromeTab：删，不重置（PIN-07）
 *   P4-02-05 无事可做：{0,0,0}，恰一条 info（计数都是 0，PIN-10）
 *   P4-02-06 计数日志：info 报 reset 3 / deleted 1 / failed 1；一条 warn 点名失败的会话与错误
 *   P4-02-07 单行重置失败不连累别的行（PIN-11）：其余照重置，删除一步照跑，resolve
 *   P4-02-08 单行删除失败不连累别的行
 *   P4-02-09 一步的查询抛错：resolve、记日志、另一步照跑（两个方向）
 *
 * 替身：sessionRecords（两条旧格式查询、updateStorageKind / findById / deleteById 记录调用；行表在 holder
 * 里）、sessionService.delete、sessionStorage、sessionHost、logger。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_SESSION_STORAGE_KIND } from '@shuvix/chat-protocol/sessionStorageKind'

interface Row {
  id: string
  parentId?: string | null
  settings: Record<string, unknown>
}

const h = vi.hoisted(() => ({
  /** 行表：findById 读它；delete 替身删掉一行连同它的子行 */
  table: new Map<string, { id: string; parentId?: string | null; settings: unknown }>(),
  findLegacyWithNotebookPath: vi.fn<() => unknown[]>(),
  findLegacyWithChromeTab: vi.fn<() => unknown[]>(),
  updateStorageKind: vi.fn<(id: string, kind: string) => void>(),
  findById: vi.fn<(id: string) => unknown>(),
  deleteById: vi.fn<(id: string) => void>(),
  delete: vi.fn<(id: string) => Promise<void>>(),
  readLegacyTranscript: vi.fn(),
  openSessionStorage: vi.fn(),
  deleteSessionStorage: vi.fn(),
  hostOpen: vi.fn(),
  hostPeek: vi.fn(),
  getSessionHost: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('../sessionRecords', () => ({
  sessionRecords: {
    findLegacyWithNotebookPath: () => h.findLegacyWithNotebookPath(),
    findLegacyWithChromeTab: () => h.findLegacyWithChromeTab(),
    updateStorageKind: (id: string, kind: string) => h.updateStorageKind(id, kind),
    findById: (id: string) => h.findById(id),
    deleteById: (id: string) => h.deleteById(id)
  }
}))
vi.mock('../sessionService', () => ({
  sessionService: { delete: (id: string) => h.delete(id) }
}))
vi.mock('../sessionStorage', () => ({
  readLegacyTranscript: h.readLegacyTranscript,
  openSessionStorage: h.openSessionStorage,
  deleteSessionStorage: h.deleteSessionStorage
}))
vi.mock('../sessionHost', () => ({
  getSessionHost: () => {
    h.getSessionHost()
    return { open: h.hostOpen, peek: h.hostPeek }
  }
}))
vi.mock('../../logger', () => ({ createLogger: () => h.log }))

import { runLegacySwitchover } from '../legacySwitchover'

const TAB = (tabId: number): Record<string, unknown> => ({
  chromeTab: { installId: 'inst', runId: 'run', tabId }
})

function notebook(id: string, extra: Partial<Row> = {}): Row {
  return { id, settings: { notebookPath: `${id}.md` }, ...extra }
}

function tab(id: string, tabId = 1, extra: Partial<Row> = {}): Row {
  return { id, settings: TAB(tabId), ...extra }
}

/** 两条查询各自交回的行；都进行表 */
function seed(fileBound: Row[], tabs: Row[], others: Row[] = []): void {
  for (const row of [...fileBound, ...tabs, ...others]) h.table.set(row.id, row)
  h.findLegacyWithNotebookPath.mockImplementation(() => fileBound)
  h.findLegacyWithChromeTab.mockImplementation(() => tabs)
}

/** 唯一那条 info 里的计数 */
function infoCounts(): { reset: number; deleted: number; failed: number } {
  expect(h.log.info).toHaveBeenCalledTimes(1)
  const line = String(h.log.info.mock.calls[0][0])
  const count = (key: string): number => {
    const match = new RegExp(`${key}\\D*(\\d+)`).exec(line)
    expect(match, `info 行里没有 ${key}: ${line}`).not.toBeNull()
    return Number(match![1])
  }
  return { reset: count('reset'), deleted: count('deleted'), failed: count('failed') }
}

function warnLines(): string[] {
  return [...h.log.warn.mock.calls, ...h.log.error.mock.calls].map((call) => String(call[0]))
}

function expectNoStorageOrHost(): void {
  expect(h.getSessionHost).not.toHaveBeenCalled()
  expect(h.hostOpen).not.toHaveBeenCalled()
  expect(h.hostPeek).not.toHaveBeenCalled()
  expect(h.openSessionStorage).not.toHaveBeenCalled()
  expect(h.deleteSessionStorage).not.toHaveBeenCalled()
  expect(h.readLegacyTranscript).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  h.table.clear()
  h.findLegacyWithNotebookPath.mockReset().mockReturnValue([])
  h.findLegacyWithChromeTab.mockReset().mockReturnValue([])
  h.updateStorageKind.mockReset()
  h.findById.mockReset().mockImplementation((id) => h.table.get(id))
  h.delete.mockReset().mockImplementation(async (id) => {
    h.table.delete(id)
    for (const [childId, row] of h.table) if (row.parentId === id) h.table.delete(childId)
  })
})

describe('P4-02 启动切换：编排', () => {
  it('P4-02-01 重置：逐条换成当前存储类型；不删、不碰宿主 / 存储 / 旧转写', async () => {
    seed([notebook('a'), notebook('b')], [])

    const result = await runLegacySwitchover()

    expect(h.updateStorageKind.mock.calls).toEqual([
      ['a', CURRENT_SESSION_STORAGE_KIND],
      ['b', CURRENT_SESSION_STORAGE_KIND]
    ])
    expect(h.delete).not.toHaveBeenCalled()
    expectNoStorageOrHost()
    expect(result).toEqual({ reset: 2, deleted: 0, failed: 0 })
  })

  it('P4-02-02 删除：逐条 sessionService.delete，一条落定才开始下一条；不直接删行、不重置', async () => {
    seed([], [tab('t1', 1), tab('t2', 2)])
    const events: string[] = []
    h.delete.mockImplementation(async (id) => {
      events.push(`start:${id}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
      h.table.delete(id)
      events.push(`end:${id}`)
    })

    const result = await runLegacySwitchover()

    expect(h.delete.mock.calls).toEqual([['t1'], ['t2']])
    expect(events).toEqual(['start:t1', 'end:t1', 'start:t2', 'end:t2'])
    expect(h.deleteById).not.toHaveBeenCalled()
    expect(h.updateStorageKind).not.toHaveBeenCalled()
    expect(result).toEqual({ reset: 0, deleted: 2, failed: 0 })
  })

  it('P4-02-03 子会话不由切换枚举：只删 t1，c1 从不经 delete / updateStorageKind', async () => {
    seed([], [tab('t1')], [{ id: 'c1', parentId: 't1', settings: {} }])

    const result = await runLegacySwitchover()

    expect(h.delete.mock.calls).toEqual([['t1']])
    expect(h.updateStorageKind).not.toHaveBeenCalled()
    expect(h.delete.mock.calls.flat()).not.toContain('c1')
    expect(result).toEqual({ reset: 0, deleted: 1, failed: 0 })
  })

  it('P4-02-04 既有 notebookPath 又有合法 chromeTab：删，不重置（PIN-07）', async () => {
    const both: Row = { id: 'x', settings: { notebookPath: 'a.md', ...TAB(3) } }
    // 两条查询都认得它
    seed([both], [both])

    const result = await runLegacySwitchover()

    expect(h.delete.mock.calls).toEqual([['x']])
    expect(h.updateStorageKind).not.toHaveBeenCalled()
    expect(result).toEqual({ reset: 0, deleted: 1, failed: 0 })
  })

  it('P4-02-05 无事可做：{0,0,0}，恰一条 info，计数都是 0', async () => {
    const result = await runLegacySwitchover()

    expect(h.updateStorageKind).not.toHaveBeenCalled()
    expect(h.delete).not.toHaveBeenCalled()
    expect(result).toEqual({ reset: 0, deleted: 0, failed: 0 })
    expect(infoCounts()).toEqual({ reset: 0, deleted: 0, failed: 0 })
    expect(warnLines()).toEqual([])
  })

  it('P4-02-06 计数日志：reset 3 / deleted 1 / failed 1；一条 warn 点名失败的会话与错误', async () => {
    seed([notebook('a'), notebook('b'), notebook('c')], [tab('t1', 1), tab('t2', 2)])
    h.delete.mockImplementation(async (id) => {
      if (id === 't2') throw new Error('disk on fire')
      h.table.delete(id)
    })

    const result = await runLegacySwitchover()

    expect(result).toEqual({ reset: 3, deleted: 1, failed: 1 })
    expect(infoCounts()).toEqual({ reset: 3, deleted: 1, failed: 1 })
    const warns = warnLines()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/\bt2\b/)
    expect(warns[0]).toContain('disk on fire')
  })

  it('P4-02-07 单行重置失败：a / c 照重置，删除一步照跑，resolve；warn 点名 b', async () => {
    seed([notebook('a'), notebook('b'), notebook('c')], [tab('t1')])
    h.updateStorageKind.mockImplementation((id) => {
      if (id === 'b') throw new Error('row locked')
    })

    const result = await runLegacySwitchover()

    expect(h.updateStorageKind.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c'])
    expect(h.delete.mock.calls).toEqual([['t1']])
    expect(result).toEqual({ reset: 2, deleted: 1, failed: 1 })
    const warns = warnLines()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/\bb\b/)
    expect(warns[0]).toContain('row locked')
  })

  it('P4-02-08 单行删除失败：t1 / t3 照删，deleted 2、failed 1，resolve', async () => {
    seed([], [tab('t1', 1), tab('t2', 2), tab('t3', 3)])
    h.delete.mockImplementation(async (id) => {
      if (id === 't2') throw new Error('nope')
      h.table.delete(id)
    })

    const result = await runLegacySwitchover()

    expect(h.delete.mock.calls).toEqual([['t1'], ['t2'], ['t3']])
    expect(result).toEqual({ reset: 0, deleted: 2, failed: 1 })
  })

  it('P4-02-09 重置一步的查询抛错：resolve、记日志、删除一步照跑', async () => {
    seed([], [tab('t1')])
    h.findLegacyWithNotebookPath.mockImplementation(() => {
      throw new Error('malformed JSON')
    })

    await expect(runLegacySwitchover()).resolves.toEqual({ reset: 0, deleted: 1, failed: 0 })
    expect(h.delete.mock.calls).toEqual([['t1']])
    expect(warnLines().some((line) => line.includes('malformed JSON'))).toBe(true)
    expect(infoCounts()).toEqual({ reset: 0, deleted: 1, failed: 0 })
  })

  it('P4-02-09 删除一步的查询抛错：已做的重置留着，resolve、记日志', async () => {
    seed([notebook('a'), notebook('b')], [])
    h.findLegacyWithChromeTab.mockImplementation(() => {
      throw new Error('tab query broke')
    })

    await expect(runLegacySwitchover()).resolves.toEqual({ reset: 2, deleted: 0, failed: 0 })
    expect(h.updateStorageKind.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    expect(h.delete).not.toHaveBeenCalled()
    expect(warnLines().some((line) => line.includes('tab query broke'))).toBe(true)
  })
})
