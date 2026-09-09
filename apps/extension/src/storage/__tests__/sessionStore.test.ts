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
import { describe, expect, it, vi } from 'vitest'

vi.mock('../idb', () => ({
  idb: { getAll: async () => [], put: async () => {}, delete: async () => {} }
}))
vi.mock('../opfsWorkspace', () => ({ deleteTempWorkspace: async () => {} }))

import { sessionStore } from '../sessionStore'

describe('sessionStore.create —— settings 不带 agentProfile', () => {
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
})
