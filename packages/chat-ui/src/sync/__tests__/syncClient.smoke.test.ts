/**
 * syncClient 的冒烟（pi 1.2 / chord2）—— 真的客户端对着**真的**视图服务端（agent-runtime 的 `viewServer`，会话宿主
 * 是假的），中间是一条进程内的链路渠道：快照 → 一个增量 → 删除之后 unavailable；以及不存在的派生 agent → error +
 * `not_found`。完整的用例集由下一轮测试设计补上；这里只证明整条路是通的。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { replicatedState, type MutableReplicatedState } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { SYNC_NOT_FOUND } from '@shuvix/chat-protocol/sync'
import { emptySessionView, type SessionView } from '@shuvix/chat-protocol/types/sessionView'
import {
  createViewServer,
  type SyncHubHost,
  type SyncSession,
  type ViewServer
} from '../../../../agent-runtime/src/sync/viewServer'
import { createSyncClient, type SyncClient, type ViewEvent } from '../syncClient'
import { linkChannel } from './support/fakeServer'

function fakeHost(views: Record<string, MutableReplicatedState<SessionView>>): SyncHubHost {
  return {
    sealed: false,
    async peek(sessionId) {
      const state = views[sessionId]
      if (state === undefined) return undefined
      const session: SyncSession = {
        sessionId,
        projector: async () => ({ acquire: () => ({ state, release: () => {} }) }),
        agentProjector: async () => undefined
      }
      return session
    },
    onSessionOpened: () => () => {},
    onSessionClosed: () => () => {}
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await tick()
  }
  throw new Error(`timeout: ${what}`)
}

let server: ViewServer | undefined
let client: SyncClient | undefined

afterEach(async () => {
  client?.dispose()
  await server?.dispose()
  client = undefined
  server = undefined
})

describe('syncClient smoke (real view server over a link channel)', () => {
  it('snapshot, a delta, unavailable on delete', async () => {
    const state = replicatedState<SessionView>({ ...emptySessionView('s1'), source: 'durable' })
    const view = createViewServer({ host: fakeHost({ s1: state }) })
    server = view
    const wire = linkChannel((link, linkId) =>
      view.accept(link, { kind: 'window', webContentsId: 1, linkId })
    )
    client = createSyncClient({ channel: wire.channel, logger: { warn: () => {} } })

    const sub = client.acquire<SessionView>({ kind: 'session', sessionId: 's1' })
    const events: ViewEvent<SessionView>[] = []
    sub.subscribe((event) => events.push(event))

    await until(() => sub.state().status === 'live', 'live')
    expect(sub.value()).toEqual(state.value)
    expect(events.find((e) => e.kind === 'value')).toMatchObject({ delivery: 'hydrate' })
    expect(view.hasSubscribers('s1')).toBe(true)

    state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.run = { state: 'busy' }
    })
    await until(() => sub.value()?.run.state === 'busy', 'delta')
    expect(events.filter((e) => e.kind === 'value').at(-1)).toMatchObject({ delivery: 'update' })

    view.deleteSession('s1')
    await until(() => sub.state().status === 'unavailable', 'unavailable')
    expect(sub.value()).toBeUndefined()

    // 最后一个使用方放手：句柄放掉，空闲的链路随后关掉（服务端这头一条都不留）
    expect(sub.release()).toBe(true)
    await until(() => wire.links().length === 0, 'idle link closed')
    expect(wire.frameListeners.active).toBe(0)
  })

  it('an unknown agent → error with the not-found code, no retry', async () => {
    const view = createViewServer({ host: fakeHost({}), resolveAgent: () => undefined })
    server = view
    const wire = linkChannel((link) => view.accept(link, { kind: 'window', webContentsId: 1 }))
    client = createSyncClient({ channel: wire.channel, logger: { warn: () => {} } })
    const sub = client.acquire({ kind: 'agent', agentId: 'nope' })
    await until(() => sub.state().status === 'error', 'error')
    expect(sub.state()).toEqual({ status: 'error', code: SYNC_NOT_FOUND })
    sub.release()
  })
})
