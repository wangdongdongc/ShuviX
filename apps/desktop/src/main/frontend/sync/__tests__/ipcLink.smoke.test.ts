/**
 * 桌面窗口链路的冒烟（pi 1.2 / chord2）—— 渲染端的 syncClient → preload 的 `createSyncBridge` → 主进程的窗口链路表
 * （`createIpcLinkHub`）→ 视图服务端（会话宿主是假的），中间是假的 ipcRenderer / webContents：
 *
 *   IL-1 快照到了、钉住了；页面导航落定（did-navigate）→ 这个窗口的链路全部结束、钉住松开（PIN-02）
 *   IL-2 没有 hello 打头的帧丢掉（一条已经收掉的链路的迟到帧），不建链路
 *
 * 完整的用例集由下一轮测试设计补上。
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { replicatedState } from '@earendil-works/chord'
import {
  createViewServer,
  type SyncHubHost,
  type SyncSession,
  type ViewServer
} from '@shuvix/agent-runtime'
import { emptySessionView, type SessionView } from '@shuvix/chat-protocol/types/sessionView'
import {
  createSyncClient,
  type SyncClient
} from '../../../../../../../packages/chat-ui/src/sync/syncClient'
import { createIpcLinkHub, SYNC_FRAME_CHANNEL, type SyncWebContents } from '../ipcLink'
// eslint-disable-next-line boundaries/dependencies -- 链路的两半（主进程的窗口链路表与 preload 的桥）在一个用例里接起来
import { createSyncBridge, type SyncIpcRenderer } from '../../../../preload/syncBridge'

class FakeWebContents extends EventEmitter implements SyncWebContents {
  destroyed = false
  /** 主进程发给渲染端的（通道，参数）—— 交给渲染端的监听器 */
  readonly toRenderer = new EventEmitter()
  constructor(readonly id: number) {
    super()
  }
  send(channel: string, ...args: unknown[]): void {
    const copy = JSON.parse(JSON.stringify(args)) as unknown[]
    queueMicrotask(() => this.toRenderer.emit(channel, { sender: 'main' }, ...copy))
  }
  isDestroyed(): boolean {
    return this.destroyed
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

function fakeHost(state: ReturnType<typeof replicatedState<SessionView>>): SyncHubHost {
  return {
    sealed: false,
    async peek(sessionId) {
      if (sessionId !== 's1') return undefined
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

let server: ViewServer | undefined
let client: SyncClient | undefined

afterEach(async () => {
  client?.dispose()
  await server?.dispose()
  client = undefined
  server = undefined
})

function wire(wc: FakeWebContents): {
  hub: ReturnType<typeof createIpcLinkHub>
  renderer: SyncIpcRenderer
} {
  const view = server!
  const hub = createIpcLinkHub({ accept: (link, principal) => view.accept(link, principal) })
  const renderer: SyncIpcRenderer = {
    send: (channel, ...args) => {
      const copy = JSON.parse(JSON.stringify(args)) as unknown[]
      queueMicrotask(() => {
        if (channel === SYNC_FRAME_CHANNEL) hub.receive(wc, copy[0], copy[1])
      })
    },
    on: (channel, listener) => wc.toRenderer.on(channel, listener),
    removeListener: (channel, listener) => wc.toRenderer.removeListener(channel, listener)
  }
  return { hub, renderer }
}

describe('desktop window links (smoke)', () => {
  it('IL-1 snapshot over IPC; did-navigate ends the window links and releases the pin', async () => {
    const state = replicatedState<SessionView>({ ...emptySessionView('s1'), source: 'durable' })
    server = createViewServer({ host: fakeHost(state) })
    const wc = new FakeWebContents(7)
    const { hub, renderer } = wire(wc)
    client = createSyncClient({ channel: createSyncBridge(renderer), logger: { warn: () => {} } })
    const sub = client.acquire<SessionView>({ kind: 'session', sessionId: 's1' })
    await until(() => sub.state().status === 'live', 'live')
    expect(sub.value()).toEqual(state.value)
    expect(hub.linkCount(7)).toBe(1)
    expect(server.hasSubscribers('s1')).toBe(true)

    // 页面重载 / 换页落定：旧页面的链路全没了，服务端放掉经它的持有
    wc.emit('did-navigate')
    expect(hub.linkCount(7)).toBe(0)
    await until(() => !server!.hasSubscribers('s1'), 'pin released')
    // did-start-navigation 不算（外部链接闸拦下的导航照样先报 start）
    expect(wc.listenerCount('did-start-navigation')).toBe(0)
  })

  it('IL-2 a frame without a leading hello is dropped and opens no link', async () => {
    server = createViewServer({ host: fakeHost(replicatedState(emptySessionView('s1'))) })
    const wc = new FakeWebContents(8)
    const { hub } = wire(wc)
    hub.receive(wc, 'stale-link', { t: 'ping', n: 1 })
    hub.receive(wc, 'stale-link', 'not a frame')
    hub.receive(wc, 42, { t: 'hello', name: 'x', kind: 'client', epoch: 1 })
    expect(hub.linkCount()).toBe(0)
  })
})
