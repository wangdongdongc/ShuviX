/**
 * services/fileLibrary.ts —— 文件时间线一轮新增的那一半（测试设计 docs/file-library-timeline-tests.md §3–§5，
 * TL-34…TL-73；TL-68 按设计稿的削减名单略去）。
 *
 * 与 fileLibrary.test.ts 同一套替身：元数据表是**真的 LibraryDao**，底下是 node:sqlite 内存库（跑全部迁移），经
 * `setLibraryTable` 注入，每条用例结束 `setLibraryTable(null)`；`os.homedir` 指到临时目录（库根、产物目录都在它下面，
 * 绝不碰真实主目录），electron 的 userData 也是临时目录（快照目录在它下面）。另外：`utils/appEventBus` 换成 publish 间谍。
 *
 * 全部用例跑在假定时器上（只假 setTimeout / clearTimeout / Date）：`library.changed` 合并 200ms 的定时器是模块级的，
 * 上一条用例留下的真定时器会让下一条的通知被合并掉 —— 所以每条用例结束先把定时器走完。
 *
 *   §3  registerLinkedFile / recordSessionFiles / recordAttachedPaths / 读权限只认 sent、attached
 *   §4  removeSessionLibraryLinks：会话自己两个目录里的引用条目先收进库（不论挂在哪条会话上）
 *   §5  libraryTimeline 与 library.changed
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const state = vi.hoisted(() => ({
  home: '',
  userData: '',
  db: null as unknown,
  warn: vi.fn(),
  publish: vi.fn(),
  limits: { bytes: 32 * 1024 * 1024, path: 500 * 1024 * 1024 }
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData }
}))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = (): string => state.home
  return { ...actual, default: { ...actual, homedir }, homedir }
})
vi.mock('../../dao/database', () => {
  class BaseDao {
    protected get db(): { prepare: (sql: string) => unknown } {
      return state.db as { prepare: (sql: string) => unknown }
    }
    protected stmt(sql: string): unknown {
      return (state.db as { prepare: (sql: string) => unknown }).prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => state.db } }
})
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: state.warn, error: () => {}, debug: () => {} })
}))
vi.mock('../../utils/appEventBus', () => ({
  appEventBus: { publish: state.publish }
}))
vi.mock('@shuvix/chat-protocol/fileLibrary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/chat-protocol/fileLibrary')>()
  return { ...actual, LIBRARY_LIMITS: state.limits }
})

import { migrations } from '../../dao/migrations'
import { LibraryDao } from '../../dao/libraryDao'
import {
  isLibraryItemId,
  sanitizeLibraryFileName,
  type LibraryAddResult
} from '@shuvix/chat-protocol/fileLibrary'
import { getSessionArtifactsDir, getShownImagesDir } from '../../utils/paths'
import {
  addToLibrary,
  copySessionLibraryLinks,
  describeLibraryItem,
  emptyLibraryTrash,
  isLibraryItemLinkedToSession,
  keepSentImages,
  libraryFileOf,
  libraryTimeline,
  recordAttachedPaths,
  recordSessionAttached,
  recordSessionFiles,
  registerLinkedFile,
  removeSessionLibraryLinks,
  restoreLibraryItem,
  setLibraryTable,
  toLibraryItemInfo,
  trashLibraryItem
} from '../fileLibrary'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>
type Table = Parameters<typeof setLibraryTable>[0] & object

const A = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const B = '0199d3a2-0000-7000-8000-000000000000'
const C = '0199d3a2-0000-7000-8000-00000000000c'
const D = '0199d3a2-0000-7000-8000-00000000000d'
const S1 = 'sess-1'
const S2 = 'sess-2'
const REAL_LIMITS = { ...state.limits }

let dao: LibraryDao
let scratch: string

const root = (): string => join(state.home, '.shuvix', 'library', 'files')
const db = (): DatabaseSync => state.db as DatabaseSync
const items = (): Row[] =>
  db()
    .prepare(
      `SELECT i.*, v.sha256, v.size, v.mime, v.fileName FROM library_items i
       JOIN library_versions v ON v.itemId = i.id AND v.version = i.currentVersion ORDER BY i.rowid`
    )
    .all() as Row[]
const linksOf = (sessionId?: string): Row[] =>
  (sessionId === undefined
    ? db().prepare('SELECT * FROM library_links ORDER BY rowid').all()
    : db()
        .prepare(
          "SELECT * FROM library_links WHERE targetType = 'session' AND targetId = ? ORDER BY rowid"
        )
        .all(sessionId)) as Row[]
const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')

/** 库根下的全部 item 目录（`<两位>/<id>`） */
function itemDirs(): string[] {
  if (!existsSync(root())) return []
  return readdirSync(root()).flatMap((p) => readdirSync(join(root(), p)).map((id) => `${p}/${id}`))
}

/** 写一个文件（连父目录），回它的路径 */
function file(path: string, content: string | Buffer = 'x'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

const artifact = (sid: string, name: string, content: string | Buffer = 'x'): string =>
  file(join(getSessionArtifactsDir(sid), name), content)
const shown = (sid: string, name: string, content: string | Buffer = 'x'): string =>
  file(join(getShownImagesDir(sid), name), content)

/** 包着真 DAO 的表；`over` 里的方法换掉 */
function wrapTable(over: Partial<Record<keyof Table, unknown>>): Table {
  const names: Array<keyof Table> = [
    'findItem',
    'findManagedBySha',
    'insertItem',
    'setDeletedAt',
    'purgeItem',
    'listDeletedIds',
    'addLink',
    'replaceDerivedLinks',
    'isLinked',
    'deleteLinksOfTarget',
    'copyLinksOfTarget',
    'findLinkedByPath',
    'touchLinked',
    'convertToManaged',
    'findLinkedUnder',
    'timeline'
  ]
  return Object.fromEntries(
    names.map((n) => [
      n,
      over[n] ?? ((...args: unknown[]) => (dao[n] as (...a: unknown[]) => unknown)(...args))
    ])
  ) as unknown as Table
}

/** 直接经 DAO 放一件 */
function seedItem(id: string, over: Partial<Parameters<LibraryDao['insertItem']>[0]> = {}): void {
  dao.insertItem({
    id,
    name: `${id.slice(-2)}.png`,
    storage: 'managed',
    kind: 'image',
    source: 'chat-image',
    sha256: `sha-${id}`,
    size: 1,
    mime: 'image/png',
    fileName: 'a.png',
    createdAt: 1_000,
    ...over
  })
}

function seedLink(
  itemId: string,
  targetId: string,
  relation: 'sent' | 'attached' | 'shown' | 'produced' | 'embedded',
  createdAt = 1_000
): void {
  dao.addLink({
    itemId,
    targetType: 'session',
    targetId,
    relation,
    origin: 'derived',
    context: null,
    createdAt
  })
}

function ok(result: LibraryAddResult): Extract<LibraryAddResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`)
  return result
}

/** 合并窗口走完 */
const settle = (): void => {
  vi.advanceTimersByTime(250)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  state.home = mkdtempSync(join(tmpdir(), 'libtl-home-'))
  state.userData = mkdtempSync(join(tmpdir(), 'libtl-ud-'))
  scratch = mkdtempSync(join(tmpdir(), 'libtl-src-'))
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  state.db = fresh
  dao = new LibraryDao()
  setLibraryTable(dao)
  state.warn.mockClear()
  state.publish.mockClear()
})

afterEach(() => {
  settle()
  setLibraryTable(null)
  Object.assign(state.limits, REAL_LIMITS)
  vi.useRealTimers()
  for (const dir of [state.home, state.userData, scratch]) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('§3 registerLinkedFile', () => {
  it('TL-34 登记一件留在原位置的文件：只记路径，不复制', () => {
    const content = '<svg xmlns="http://www.w3.org/2000/svg"/>'
    const path = file(join(scratch, 'chart.svg'), content)

    const id = registerLinkedFile({ path, source: 'artifact', name: 'Sales chart' })

    expect(isLibraryItemId(id)).toBe(true)
    const rows = items()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      storage: 'linked',
      externalPath: path,
      name: 'Sales chart',
      fileName: 'chart.svg',
      size: Buffer.byteLength(content),
      sha256: '',
      kind: 'image',
      mime: 'image/svg+xml',
      source: 'artifact',
      deletedAt: null
    })
    expect(itemDirs()).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(content)
  })

  it.each([
    ['不给 name', undefined],
    ['空串', ''],
    ['只有空白', '   ']
  ])('TL-35 %s → 显示名取文件名', (_label, name) => {
    const path = file(join(scratch, 'a.png'))
    const id = registerLinkedFile({
      path,
      source: 'chat-file',
      ...(name === undefined ? {} : { name })
    })
    expect(dao.findItem(id!)?.name).toBe('a.png')
  })

  it('TL-36 同一路径再登记、文件没变：同一件，不更新', () => {
    const path = file(join(scratch, 'a.txt'), 'hello')
    const first = registerLinkedFile({ path, source: 'chat-file' })
    const before = dao.findItem(first!)
    const touchLinked = vi.fn()
    setLibraryTable(wrapTable({ touchLinked }))
    vi.setSystemTime(Date.now() + 5_000)

    expect(registerLinkedFile({ path, source: 'chat-file' })).toBe(first)

    expect(items()).toHaveLength(1)
    expect(dao.findItem(first!)).toEqual(before)
    expect(touchLinked).not.toHaveBeenCalled()
  })

  it('TL-37 文件换了长度再登记：同一件，大小与修改时间跟上', () => {
    const path = file(join(scratch, 'a.txt'), 'hello')
    const first = registerLinkedFile({ path, source: 'chat-file' })
    const before = dao.findItem(first!)!
    writeFileSync(path, 'hello, world')
    vi.setSystemTime(Date.now() + 5_000)

    expect(registerLinkedFile({ path, source: 'chat-file' })).toBe(first)

    expect(items()).toHaveLength(1)
    const after = dao.findItem(first!)!
    expect(after.size).toBe(12)
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
    expect(after.createdAt).toBe(before.createdAt)
  })

  it('TL-38 在回收站里的那件再登记：拿回来', () => {
    const path = file(join(scratch, 'a.txt'))
    const id = registerLinkedFile({ path, source: 'chat-file' })!
    expect(trashLibraryItem(id)).toBe(true)
    expect(dao.findItem(id)?.deletedAt).not.toBeNull()

    expect(registerLinkedFile({ path, source: 'chat-file' })).toBe(id)
    expect(dao.findItem(id)?.deletedAt).toBeNull()
    expect(items()).toHaveLength(1)
  })

  it('TL-39 目录、不存在的路径、不存在的相对路径 → null，不抛，不留行', () => {
    for (const path of [scratch, join(scratch, 'none.txt'), 'no-such-dir/none.txt']) {
      let id: string | null = 'unset'
      expect(() => {
        id = registerLinkedFile({ path, source: 'chat-file' })
      }).not.toThrow()
      expect(id).toBeNull()
    }
    expect(items()).toEqual([])
  })

  it('TL-40 没有表、insertItem 抛错 → null，不抛', () => {
    const path = file(join(scratch, 'a.txt'))
    setLibraryTable(null)
    expect(registerLinkedFile({ path, source: 'chat-file' })).toBeNull()

    setLibraryTable(
      wrapTable({
        insertItem: () => {
          throw new Error('locked')
        }
      })
    )
    expect(registerLinkedFile({ path, source: 'chat-file' })).toBeNull()
    expect(items()).toEqual([])
  })
})

describe('§3 recordSessionFiles / recordAttachedPaths', () => {
  it('TL-41 produced：两件 artifact，两条派生关联', () => {
    const p1 = file(join(scratch, 'one.svg'))
    const p2 = file(join(scratch, 'two.svg'))

    recordSessionFiles(S1, 'produced', [{ path: p1, name: 'One' }, { path: p2 }])

    const rows = items()
    expect(rows.map((r) => [r.name, r.source, r.storage, r.externalPath])).toEqual([
      ['One', 'artifact', 'linked', p1],
      ['two.svg', 'artifact', 'linked', p2]
    ])
    expect(
      linksOf().map((l) => [l.itemId, l.targetType, l.targetId, l.relation, l.origin, l.context])
    ).toEqual(
      rows.map((r) => [r.id, 'session', S1, 'produced', 'derived', '{"source":"artifact"}'])
    )
  })

  it.each([
    ['shown', 'shown'],
    ['attached', 'chat-file']
  ] as const)('TL-42 关系 %s → 来源 %s，关联的 context 记同一个词', (relation, source) => {
    recordSessionFiles(S1, relation, [{ path: file(join(scratch, 'a.png')) }])
    expect(items()[0].source).toBe(source)
    expect(linksOf(S1).map((l) => [l.relation, l.context])).toEqual([
      [relation, JSON.stringify({ source })]
    ])
  })

  it('TL-43 坏的跳过、好的照记；addLink 第一次抛错，第二件照样挂上', () => {
    const good1 = file(join(scratch, 'a.png'))
    const good2 = file(join(scratch, 'b.png'))
    expect(() =>
      recordSessionFiles(S1, 'produced', [
        { path: good1 },
        { path: scratch },
        { path: join(scratch, 'missing.png') },
        { path: good2 }
      ])
    ).not.toThrow()
    expect(items().map((r) => r.externalPath)).toEqual([good1, good2])
    expect(linksOf(S1)).toHaveLength(2)

    let calls = 0
    setLibraryTable(
      wrapTable({
        addLink: (link: Parameters<LibraryDao['addLink']>[0]) => {
          if (++calls === 1) throw new Error('locked')
          dao.addLink(link)
        }
      })
    )
    const c = file(join(scratch, 'c.png'))
    const d = file(join(scratch, 'd.png'))
    expect(() => recordSessionFiles(S2, 'produced', [{ path: c }, { path: d }])).not.toThrow()
    const dId = dao.findLinkedByPath(d)!.id
    expect(linksOf(S2).map((l) => l.itemId)).toEqual([dId])
  })

  it('TL-44 同一个文件：一件；同一会话同一关系只有一条关联', () => {
    const path = file(join(scratch, 'a.svg'))
    recordSessionFiles(S1, 'produced', [{ path }])
    recordSessionFiles(S1, 'produced', [{ path }])
    recordSessionFiles(S2, 'attached', [{ path }])

    expect(items()).toHaveLength(1)
    expect(linksOf(S1).map((l) => l.relation)).toEqual(['produced'])
    expect(linksOf(S2).map((l) => l.relation)).toEqual(['attached'])
  })

  it('TL-45 没有表：直接返回，不抛，不发事件', () => {
    setLibraryTable(null)
    expect(() =>
      recordSessionFiles(S1, 'produced', [{ path: file(join(scratch, 'a.svg')) }])
    ).not.toThrow()
    settle()
    expect(state.publish).not.toHaveBeenCalled()
  })

  it('TL-46 recordAttachedPaths：两件 chat-file，attached 关联，文件不复制', () => {
    const a = file(join(scratch, 'a.pdf'))
    const b = file(join(scratch, 'b.txt'))

    recordAttachedPaths(S1, [a, b])

    expect(items().map((r) => [r.storage, r.source, r.externalPath])).toEqual([
      ['linked', 'chat-file', a],
      ['linked', 'chat-file', b]
    ])
    expect(linksOf(S1).map((l) => l.relation)).toEqual(['attached', 'attached'])
    expect(itemDirs()).toEqual([])
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['字符串', '/abs/a.pdf'],
    ['对象', {}],
    ['空数组', []],
    ['没有一个可用的', [42, null, {}, 'rel/a.pdf', './a', '']]
  ])('TL-47 载荷是 %s：什么都不记，不抛', (_label, payload) => {
    expect(() => recordAttachedPaths(S1, payload)).not.toThrow()
    expect(items()).toEqual([])
    expect(linksOf()).toEqual([])
  })

  it('TL-48 坏值里夹着一个真的绝对路径：只记它', () => {
    const good = file(join(scratch, 'good.pdf'))
    mkdirSync(join(scratch, 'dir'))
    recordAttachedPaths(S1, [1, 'rel.txt', good, `${join(scratch, 'dir')}/`])
    expect(items().map((r) => r.externalPath)).toEqual([good])
    expect(linksOf(S1)).toHaveLength(1)
  })
})

describe('§3 读权限：只认用户交给这条会话的（sent / attached）', () => {
  it('TL-49 输入框里添加的文件：本会话可直接读，别的会话不行', () => {
    const path = file(join(scratch, 'a.pdf'))
    recordAttachedPaths(S1, [path])
    const id = dao.findLinkedByPath(path)!.id

    expect(isLibraryItemLinkedToSession(id, S1)).toBe(true)
    expect(isLibraryItemLinkedToSession(id, S2)).toBe(false)
    expect(describeLibraryItem(id, S1)).toEqual({ name: 'a.pdf', linked: true })
  })

  it('TL-50 shown / produced / embedded 都不算', () => {
    const shownPath = file(join(scratch, 's.png'))
    const producedPath = file(join(scratch, 'p.svg'))
    recordSessionFiles(S1, 'shown', [{ path: shownPath }])
    recordSessionFiles(S1, 'produced', [{ path: producedPath }])
    seedItem(C)
    seedLink(C, S1, 'embedded')

    for (const id of [
      dao.findLinkedByPath(shownPath)!.id,
      dao.findLinkedByPath(producedPath)!.id,
      C
    ]) {
      expect(isLibraryItemLinkedToSession(id, S1)).toBe(false)
      expect(describeLibraryItem(id, S1)?.linked).toBe(false)
    }
  })

  it('TL-51 shown 旁边有一条 sent：可直接读', () => {
    seedItem(A)
    seedLink(A, S1, 'shown')
    seedLink(A, S1, 'sent')
    expect(isLibraryItemLinkedToSession(A, S1)).toBe(true)
    expect(describeLibraryItem(A, S1)?.linked).toBe(true)
  })
})

describe('§4 removeSessionLibraryLinks：删会话', () => {
  it('TL-52 产物目录里的文件先收进库：改成托管，字节一致，原文件不动，关联删掉', () => {
    const content = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
    const path = artifact(S1, 'sales chart.svg', content)
    recordSessionFiles(S1, 'produced', [{ path, name: 'Sales chart' }])
    const id = dao.findLinkedByPath(path)!.id
    const fileName = sanitizeLibraryFileName('sales chart.svg')

    removeSessionLibraryLinks(S1)

    expect(items()).toHaveLength(1)
    expect(dao.findItem(id)).toMatchObject({
      id,
      storage: 'managed',
      externalPath: null,
      sha256: sha256(content),
      size: Buffer.byteLength(content),
      fileName,
      name: 'Sales chart'
    })
    const copy = join(root(), id.slice(0, 2), id, fileName)
    expect(readFileSync(copy, 'utf8')).toBe(content)
    expect(readFileSync(path, 'utf8')).toBe(content)
    expect(linksOf(S1)).toEqual([])
    expect(libraryFileOf(id)?.path).toBe(copy)
  })

  it('TL-53 快照目录里的图同样收进库', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const path = shown(S1, `${'ab'.repeat(32)}.png`, bytes)
    recordSessionFiles(S1, 'shown', [{ path, name: 'cat.png' }])
    const id = dao.findLinkedByPath(path)!.id

    removeSessionLibraryLinks(S1)

    const row = dao.findItem(id)!
    expect(row).toMatchObject({ storage: 'managed', externalPath: null, sha256: sha256(bytes) })
    expect(readFileSync(libraryFileOf(id)!.path)).toEqual(bytes)
    expect(linksOf(S1)).toEqual([])
  })

  it('TL-54 输入框里添加的、在别处的文件：仍是引用，不复制；时间线上还在，没有会话', () => {
    const path = file(join(state.home, 'docs', 'a.pdf'))
    recordAttachedPaths(S1, [path])
    const id = dao.findLinkedByPath(path)!.id

    removeSessionLibraryLinks(S1)

    expect(dao.findItem(id)).toMatchObject({ storage: 'linked', externalPath: path })
    expect(itemDirs()).toEqual([])
    expect(linksOf(S1)).toEqual([])
    expect(libraryTimeline().map((e) => [e.item.id, e.sessionId, e.relation])).toEqual([
      [id, null, null]
    ])
  })

  it('TL-55 托管文件（发送的图）：文件与条目不动，只删关联', async () => {
    const [id] = await keepSentImages(S1, 7, [
      { data: Buffer.from('image bytes').toString('base64'), mimeType: 'image/png' }
    ])
    const before = dao.findItem(id)
    const path = libraryFileOf(id)!.path

    removeSessionLibraryLinks(S1)

    expect(dao.findItem(id)).toEqual(before)
    expect(readFileSync(path, 'utf8')).toBe('image bytes')
    expect(linksOf(S1)).toEqual([])
  })

  it('TL-56 分支复制过关联：收进库后另一条会话的关联还在，指着托管的那件', () => {
    const path = artifact(S1, 'a.svg', 'art')
    recordSessionFiles(S1, 'produced', [{ path }])
    copySessionLibraryLinks(S1, S2)
    const id = dao.findLinkedByPath(path)!.id

    removeSessionLibraryLinks(S1)

    expect(dao.findItem(id)?.storage).toBe('managed')
    expect(linksOf(S1)).toEqual([])
    expect(linksOf(S2).map((l) => [l.itemId, l.relation])).toEqual([[id, 'produced']])
  })

  it('TL-57 文件在别的会话的目录里（分支带来的关联）：不收，只删这条会话的关联', () => {
    const path = artifact(S2, 'a.svg')
    recordSessionFiles(S1, 'produced', [{ path }])
    const id = dao.findLinkedByPath(path)!.id

    removeSessionLibraryLinks(S1)

    expect(dao.findItem(id)).toMatchObject({ storage: 'linked', externalPath: path })
    expect(itemDirs()).toEqual([])
    expect(linksOf(S1)).toEqual([])
  })

  it('TL-58 目录名只是前缀相同的兄弟会话（sess-1 / sess-10）：不算在里面', () => {
    const path = artifact('sess-10', 'a.svg')
    recordSessionFiles('sess-1', 'produced', [{ path }])
    const id = dao.findLinkedByPath(path)!.id

    removeSessionLibraryLinks('sess-1')

    expect(dao.findItem(id)).toMatchObject({ storage: 'linked', externalPath: path })
    expect(itemDirs()).toEqual([])
  })

  it('TL-59 登记后文件已经不在盘上：不抛，仍是引用，关联删掉', () => {
    const path = artifact(S1, 'a.svg')
    recordSessionFiles(S1, 'produced', [{ path }])
    const id = dao.findLinkedByPath(path)!.id
    unlinkSync(path)

    expect(() => removeSessionLibraryLinks(S1)).not.toThrow()

    expect(dao.findItem(id)).toMatchObject({ storage: 'linked', externalPath: path })
    expect(linksOf(S1)).toEqual([])
  })

  it('TL-60 一件收进库时抛错：一条 warn，另一件照收，关联全删', () => {
    const p1 = artifact(S1, 'a.svg', 'one')
    const p2 = artifact(S1, 'b.svg', 'two')
    recordSessionFiles(S1, 'produced', [{ path: p1 }, { path: p2 }])
    let calls = 0
    setLibraryTable(
      wrapTable({
        convertToManaged: (...args: Parameters<LibraryDao['convertToManaged']>) => {
          if (++calls === 1) throw new Error('locked')
          dao.convertToManaged(...args)
        }
      })
    )
    state.warn.mockClear()

    expect(() => removeSessionLibraryLinks(S1)).not.toThrow()

    expect(calls).toBe(2)
    expect(state.warn).toHaveBeenCalledTimes(1)
    expect(
      items()
        .map((r) => r.storage)
        .sort()
    ).toEqual(['linked', 'managed'])
    expect(linksOf(S1)).toEqual([])
  })

  it('TL-61 查目录抛错、删关联抛错、没有表：都不抛', () => {
    for (const method of ['findLinkedUnder', 'deleteLinksOfTarget'] as const) {
      setLibraryTable(
        wrapTable({
          [method]: () => {
            throw new Error('locked')
          }
        })
      )
      state.warn.mockClear()
      expect(() => removeSessionLibraryLinks(S1)).not.toThrow()
      expect(state.warn).toHaveBeenCalledTimes(1)
    }
    setLibraryTable(null)
    expect(() => removeSessionLibraryLinks(S1)).not.toThrow()
  })

  it.each([['../x'], ['']])('TL-62 会话 id 不安全（%j）：不抛，什么都不收，它的关联删掉', (sid) => {
    const path = artifact(S1, 'a.svg')
    const id = registerLinkedFile({ path, source: 'artifact' })!
    seedLink(id, sid, 'produced')

    expect(() => removeSessionLibraryLinks(sid)).not.toThrow()

    expect(dao.findItem(id)).toMatchObject({ storage: 'linked', externalPath: path })
    expect(itemDirs()).toEqual([])
    expect(linksOf(sid)).toEqual([])
  })

  it('TL-63 在回收站里的那件也收进库，仍在回收站', () => {
    const path = artifact(S1, 'a.svg', 'art')
    recordSessionFiles(S1, 'produced', [{ path }])
    const id = dao.findLinkedByPath(path)!.id
    trashLibraryItem(id)

    removeSessionLibraryLinks(S1)

    const row = dao.findItem(id)!
    expect(row).toMatchObject({ storage: 'managed', externalPath: null, sha256: sha256('art') })
    expect(row.deletedAt).not.toBeNull()
    expect(readFileSync(join(root(), id.slice(0, 2), id, 'a.svg'), 'utf8')).toBe('art')
  })

  it('TL-64 文件在被删会话的目录里、只挂在另一条会话上：照样收进库，那条关联留着', () => {
    const path = artifact(S1, 'b.svg', 'other')
    recordAttachedPaths(S2, [path])
    const id = dao.findLinkedByPath(path)!.id

    removeSessionLibraryLinks(S1)

    expect(dao.findItem(id)).toMatchObject({
      storage: 'managed',
      externalPath: null,
      sha256: sha256('other')
    })
    expect(readFileSync(libraryFileOf(id)!.path, 'utf8')).toBe('other')
    expect(linksOf(S2).map((l) => [l.itemId, l.relation])).toEqual([[id, 'attached']])
  })
})

describe('§5 libraryTimeline', () => {
  it('TL-65 每件文件每条会话一条，新的在前；没有会话的取进库时刻；回收站里的不出现；不带路径', () => {
    seedItem(A, { createdAt: 10 })
    seedLink(A, S1, 'sent', 300)
    seedItem(B, {
      storage: 'linked',
      externalPath: join(scratch, 'b.svg'),
      sha256: '',
      createdAt: 10
    })
    seedLink(B, S1, 'produced', 400)
    seedLink(B, S2, 'attached', 100)
    seedItem(C, { createdAt: 200 })
    seedItem(D, { createdAt: 500 })
    seedLink(D, S1, 'sent', 500)
    dao.setDeletedAt(D, 600, 600)

    const entries = libraryTimeline()

    expect(entries.map((e) => [e.item.id, e.sessionId, e.relation, e.at])).toEqual([
      [B, S1, 'produced', 400],
      [A, S1, 'sent', 300],
      [C, null, null, 200],
      [B, S2, 'attached', 100]
    ])
    for (const e of entries) {
      expect(e.item).toEqual(toLibraryItemInfo(dao.findItem(e.item.id)!))
      expect(e.item).not.toHaveProperty('externalPath')
      expect(e.item).not.toHaveProperty('sha256')
    }
  })

  it('TL-66 同一件在同一条会话里有两条关联：只出现一次，取最新建立的那条', () => {
    seedItem(A)
    seedLink(A, S1, 'sent', 10)
    seedLink(A, S1, 'attached', 20)
    expect(libraryTimeline().map((e) => [e.item.id, e.sessionId, e.relation, e.at])).toEqual([
      [A, S1, 'attached', 20]
    ])
  })

  it('TL-67 文件不在了 → missing: true；还在的没有这个键', async () => {
    const linkedPath = file(join(scratch, 'gone.pdf'))
    const linkedId = registerLinkedFile({ path: linkedPath, source: 'chat-file' })!
    unlinkSync(linkedPath)
    const managed = ok(
      await addToLibrary({
        item: { kind: 'bytes', name: 'm.txt', mimeType: 'text/plain', dataBase64: 'bQ==' },
        source: 'import'
      })
    )
    unlinkSync(libraryFileOf(managed.item.id)!.path)
    const intactId = registerLinkedFile({
      path: file(join(scratch, 'here.pdf')),
      source: 'chat-file'
    })!

    const byId = new Map(libraryTimeline().map((e) => [e.item.id, e]))

    expect(byId.get(linkedId)?.missing).toBe(true)
    expect(byId.get(managed.item.id)?.missing).toBe(true)
    expect(byId.get(intactId)).toBeDefined()
    expect(byId.get(intactId)).not.toHaveProperty('missing')
  })

  it('TL-69 没有表 → []', () => {
    setLibraryTable(null)
    expect(libraryTimeline()).toEqual([])
  })
})

describe('§5 library.changed（合并 200ms）', () => {
  const image = (text: string): { data: string; mimeType: string } => ({
    data: Buffer.from(text).toString('base64'),
    mimeType: 'image/png'
  })

  it('TL-70 100ms 内三次登记 → 200ms 后一次事件；之后的改动再发一次', () => {
    for (const name of ['a.svg', 'b.svg', 'c.svg']) {
      recordSessionFiles(S1, 'produced', [{ path: file(join(scratch, name)) }])
      vi.advanceTimersByTime(40)
    }
    vi.advanceTimersByTime(70)
    expect(state.publish).not.toHaveBeenCalled()

    vi.advanceTimersByTime(20)
    expect(state.publish).toHaveBeenCalledTimes(1)
    expect(state.publish).toHaveBeenCalledWith({ type: 'library.changed' })

    recordSessionFiles(S1, 'produced', [{ path: file(join(scratch, 'd.svg')) }])
    settle()
    expect(state.publish).toHaveBeenCalledTimes(2)
  })

  it.each<[string, () => void | Promise<unknown>]>([
    ['keepSentImages', () => keepSentImages(S1, 1, [image('one')])],
    [
      'recordSessionAttached',
      () => {
        seedItem(A)
        recordSessionAttached(S1, A, 'note-paste')
      }
    ],
    ['removeSessionLibraryLinks', () => removeSessionLibraryLinks(S1)],
    ['copySessionLibraryLinks', () => copySessionLibraryLinks(S1, S2)],
    ['recordAttachedPaths', () => recordAttachedPaths(S1, [file(join(scratch, 'a.pdf'))])]
  ])('TL-71 %s → 一次事件', async (_name, act) => {
    await act()
    expect(state.publish).not.toHaveBeenCalled()
    settle()
    expect(state.publish).toHaveBeenCalledTimes(1)
    expect(state.publish).toHaveBeenCalledWith({ type: 'library.changed' })
  })

  it('TL-72 什么都没记下：不发事件', async () => {
    recordSessionFiles(S1, 'produced', [{ path: scratch }, { path: join(scratch, 'none') }])
    recordAttachedPaths(S1, ['rel'])
    state.limits.bytes = 2
    expect(await keepSentImages(S1, 1, [image('too large')])).toEqual([])
    settle()
    expect(state.publish).not.toHaveBeenCalled()
  })

  it('TL-73 进库成功、进回收站、恢复各发一次；进库失败与清空回收站不发', async () => {
    const added = ok(
      await addToLibrary({
        item: { kind: 'bytes', name: 'a.txt', mimeType: 'text/plain', dataBase64: 'YQ==' },
        source: 'import'
      })
    )
    settle()
    expect(state.publish).toHaveBeenCalledTimes(1)

    expect(trashLibraryItem(added.item.id)).toBe(true)
    settle()
    expect(state.publish).toHaveBeenCalledTimes(2)

    expect(restoreLibraryItem(added.item.id)).toBe(true)
    settle()
    expect(state.publish).toHaveBeenCalledTimes(3)

    // 不成的：没有这件、进库失败
    expect(trashLibraryItem(B)).toBe(false)
    expect(restoreLibraryItem(B)).toBe(false)
    const failed = await addToLibrary({
      item: { kind: 'path', path: join(scratch, 'none.txt') },
      source: 'import'
    })
    expect(failed.ok).toBe(false)
    settle()
    expect(state.publish).toHaveBeenCalledTimes(3)

    // 清空回收站：回收站里的文件本来就不在时间线上
    expect(trashLibraryItem(added.item.id)).toBe(true)
    settle()
    expect(state.publish).toHaveBeenCalledTimes(4)
    expect(await emptyLibraryTrash()).toBe(1)
    settle()
    expect(state.publish).toHaveBeenCalledTimes(4)
  })
})
