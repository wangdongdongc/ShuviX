/**
 * 派生 agent 路由的索引接线（P3-14-10 的单元部分；`routerIndex.ts` + 同步接线的转发监听器 + sessionSignalSeams）：
 * 主进程真扇出（`sessionHostHooks`）+ 假路由。
 *
 *   P3-14-10 路由没登记：打开 / 关闭什么都不做（PIN-16）；登记之后每次 opened（open 或 peek）恰调一次
 *            indexSession；关闭原因：destroy 原样、其余都算 remove；路由建出来时把已经打开着的 S1、S2 各重建
 *            一次（`openSessionsOf` 只用 `get`，不碰 LRU 的新近度）；一个抛错的重建只记一笔日志、不拦扇出里
 *            后面的监听器（P3-05 的扇出语义）；注销之后不再调
 *
 * 真模块图里的懒建与打开钩子在 `routerIndexIntegration.test.ts`。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DurableSession } from '@shuvix/agent-runtime'

const logs = vi.hoisted(() => ({ warn: [] as string[] }))

// 扇出用 syncWiring 里的真单例；它所在模块的其余依赖（宿主、行表、存储）换成空的替身
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, webContents: { fromId: vi.fn() } }))
vi.mock('../../services/sessionHost', () => ({
  getSessionHost: () => undefined,
  peekSessionHost: () => undefined
}))
vi.mock('../../services/sessionRecords', () => ({ sessionRecords: { pick: () => undefined } }))
vi.mock('../../services/sessionStorage', () => ({ readLegacyTranscript: () => undefined }))
vi.mock('../AgentManager', () => ({ agentManager: { locate: () => undefined } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: (message: string) => void logs.warn.push(message),
    error: () => {},
    debug: () => {}
  })
}))

import { sessionHostHooks } from '../../frontend/sync/syncWiring'
import { setAgentIndexer } from '../../services/sessionSignalSeams'
import { openSessionsOf, wireRouterIndex } from '../routerIndex'

const session = (sessionId: string): DurableSession => ({ sessionId }) as unknown as DurableSession

function fakeRouter(): {
  indexSession: ReturnType<typeof vi.fn<(session: DurableSession) => void>>
  onSessionClosed: ReturnType<typeof vi.fn<(id: string, reason: 'remove' | 'destroy') => void>>
} {
  return {
    indexSession: vi.fn<(session: DurableSession) => void>(),
    onSessionClosed: vi.fn<(id: string, reason: 'remove' | 'destroy') => void>()
  }
}

afterEach(() => {
  setAgentIndexer(null)
  logs.warn.length = 0
})

describe('P3-14-10 the router index wiring', () => {
  it('P3-14-10 no router registered: opens and closes do nothing (PIN-16)', () => {
    expect(() => sessionHostHooks.opened(session('s1'))).not.toThrow()
    expect(() => sessionHostHooks.closed('s1', 'destroy')).not.toThrow()
    expect(logs.warn).toEqual([])
  })

  it('P3-14-10 each opened (open or peek) rebuilds exactly once per open; reasons map destroy → destroy, the rest → remove', () => {
    const router = fakeRouter()
    wireRouterIndex(router, { register: setAgentIndexer, openSessions: () => [] })
    expect(router.indexSession).not.toHaveBeenCalled()
    const s1 = session('s1')
    sessionHostHooks.opened(s1)
    expect(router.indexSession.mock.calls).toEqual([[s1]])
    sessionHostHooks.opened(s1)
    expect(router.indexSession).toHaveBeenCalledTimes(2)

    sessionHostHooks.closed('s1', 'remove')
    sessionHostHooks.closed('s1', 'invalidate')
    sessionHostHooks.closed('s1', 'destroy')
    expect(router.onSessionClosed.mock.calls).toEqual([
      ['s1', 'remove'],
      ['s1', 'remove'],
      ['s1', 'destroy']
    ])
  })

  it('P3-14-10 built while S1 and S2 are already open: both indexed at construction, via get (no peek / open)', () => {
    const s1 = session('s1')
    const s2 = session('s2')
    const host = {
      openSessionIds: vi.fn(() => ['s1', 's2', 'gone']),
      get: vi.fn((id: string) => (id === 's1' ? s1 : id === 's2' ? s2 : undefined)),
      peek: vi.fn(),
      open: vi.fn()
    }
    const router = fakeRouter()
    wireRouterIndex(router, { register: setAgentIndexer, openSessions: () => openSessionsOf(host) })
    expect(router.indexSession.mock.calls).toEqual([[s1], [s2]])
    expect(host.peek).not.toHaveBeenCalled()
    expect(host.open).not.toHaveBeenCalled()
    // 宿主没建过：什么都不重建
    expect(openSessionsOf(undefined)).toEqual([])
  })

  it('P3-14-10 a throwing rebuild is logged once and does not block the other fan-out listeners', () => {
    const router = fakeRouter()
    router.indexSession.mockImplementation(() => {
      throw new Error('boom')
    })
    wireRouterIndex(router, { register: setAgentIndexer, openSessions: () => [] })
    const after = vi.fn()
    const off = sessionHostHooks.onSessionOpened(after)
    const s1 = session('s1')
    sessionHostHooks.opened(s1)
    off()
    expect(logs.warn).toHaveLength(1)
    expect(logs.warn[0]).toContain('boom')
    expect(after.mock.calls).toEqual([[s1]])
  })

  it('P3-14-10 a throwing rebuild at construction is logged once per session and the rest still index', () => {
    const warn = vi.fn()
    const router = fakeRouter()
    router.indexSession.mockImplementationOnce(() => {
      throw new Error('bad s1')
    })
    wireRouterIndex(router, {
      register: setAgentIndexer,
      openSessions: () => [session('s1'), session('s2')],
      logger: { warn }
    })
    expect(router.indexSession).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('s1')
  })

  it('P3-14-10 unwiring stops both forwards (idempotent)', () => {
    const router = fakeRouter()
    const off = wireRouterIndex(router, { register: setAgentIndexer, openSessions: () => [] })
    off()
    off()
    sessionHostHooks.opened(session('s1'))
    sessionHostHooks.closed('s1', 'destroy')
    expect(router.indexSession).not.toHaveBeenCalled()
    expect(router.onSessionClosed).not.toHaveBeenCalled()
  })
})
