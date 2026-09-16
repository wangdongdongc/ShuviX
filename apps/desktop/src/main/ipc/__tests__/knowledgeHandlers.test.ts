/**
 * knowledgeHandlers —— 侧栏「知识库」分组的 IPC：
 *   - `knowledge:openFolder` 打开**用户根**（建库就是往那里拷文件夹），不存在先建出来再打开；
 *   - `knowledge:revealFile` 按条目 id 的首段分派到三个根（`knowledge/…` → 用户根，`builtin/…` →
 *     应用包里的内置根**当前语言**那一版，其余 → shuvix 根），落不进任何库的路径回 `success: false`，
 *     不碰 shell；
 *   - `knowledge:createFolder` / `knowledge:createEntry` 的拒绝原样回到渲染端（KH-3 走内置库只读那一道）；
 *   - `knowledge:list` 的回包**逐字透传**，`bundleDirs` 也在其中（KH-5）。
 *
 * electron 是替身（handle 收进 Map、shell 两个 spy）；services/knowledge 只替到接口那一层：路径相关的
 * 三个导出与三个「新建」转发**真的**实现（「什么路径算数」正是这里要验的），清单与笔记本是替身。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, Handler>(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      state.handlers.set(channel, handler)
    }
  },
  shell: { openPath: state.openPath, showItemInFolder: state.showItemInFolder }
}))
vi.mock('../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  // 三个根都是同一个临时目录的兄弟：内置根同样每个用例一份（afterEach 自己收）
  getBuiltinKnowledgeDir: () => `${state.root}-builtin`,
  getUserKnowledgeRootDir: () => `${state.root}-user`
}))
// i18next 是单例：内置库的语言目录从它现读（真身在单测里没 init）。KH-4 要切语言，所以放可变 state
const i18n = vi.hoisted(() => ({ language: 'en' }))
vi.mock('i18next', () => ({
  default: {
    get language() {
      return i18n.language
    },
    t: (key: string) => `i18n(${key})`
  }
}))
// 新建失败的原因要原样回到渲染端：替身回 key 本身（文案本身在 create 的单测里）
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../services/knowledge', async () => {
  const real = await vi.importActual<typeof import('../../services/knowledge/knowledgePaths')>(
    '../../services/knowledge/knowledgePaths'
  )
  // 三个「新建」也用真的：KH-3 验的正是「什么 id 是落点」（内置库只读那一道），替身验不出来
  const create = await vi.importActual<typeof import('../../services/knowledge/create')>(
    '../../services/knowledge/create'
  )
  return {
    entryFilePath: real.entryFilePath,
    getUserKnowledgeRoot: real.getUserKnowledgeRoot,
    locateBundle: real.locateBundle,
    createKnowledgeBase: create.createKnowledgeBase,
    createKnowledgeFolder: create.createKnowledgeFolder,
    createKnowledgeEntry: create.createKnowledgeEntry,
    listKnowledgeEntries: vi.fn()
  }
})
vi.mock('../../services/knowledgeNotes', () => ({ openKnowledgeNote: vi.fn() }))

import { listKnowledgeEntries } from '../../services/knowledge'
import { registerKnowledgeHandlers } from '../knowledgeHandlers'

/** 像渲染端 invoke 那样调一个已注册的处理函数（事件对象用不到，给个空的） */
const invoke = (channel: string, ...args: unknown[]): unknown => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler({}, ...args)
}

let root: string
let userRoot: string
let builtinRoot: string

/** 目录下的全部条目（递归、`/` 分隔、字典序）；目录不在给 `[]` —— 「磁盘没多出东西」一律比它 */
const treeOf = (dir: string): string[] => {
  try {
    return readdirSync(dir, { recursive: true })
      .map((p) => String(p).replace(/\\/g, '/'))
      .sort()
  } catch {
    return []
  }
}

/** 种一份内置库条目：rel 是**内置根相对**的 `<库名>/<语言>/<库内路径>`（语言那一层不进 id） */
const seedBuiltin = (rel: string, text = '# Guide\n'): string => {
  const abs = join(builtinRoot, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, text, 'utf-8')
  return abs
}

beforeAll(() => {
  registerKnowledgeHandlers()
})

beforeEach(() => {
  state.openPath.mockReset().mockResolvedValue('')
  state.showItemInFolder.mockReset()
  i18n.language = 'en'
  root = mkdtempSync(join(tmpdir(), 'shuvix-kb-ipc-'))
  userRoot = `${root}-user`
  builtinRoot = `${root}-builtin`
  state.root = root
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  // 用户根与内置根是 root 的**兄弟**目录：不在被删的那棵树下，各自收
  rmSync(userRoot, { recursive: true, force: true })
  rmSync(builtinRoot, { recursive: true, force: true })
})

describe('knowledge:openFolder', () => {
  it('KH-1 打开的是用户根而不是 shuvix 根；不存在先建出来再打开；再调一次照常', async () => {
    const existedWhenOpened: boolean[] = []
    state.openPath.mockImplementation(async (p: string) => {
      existedWhenOpened.push(existsSync(p))
      return ''
    })
    expect(existsSync(userRoot)).toBe(false)

    await expect(invoke('knowledge:openFolder')).resolves.toEqual({ success: true })
    expect(existsSync(userRoot)).toBe(true)
    expect(state.openPath).toHaveBeenCalledTimes(1)
    expect(state.openPath).toHaveBeenCalledWith(userRoot)
    expect(state.openPath).not.toHaveBeenCalledWith(root)
    // 打开的那一刻目录已经在了：先建再开
    expect(existedWhenOpened).toEqual([true])

    await expect(invoke('knowledge:openFolder')).resolves.toEqual({ success: true })
    expect(state.openPath).toHaveBeenCalledTimes(2)
    expect(state.showItemInFolder).not.toHaveBeenCalled()
  })
})

describe('knowledge:revealFile', () => {
  it('KH-2 按条目 id 首段分派到两个根；落不进任何库的路径回 success:false 且不碰 shell', () => {
    expect(invoke('knowledge:revealFile', { path: 'knowledge/notes/a.md' })).toEqual({
      success: true
    })
    expect(state.showItemInFolder).toHaveBeenLastCalledWith(join(userRoot, 'notes', 'a.md'))
    expect(invoke('knowledge:revealFile', { path: 'projects/p1/a.md' })).toEqual({ success: true })
    expect(state.showItemInFolder).toHaveBeenLastCalledWith(join(root, 'projects', 'p1', 'a.md'))
    expect(state.showItemInFolder).toHaveBeenCalledTimes(2)

    state.showItemInFolder.mockClear()
    for (const path of [
      '',
      'knowledge/readme.md',
      'knowledge/notes',
      'knowledge/.trash/a.md',
      'knowledge/notes/.trash/a.md',
      '../x.md'
    ]) {
      expect(invoke('knowledge:revealFile', { path }), path).toEqual({ success: false })
    }
    expect(state.showItemInFolder).not.toHaveBeenCalled()
    expect(state.openPath).not.toHaveBeenCalled()
  })

  /**
   * 内置库比另外两个根多一层语言目录，而**语言不进条目 id** —— 同一个 id 在不同界面语言下指向不同的
   * 原文。语言那一层因此是**边界**而不是路径的一段：另一语言那一份不属于任何 bundle，够不着。
   */
  it('KH-4 内置条目落到内置根**当前语言**那一版（语言一换，同一个 id 换一份原文）；另一语言那一份、库目录本身、隐藏段一律 success:false 且不碰 shell', () => {
    const en = seedBuiltin('shuvix/en/agent-md.md')
    const zh = seedBuiltin('shuvix/zh/agent-md.md')

    expect(invoke('knowledge:revealFile', { path: 'builtin/shuvix/agent-md.md' })).toEqual({
      success: true
    })
    expect(state.showItemInFolder).toHaveBeenLastCalledWith(en)
    expect(state.showItemInFolder).not.toHaveBeenCalledWith(zh)

    // 切界面语言（`zh-CN` 取基础段）：id 一个字没变，指的却是另一份
    i18n.language = 'zh-CN'
    expect(invoke('knowledge:revealFile', { path: 'builtin/shuvix/agent-md.md' })).toEqual({
      success: true
    })
    expect(state.showItemInFolder).toHaveBeenLastCalledWith(zh)

    // 反过来点名另一语言那一版（以及库目录本身、容器、隐藏段）：都不属于任何 bundle
    i18n.language = 'en'
    state.showItemInFolder.mockClear()
    for (const path of [
      'builtin/shuvix/../zh/agent-md.md',
      'builtin/shuvix',
      'builtin',
      'builtin/shuvix/.trash/a.md'
    ]) {
      expect(invoke('knowledge:revealFile', { path }), path).toEqual({ success: false })
    }
    expect(state.showItemInFolder).not.toHaveBeenCalled()
  })
})

describe('knowledge:createFolder / knowledge:createEntry', () => {
  it('KH-3 内置库只读：文件夹与条目的新建都回 {success:false,error}，归一后同一个 id 的几种绕写法一并拒，内置根一个字节没多；同一批打到用户库照常成功', () => {
    seedBuiltin('shuvix/en/agent-md.md')
    mkdirSync(join(userRoot, 'notes'), { recursive: true })
    const before = treeOf(builtinRoot)

    // 只读那一道与落点解析必须用**同一套**归一（前导 ./、反斜杠、重复斜杠、前导 /）——
    // 两套归一之间就有一条绕过去的路；深一层（builtin/shuvix/sub）判的同样是首段
    for (const dir of [
      'builtin/shuvix',
      './builtin/shuvix',
      'builtin\\shuvix',
      '/builtin/shuvix',
      'builtin//shuvix',
      'builtin/shuvix/sub'
    ]) {
      expect(invoke('knowledge:createFolder', { dir, name: 'archive' }), dir).toEqual({
        success: false,
        error: 'knowledge.errReadOnly'
      })
      expect(invoke('knowledge:createEntry', { dir, title: 'My Note' }), dir).toEqual({
        success: false,
        error: 'knowledge.errReadOnly'
      })
    }
    expect(treeOf(builtinRoot)).toEqual(before)

    // 对照：拒绝不是因为这条 IPC 没接上 —— 同一个通道打到用户库照常建得出来
    expect(invoke('knowledge:createFolder', { dir: 'knowledge/notes', name: 'archive' })).toEqual({
      success: true,
      id: 'knowledge/notes/archive'
    })
    expect(existsSync(join(userRoot, 'notes', 'archive'))).toBe(true)
  })
})

describe('knowledge:list', () => {
  it('KH-5 清单逐字透传，`bundleDirs` 也在其中 —— 内置库的绝对目录两个根都拼不出来（侧栏「复制路径」靠它）', async () => {
    const builtinDir = join(builtinRoot, 'shuvix', 'en')
    const listed = {
      entries: [],
      root,
      userRoot,
      dirs: ['builtin/shuvix'],
      bundleNames: { 'builtin/shuvix': 'ShuviX' },
      bundleDirs: { 'builtin/shuvix': builtinDir }
    }
    vi.mocked(listKnowledgeEntries).mockResolvedValue(listed)

    await expect(invoke('knowledge:list')).resolves.toEqual(listed)

    const res = (await invoke('knowledge:list')) as { bundleDirs: Record<string, string> }
    expect(res.bundleDirs['builtin/shuvix']).toBe(builtinDir)
    // 两个根都在这条路径之外（而且它里面还夹着语言那一层）：渲染端只能照抄，拼不出来
    expect(relative(root, builtinDir).startsWith('..')).toBe(true)
    expect(relative(userRoot, builtinDir).startsWith('..')).toBe(true)
  })
})
