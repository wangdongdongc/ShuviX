/**
 * 扩展端 sessionStore.create —— 落库 settings 不写 `agentProfile`（EXT-6）。
 *
 * 根 Agent 的档案由会话形态推导（agentRuntime.buildRuntimeSession），扩展端又没有子会话，
 * 所以这个键在这一端**从不被写**：改制前 `create` 收一个 `agentProfile` 入参并落进 settings
 * （调用方按形态解析后传入），那条路已删。这里钉 settings 恰为 `{}` / `{ notebookPath }`。
 *
 * mock：`./idb`（IndexedDB）与 `./opfsWorkspace`（OPFS）在 node 下不存在，整模块顶掉；
 * 存储层只剩内存缓存，create 的返回值就是它写进去的那一行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../idb', () => ({
  idb: { getAll: async () => [], put: async () => {}, delete: async () => {} }
}))
vi.mock('../opfsWorkspace', () => ({ deleteTempWorkspace: async () => {} }))

import { sessionStore } from '../sessionStore'

describe('sessionStore.create —— settings 不带 agentProfile', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('EXT-6 普通会话 settings 恰为 {}；项目会话同样；笔记本会话恰为 { notebookPath }', async () => {
    const plain = await sessionStore.create({ provider: 'p', model: 'm' })
    expect(plain.settings).toEqual({})
    expect('agentProfile' in plain.settings).toBe(false)
    expect(plain.projectId).toBeNull()

    const inProject = await sessionStore.create({ provider: 'p', model: 'm', projectId: 'proj' })
    expect(inProject.settings).toEqual({})
    expect(inProject.projectId).toBe('proj')

    const notebook = await sessionStore.create({
      provider: 'p',
      model: 'm',
      projectId: 'proj',
      notebookPath: 'notes/a.md'
    })
    expect(notebook.settings).toEqual({ notebookPath: 'notes/a.md' })
    expect('agentProfile' in notebook.settings).toBe(false)
  })

  it('子会话是桌面端形态：扩展建出的会话恒为顶层（parentId null）', async () => {
    // 扩展没有 session 工具，也就没有「父级点名档案」这条唯一的写戳入口
    const s = await sessionStore.create({ provider: 'p', model: 'm' })
    expect(s.parentId).toBeNull()
  })

  it('create 写入 lastActiveAt === createdAt === updatedAt', async () => {
    const s = await sessionStore.create({ provider: 'p', model: 'm' })
    expect(s.lastActiveAt).toBe(s.createdAt)
    expect(s.updatedAt).toBe(s.createdAt)
  })

  it('list 按 lastActiveAt 倒序', async () => {
    const older = await sessionStore.create({ provider: 'p', model: 'm', title: 'older' })
    vi.setSystemTime(2_000)
    const newer = await sessionStore.create({ provider: 'p', model: 'm', title: 'newer' })
    vi.setSystemTime(3_000)
    await sessionStore.touchActive(older.id)
    const listed = await sessionStore.list()
    const iOlder = listed.findIndex((s) => s.id === older.id)
    const iNewer = listed.findIndex((s) => s.id === newer.id)
    expect(listed[iOlder]!.lastActiveAt).toBeGreaterThan(listed[iNewer]!.lastActiveAt)
    expect(iOlder).toBeLessThan(iNewer)
  })
})
