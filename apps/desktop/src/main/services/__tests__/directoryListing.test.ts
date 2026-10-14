/**
 * `services/directoryListing.ts`（server mode phase D §D3）—— web 客户端的目录浏览器一层一层问的 `fs:listDirectories`：
 * 路径怎么解析、只列目录（含指向目录的链接）、隐藏目录的开关、排序、条数上限、读不了时从不拒绝。
 * 目录树是临时目录里真建的；`fs/promises` 的 readdir 包一层间谍（缺省走真实现），DL-4 拿它造一个没有 code 的错误。
 *
 *   DL-1 resolveListingPath：空 / 空白 / `~` / 非字符串 → 主目录；`~/a`、`~\a` → 主目录下；相对路径按主目录解析；
 *        绝对路径规范化；`~foo` 不是主目录展开；首尾空白去掉
 *   DL-2 只列目录与指向目录的链接，按名字排序（不分大小写、数字按数值）；path 是 join(dir, name)；
 *        showHidden:true 才列 `.` 开头的；showHidden:'true'（不是布尔）不算
 *   DL-3 正常目录恰回 {path, parent, home, entries}（没有 truncated / error 键）；`/` 的 parent 是 null；path 规范化
 *   DL-4 从不拒绝：不在 → ENOENT（path / parent 照给、entries 空）；是文件 → ENOTDIR；没权限 → EACCES（root / win32
 *        跳过）；readdir 的错误没有 code → EIO
 *   DL-5 2001 个子目录 → 前 2000 个（按排序）+ truncated:true；恰 2000 个 → 没有 truncated 键
 *   DL-6 不给 home → home 就是 os.homedir()
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const state = vi.hoisted(() => ({ readdir: vi.fn() }))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const readdir = (...args: unknown[]): unknown => state.readdir(...args)
  return { ...actual, default: { ...actual, readdir }, readdir }
})

import { MAX_DIRECTORY_ENTRIES, listDirectories, resolveListingPath } from '../directoryListing'

const HOME = resolve('/home/tester')
const canRestrictReads = process.platform !== 'win32' && process.getuid?.() !== 0

let tmp: string

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  state.readdir.mockReset()
  state.readdir.mockImplementation((...args: unknown[]) =>
    (actual.readdir as (...a: unknown[]) => Promise<unknown>)(...args)
  )
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-dirlist-'))
})

afterEach(() => {
  try {
    chmodSync(join(tmp, 'locked'), 0o755)
  } catch {
    /* 没建过 */
  }
  rmSync(tmp, { recursive: true, force: true })
})

describe('DL-1 resolveListingPath', () => {
  it('DL-1 空 / 空白 / ~ / 非字符串 → 主目录', () => {
    for (const raw of [undefined, '', '   ', '~', 5, null, {}]) {
      expect(resolveListingPath(raw, HOME), JSON.stringify(raw)).toBe(HOME)
    }
  })

  it('DL-1 ~/a 与 ~\\a → 主目录下；相对路径按主目录；绝对路径规范化；~foo 不展开；去首尾空白', () => {
    expect(resolveListingPath('~/a', HOME)).toBe(join(HOME, 'a'))
    expect(resolveListingPath('~\\a', HOME)).toBe(join(HOME, 'a'))
    expect(resolveListingPath('a/../b', HOME)).toBe(join(HOME, 'b'))
    expect(resolveListingPath('/x/y/', HOME)).toBe(resolve('/x/y'))
    expect(resolveListingPath('~foo', HOME)).toBe(join(HOME, '~foo'))
    expect(resolveListingPath('  /x/y  ', HOME)).toBe(resolve('/x/y'))
    expect(resolveListingPath('  ~/a ', HOME)).toBe(join(HOME, 'a'))
  })
})

describe('DL-2 只列目录、排序、隐藏', () => {
  beforeEach(() => {
    for (const name of ['alpha', 'Beta', 'a10', 'a2', '.hidden']) mkdirSync(join(tmp, name))
    writeFileSync(join(tmp, 'file.txt'), 'x')
    symlinkSync(join(tmp, 'alpha'), join(tmp, 'link-to-dir'))
    symlinkSync(join(tmp, 'file.txt'), join(tmp, 'link-to-file'))
    symlinkSync(join(tmp, 'nowhere'), join(tmp, 'broken-link'))
    symlinkSync(join(tmp, 'alpha'), join(tmp, '.hidden-link'))
  })

  it('DL-2 缺省：只有目录与指向目录的链接，按名字排序；path 是 join(dir, name)', async () => {
    const listing = await listDirectories({ path: tmp }, HOME)
    expect(listing.entries.map((e) => e.name)).toStrictEqual([
      'a2',
      'a10',
      'alpha',
      'Beta',
      'link-to-dir'
    ])
    for (const entry of listing.entries) expect(entry.path).toBe(join(tmp, entry.name))
  })

  it('DL-2 showHidden:true 加上 .hidden 与 .hidden-link；其余照旧', async () => {
    const listing = await listDirectories({ path: tmp, showHidden: true }, HOME)
    const names = listing.entries.map((e) => e.name)
    expect([...names].sort()).toStrictEqual(
      ['.hidden', '.hidden-link', 'a2', 'a10', 'alpha', 'Beta', 'link-to-dir'].sort()
    )
    expect(names.filter((n) => !n.startsWith('.'))).toStrictEqual([
      'a2',
      'a10',
      'alpha',
      'Beta',
      'link-to-dir'
    ])
  })

  it("DL-2 showHidden:'true'（不是布尔）什么也不加", async () => {
    const listing = await listDirectories(
      { path: tmp, showHidden: 'true' as unknown as boolean },
      HOME
    )
    expect(listing.entries.map((e) => e.name)).toStrictEqual([
      'a2',
      'a10',
      'alpha',
      'Beta',
      'link-to-dir'
    ])
  })
})

describe('DL-3 回包的形状', () => {
  it('DL-3 正常目录恰是 {path, parent, home, entries}；path 规范化', async () => {
    mkdirSync(join(tmp, 'sub'))
    const listing = await listDirectories({ path: `${tmp}/./sub/../` }, HOME)
    expect(Object.keys(listing).sort()).toStrictEqual(['entries', 'home', 'parent', 'path'])
    expect(listing).toStrictEqual({
      path: tmp,
      parent: resolve(tmp, '..'),
      home: HOME,
      entries: [{ name: 'sub', path: join(tmp, 'sub') }]
    })
  })

  it('DL-3 根目录的 parent 是 null', async () => {
    const root = resolve('/')
    const listing = await listDirectories({ path: root }, HOME)
    expect(listing.path).toBe(root)
    expect(listing.parent).toBeNull()
  })
})

describe('DL-4 从不拒绝', () => {
  it('DL-4 不在 → ENOENT，path / parent 照给，entries 空', async () => {
    const missing = join(tmp, 'missing')
    await expect(listDirectories({ path: missing }, HOME)).resolves.toStrictEqual({
      path: missing,
      parent: tmp,
      home: HOME,
      entries: [],
      error: 'ENOENT'
    })
  })

  it('DL-4 是文件 → ENOTDIR', async () => {
    writeFileSync(join(tmp, 'plain.txt'), 'x')
    const listing = await listDirectories({ path: join(tmp, 'plain.txt') }, HOME)
    expect(listing.error).toBe('ENOTDIR')
    expect(listing.entries).toStrictEqual([])
    expect(listing.parent).toBe(tmp)
  })

  it.skipIf(!canRestrictReads)('DL-4 没权限 → EACCES', async () => {
    mkdirSync(join(tmp, 'locked'))
    mkdirSync(join(tmp, 'locked', 'inner'))
    chmodSync(join(tmp, 'locked'), 0o000)
    const listing = await listDirectories({ path: join(tmp, 'locked') }, HOME)
    expect(listing.error).toBe('EACCES')
    expect(listing.entries).toStrictEqual([])
    expect(listing.path).toBe(join(tmp, 'locked'))
  })

  it('DL-4 readdir 的错误没有 code → EIO', async () => {
    state.readdir.mockRejectedValueOnce(new Error('something odd'))
    const listing = await listDirectories({ path: tmp }, HOME)
    expect(listing.error).toBe('EIO')
    expect(listing.entries).toStrictEqual([])
  })
})

describe('DL-5 条数上限', () => {
  it('DL-5 2001 个子目录 → 按排序的前 2000 个 + truncated:true', async () => {
    expect(MAX_DIRECTORY_ENTRIES).toBe(2000)
    for (let i = 0; i <= 2000; i++) mkdirSync(join(tmp, `d${i}`))
    const listing = await listDirectories({ path: tmp }, HOME)
    expect(listing.truncated).toBe(true)
    expect(listing.entries).toHaveLength(2000)
    // 数字按数值排：d2000 排在最后、被截掉（按字典序它会排在 d201 前面）
    expect(listing.entries[0].name).toBe('d0')
    expect(listing.entries[1].name).toBe('d1')
    expect(listing.entries[1999].name).toBe('d1999')
    expect(listing.entries.map((e) => e.name)).not.toContain('d2000')
  })

  it('DL-5 恰 2000 个 → 没有 truncated 键', async () => {
    for (let i = 0; i < 2000; i++) mkdirSync(join(tmp, `d${i}`))
    const listing = await listDirectories({ path: tmp }, HOME)
    expect(listing.entries).toHaveLength(2000)
    expect('truncated' in listing).toBe(false)
  })
})

describe('DL-6 主目录的缺省', () => {
  it('DL-6 不给 home → os.homedir()', async () => {
    const listing = await listDirectories({ path: tmp })
    expect(listing.home).toBe(homedir())
    expect(listing.path).toBe(tmp)
  })
})
