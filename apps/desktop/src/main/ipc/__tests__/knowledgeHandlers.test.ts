/**
 * knowledgeHandlers —— 侧栏「知识库」分组通往 OS 文件管理器的两条 IPC：
 *   - `knowledge:openFolder` 打开**用户根**（建库就是往那里拷文件夹），不存在先建出来再打开；
 *   - `knowledge:revealFile` 按条目 id 的首段分派到两个根（`knowledge/…` → 用户根，其余 → shuvix 根），
 *     落不进任何库的路径回 `success: false`，不碰 shell。
 *
 * electron 是替身（handle 收进 Map、shell 两个 spy）；services/knowledge 只替到接口那一层：路径相关的
 * 三个导出转发**真的** knowledgePaths（「什么路径算数」正是这里要验的），清单与笔记本是替身。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  getUserKnowledgeRootDir: () => `${state.root}-user`
}))
vi.mock('../../services/knowledge', async () => {
  const real = await vi.importActual<typeof import('../../services/knowledge/knowledgePaths')>(
    '../../services/knowledge/knowledgePaths'
  )
  return {
    entryFilePath: real.entryFilePath,
    getUserKnowledgeRoot: real.getUserKnowledgeRoot,
    locateBundle: real.locateBundle,
    listKnowledgeEntries: vi.fn()
  }
})
vi.mock('../../services/knowledgeNotes', () => ({ openKnowledgeNote: vi.fn() }))

import { registerKnowledgeHandlers } from '../knowledgeHandlers'

/** 像渲染端 invoke 那样调一个已注册的处理函数（事件对象用不到，给个空的） */
const invoke = (channel: string, ...args: unknown[]): unknown => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler({}, ...args)
}

let root: string
let userRoot: string

beforeAll(() => {
  registerKnowledgeHandlers()
})

beforeEach(() => {
  state.openPath.mockReset().mockResolvedValue('')
  state.showItemInFolder.mockReset()
  root = mkdtempSync(join(tmpdir(), 'shuvix-kb-ipc-'))
  userRoot = `${root}-user`
  state.root = root
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(userRoot, { recursive: true, force: true })
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
})
