/**
 * botHandlers —— 侧栏「Bots」分节与 设置 → 已归档 → Bots 的 IPC。归档 / 恢复 / 删除的文件操作归 botService
 * （见 botService.test 的 PSv-ARC），这里只钉 IPC 层自己的那几件事：列表的投影、会话条数、删除时连带删会话的
 * 条件，以及归档时那份文件的笔记本会话。
 *
 *   BH-1  bot:list 多一个 `archived`（归档里的 bot 名，去重）；bot:listArchived 给每份带上 sessionCount ——
 *         绑定这个名字的**顶层**会话条数（子会话随父会话级联，不单数；bot 名按 boundBotOf 的 trim 认）
 *   BH-2  bot:deleteArchived：删文件，这个名字此刻没有别的主人（生效的或归档里的另一份）→ 逐条 sessionService.delete
 *         它名下的顶层会话，回 deletedSessions；还有主人 → 只删文件、一条会话都不动；删文件失败 → 原样回失败、不动会话；
 *         一条会话删失败 → 调用失败、后面的不再删
 *   BH-3  bot:deleteSessions：名字还有主人（生效 / 归档）→ 拒绝；孤儿名字 → 删它名下的顶层会话；
 *         bot:delete 不再注册；CHANNEL_ACCESS 的等级；API_TABLE.bot 没有 delete，新成员各走自己的通道
 *   BH-4  bot:archive：成功后删掉**那份文件**的笔记本会话（`__bots__` 承载、按生效文件的文件名找）—— 别的会话不动；
 *         归档失败 / 没有笔记本会话 → 什么都不删
 *
 * electron 是替身（handle 收进 Map）；botService / sessionService / sessionRecords / registryNotes 整个替掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNEL_ACCESS } from '../../../shared/channelAccess'
import { API_TABLE } from '../../../shared/apiTable'

type Handler = (event: unknown, ...args: unknown[]) => unknown

interface FakeSession {
  id: string
  parentId: string | null
  settings: Record<string, unknown>
}
interface FakeArchived {
  name: string
  displayName: string
  description: string
  fileName: string
}

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  /** 生效的 bot：名字 → 文件绝对路径 */
  live: new Map<string, string>(),
  archived: [] as FakeArchived[],
  sessions: [] as FakeSession[],
  /** 承载项目 + 笔记本路径 → 笔记本会话 id */
  notes: new Map<string, string>(),
  archiveResult: { success: true } as { success: boolean; error?: string },
  deleteArchivedFailure: null as null | { success: false; error: string },
  calls: [] as string[]
}))

const fake = vi.hoisted(() => ({
  get: vi.fn((name: string) => {
    const basePath = state.live.get(name)
    return basePath ? { file: { name }, basePath } : null
  }),
  archive: vi.fn((name: string) => {
    state.calls.push(`archive:${name}`)
    if (state.archiveResult.success) state.live.delete(name)
    return state.archiveResult
  }),
  listArchived: vi.fn(() => state.archived.map((b) => ({ ...b }))),
  listWithInvalid: vi.fn(),
  restore: vi.fn((fileName: string) => ({ success: true, fileName })),
  deleteArchivedFile: vi.fn((fileName: string) => {
    state.calls.push(`deleteFile:${fileName}`)
    if (state.deleteArchivedFailure) return state.deleteArchivedFailure
    const hit = state.archived.find((b) => b.fileName === fileName)
    state.archived = state.archived.filter((b) => b.fileName !== fileName)
    return { success: true, name: hit?.name }
  }),
  deleteByFile: vi.fn(),
  createNew: vi.fn(),
  openFolder: vi.fn(async () => {}),
  sessionDelete: vi.fn(async (id: string) => {
    state.calls.push(`delete:${id}`)
    state.sessions = state.sessions.filter((s) => s.id !== id && s.parentId !== id)
  }),
  findByProjectAndNotebookPath: vi.fn((projectId: string, notebookPath: string) => {
    const id = state.notes.get(`${projectId}|${notebookPath}`)
    return id ? { id } : undefined
  }),
  openRegistryNote: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      state.handlers.set(channel, fn)
    }
  }
}))
vi.mock('../../services/botService', () => ({
  botService: {
    get: fake.get,
    archive: fake.archive,
    listArchived: fake.listArchived,
    listWithInvalid: fake.listWithInvalid,
    restore: fake.restore,
    deleteArchivedFile: fake.deleteArchivedFile,
    deleteByFile: fake.deleteByFile,
    createNew: fake.createNew,
    openFolder: fake.openFolder
  }
}))
vi.mock('../../services/sessionService', () => ({
  sessionService: {
    list: () => state.sessions.map((s) => ({ ...s })),
    delete: fake.sessionDelete
  }
}))
vi.mock('../../services/sessionRecords', () => ({
  sessionRecords: { findByProjectAndNotebookPath: fake.findByProjectAndNotebookPath }
}))
vi.mock('../../services/registryNotes', () => ({ openRegistryNote: fake.openRegistryNote }))

import { registerBotHandlers } from '../botHandlers'
import { attachIpcAdapter } from '../ipcAdapter'

const IPC_EVENT = { sender: { id: 1 } }
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = state.handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(fn(IPC_EVENT, ...args))
}

// 注册一次（同一通道再定义会抛错），经 IPC 适配器挂到替身 ipcMain 上
registerBotHandlers()
attachIpcAdapter()

const session = (
  id: string,
  bot?: string,
  parentId: string | null = null,
  extra: Record<string, unknown> = {}
): FakeSession => ({
  id,
  parentId,
  settings: { ...(bot !== undefined ? { bot } : {}), ...extra }
})

const archived = (name: string, fileName = `${name}.md`): FakeArchived => ({
  name,
  displayName: name,
  description: '',
  fileName
})

beforeEach(() => {
  state.live = new Map()
  state.archived = []
  state.sessions = []
  state.notes = new Map()
  state.archiveResult = { success: true }
  state.deleteArchivedFailure = null
  state.calls = []
  for (const fn of Object.values(fake)) fn.mockClear()
})

describe('BH-1 列表与会话条数', () => {
  it('BH-1 bot:list 原样投影三拨，另给归档里的 bot 名（去重）', async () => {
    fake.listWithInvalid.mockReturnValueOnce({
      valid: [
        {
          file: { name: 'scout', displayName: 'Scout', description: 'd' },
          basePath: '/bots/scout.md'
        }
      ],
      shadowed: [
        {
          file: { name: 'scout', displayName: 'Scout 2', description: '' },
          basePath: '/bots/a.md',
          shadowedBy: 'scout.md'
        }
      ],
      invalid: [{ fileName: 'broken.md', reason: 'bad' }]
    })
    state.archived = [archived('old'), archived('old', 'old-2.md'), archived('gone')]

    expect(await invoke('bot:list')).toEqual({
      bots: [
        {
          name: 'scout',
          displayName: 'Scout',
          description: 'd',
          basePath: '/bots/scout.md',
          fileName: 'scout.md'
        }
      ],
      shadowed: [
        {
          name: 'scout',
          displayName: 'Scout 2',
          description: '',
          basePath: '/bots/a.md',
          fileName: 'a.md',
          shadowedBy: 'scout.md'
        }
      ],
      invalid: [{ fileName: 'broken.md', reason: 'bad' }],
      archived: ['old', 'gone']
    })
  })

  it('BH-1 bot:listArchived：每份带上它名下顶层会话的条数（子会话不数、名字按 trim 认、别的 bot 不数）', async () => {
    state.archived = [archived('old'), archived('none'), archived('old', 'old-copy.md')]
    state.sessions = [
      session('r1', 'old'),
      session('r2', '  old '),
      session('c1', 'old', 'r1'),
      session('c2', undefined, 'r1', { workProject: 'p1' }),
      session('x', 'other'),
      session('blank', '   '),
      session('plain')
    ]

    expect(await invoke('bot:listArchived')).toEqual([
      { ...archived('old'), sessionCount: 2 },
      { ...archived('none'), sessionCount: 0 },
      { ...archived('old', 'old-copy.md'), sessionCount: 2 }
    ])
  })
})

describe('BH-2 bot:deleteArchived', () => {
  it('BH-2 名字没有别的主人 → 删文件，再逐条删它名下的顶层会话（子会话由 sessionService 级联）', async () => {
    state.archived = [archived('old')]
    state.sessions = [
      session('r1', 'old'),
      session('c1', undefined, 'r1'),
      session('r2', 'old'),
      session('keep', 'other'),
      session('plain')
    ]

    expect(await invoke('bot:deleteArchived', { fileName: 'old.md' })).toEqual({
      success: true,
      deletedSessions: 2
    })
    expect(state.calls).toEqual(['deleteFile:old.md', 'delete:r1', 'delete:r2'])
    expect(state.sessions.map((s) => s.id)).toEqual(['keep', 'plain'])
  })

  it('BH-2 名字还有别的主人（生效的那份 / 归档里的另一份）→ 只删文件，会话一条不动', async () => {
    state.sessions = [session('r1', 'old')]

    state.live.set('old', '/bots/old.md')
    state.archived = [archived('old', 'old-archived.md')]
    expect(await invoke('bot:deleteArchived', { fileName: 'old-archived.md' })).toEqual({
      success: true,
      deletedSessions: 0
    })

    state.live.clear()
    state.archived = [archived('old', 'a.md'), archived('old', 'b.md')]
    expect(await invoke('bot:deleteArchived', { fileName: 'a.md' })).toEqual({
      success: true,
      deletedSessions: 0
    })

    expect(fake.sessionDelete).not.toHaveBeenCalled()
    expect(state.sessions.map((s) => s.id)).toEqual(['r1'])
  })

  it('BH-2 删文件失败 → 原样回失败（deletedSessions 0），会话不动', async () => {
    state.archived = [archived('old')]
    state.sessions = [session('r1', 'old')]
    state.deleteArchivedFailure = { success: false, error: 'Archived file "old.md" not found' }

    expect(await invoke('bot:deleteArchived', { fileName: 'old.md' })).toEqual({
      success: false,
      error: 'Archived file "old.md" not found',
      deletedSessions: 0
    })
    expect(fake.sessionDelete).not.toHaveBeenCalled()
  })

  it('BH-2 一条会话删失败 → 整个调用失败，后面的不再删', async () => {
    state.archived = [archived('old')]
    state.sessions = [session('r1', 'old'), session('r2', 'old')]
    fake.sessionDelete.mockImplementationOnce(async () => {
      throw new Error('busy')
    })

    await expect(invoke('bot:deleteArchived', { fileName: 'old.md' })).rejects.toThrow('busy')
    expect(fake.sessionDelete.mock.calls.map((c) => c[0])).toEqual(['r1'])
  })
})

describe('BH-3 bot:deleteSessions 与通道表', () => {
  it('BH-3 名字还有主人（生效 / 归档）→ 拒绝，一条会话都不动', async () => {
    state.sessions = [session('r1', 'scout')]
    state.live.set('scout', '/bots/scout.md')
    expect(await invoke('bot:deleteSessions', { name: 'scout' })).toEqual({
      success: false,
      deletedSessions: 0,
      error: 'Bot "scout" still exists'
    })

    state.live.clear()
    state.archived = [archived('scout')]
    expect(await invoke('bot:deleteSessions', { name: 'scout' })).toEqual({
      success: false,
      deletedSessions: 0,
      error: 'Bot "scout" still exists'
    })
    expect(fake.sessionDelete).not.toHaveBeenCalled()
  })

  it('BH-3 孤儿名字 → 删它名下的顶层会话；一条都没有 → deletedSessions 0', async () => {
    state.sessions = [
      session('r1', 'ghost'),
      session('c1', 'ghost', 'r1'),
      session('r2', ' ghost '),
      session('keep', 'scout')
    ]
    expect(await invoke('bot:deleteSessions', { name: 'ghost' })).toEqual({
      success: true,
      deletedSessions: 2
    })
    expect(fake.sessionDelete.mock.calls.map((c) => c[0])).toEqual(['r1', 'r2'])
    expect(state.sessions.map((s) => s.id)).toEqual(['keep'])

    expect(await invoke('bot:deleteSessions', { name: 'nobody' })).toEqual({
      success: true,
      deletedSessions: 0
    })
  })

  it('BH-3 bot:delete 不再注册；注册的通道正是 API_TABLE.bot 的那几条', () => {
    expect(state.handlers.has('bot:delete')).toBe(false)
    const tableChannels = Object.values(API_TABLE.bot).map((m) => m.channel)
    expect([...state.handlers.keys()].filter((c) => c.startsWith('bot:')).sort()).toEqual(
      [...tableChannels].sort()
    )
  })

  it('BH-3 API_TABLE.bot 没有 delete；新成员各走自己的通道、各带一个参数（listArchived 不带）', () => {
    const bot = API_TABLE.bot as Record<string, { kind: string; channel: string; args: number }>
    expect(bot).not.toHaveProperty('delete')
    expect(bot.archive).toEqual({ kind: 'invoke', channel: 'bot:archive', args: 1 })
    expect(bot.listArchived).toEqual({ kind: 'invoke', channel: 'bot:listArchived', args: 0 })
    expect(bot.restore).toEqual({ kind: 'invoke', channel: 'bot:restore', args: 1 })
    expect(bot.deleteArchived).toEqual({ kind: 'invoke', channel: 'bot:deleteArchived', args: 1 })
    expect(bot.deleteSessions).toEqual({ kind: 'invoke', channel: 'bot:deleteSessions', args: 1 })
  })

  it('BH-3 CHANNEL_ACCESS：只读的两条是 read，会改东西的是 admin；bot:delete 不在表里', () => {
    expect(CHANNEL_ACCESS['bot:list']).toBe('read')
    expect(CHANNEL_ACCESS['bot:listArchived']).toBe('read')
    for (const channel of [
      'bot:archive',
      'bot:restore',
      'bot:deleteArchived',
      'bot:deleteSessions'
    ]) {
      expect(CHANNEL_ACCESS[channel], channel).toBe('admin')
    }
    expect(CHANNEL_ACCESS).not.toHaveProperty('bot:delete')
  })
})

describe('BH-4 bot:archive', () => {
  it('BH-4 成功 → 删掉那份文件的笔记本会话（__bots__ 承载、按文件名找），别的会话不动', async () => {
    state.live.set('scout', '/bots/scout.md')
    state.notes.set('__bots__|scout.md', 'note-scout')
    state.notes.set('__bots__|other.md', 'note-other')
    state.sessions = [session('r1', 'scout')]

    expect(await invoke('bot:archive', { name: 'scout' })).toEqual({ success: true })
    expect(fake.findByProjectAndNotebookPath.mock.calls).toEqual([['__bots__', 'scout.md']])
    // 先归档、再删笔记本会话；bot 会话本身不动
    expect(state.calls).toEqual(['archive:scout', 'delete:note-scout'])
    expect(state.sessions.map((s) => s.id)).toEqual(['r1'])
  })

  it('BH-4 生效的那份文件名与 bot 名不同 → 按文件名找它的笔记本会话', async () => {
    state.live.set('scout', '/bots/a.md')
    state.notes.set('__bots__|a.md', 'note-a')
    state.notes.set('__bots__|scout.md', 'note-scout')

    await invoke('bot:archive', { name: 'scout' })
    expect(fake.findByProjectAndNotebookPath.mock.calls).toEqual([['__bots__', 'a.md']])
    expect(fake.sessionDelete.mock.calls.map((c) => c[0])).toEqual(['note-a'])
  })

  it('BH-4 归档失败 / 没有笔记本会话 → 什么都不删', async () => {
    state.live.set('scout', '/bots/scout.md')
    state.notes.set('__bots__|scout.md', 'note-scout')
    state.archiveResult = {
      success: false,
      error: 'An archived bot file "scout.md" already exists'
    }
    expect(await invoke('bot:archive', { name: 'scout' })).toEqual(state.archiveResult)
    expect(fake.findByProjectAndNotebookPath).not.toHaveBeenCalled()

    state.archiveResult = { success: true }
    state.notes.clear()
    expect(await invoke('bot:archive', { name: 'scout' })).toEqual({ success: true })
    expect(fake.sessionDelete).not.toHaveBeenCalled()
  })

  it('BH-4 名字不在 → 回 botService 的拒绝，不找笔记本会话', async () => {
    state.archiveResult = { success: false, error: 'Bot "ghost" not found' }
    expect(await invoke('bot:archive', { name: 'ghost' })).toEqual({
      success: false,
      error: 'Bot "ghost" not found'
    })
    expect(fake.findByProjectAndNotebookPath).not.toHaveBeenCalled()
    expect(fake.sessionDelete).not.toHaveBeenCalled()
  })
})
