/**
 * projectHandlers —— `project:delete` 删项目连同它的会话（2026-10-31：以前只删了数据库里那几行，每条会话的文件都留在
 * 磁盘上）。会话逐条走 sessionService.delete（运行时、对话文件、权限表、子会话一并清掉），最后才删项目行。
 *
 *   PH-1  只删**成员**（findByProjectId 的那几条）：引用这个项目当工作位置的 bot 会话（projectId 空、settings.workProject）
 *         与别的项目的会话不动；只删顶层的（父会话也在这个项目里的子会话随父会话级联，父会话不在项目里的照样单删）；
 *         一条一条来（前一条没删完不开始下一条）；项目行最后删；一条会话删失败 → 调用失败、项目行留着；
 *         没有会话的项目照删、回 { success: true }
 *
 * （项目改路径时引用它的 bot 会话的路径快照跟着搬 —— PH-2 —— 在 services/__tests__/projectService.test.ts。）
 *
 * electron 是替身（handle 收进 Map）；projectService / sessionService / sessionRecords 整个替掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

interface FakeSession {
  id: string
  projectId: string | null
  parentId: string | null
  settings: Record<string, unknown>
}

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  sessions: [] as FakeSession[],
  calls: [] as string[]
}))

const fake = vi.hoisted(() => ({
  findByProjectId: vi.fn((projectId: string) =>
    state.sessions.filter((s) => s.projectId === projectId).map((s) => ({ ...s }))
  ),
  sessionDelete: vi.fn(async (id: string) => {
    state.calls.push(`delete:${id}`)
  }),
  projectDelete: vi.fn((id: string) => {
    state.calls.push(`project:${id}`)
  })
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      state.handlers.set(channel, fn)
    }
  }
}))
vi.mock('../../services/projectService', () => ({
  KNOWN_PROJECT_FIELDS: {},
  projectService: {
    list: vi.fn(),
    listArchived: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: fake.projectDelete
  }
}))
vi.mock('../../services/sessionRecords', () => ({
  sessionRecords: { findByProjectId: fake.findByProjectId }
}))
vi.mock('../../services/sessionService', () => ({
  sessionService: { delete: fake.sessionDelete }
}))

import { registerProjectHandlers } from '../projectHandlers'
import { attachIpcAdapter } from '../ipcAdapter'

const IPC_EVENT = { sender: { id: 1 } }
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = state.handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(fn(IPC_EVENT, ...args))
}

registerProjectHandlers()
attachIpcAdapter()

const row = (
  id: string,
  projectId: string | null,
  parentId: string | null = null,
  settings: Record<string, unknown> = {}
): FakeSession => ({ id, projectId, parentId, settings })

beforeEach(() => {
  state.sessions = []
  state.calls = []
  for (const fn of Object.values(fake)) fn.mockClear()
  // 用例里换过的实现换回缺省的
  fake.sessionDelete.mockImplementation(async (id: string) => {
    state.calls.push(`delete:${id}`)
  })
})

describe('PH-1 project:delete', () => {
  it('PH-1 只删成员里的顶层会话（子会话随父会话级联），引用这个项目的 bot 会话与别的项目不动；项目行最后删', async () => {
    state.sessions = [
      row('r1', 'p1'),
      row('c1', 'p1', 'r1'),
      row('r2', 'p1', null, { bot: 'scout', notebookPath: 'scout.md' }),
      // 父会话不在这个项目里的子会话（不该有）：照样单删
      row('stray', 'p1', 'elsewhere'),
      // 只归属 bot、引用 p1 当工作位置
      row('bot', null, null, { bot: 'scout', workProject: 'p1', workingDirectory: '/w/p1' }),
      row('bot-child', null, 'bot', { workProject: 'p1' }),
      row('other', 'p2')
    ]

    expect(await invoke('project:delete', { id: 'p1' })).toEqual({ success: true })
    expect(fake.findByProjectId).toHaveBeenCalledWith('p1')
    expect(state.calls).toEqual(['delete:r1', 'delete:r2', 'delete:stray', 'project:p1'])
  })

  it('PH-1 一条一条删：前一条没删完不开始下一条，项目行等最后一条删完', async () => {
    state.sessions = [row('a', 'p1'), row('b', 'p1')]
    const gates: Array<() => void> = []
    fake.sessionDelete.mockImplementation(
      (id: string) =>
        new Promise<void>((resolve) => {
          state.calls.push(`start:${id}`)
          gates.push(() => {
            state.calls.push(`done:${id}`)
            resolve()
          })
        })
    )

    const pending = invoke('project:delete', { id: 'p1' })
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    expect(state.calls).toEqual(['start:a'])
    gates[0]()
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(state.calls).toEqual(['start:a', 'done:a', 'start:b'])
    expect(fake.projectDelete).not.toHaveBeenCalled()
    gates[1]()
    expect(await pending).toEqual({ success: true })
    expect(state.calls).toEqual(['start:a', 'done:a', 'start:b', 'done:b', 'project:p1'])
  })

  it('PH-1 一条会话删失败 → 调用失败，后面的不删，项目行留着', async () => {
    state.sessions = [row('a', 'p1'), row('b', 'p1')]
    fake.sessionDelete.mockImplementationOnce(async () => {
      throw new Error('locked')
    })

    await expect(invoke('project:delete', { id: 'p1' })).rejects.toThrow('locked')
    expect(fake.sessionDelete.mock.calls.map((c) => c[0])).toEqual(['a'])
    expect(fake.projectDelete).not.toHaveBeenCalled()
  })

  it('PH-1 没有会话的项目照删', async () => {
    state.sessions = [row('bot', null, null, { bot: 'scout', workProject: 'p1' })]
    expect(await invoke('project:delete', { id: 'p1' })).toEqual({ success: true })
    expect(fake.sessionDelete).not.toHaveBeenCalled()
    expect(state.calls).toEqual(['project:p1'])
  })
})
