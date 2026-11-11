/**
 * services/fileLibrary.ts —— 文件库 L1 的宿主一半（docs/file-library-design.md §3、§5、§6、§10、§15；
 * 测试设计 docs/file-library-l1-tests.md §5）。
 *
 * 元数据表是**真的 LibraryDao**，底下是 node:sqlite 内存库（同 mdAttrDao.test：mock `dao/database` 的 BaseDao、跑全部
 * 迁移），经 `setLibraryTable` 注入；每条用例结束 `setLibraryTable(null)`。`os.homedir` 指到临时目录，所以库根是
 * `<tmpHome>/.shuvix/library/files` —— 绝不碰真实主目录。`fs/promises` 的 rename / writeFile 与 `fs` 的 createReadStream
 * 包一层透传的间谍（中断写入、量读没读）；上限用可改的 LIBRARY_LIMITS（partial mock chat-protocol/fileLibrary）。
 *
 *   LS-1   字节进库：新建一件（字段、落盘位置、sha、markdown、label 三种、命名清洗与越界名）
 *   LS-2   路径进库：清洗后的 fileName、原名、mime / kind、markdown；源文件还在
 *   LS-3   去重（D2）：同内容的第二、三次（字节 / 路径）都 reused、同 id、fileName 不变；一个目录、一件；label 用自己的
 *   LS-4   同名不同内容：两件两个目录，都叫 a.png（不加序号）
 *   LS-5   并发进库：同内容三份同时进 → 一件，一个新建两个 reused
 *   LS-6   去重把回收站里的那件拿回来
 *   LS-7   heal：盘上的文件 / 整个目录被删，再交同内容 → 原路径补回；补写失败 → io
 *   LS-8   拒收：字节超限、路径超限（不读内容、不建目录）、恰好等于上限能进、目录或不存在 → not-a-file
 *   LS-9   写入中断：rename 失败 / insertItem 抛错 → io，没有行、目录删掉、没有 .tmp
 *   LS-10  没注入表：进库 io、什么都不写；其余函数不抛
 *   LS-11  按 id 定位：libraryItemDir / libraryFileOf / libraryPathOfRef
 *   LS-12  回收站：trash / restore / emptyLibraryTrash（linked 的外部原文件不删）
 *   LS-13  笔记关联 recordNoteLinks / forgetNoteLinks（只 .md、realpath 作 targetId、不读盘、warn、手动行不动）
 *   LS-14  keepSentImages：命名、source、links 行、同图一件、超限的跳过
 *   LS-15  删会话 / 分支会话的关联；DAO 抛错不外抛
 *   LS-16  describeLibraryItem 与 isLibraryItemLinkedToSession（只看会话关联 sent / attached，embedded 不算）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'

const state = vi.hoisted(() => ({
  home: '',
  userData: '',
  db: null as unknown,
  warn: vi.fn(),
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
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const rename = vi.fn(actual.rename)
  const writeFile = vi.fn(actual.writeFile)
  return { ...actual, default: { ...actual, rename, writeFile }, rename, writeFile }
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const createReadStream = vi.fn(actual.createReadStream)
  return { ...actual, default: { ...actual, createReadStream }, createReadStream }
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
vi.mock('@shuvix/chat-protocol/fileLibrary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/chat-protocol/fileLibrary')>()
  return { ...actual, LIBRARY_LIMITS: state.limits }
})

import * as fsp from 'fs/promises'
import * as fs from 'fs'
import { migrations } from '../../dao/migrations'
import { LibraryDao } from '../../dao/libraryDao'
import { isLibraryItemId, type LibraryAddResult } from '@shuvix/chat-protocol/fileLibrary'
import { formatSize } from '../../../shared/node/truncate'
import {
  addToLibrary,
  copySessionLibraryLinks,
  describeLibraryItem,
  emptyLibraryTrash,
  forgetNoteLinks,
  isLibraryItemLinkedToSession,
  keepSentImages,
  libraryFileOf,
  libraryItemDir,
  libraryPathOfRef,
  recordNoteLinks,
  recordSessionAttached,
  recordSessionSent,
  removeSessionLibraryLinks,
  restoreLibraryItem,
  setLibraryTable,
  trashLibraryItem
} from '../fileLibrary'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>
type Table = Parameters<typeof setLibraryTable>[0] & object

const ID = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const ID2 = '0199d3a2-0000-7000-8000-000000000000'
const ID_UP = ID.toUpperCase()
const NOW = 1_800_000_000_000
const REAL_LIMITS = { ...state.limits }

let dao: LibraryDao
let scratch: string

const root = (): string => join(state.home, '.shuvix', 'library', 'files')
const db = (): DatabaseSync => state.db as DatabaseSync
const rowsOf = (table: string): Row[] =>
  db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[]
const linksOf = (where = '1 = 1', ...args: string[]): Row[] =>
  db()
    .prepare(`SELECT * FROM library_links WHERE ${where} ORDER BY itemId, targetId, relation`)
    .all(...args) as Row[]

/** 一张真的 PNG（`seed` 决定像素颜色：不同 seed = 不同内容） */
function png(width = 40, height = 24, seed = 0): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 3
      raw[o] = (200 + seed) & 0xff
      raw[o + 1] = (40 + seed * 7) & 0xff
      raw[o + 2] = (40 + seed * 13) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

const bytesItem = (
  name: string,
  data: Buffer,
  mimeType = 'image/png'
): { kind: 'bytes'; name: string; mimeType: string; dataBase64: string } => ({
  kind: 'bytes',
  name,
  mimeType,
  dataBase64: data.toString('base64')
})

/** 断言成功并收窄类型 */
function ok(result: LibraryAddResult): Extract<LibraryAddResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`)
  return result
}

/** 一个目录下的全部文件（相对路径，递归） */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(d, entry.name), r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
}

/** 库根下 item 目录（`<两位>/<id>`） */
function itemDirs(): string[] {
  if (!existsSync(root())) return []
  return readdirSync(root()).flatMap((p) => readdirSync(join(root(), p)).map((id) => `${p}/${id}`))
}

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
    'copyLinksOfTarget'
  ]
  return Object.fromEntries(
    names.map((n) => [
      n,
      over[n] ?? ((...args: unknown[]) => (dao[n] as (...a: unknown[]) => unknown)(...args))
    ])
  ) as unknown as Table
}

/** 直接经 DAO 放一件（固定 id 用；文件不落盘，需要时自己写） */
function seedItem(id: string, over: Partial<Parameters<LibraryDao['insertItem']>[0]> = {}): void {
  dao.insertItem({
    id,
    name: `${id.slice(0, 4)}.png`,
    storage: 'managed',
    kind: 'image',
    source: 'note-paste',
    sha256: `sha-${id}`,
    size: 1,
    mime: 'image/png',
    fileName: 'a.png',
    createdAt: NOW,
    ...over
  })
}

beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), 'lib-home-'))
  state.userData = mkdtempSync(join(tmpdir(), 'lib-ud-'))
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'lib-src-')))
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  state.db = fresh
  dao = new LibraryDao()
  setLibraryTable(dao)
  state.warn.mockClear()
  vi.mocked(fsp.rename).mockClear()
  vi.mocked(fsp.writeFile).mockClear()
  vi.mocked(fs.createReadStream).mockClear()
})

afterEach(() => {
  setLibraryTable(null)
  Object.assign(state.limits, REAL_LIMITS)
  vi.useRealTimers()
  for (const dir of [state.home, state.userData, scratch]) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('LS-1 字节进库：新建一件', () => {
  it('字段、落盘位置、sha、markdown', async () => {
    const data = png()
    const result = ok(
      await addToLibrary({ item: bytesItem('shot.png', data), source: 'note-paste', now: NOW })
    )

    expect(result.reused).toBe(false)
    const { item } = result
    expect(isLibraryItemId(item.id)).toBe(true)
    expect(item).toEqual({
      id: item.id,
      name: 'shot.png',
      fileName: 'shot.png',
      kind: 'image',
      mime: 'image/png',
      size: data.length,
      width: 40,
      height: 24,
      storage: 'managed',
      source: 'note-paste',
      createdAt: NOW
    })
    expect('deletedAt' in item).toBe(false)

    const dir = join(root(), item.id.slice(0, 2), item.id)
    expect(readdirSync(dir)).toEqual(['shot.png'])
    expect(readFileSync(join(dir, 'shot.png')).equals(data)).toBe(true)
    expect(listFiles(root()).filter((f) => f.endsWith('.tmp'))).toEqual([])

    expect(rowsOf('library_versions').map((r) => r.sha256)).toEqual([sha256(data)])
    expect(result.markdown).toBe(`![shot](shuvix://file/${item.id}/shot.png)`)
  })

  it.each<[string, string | undefined, string]>([
    ["label ''：alt 留空", '', '![]'],
    ["label 'Diagram'", 'Diagram', '![Diagram]'],
    ['不传 label：用显示名去扩展名', undefined, '![photo]']
  ])('%s', async (_l, label, prefix) => {
    const result = ok(
      await addToLibrary({
        item: bytesItem('photo.png', png(40, 24, 3)),
        source: 'note-paste',
        ...(label === undefined ? {} : { label }),
        now: NOW
      })
    )
    expect(result.markdown).toBe(`${prefix}(shuvix://file/${result.item.id}/photo.png)`)
  })

  it("命名：'../../etc/x.md' → x.md、落在自己的目录里，库根以外什么都没建", async () => {
    const result = ok(
      await addToLibrary({
        item: bytesItem('../../etc/x.md', Buffer.from('# hi\n'), 'text/markdown'),
        source: 'note-paste',
        now: NOW
      })
    )
    expect(result.item.fileName).toBe('x.md')
    expect(result.item.name).toBe('../../etc/x.md')
    expect(listFiles(state.home)).toEqual([
      `.shuvix/library/files/${result.item.id.slice(0, 2)}/${result.item.id}/x.md`
    ])
  })

  it.each([
    ['', 'file'],
    ['con', 'con_']
  ])("命名：name '%s' → fileName '%s'", async (name, fileName) => {
    const result = ok(
      await addToLibrary({
        item: bytesItem(
          name,
          Buffer.from(`data for ${name || 'empty'}`),
          'application/octet-stream'
        ),
        source: 'note-paste',
        now: NOW
      })
    )
    expect(result.item.fileName).toBe(fileName)
    expect(existsSync(join(libraryItemDir(result.item.id)!, fileName))).toBe(true)
  })
})

describe('LS-2 路径进库', () => {
  it('Report Q3.pdf：fileName 清洗、name 原样、pdf、没有宽高；markdown；源文件还在', async () => {
    const src = join(scratch, 'Report Q3.pdf')
    const data = Buffer.from('%PDF-1.4\n%fake\n')
    writeFileSync(src, data)

    const result = ok(
      await addToLibrary({ item: { kind: 'path', path: src }, source: 'note-drop', now: NOW })
    )
    expect(result.reused).toBe(false)
    expect(result.item).toMatchObject({
      name: 'Report Q3.pdf',
      fileName: 'Report-Q3.pdf',
      mime: 'application/pdf',
      kind: 'pdf',
      size: data.length,
      source: 'note-drop'
    })
    expect(result.item.width).toBeUndefined()
    expect(result.item.height).toBeUndefined()
    expect(result.markdown).toBe(`[Report Q3.pdf](shuvix://file/${result.item.id}/Report-Q3.pdf)`)
    expect(readFileSync(join(libraryItemDir(result.item.id)!, 'Report-Q3.pdf')).equals(data)).toBe(
      true
    )
    expect(readFileSync(src).equals(data)).toBe(true)
  })
})

describe('LS-3 / LS-4 / LS-5 去重', () => {
  it('LS-3 同内容：字节 a.png → 字节 b.png → 路径；后两次 reused、同 id、fileName 仍是 a.png；一个目录一件', async () => {
    const data = png()
    const first = ok(
      await addToLibrary({ item: bytesItem('a.png', data), source: 'note-paste', now: NOW })
    )
    const second = ok(
      await addToLibrary({ item: bytesItem('b.png', data), source: 'note-drop', now: NOW + 1 })
    )
    const src = join(scratch, 'c.png')
    writeFileSync(src, data)
    const third = ok(
      await addToLibrary({ item: { kind: 'path', path: src }, source: 'note-drop', now: NOW + 2 })
    )

    expect(first.reused).toBe(false)
    expect([second.reused, third.reused]).toEqual([true, true])
    expect(second.item.id).toBe(first.item.id)
    expect(third.item.id).toBe(first.item.id)
    expect(second.item.fileName).toBe('a.png')
    expect(third.item.fileName).toBe('a.png')
    expect(second.item.source).toBe('note-paste')
    expect(itemDirs()).toEqual([`${first.item.id.slice(0, 2)}/${first.item.id}`])
    expect(rowsOf('library_items')).toHaveLength(1)
    expect(second.markdown).toBe(`![b](shuvix://file/${first.item.id}/a.png)`)
  })

  it('LS-4 同名不同内容：两件两个目录，都叫 a.png、不加序号', async () => {
    const one = ok(
      await addToLibrary({ item: bytesItem('a.png', png(40, 24, 1)), source: 'note-paste' })
    )
    const two = ok(
      await addToLibrary({ item: bytesItem('a.png', png(40, 24, 2)), source: 'note-paste' })
    )
    expect(one.item.id).not.toBe(two.item.id)
    expect([one.item.fileName, two.item.fileName]).toEqual(['a.png', 'a.png'])
    expect(itemDirs().sort()).toEqual(
      [one.item.id, two.item.id].map((id) => `${id.slice(0, 2)}/${id}`).sort()
    )
    expect(listFiles(root()).every((f) => f.endsWith('/a.png'))).toBe(true)
    expect(rowsOf('library_items')).toHaveLength(2)
  })

  it('LS-5 并发：同内容三份同时进 → 恰一件；一个新建、两个 reused，id 相同', async () => {
    const data = png()
    const results = (
      await Promise.all(
        ['x.png', 'y.png', 'z.png'].map((name) =>
          addToLibrary({ item: bytesItem(name, data), source: 'note-paste' })
        )
      )
    ).map(ok)
    expect(results.filter((r) => !r.reused)).toHaveLength(1)
    expect(results.filter((r) => r.reused)).toHaveLength(2)
    expect(new Set(results.map((r) => r.item.id)).size).toBe(1)
    expect(rowsOf('library_items')).toHaveLength(1)
    expect(itemDirs()).toHaveLength(1)
  })

  it('LS-6 去重把回收站里的那件拿回来：reused、同 id、deletedAt 清空、libraryFileOf 重新非空', async () => {
    const data = png()
    const first = ok(await addToLibrary({ item: bytesItem('a.png', data), source: 'note-paste' }))
    expect(trashLibraryItem(first.item.id, NOW + 5)).toBe(true)
    expect(libraryFileOf(first.item.id)).toBeNull()

    const again = ok(
      await addToLibrary({ item: bytesItem('a.png', data), source: 'note-paste', now: NOW + 9 })
    )
    expect(again.reused).toBe(true)
    expect(again.item.id).toBe(first.item.id)
    expect(again.item.deletedAt).toBeUndefined()
    expect(dao.findItem(first.item.id)?.deletedAt).toBeNull()
    expect(libraryFileOf(first.item.id)?.path).toBe(join(libraryItemDir(first.item.id)!, 'a.png'))
  })
})

describe('LS-7 补回被删的文件（heal）', () => {
  it.each([
    ['删掉盘上的文件', 'file'],
    ['删掉整个 item 目录', 'dir']
  ])('%s → reused，原路径补回、逐字节相同', async (_l, what) => {
    const data = png()
    const first = ok(await addToLibrary({ item: bytesItem('a.png', data), source: 'note-paste' }))
    const dir = libraryItemDir(first.item.id)!
    const file = join(dir, 'a.png')
    if (what === 'file') unlinkSync(file)
    else rmSync(dir, { recursive: true })
    expect(libraryFileOf(first.item.id)).toBeNull()

    const again = ok(await addToLibrary({ item: bytesItem('b.png', data), source: 'note-paste' }))
    expect(again.reused).toBe(true)
    expect(again.item.id).toBe(first.item.id)
    expect(readFileSync(file).equals(data)).toBe(true)
    expect(readdirSync(dir)).toEqual(['a.png'])
  })

  it('路径进库也能补回', async () => {
    const data = png()
    const first = ok(await addToLibrary({ item: bytesItem('a.png', data), source: 'note-paste' }))
    const file = join(libraryItemDir(first.item.id)!, 'a.png')
    unlinkSync(file)
    const src = join(scratch, 'again.png')
    writeFileSync(src, data)

    const again = ok(await addToLibrary({ item: { kind: 'path', path: src }, source: 'note-drop' }))
    expect(again.reused).toBe(true)
    expect(readFileSync(file).equals(data)).toBe(true)
  })

  it('补写失败（writeFile reject）→ { ok: false, reason: io }', async () => {
    const data = png()
    const first = ok(await addToLibrary({ item: bytesItem('a.png', data), source: 'note-paste' }))
    unlinkSync(join(libraryItemDir(first.item.id)!, 'a.png'))
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(new Error('EIO: disk gone'))

    const again = await addToLibrary({ item: bytesItem('a.png', data), source: 'note-paste' })
    expect(again).toMatchObject({ ok: false, reason: 'io', name: 'a.png' })
    expect(state.warn).toHaveBeenCalled()
  })
})

describe('LS-8 拒收', () => {
  it('字节超上限 → too-large，message 是 formatSize(上限)；盘上与库里都没有东西', async () => {
    state.limits.bytes = 1024
    const result = await addToLibrary({
      item: bytesItem('big.bin', Buffer.alloc(1025, 7), 'application/octet-stream'),
      source: 'note-paste'
    })
    expect(result).toEqual({
      ok: false,
      name: 'big.bin',
      reason: 'too-large',
      message: formatSize(1024)
    })
    expect(listFiles(state.home)).toEqual([])
    expect(rowsOf('library_items')).toEqual([])
  })

  it('路径超上限（稀疏文件）→ too-large，不读内容、不建目录', async () => {
    state.limits.path = 4096
    const src = join(scratch, 'huge.bin')
    writeFileSync(src, '')
    truncateSync(src, 4097)

    const result = await addToLibrary({ item: { kind: 'path', path: src }, source: 'note-drop' })
    expect(result).toEqual({
      ok: false,
      name: 'huge.bin',
      reason: 'too-large',
      message: formatSize(4096)
    })
    expect(fs.createReadStream).not.toHaveBeenCalled()
    expect(existsSync(root())).toBe(false)
    expect(rowsOf('library_items')).toEqual([])
  })

  it('恰好等于上限的能进库（字节与路径）', async () => {
    state.limits.bytes = 1024
    state.limits.path = 4096
    const bytes = ok(
      await addToLibrary({
        item: bytesItem('edge.bin', Buffer.alloc(1024, 1), 'application/octet-stream'),
        source: 'note-paste'
      })
    )
    expect(bytes.item.size).toBe(1024)
    const src = join(scratch, 'edge2.bin')
    writeFileSync(src, Buffer.alloc(4096, 2))
    const path = ok(await addToLibrary({ item: { kind: 'path', path: src }, source: 'note-drop' }))
    expect(path.item.size).toBe(4096)
    // 对照：路径进库真的经 createReadStream 读内容（上一条的「没被调」才有意义）
    expect(fs.createReadStream).toHaveBeenCalledWith(src)
  })

  it.each([
    ['目录', 'dir'],
    ['不存在', 'missing']
  ])('路径是%s → not-a-file，name 是 basename，什么都不写', async (_l, what) => {
    const p = join(scratch, what === 'dir' ? 'folder' : 'nope.png')
    if (what === 'dir') mkdirSync(p)
    const result = await addToLibrary({ item: { kind: 'path', path: p }, source: 'note-drop' })
    expect(result).toMatchObject({ ok: false, reason: 'not-a-file', name: basename(p) })
    expect(existsSync(root())).toBe(false)
    expect(rowsOf('library_items')).toEqual([])
  })
})

describe('LS-9 写入中断（§15）', () => {
  it('rename 失败一次 → io；库里没有行、item 目录删掉、库根下没有 .tmp', async () => {
    vi.mocked(fsp.rename).mockRejectedValueOnce(new Error('EXDEV'))
    const result = await addToLibrary({ item: bytesItem('a.png', png()), source: 'note-paste' })
    expect(result).toMatchObject({ ok: false, reason: 'io', name: 'a.png' })
    expect(rowsOf('library_items')).toEqual([])
    expect(rowsOf('library_versions')).toEqual([])
    expect(itemDirs()).toEqual([])
    expect(listFiles(root())).toEqual([])
  })

  it('insertItem 抛错 → io；item 目录删掉', async () => {
    setLibraryTable(
      wrapTable({
        insertItem: () => {
          throw new Error('SQLITE_FULL')
        }
      })
    )
    const result = await addToLibrary({ item: bytesItem('a.png', png()), source: 'note-paste' })
    expect(result).toMatchObject({ ok: false, reason: 'io', message: 'SQLITE_FULL' })
    expect(itemDirs()).toEqual([])
    expect(listFiles(root())).toEqual([])
    expect(rowsOf('library_items')).toEqual([])
  })
})

describe('LS-10 没注入表', () => {
  it('进库 → io、什么都不写；其余函数不抛，回 null / false / 0', async () => {
    setLibraryTable(null)
    const src = join(scratch, 'n.md')
    writeFileSync(src, `![](shuvix://file/${ID}/a.png)`)

    const result = await addToLibrary({ item: bytesItem('a.png', png()), source: 'note-paste' })
    expect(result).toMatchObject({ ok: false, reason: 'io' })
    expect(listFiles(state.home)).toEqual([])

    expect(libraryFileOf(ID)).toBeNull()
    await expect(recordNoteLinks(src)).resolves.toBeUndefined()
    await expect(recordNoteLinks(src, 'x')).resolves.toBeUndefined()
    expect(() => forgetNoteLinks(src)).not.toThrow()
    expect(() => removeSessionLibraryLinks('S')).not.toThrow()
    expect(() => copySessionLibraryLinks('S', 'F')).not.toThrow()
    expect(() => recordSessionSent('S', [ID], 1)).not.toThrow()
    expect(() => recordSessionAttached('S', ID, 'note-paste')).not.toThrow()
    expect(describeLibraryItem(ID, 'S')).toBeNull()
    expect(isLibraryItemLinkedToSession(ID, 'S')).toBe(false)
    expect(trashLibraryItem(ID)).toBe(false)
    expect(restoreLibraryItem(ID)).toBe(false)
    await expect(emptyLibraryTrash()).resolves.toBe(0)
  })
})

describe('LS-11 按 id 定位', () => {
  it('libraryItemDir：形状不对 → undefined；合法 id → root/<两位>/<id>', () => {
    expect(libraryItemDir('bad')).toBeUndefined()
    expect(libraryItemDir(ID_UP)).toBeUndefined()
    expect(libraryItemDir(ID)).toBe(join(root(), ID.slice(0, 2), ID))
  })

  it('libraryFileOf：存在 → { item, path }；回收站、文件不在、库里没有、大写 id → null', async () => {
    const live = ok(
      await addToLibrary({ item: bytesItem('a.png', png(40, 24, 1)), source: 'note-paste' })
    )
    const trashed = ok(
      await addToLibrary({ item: bytesItem('b.png', png(40, 24, 2)), source: 'note-paste' })
    )
    const gone = ok(
      await addToLibrary({ item: bytesItem('c.png', png(40, 24, 3)), source: 'note-paste' })
    )
    trashLibraryItem(trashed.item.id)
    unlinkSync(join(libraryItemDir(gone.item.id)!, 'c.png'))

    const hit = libraryFileOf(live.item.id)
    expect(hit?.path).toBe(join(libraryItemDir(live.item.id)!, 'a.png'))
    expect(hit?.item.id).toBe(live.item.id)
    expect(libraryFileOf(trashed.item.id)).toBeNull()
    expect(libraryFileOf(gone.item.id)).toBeNull()
    expect(libraryFileOf(ID)).toBeNull()
    expect(libraryFileOf(live.item.id.toUpperCase())).toBeNull()
  })

  it('libraryPathOfRef：大小写同一路径；找不到 → 库根内不存在的路径；不是库引用 → undefined', async () => {
    const live = ok(
      await addToLibrary({ item: bytesItem('a.png', png(40, 24, 1)), source: 'note-paste' })
    )
    const trashed = ok(
      await addToLibrary({ item: bytesItem('b.png', png(40, 24, 2)), source: 'note-paste' })
    )
    trashLibraryItem(trashed.item.id)
    const expected = join(libraryItemDir(live.item.id)!, 'a.png')

    expect(libraryPathOfRef(`library:${live.item.id}`)).toBe(expected)
    expect(libraryPathOfRef(`library:${live.item.id.toUpperCase()}`)).toBe(expected)

    for (const ref of [`library:${trashed.item.id}`, `library:${ID}`]) {
      const p = libraryPathOfRef(ref)!
      expect(p, ref).toBeTypeOf('string')
      expect(p.startsWith(root() + '/'), ref).toBe(true)
      expect(existsSync(p), ref).toBe(false)
      expect(p.startsWith(scratch)).toBe(false)
    }

    expect(libraryPathOfRef('shown:x')).toBeUndefined()
    expect(libraryPathOfRef('a.png')).toBeUndefined()
    expect(libraryPathOfRef('library:bad')).toBeUndefined()
  })
})

describe('LS-12 回收站', () => {
  it('trash / restore；emptyLibraryTrash 清三件：托管的目录没了，linked 的外部原文件还在，正常那件不动', async () => {
    const m1 = ok(
      await addToLibrary({ item: bytesItem('a.png', png(40, 24, 1)), source: 'note-paste' })
    )
    const m2 = ok(
      await addToLibrary({ item: bytesItem('b.png', png(40, 24, 2)), source: 'note-paste' })
    )
    const keep = ok(
      await addToLibrary({ item: bytesItem('k.png', png(40, 24, 3)), source: 'note-paste' })
    )
    const external = join(scratch, 'outside.pdf')
    writeFileSync(external, 'pdf bytes')
    seedItem(ID, {
      storage: 'linked',
      externalPath: external,
      kind: 'pdf',
      mime: 'application/pdf',
      fileName: 'outside.pdf'
    })
    for (const id of [m1.item.id, m2.item.id, ID, keep.item.id]) {
      recordSessionSent('S', [id], 1)
    }

    // trash 之后 libraryFileOf 为 null，但盘上文件还在；restore 拿回来
    const m1File = join(libraryItemDir(m1.item.id)!, 'a.png')
    expect(trashLibraryItem(m1.item.id)).toBe(true)
    expect(libraryFileOf(m1.item.id)).toBeNull()
    expect(existsSync(m1File)).toBe(true)
    expect(restoreLibraryItem(m1.item.id)).toBe(true)
    expect(libraryFileOf(m1.item.id)?.path).toBe(m1File)
    expect(trashLibraryItem(ID2)).toBe(false)
    expect(trashLibraryItem('bad')).toBe(false)
    expect(restoreLibraryItem(ID2)).toBe(false)
    expect(restoreLibraryItem('bad')).toBe(false)

    expect(trashLibraryItem(m1.item.id)).toBe(true)
    expect(trashLibraryItem(m2.item.id)).toBe(true)
    expect(trashLibraryItem(ID)).toBe(true)
    expect(libraryFileOf(ID)).toBeNull()

    await expect(emptyLibraryTrash()).resolves.toBe(3)

    expect(existsSync(libraryItemDir(m1.item.id)!)).toBe(false)
    expect(existsSync(libraryItemDir(m2.item.id)!)).toBe(false)
    expect(readFileSync(external, 'utf8')).toBe('pdf bytes')
    expect(libraryFileOf(keep.item.id)).not.toBeNull()
    expect(itemDirs()).toEqual([`${keep.item.id.slice(0, 2)}/${keep.item.id}`])

    for (const id of [m1.item.id, m2.item.id, ID]) {
      expect(dao.findItem(id), id).toBeNull()
      expect(
        rowsOf('library_versions').filter((r) => r.itemId === id),
        id
      ).toEqual([])
      expect(linksOf('itemId = ?', id), id).toEqual([])
    }
    expect(linksOf('itemId = ?', keep.item.id)).toHaveLength(1)
    await expect(emptyLibraryTrash()).resolves.toBe(0)
  })
})

describe('LS-13 笔记关联', () => {
  const body = (extra = ''): string =>
    [
      `![](shuvix://file/${ID}/a.png)`,
      `again shuvix://file/${ID}/a.png`,
      `upper ![](shuvix://file/${ID_UP}/a.png)`,
      `[r](shuvix://file/${ID2}/r.pdf)`,
      `[gone](shuvix://file/0199d3a2-0000-7000-8000-0000000000ff/x.pdf)`,
      extra
    ].join('\n')

  const noteRows = (targetId: string): Array<[unknown, unknown]> =>
    linksOf("targetType = 'note' AND targetId = ?", targetId).map((r) => [r.itemId, r.origin])

  beforeEach(() => {
    seedItem(ID)
    seedItem(ID2)
  })

  it('只有库里有的 ID / ID2 记 embedded 派生行，targetId = realpath(n.md)', async () => {
    const note = join(scratch, 'n.md')
    writeFileSync(note, body())
    await recordNoteLinks(note)

    expect(linksOf("targetType = 'note'")).toEqual(
      [ID, ID2]
        .map((itemId) => ({
          itemId,
          targetType: 'note',
          targetId: realpathSync.native(note),
          relation: 'embedded',
          origin: 'derived',
          context: null,
          createdAt: expect.any(Number)
        }))
        .sort((a, b) => a.itemId.localeCompare(b.itemId))
    )
  })

  it('传了 content 就不读盘：盘上没有这个文件也能记', async () => {
    const note = join(scratch, 'ghost.md')
    await recordNoteLinks(note, body())
    expect(noteRows(note)).toHaveLength(2)
    expect(state.warn).not.toHaveBeenCalled()
  })

  it('正文删掉一个链接再记：那一行没了；手动行不动', async () => {
    const note = join(scratch, 'n.md')
    writeFileSync(note, body())
    await recordNoteLinks(note)
    dao.addLink({
      itemId: ID2,
      targetType: 'note',
      targetId: note,
      relation: 'bound',
      origin: 'manual',
      context: null,
      createdAt: 1
    })

    writeFileSync(note, `only ![](shuvix://file/${ID}/a.png)`)
    await recordNoteLinks(note)
    expect(noteRows(note).sort()).toEqual(
      [
        [ID, 'derived'],
        [ID2, 'manual']
      ].sort()
    )
  })

  it('n.txt 不记；N.MD 照记', async () => {
    const txt = join(scratch, 'n.txt')
    const upper = join(scratch, 'N.MD')
    writeFileSync(txt, body())
    writeFileSync(upper, body())
    await recordNoteLinks(txt)
    await recordNoteLinks(txt, body())
    expect(linksOf("targetType = 'note'")).toEqual([])
    await recordNoteLinks(upper)
    expect(noteRows(realpathSync.native(upper))).toHaveLength(2)
  })

  it('文件不在又没传 content：不抛、记一条 warn，已有的行不动', async () => {
    const note = join(scratch, 'n.md')
    writeFileSync(note, body())
    await recordNoteLinks(note)
    const before = linksOf()
    unlinkSync(note)

    await expect(recordNoteLinks(note)).resolves.toBeUndefined()
    expect(state.warn).toHaveBeenCalledTimes(1)
    expect(linksOf()).toEqual(before)
  })

  it('路径规范化：符号链接、dir/../dir/n.md 落到同一个 targetId；forgetNoteLinks 对已删的文件照样清得掉', async () => {
    const dir = join(scratch, 'dir')
    mkdirSync(dir)
    const note = join(dir, 'n.md')
    writeFileSync(note, body())
    const alias = join(scratch, 'alias')
    symlinkSync(dir, alias)

    await recordNoteLinks(join(alias, 'n.md'))
    await recordNoteLinks(join(dir, '..', 'dir', 'n.md'), `![](shuvix://file/${ID}/a.png)`)
    expect(new Set(linksOf("targetType = 'note'").map((r) => r.targetId))).toEqual(
      new Set([realpathSync.native(note)])
    )
    expect(noteRows(note)).toEqual([[ID, 'derived']])

    await recordNoteLinks(note)
    expect(noteRows(note)).toHaveLength(2)
    unlinkSync(note)
    forgetNoteLinks(join(alias, 'n.md'))
    expect(linksOf("targetType = 'note'")).toEqual([])
  })
})

describe('LS-14 keepSentImages', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 10, 15, 30, 12))
  })

  it('png + jpeg：-1 / -2 命名、chat-image、按顺序回 ids；links 是 sent + entryId', async () => {
    const p = png(40, 24, 1)
    const j = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9])
    const ids = await keepSentImages('S', 7, [
      { data: p.toString('base64'), mimeType: 'image/png' },
      { data: j.toString('base64'), mimeType: 'image/jpeg' }
    ])

    expect(ids).toHaveLength(2)
    const rows = ids.map((id) => dao.findItem(id)!)
    expect(rows.map((r) => [r.name, r.fileName, r.source])).toEqual([
      ['image-20261110-153012-1.png', 'image-20261110-153012-1.png', 'chat-image'],
      ['image-20261110-153012-2.jpg', 'image-20261110-153012-2.jpg', 'chat-image']
    ])
    expect(readFileSync(join(libraryItemDir(ids[1])!, rows[1].fileName)).equals(j)).toBe(true)
    expect(
      linksOf().map((r) => [r.itemId, r.targetType, r.targetId, r.relation, r.origin, r.context])
    ).toEqual([...ids].sort().map((id) => [id, 'session', 'S', 'sent', 'derived', '{"entryId":7}']))
  })

  it('只有一张：不带 -1', async () => {
    const ids = await keepSentImages('S', 3, [
      { data: png().toString('base64'), mimeType: 'image/png' }
    ])
    expect(dao.findItem(ids[0])?.name).toBe('image-20261110-153012.png')
  })

  it('同一次发送里两张相同的图：一件、一条 link', async () => {
    const data = png().toString('base64')
    const ids = await keepSentImages('S', 3, [
      { data, mimeType: 'image/png' },
      { data, mimeType: 'image/png' }
    ])
    expect(new Set(ids).size).toBe(1)
    expect(rowsOf('library_items')).toHaveLength(1)
    expect(linksOf()).toHaveLength(1)
  })

  it('一张超上限：其余照常进库，记一条 warn，只给进了库的写 link', async () => {
    state.limits.bytes = 2048
    const small = png(40, 24, 1)
    expect(small.length).toBeLessThan(2048)
    const ids = await keepSentImages('S', 9, [
      { data: Buffer.alloc(4096, 9).toString('base64'), mimeType: 'image/png' },
      { data: small.toString('base64'), mimeType: 'image/png' }
    ])
    expect(ids).toHaveLength(1)
    expect(dao.findItem(ids[0])?.name).toBe('image-20261110-153012-2.png')
    expect(state.warn).toHaveBeenCalledTimes(1)
    expect(linksOf().map((r) => r.itemId)).toEqual(ids)
  })
})

describe('LS-15 删会话、分支会话', () => {
  it('removeSessionLibraryLinks 只删 S 的关联，文件与笔记关联都在；copySessionLibraryLinks 复制关系与 context', async () => {
    const a = ok(
      await addToLibrary({ item: bytesItem('a.png', png(40, 24, 1)), source: 'chat-image' })
    )
    const b = ok(
      await addToLibrary({ item: bytesItem('b.png', png(40, 24, 2)), source: 'chat-image' })
    )
    recordSessionSent('S', [a.item.id, b.item.id], 4)
    recordSessionAttached('S', b.item.id, 'note-drop')
    const note = join(scratch, 'n.md')
    await recordNoteLinks(note, `![](shuvix://file/${a.item.id}/a.png)`)
    const noteBefore = linksOf("targetType = 'note'")
    expect(noteBefore).toHaveLength(1)

    copySessionLibraryLinks('S', 'F')
    const strip = (rows: Row[]): unknown[] =>
      rows.map((r) => [r.itemId, r.relation, r.origin, r.context, r.createdAt])
    const sRows = linksOf("targetType = 'session' AND targetId = 'S'")
    expect(sRows).toHaveLength(3)
    expect(strip(linksOf("targetType = 'session' AND targetId = 'F'"))).toEqual(strip(sRows))

    removeSessionLibraryLinks('S')
    expect(linksOf("targetType = 'session' AND targetId = 'S'")).toEqual([])
    expect(linksOf("targetType = 'session' AND targetId = 'F'")).toHaveLength(3)
    expect(linksOf("targetType = 'note'")).toEqual(noteBefore)
    expect(libraryFileOf(a.item.id)).not.toBeNull()
    expect(libraryFileOf(b.item.id)).not.toBeNull()
  })

  it('DAO 抛错：两个函数都不抛，各记一条 warn', () => {
    setLibraryTable(
      wrapTable({
        deleteLinksOfTarget: () => {
          throw new Error('locked')
        },
        copyLinksOfTarget: () => {
          throw new Error('locked')
        }
      })
    )
    expect(() => removeSessionLibraryLinks('S')).not.toThrow()
    expect(() => copySessionLibraryLinks('S', 'F')).not.toThrow()
    expect(state.warn).toHaveBeenCalledTimes(2)
  })
})

describe('LS-16 describeLibraryItem / isLibraryItemLinkedToSession（只看会话关联）', () => {
  it('sent：本会话 linked true，别的会话 false', async () => {
    const a = ok(
      await addToLibrary({ item: bytesItem('a.png', png(40, 24, 1)), source: 'chat-image' })
    )
    recordSessionSent('S', [a.item.id], 2)
    expect(describeLibraryItem(a.item.id, 'S')).toEqual({ name: 'a.png', linked: true })
    expect(describeLibraryItem(a.item.id, 'T')).toEqual({ name: 'a.png', linked: false })
    expect(isLibraryItemLinkedToSession(a.item.id, 'S')).toBe(true)
    expect(isLibraryItemLinkedToSession(a.item.id, 'T')).toBe(false)
  })

  it('attached：recordSessionAttached 写 attached、context 记 source，linked true', async () => {
    const c = ok(
      await addToLibrary({ item: bytesItem('c.png', png(40, 24, 3)), source: 'note-paste' })
    )
    recordSessionAttached('S', c.item.id, 'note-paste')
    expect(describeLibraryItem(c.item.id, 'S')).toEqual({ name: 'c.png', linked: true })
    expect(linksOf('itemId = ?', c.item.id)).toEqual([
      {
        itemId: c.item.id,
        targetType: 'session',
        targetId: 'S',
        relation: 'attached',
        origin: 'derived',
        context: '{"source":"note-paste"}',
        createdAt: expect.any(Number)
      }
    ])
  })

  it('只被笔记正文引用（embedded）：对任何会话都是 linked false', async () => {
    const b = ok(
      await addToLibrary({ item: bytesItem('b.png', png(40, 24, 2)), source: 'note-paste' })
    )
    const note = join(scratch, 'n.md')
    await recordNoteLinks(note, `![](shuvix://file/${b.item.id}/b.png)`)
    expect(linksOf('itemId = ?', b.item.id)).toHaveLength(1)

    for (const sid of ['S', 'T', note, realpathSync.native(scratch) + '/n.md']) {
      expect(describeLibraryItem(b.item.id, sid), sid).toEqual({ name: 'b.png', linked: false })
      expect(isLibraryItemLinkedToSession(b.item.id, sid), sid).toBe(false)
    }
  })

  it('未知 id、形状不对的 id、在回收站里的 → null', async () => {
    const a = ok(
      await addToLibrary({ item: bytesItem('a.png', png(40, 24, 1)), source: 'chat-image' })
    )
    recordSessionSent('S', [a.item.id], 2)
    trashLibraryItem(a.item.id)
    expect(describeLibraryItem(a.item.id, 'S')).toBeNull()
    expect(describeLibraryItem(ID, 'S')).toBeNull()
    expect(describeLibraryItem('not-an-id', 'S')).toBeNull()
    expect(describeLibraryItem(a.item.id.toUpperCase(), 'S')).toBeNull()
  })
})
