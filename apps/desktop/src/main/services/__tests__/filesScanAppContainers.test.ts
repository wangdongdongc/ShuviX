/**
 * 文件面板的两条扫描（scanSessionFiles / scanSessionDir）与 ripgrep 类工具共用的 rg 封装，
 * 都**不进其他应用的沙盒容器**（`~/Library/Containers`、`~/Library/Group Containers`）。
 *
 * 工作目录是家目录（或家目录的祖先、或 `~/Library`）时，`rg --files --hidden` 会一路扫进别的应用的
 * 容器，macOS 于是弹「访问其他应用的数据」授权框 —— 用户只是打开了文件面板。判据只认**家目录下的**
 * 那两个目录：项目里恰好叫 `Library/Containers` 的目录照常列。
 *
 *   FS-1  工作目录 = 家目录：容器里的一个不出，其余（含 `~/Library` 的其他部分）照常；
 *   FS-2  工作目录 = 家目录的上一级（家目录名里带 glob 元字符）：照样排除；
 *   FS-3  工作目录 = `~/Library`：两个容器根排除，兄弟照常；
 *   FS-4  工作目录不含家目录的 Library：项目里的 `Library/Containers` 照常列；
 *   FS-5  工作目录本身就在容器里 = 用户明确指向那里：不拦；
 *   FS-6  调用方的白名单 glob（`*.txt`）捞不回容器里的文件（排除排在最后）；
 *   FS-7  rgSearch（grep 工具）从家目录搜，不进容器；
 *   FS-8  scanSessionDir 列 `~/Library`：两个容器根不出现，兄弟照常；列家目录：`Library/` 照常出现；
 *   FS-9  scanSessionDir 展开容器里的目录：回空，**不 readdir**；
 *   FS-10 scanSessionDir 经符号链接展开到容器：同样回空、不 readdir。
 *
 * fs 与 rg 都是真的（rg 二进制来自 @vscode/ripgrep；Windows 或二进制缺席时整组跳过）。
 * `homedir` 换成本文件的假家目录；`fs/promises` 的 readdir 套一层可数的透传壳（「容器没被列」看它）。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ home: '', sessions: new Map<string, string>() }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = (): string => fake.home || actual.homedir()
  return { ...actual, default: { ...actual, homedir }, homedir }
})
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = (): string => fake.home || actual.homedir()
  return { ...actual, default: { ...actual, homedir }, homedir }
})
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const readdir = vi.fn(actual.readdir)
  return { ...actual, default: { ...actual, readdir }, readdir }
})
vi.mock('../sessionService', () => ({
  sessionService: {
    getById: (id: string) =>
      fake.sessions.has(id) ? { id, workingDirectory: fake.sessions.get(id) } : undefined
  }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { readdir } from 'fs/promises'
import { scanSessionDir, scanSessionFiles } from '../filesWatcherService'
import { getRgPath, rgFilesList, rgSearch } from '../../utils/toolUtils/ripgrep'

const RG_AVAILABLE = process.platform !== 'win32' && existsSync(getRgPath())

/**
 * 夹具（家目录名刻意带 `[` `]` `{` `}` —— 工作目录是家目录的上一级时，排除 glob 里要原样出现这一段）：
 *   <P>/u[1]{x}/notes.txt                                        needle
 *   <P>/u[1]{x}/Library/Preferences/p.plist                      needle
 *   <P>/u[1]{x}/Library/Containers/com.keymgr/Data/secret.txt    needle   ← 不该出现
 *   <P>/u[1]{x}/Library/Group Containers/T.keymgr/ssh_config     needle   ← 不该出现
 *   <P>/u[1]{x}/proj/Library/Containers/keep/k.txt               needle   （项目里的同名目录，照常）
 *   <P>/u[1]{x}/km → Library/Group Containers/T.keymgr           （符号链接进容器）
 */
const parent = mkdtempSync(join(tmpdir(), 'shuvix-fscan-'))
const home = join(parent, 'u[1]{x}')
const put = (rel: string, text = 'needle\n'): void => {
  const p = join(home, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}
put('notes.txt')
put('Library/Preferences/p.plist')
put('Library/Containers/com.keymgr/Data/secret.txt')
put('Library/Group Containers/T.keymgr/ssh_config')
put('proj/Library/Containers/keep/k.txt')
symlinkSync(join(home, 'Library', 'Group Containers', 'T.keymgr'), join(home, 'km'))

afterAll(() => {
  rmSync(parent, { recursive: true, force: true })
})

beforeEach(() => {
  fake.home = home
  fake.sessions.clear()
  vi.mocked(readdir).mockClear()
})

/** 起一条工作目录为 cwd 的会话，扫一遍，回相对路径（排好序） */
async function scanFrom(cwd: string): Promise<string[]> {
  fake.sessions.set('s', cwd)
  const { paths, root } = await scanSessionFiles('s')
  expect(root).toBe(cwd)
  return [...paths].sort()
}

const inContainer = (p: string): boolean => /(^|\/)Library\/(Group )?Containers\//.test(p)

describe.skipIf(!RG_AVAILABLE)('scanSessionFiles 不进其他应用的沙盒容器', () => {
  it('FS-1 工作目录 = 家目录：容器里的一个不出，其余照常', async () => {
    expect(await scanFrom(home)).toEqual([
      'Library/Preferences/p.plist',
      'notes.txt',
      'proj/Library/Containers/keep/k.txt'
    ])
  })

  it('FS-2 工作目录 = 家目录的上一级（家目录名带 glob 元字符）：照样排除', async () => {
    const name = basename(home)
    expect(await scanFrom(parent)).toEqual([
      `${name}/Library/Preferences/p.plist`,
      `${name}/notes.txt`,
      `${name}/proj/Library/Containers/keep/k.txt`
    ])
  })

  it('FS-3 工作目录 = ~/Library：两个容器根排除，兄弟照常', async () => {
    expect(await scanFrom(join(home, 'Library'))).toEqual(['Preferences/p.plist'])
  })

  it('FS-4 工作目录不含家目录的 Library：项目里的 Library/Containers 照常列', async () => {
    expect(await scanFrom(join(home, 'proj'))).toEqual(['Library/Containers/keep/k.txt'])
  })

  it('FS-5 工作目录本身就在容器里（用户明确指向那里）：不拦', async () => {
    expect(await scanFrom(join(home, 'Library', 'Group Containers', 'T.keymgr'))).toEqual([
      'ssh_config'
    ])
  })

  it('FS-1b 家目录经真实路径与字面路径两种写法给出，都排除（tmpdir 在 macOS 上是符号链接）', async () => {
    const real = realpathSync(home)
    expect((await scanFrom(real)).filter(inContainer)).toEqual([
      'proj/Library/Containers/keep/k.txt'
    ])
    fake.home = real
    expect((await scanFrom(home)).filter(inContainer)).toEqual([
      'proj/Library/Containers/keep/k.txt'
    ])
  })
})

describe.skipIf(!RG_AVAILABLE)('ripgrep 封装（ls / glob / grep 共用）不进容器', () => {
  it('FS-6 调用方的白名单 glob 捞不回容器里的文件（排除排在调用方 glob 之后）', async () => {
    const { files } = await rgFilesList({ cwd: home, glob: ['*.txt', '**/ssh_config'] })
    expect([...files].sort()).toEqual(['notes.txt', 'proj/Library/Containers/keep/k.txt'])
  })

  it('FS-7 rgSearch 从家目录搜：容器里的命中一条都没有', async () => {
    const { matches } = await rgSearch({ cwd: home, pattern: 'needle' })
    const paths = matches.map((m) => m.path).sort()
    expect(paths).toEqual([
      'Library/Preferences/p.plist',
      'notes.txt',
      'proj/Library/Containers/keep/k.txt'
    ])
  })
})

describe('scanSessionDir 不列、不展开其他应用的沙盒容器', () => {
  const touchedContainers = (): string[] =>
    vi
      .mocked(readdir)
      .mock.calls.map((c) => String(c[0]))
      .filter((p) => /\/Library\/(Group )?Containers(\/|$)/.test(p) && !p.includes('/proj/'))

  it('FS-8 列 ~/Library：两个容器根不出现；列家目录：Library/ 照常出现', async () => {
    fake.sessions.set('s', home)
    const lib = await scanSessionDir('s', 'Library')
    expect(lib.dirs).toEqual(['Library/Preferences/'])
    const top = await scanSessionDir('s', '')
    expect(top.dirs).toEqual(['Library/', 'km/', 'proj/'])
    expect(top.files).toEqual(['notes.txt'])
    expect(touchedContainers()).toEqual([])
  })

  it('FS-9 展开容器里的目录：回空，不 readdir', async () => {
    fake.sessions.set('s', home)
    expect(await scanSessionDir('s', 'Library/Group Containers/T.keymgr')).toEqual({
      files: [],
      dirs: [],
      root: home
    })
    expect(await scanSessionDir('s', 'Library/Containers')).toEqual({
      files: [],
      dirs: [],
      root: home
    })
    expect(touchedContainers()).toEqual([])
  })

  it('FS-10 经符号链接展开到容器（km → 容器）：回空，不 readdir', async () => {
    fake.sessions.set('s', home)
    expect(await scanSessionDir('s', 'km')).toEqual({ files: [], dirs: [], root: home })
    expect(vi.mocked(readdir).mock.calls.map((c) => String(c[0]))).not.toContain(join(home, 'km'))
    expect(touchedContainers()).toEqual([])
  })

  it('FS-4b 项目里恰好叫 Library/Containers 的目录照常列、照常展开', async () => {
    fake.sessions.set('s', join(home, 'proj'))
    expect((await scanSessionDir('s', 'Library')).dirs).toEqual(['Library/Containers/'])
    expect((await scanSessionDir('s', 'Library/Containers')).dirs).toEqual([
      'Library/Containers/keep/'
    ])
  })
})
