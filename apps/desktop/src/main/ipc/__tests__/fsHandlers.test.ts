/**
 * `ipc/fsHandlers.ts`（server mode phase D）—— 服务端文件系统的两条只读通道：`fs:locateFolder`（「在文件管理器中打开」
 * 那几条打开的是哪个目录 / 文件）与 `fs:listDirectories`（web 客户端的目录浏览器）。经注册表的定义直接以窗口 / 网络
 * 上下文调用（`listDefinitions()`）。
 *
 * 替身照 knowledgeHandlers.test.ts：electron 只要 shell 的两个间谍；`utils/paths` 的几个目录指向临时目录的子目录；
 * services/knowledge 的路径三件（entryFilePath / getUserKnowledgeRoot / locateBundle）用**真的**，其余替身；
 * `os.homedir` 指向临时目录里的假主目录（目录列表本身用真的，外面包一层间谍看参数）。
 *
 *   FS-1 agents / policies / hooks / bots / knowledge → 各自「在文件管理器中打开」的那个目录；不在先建；再调一次照常；
 *        网络上下文一样
 *   FS-2 不认识的 kind（含原型链上的名字、非字符串）、没有 kind、参数是 undefined / null → {path:null}，什么也不建
 *   FS-3 knowledgeEntry：用户库 / 项目库的条目 id → 各自根下的绝对路径；落不进任何库的、空的、缺的、非字符串的 → null。
 *        与 knowledge:revealFile 同口径：那边 {success:false} ⇔ 这边 null，不是 null 时就是交给 showItemInFolder 的那个
 *   FS-4 listDirectories：参数原样交给目录列表；不给参数 → 主目录的列表
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientContext } from '../registry'

const state = vi.hoisted(() => ({
  root: '',
  home: '',
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  listDirectories: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: { openPath: state.openPath, showItemInFolder: state.showItemInFolder }
}))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = (): string => state.home
  return { ...actual, default: { ...actual, homedir }, homedir }
})
vi.mock('../../utils/paths', () => ({
  getDefaultAgentsDir: () => join(state.root, 'agents'),
  getDefaultPoliciesDir: () => join(state.root, 'policies'),
  getDefaultHooksDir: () => join(state.root, 'hooks'),
  getDefaultBotsDir: () => join(state.root, 'bots'),
  getShuvixKnowledgeRootDir: () => join(state.root, 'knowledge-shuvix'),
  getBuiltinKnowledgeDir: () => join(state.root, 'knowledge-builtin'),
  getUserKnowledgeRootDir: () => join(state.root, 'knowledge')
}))
vi.mock('i18next', () => ({
  default: { language: 'en', t: (key: string) => key }
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../services/knowledge', async () => {
  const real = await vi.importActual<typeof import('../../services/knowledge/knowledgePaths')>(
    '../../services/knowledge/knowledgePaths'
  )
  return {
    entryFilePath: real.entryFilePath,
    getUserKnowledgeRoot: real.getUserKnowledgeRoot,
    locateBundle: real.locateBundle,
    createKnowledgeBase: vi.fn(),
    createKnowledgeFolder: vi.fn(),
    createKnowledgeEntry: vi.fn(),
    knowledgeBaseOptions: vi.fn(),
    listKnowledgeEntries: vi.fn(),
    listKnowledgeMentionEntries: vi.fn()
  }
})
vi.mock('../../services/knowledgeNotes', () => ({ openKnowledgeNote: vi.fn() }))
vi.mock('../../services/directoryListing', async () => {
  const real = await vi.importActual<typeof import('../../services/directoryListing')>(
    '../../services/directoryListing'
  )
  state.listDirectories.mockImplementation(real.listDirectories)
  return {
    ...real,
    listDirectories: (...args: unknown[]): unknown => state.listDirectories(...args)
  }
})

import { listDefinitions } from '../registry'
import { registerFsHandlers } from '../fsHandlers'
import { registerKnowledgeHandlers } from '../knowledgeHandlers'

const netCtx: ClientContext = {
  client: { kind: 'network', id: 'ws:1', remoteAddress: '192.168.1.20', userAgent: 'UA/1' },
  transport: 'network'
}
const winCtx: ClientContext = {
  client: { kind: 'window', id: 'ipc:7', webContentsId: 7 },
  transport: 'ipc'
}

function call(ctx: ClientContext, channel: string, ...args: unknown[]): unknown {
  const definition = listDefinitions().find((d) => d.channel === channel)
  if (!definition) throw new Error(`no definition for ${channel}`)
  return definition.fn(ctx, ...args)
}

const locate = (ctx: ClientContext, params: unknown): unknown =>
  call(ctx, 'fs:locateFolder', params)

/** 每个 kind 对应的那个目录（与 paths 的替身同一份） */
const dirOf = (kind: string): string =>
  ({
    agents: join(state.root, 'agents'),
    policies: join(state.root, 'policies'),
    hooks: join(state.root, 'hooks'),
    bots: join(state.root, 'bots'),
    knowledge: join(state.root, 'knowledge')
  })[kind]!

beforeAll(() => {
  registerFsHandlers()
  registerKnowledgeHandlers()
})

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'shuvix-fs-ipc-'))
  state.home = mkdtempSync(join(tmpdir(), 'shuvix-fs-home-'))
  state.openPath.mockReset().mockResolvedValue('')
  state.showItemInFolder.mockReset()
  state.listDirectories.mockClear()
})

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
  rmSync(state.home, { recursive: true, force: true })
})

describe('FS-1 locateFolder 的几个目录', () => {
  it.each([
    ['window', winCtx],
    ['network', netCtx]
  ])('FS-1 %s 上下文：回那个目录、不在先建、再调一次照常', (_name, ctx) => {
    for (const kind of ['agents', 'policies', 'hooks', 'bots', 'knowledge']) {
      const dir = dirOf(kind)
      expect(existsSync(dir), kind).toBe(false)
      expect(locate(ctx, { kind }), kind).toStrictEqual({ path: dir })
      expect(existsSync(dir), kind).toBe(true)
      expect(locate(ctx, { kind }), kind).toStrictEqual({ path: dir })
    }
    expect(state.openPath).not.toHaveBeenCalled()
    expect(state.showItemInFolder).not.toHaveBeenCalled()
  })
})

describe('FS-2 认不出的参数', () => {
  it('FS-2 → {path:null}，什么也不建', () => {
    for (const params of [
      { kind: 'nope' },
      { kind: 'toString' },
      { kind: '__proto__' },
      { kind: 'constructor' },
      { kind: 5 },
      {},
      undefined,
      null
    ]) {
      expect(locate(netCtx, params), JSON.stringify(params)).toStrictEqual({ path: null })
      expect(locate(winCtx, params), JSON.stringify(params)).toStrictEqual({ path: null })
    }
    expect(readdirSync(state.root)).toStrictEqual([])
  })
})

describe('FS-3 knowledgeEntry', () => {
  it('FS-3 用户库与项目库的条目 → 各自根下的绝对路径；别的 → null', () => {
    expect(locate(netCtx, { kind: 'knowledgeEntry', path: 'knowledge/notes/a.md' })).toStrictEqual({
      path: join(state.root, 'knowledge', 'notes', 'a.md')
    })
    expect(locate(netCtx, { kind: 'knowledgeEntry', path: 'projects/p1/x.md' })).toStrictEqual({
      path: join(state.root, 'knowledge-shuvix', 'projects', 'p1', 'x.md')
    })
    for (const params of [
      { kind: 'knowledgeEntry', path: 'foo/bar.md' },
      { kind: 'knowledgeEntry', path: 'knowledge/../x.md' },
      { kind: 'knowledgeEntry', path: '' },
      { kind: 'knowledgeEntry' },
      { kind: 'knowledgeEntry', path: 5 }
    ]) {
      expect(locate(netCtx, params), JSON.stringify(params)).toStrictEqual({ path: null })
    }
    // 只算路径，不建东西
    expect(readdirSync(state.root)).toStrictEqual([])
  })

  it('FS-3 与 knowledge:revealFile 同口径', () => {
    for (const path of [
      'knowledge/notes/a.md',
      'projects/p1/x.md',
      'projects/p1/sub/y.md',
      'foo/bar.md',
      'knowledge/../x.md',
      'knowledge/readme.md',
      'knowledge/notes/.trash/a.md',
      '../x.md'
    ]) {
      state.showItemInFolder.mockClear()
      const reveal = call(winCtx, 'knowledge:revealFile', { path }) as { success: boolean }
      const located = locate(netCtx, { kind: 'knowledgeEntry', path }) as { path: string | null }
      if (reveal.success) {
        expect(located.path, path).not.toBeNull()
        expect(state.showItemInFolder, path).toHaveBeenCalledWith(located.path)
      } else {
        expect(located.path, path).toBeNull()
        expect(state.showItemInFolder, path).not.toHaveBeenCalled()
      }
    }
  })
})

describe('FS-4 listDirectories', () => {
  it('FS-4 参数原样交给目录列表', async () => {
    mkdirSync(join(state.root, 'alpha'))
    mkdirSync(join(state.root, '.hidden'))
    const params = { path: state.root, showHidden: true }
    const listing = (await call(netCtx, 'fs:listDirectories', params)) as {
      path: string
      entries: Array<{ name: string }>
    }
    expect(state.listDirectories).toHaveBeenCalledTimes(1)
    expect(state.listDirectories.mock.calls[0][0]).toBe(params)
    expect(listing.path).toBe(state.root)
    expect(listing.entries.map((e) => e.name).sort()).toStrictEqual(['.hidden', 'alpha'])
  })

  it('FS-4 不给参数 → 主目录的列表', async () => {
    mkdirSync(join(state.home, 'Documents'))
    mkdirSync(join(state.home, 'Projects'))
    const listing = (await call(winCtx, 'fs:listDirectories')) as {
      path: string
      home: string
      entries: Array<{ name: string }>
    }
    expect(state.listDirectories).toHaveBeenCalledWith(undefined)
    expect(listing.path).toBe(state.home)
    expect(listing.home).toBe(state.home)
    expect(listing.entries.map((e) => e.name)).toStrictEqual(['Documents', 'Projects'])
  })
})
