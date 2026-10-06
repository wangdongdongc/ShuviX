/**
 * P3-11-08 —— preload 的 `api.agent`：`withdrawQueued(p)` = `ipcRenderer.invoke('agent:withdrawQueued', p)`；
 * 「下一轮」那一档已去掉（Q-P3-09），`api.agent` 上没有它。
 *
 * electron 是替身：`contextBridge.exposeInMainWorld` 收下暴露出去的对象，`ipcRenderer.invoke` 记下调用。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(async (..._args: unknown[]) => ({ result: 'aborted' }))
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => state.exposed.set(key, value)
  },
  ipcRenderer: { invoke: state.invoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() }
}))
vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

type AgentApi = Record<string, (...args: unknown[]) => unknown>

let agent: AgentApi

beforeAll(async () => {
  const proc = process as unknown as { contextIsolated?: boolean }
  const previous = proc.contextIsolated
  proc.contextIsolated = true
  try {
    await import('../index')
  } finally {
    proc.contextIsolated = previous
  }
  agent = (state.exposed.get('api') as { agent: AgentApi }).agent
})

describe('P3-11-08 preload api.agent', () => {
  it("P3-11-08 withdrawQueued(p) → invoke('agent:withdrawQueued', p)，结果原样交回", async () => {
    const params = { sessionId: 's1', submissionId: 5 }
    await expect(agent.withdrawQueued!(params)).resolves.toEqual({ result: 'aborted' })
    expect(state.invoke.mock.calls).toEqual([['agent:withdrawQueued', params]])
  })

  it('P3-11-08 api.agent 上没有「下一轮」', () => {
    expect(Object.keys(agent).filter((key) => /turn/i.test(key))).toEqual([])
    expect(typeof agent.steer).toBe('function')
    expect(typeof agent.followUp).toBe('function')
  })
})
