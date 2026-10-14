/**
 * 视图服务端的冒烟（pi 1.2 / chord2）—— 一条内存链路上的真 chord 客户端：快照、一个增量、钉住、删除之后
 * unavailable、再 get → 找不到。完整的用例集由下一轮测试设计补上；这里只证明整条路是通的。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  createHost,
  memoryLinkPair,
  replicatedState,
  type Host,
  type MutableReplicatedState
} from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { emptySessionView, type SessionView } from '@shuvix/chat-protocol/types/sessionView'
import {
  createViewServer,
  type SyncHubHost,
  type SyncSession,
  type SyncSessionClosedReason,
  type ViewServer
} from '../viewServer'
import { isNotFoundError, SessionViewContract, VIEW_SERVER_HOST } from '../viewContracts'

function fakeHost(views: Record<string, MutableReplicatedState<SessionView>>): SyncHubHost & {
  peeks: string[]
} {
  const opened = new Set<(session: SyncSession) => void>()
  const closed = new Set<(sessionId: string, reason: SyncSessionClosedReason) => void>()
  const peeks: string[] = []
  return {
    peeks,
    sealed: false,
    async peek(sessionId) {
      peeks.push(sessionId)
      const state = views[sessionId]
      if (state === undefined) return undefined
      return {
        sessionId,
        projector: async () => ({ acquire: () => ({ state, release: () => {} }) }),
        agentProjector: async () => undefined
      }
    },
    onSessionOpened: (listener) => {
      opened.add(listener)
      return () => opened.delete(listener)
    },
    onSessionClosed: (listener) => {
      closed.add(listener)
      return () => closed.delete(listener)
    }
  }
}

async function until<T>(read: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read()
    if (value !== undefined && value !== false) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timeout: ${what}`)
}

let server: ViewServer | undefined
let client: Host | undefined

afterEach(async () => {
  await client?.close()
  await server?.dispose()
  client = undefined
  server = undefined
})

describe('view server smoke (memory link)', () => {
  it('snapshot, a delta, pinning, unavailable on delete, not-found afterwards', async () => {
    const state = replicatedState<SessionView>({
      ...emptySessionView('s1'),
      source: 'durable',
      messages: [{ id: 'u1', role: 'user', type: 'text', content: 'hi', timestamp: 1 } as never]
    })
    const host = fakeHost({ s1: state })
    server = createViewServer({ host })
    const [down, up] = memoryLinkPair()
    server.accept(down, { kind: 'window', webContentsId: 1 })
    client = createHost({ name: 'renderer', kind: 'client', upstream: up, onError: () => {} })

    const handle = client.get(SessionViewContract, { sessionId: 's1' }, { at: VIEW_SERVER_HOST })
    const views: unknown[] = []
    const events: string[] = []
    const availability: unknown[] = []
    const stopView = handle.view.subscribe((value) => views.push(value))
    const stopEvents = handle.view.events((event) => events.push(event.type))
    const stopAvailability = handle.availability.subscribe((value) => availability.push(value))
    await handle.ready

    // 第一份快照就是投影的值（不是空视图）
    const first = await until(
      () => views.find((v) => v !== undefined) as SessionView | undefined,
      'snapshot'
    )
    expect(first).toEqual(state.value)
    expect(await until(() => availability.find((a) => a !== undefined), 'availability')).toBe(
      'available'
    )
    // 先钉住再 peek；记录活着就一直钉着
    expect(host.peeks).toEqual(['s1'])
    expect(server.hasSubscribers('s1')).toBe(true)

    // 一个增量：投影改一处，客户端收到 ops（不是整份重发）
    state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.run = { state: 'busy' }
    })
    await until(
      () => (handle.view.value as SessionView | undefined)?.run.state === 'busy',
      'delta applied'
    )
    expect(events).toContain('ops')
    expect(handle.view.value).toEqual(state.value)

    // 删除：availability → unavailable，钉住立刻松开
    server.deleteSession('s1')
    expect(server.hasSubscribers('s1')).toBe(false)
    await until(() => handle.availability.value === 'unavailable', 'unavailable')

    // 放手之后再 get 这条会话 → 找不到（新记录的工厂拒绝）
    stopView()
    stopEvents()
    stopAvailability()
    handle.release()
    const again = client.get(SessionViewContract, { sessionId: 's1' }, { at: VIEW_SERVER_HOST })
    const error = await again.ready.then(
      () => undefined,
      (e: unknown) => e
    )
    expect(isNotFoundError(error)).toBe(true)
  })
})
