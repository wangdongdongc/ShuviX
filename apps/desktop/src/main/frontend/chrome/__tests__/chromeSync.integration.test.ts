/**
 * Chrome 侧边栏的视图同步，整条路（pi 1.2 / chord2）：侧边栏里**真的** chat-ui syncClient → `support/fakeSw` 扮演的
 * SW → 桌面的链路表（`chromeLinks`）→ **真的**视图服务端（agent-runtime 的 `viewServer`，会话宿主是 viewRig 的假宿主），
 * 主体核对就是产品的 `chromeViewAllowed`（`frontend/chrome/index.ts`）—— 标签页会话的归属（`tabSessionOwnedBy`）换成
 * 一张表，口径与真的一样（installId / runId 为空一律不归属）。
 *
 *   CI-1 自己浏览器这一轮的标签页会话 → live（同一安装 + 同一轮运行的别的标签页的会话也行，与 channel.call 的归属
 *        口径一致）；别的安装、别的一轮、桌面会话、不存在的 id → forbidden，不 peek、不钉住、一帧视图都不发
 *   CI-2 派生 agent 目标一律 forbidden（根在自己的标签页会话里的也是；根在别处 / 认不出的同样是 forbidden 而不是
 *        not_found）：不解析 agent、不 peek、不钉住、一帧视图都不发
 *   CI-3 侧边栏关了（SW 补 bye）→ 一个来回之内放掉持有、钉住；另一个侧边栏照旧
 *   CI-4 桥连接断了（closeConnection）→ 链路结束、钉住松开；侧边栏的渠道 down、客户端回到 loading；新的连接就绪 →
 *        新链路、新快照
 *   CI-5 标签页关了 → deleteSession → 侧边栏的绑定 unavailable、不再钉住
 *   CI-6 超过 1 MB 的帧（中日文 + emoji）经**真的** ChromeBridgeServer 连接：每一行都不超原生消息上限、这一帧的每行
 *        都是分片，BridgeChunkAssembler 拼回的正是 `{type:'event', name:'sync.link', params:{panelId, link, frame}}`
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connect, type Socket } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Frame } from '@earendil-works/chord'
import type { ViewPrincipal, ViewServer } from '@shuvix/agent-runtime'
import {
  BridgeChunkAssembler,
  CHROME_BRIDGE_PROTOCOL,
  CHROME_NATIVE_MESSAGE_MAX_BYTES,
  type BridgeChunk,
  type BridgeMessage
} from '@shuvix/chat-protocol/chromeBridge'
import type { JsonValue, SyncLinkChannel, SyncTarget } from '@shuvix/chat-protocol/sync'
import type { AssistantMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { AgentView, SessionView } from '@shuvix/chat-protocol/types/sessionView'

const mocks = vi.hoisted(() => ({
  /** 标签页会话 → 它属于哪个浏览器的哪一轮运行 */
  owners: new Map<string, { installId: string; runId: string }>(),
  locate: vi.fn()
}))

vi.mock('../../core', () => ({ chatFrontendRegistry: { bind: vi.fn() } }))
vi.mock('../../../utils/appEventBus', () => ({ appEventBus: { subscribe: vi.fn() } }))
vi.mock('../../../dao/settingsDao', () => ({ settingsDao: { findByKey: () => undefined } }))
vi.mock('../../../services/chromeBridge', () => ({
  chromeBridge: {
    setHandlers: vi.fn(),
    readyConnections: () => [],
    connectionById: () => undefined,
    onConnectionClosed: vi.fn()
  }
}))
vi.mock('../../../services/sessionHost', () => ({
  getSessionHost: vi.fn(),
  peekSessionHost: () => undefined
}))
vi.mock('../../../services/sessionRecords', () => ({ sessionRecords: { pick: () => undefined } }))
vi.mock('../../../services/sessionStorage', () => ({ readLegacyTranscript: () => undefined }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
vi.mock('../../../agents/AgentManager', () => ({ agentManager: { locate: mocks.locate } }))
vi.mock('../channel', () => ({ callPanelChannel: vi.fn() }))
vi.mock('../tabSessions', () => ({
  openTabSession: vi.fn(),
  closeTabSession: vi.fn(),
  sweepTabSessions: vi.fn(),
  connectionOwnsSession: vi.fn(),
  // 与真的 tabSessionOwnedBy 同一口径：id / installId / runId 为空一律不归属
  tabSessionOwnedBy: (sessionId: unknown, installId: string, runId: string): boolean => {
    if (typeof sessionId !== 'string' || !sessionId || !installId || !runId) return false
    const owner = mocks.owners.get(sessionId)
    return owner !== undefined && owner.installId === installId && owner.runId === runId
  }
}))

import { chromeViewAllowed } from '../index'
import { createChromeLinkHub, type ChromeLinkHub } from '../chromeLinks'
import { ChromeBridgeServer } from '../../../services/chromeBridge/server'
import { FakeConn, FakeSw } from './support/fakeSw'
import {
  durableView,
  fakeViewHost,
  isViewStateFrame,
  serverFor,
  settle,
  until,
  type FakeViewHost
} from '../../../../../../../packages/agent-runtime/src/sync/__tests__/support/viewRig'
import {
  createSyncClient,
  type SyncClient,
  type ViewSubscription
} from '../../../../../../../packages/chat-ui/src/sync/syncClient'

const I1R1 = { installId: 'i1', runId: 'r1' }

let servers: ViewServer[] = []
let clients: SyncClient[] = []

afterEach(async () => {
  for (const client of clients) client.dispose()
  for (const server of servers) await server.dispose().catch(() => undefined)
  clients = []
  servers = []
  mocks.owners.clear()
  mocks.locate.mockReset()
})

/**
 * 真的视图服务端（authorize = chromeViewAllowed）+ 链路表。会话：tab5 / tab7（i1 的 r1 一轮）、other（i2）、
 * oldRun（i1 的上一轮 r0）、desk（桌面会话，不是标签页会话）
 */
function rig(): {
  host: FakeViewHost
  server: ViewServer
  hub: ChromeLinkHub
  principals: ViewPrincipal[]
} {
  const host = fakeViewHost()
  const server = serverFor(host, { authorize: chromeViewAllowed })
  servers.push(server)
  const principals: ViewPrincipal[] = []
  const hub = createChromeLinkHub({
    accept: (link, principal) => {
      principals.push(principal)
      server.accept(link, principal)
    }
  })
  for (const id of ['tab5', 'tab7', 'other', 'oldRun', 'desk']) host.add(id)
  mocks.owners.set('tab5', I1R1)
  mocks.owners.set('tab7', I1R1)
  mocks.owners.set('other', { installId: 'i2', runId: 'r1' })
  mocks.owners.set('oldRun', { installId: 'i1', runId: 'r0' })
  return { host, server, hub, principals }
}

function clientOn(channel: SyncLinkChannel, prefix: string): SyncClient {
  const client = createSyncClient({
    channel,
    idPrefix: prefix,
    reconnectDelayMs: 5,
    logger: { warn: () => {} }
  })
  clients.push(client)
  return client
}

const session = (sessionId: string): SyncTarget => ({ kind: 'session', sessionId })
const agent = (agentId: string): SyncTarget => ({ kind: 'agent', agentId })

const settled = (subs: ViewSubscription<SessionView | AgentView>[]): Promise<unknown> =>
  until(() => subs.every((sub) => sub.state().status !== 'loading'), 'all settled')

const FORBIDDEN = { status: 'error', code: 'forbidden' }

/** 送到这个侧边栏的、带视图值的 state 帧（快照 / 重置 / 增量） */
const viewFrames = (received: Array<[string, unknown]>): unknown[] =>
  received.filter(([, frame]) => isViewStateFrame(frame as Frame)).map(([, frame]) => frame)

describe('CI-1 侧边栏只能看自己浏览器这一轮的标签页会话', () => {
  it('CI-1 自己的 / 同一轮的别的标签页 → live；别的安装、别的一轮、桌面会话、不存在 → forbidden', async () => {
    const { host, server, hub, principals } = rig()
    const sw = new FakeSw(hub, new FakeConn('c1', I1R1))
    const p5 = sw.panelChannel('panel:5')
    const client5 = clientOn(p5.channel, 'tab5')
    const own = client5.acquire<SessionView>(session('tab5'))
    const sibling = client5.acquire<SessionView>(session('tab7'))
    const refused = ['other', 'oldRun', 'desk', 'nope'].map((id) =>
      client5.acquire<SessionView>(session(id))
    )
    await settled([own, sibling, ...refused])

    expect(principals).toStrictEqual([
      { kind: 'chrome', installId: 'i1', runId: 'r1', connId: 'c1', tabId: 5 }
    ])
    expect(own.state()).toEqual({ status: 'live' })
    expect(own.value()).toEqual(host.session('tab5')!.lastRoot())
    expect(sibling.state()).toEqual({ status: 'live' })
    expect(sibling.value()?.sessionId).toBe('tab7')
    for (const sub of refused) {
      // 不存在的 id 也是 forbidden，不是 not_found：不归你的东西不告诉你它在不在
      expect(sub.state()).toEqual(FORBIDDEN)
      expect(sub.value()).toBeUndefined()
    }
    // 拒掉的目标：不 peek、不钉住，一帧视图值都没出桌面
    expect(host.peeks.filter((id) => ['other', 'oldRun', 'desk', 'nope'].includes(id))).toEqual([])
    for (const id of ['other', 'oldRun', 'desk', 'nope']) {
      expect(server.hasSubscribers(id)).toBe(false)
    }
    const leaked = JSON.stringify(viewFrames(p5.received))
    for (const id of ['other', 'oldRun', 'desk', 'nope']) {
      expect(leaked).not.toContain(`"sessionId":"${id}"`)
    }

    // 同一安装 + 同一轮运行的另一个标签页（7）的侧边栏看得了标签页 5 的会话
    const p7 = sw.panelChannel('panel:7')
    const from7 = clientOn(p7.channel, 'tab7').acquire<SessionView>(session('tab5'))
    await settled([from7])
    expect(from7.state()).toEqual({ status: 'live' })
    expect(principals.at(-1)).toStrictEqual({
      kind: 'chrome',
      installId: 'i1',
      runId: 'r1',
      connId: 'c1',
      tabId: 7
    })
  })

  it('CI-1 别的浏览器（安装）/ 同一浏览器的上一轮运行：只看得了自己的，看不了 i1 r1 的', async () => {
    const { hub } = rig()
    const fromI2 = clientOn(
      new FakeSw(hub, new FakeConn('c2', { installId: 'i2', runId: 'r1' })).panelChannel('panel:5')
        .channel,
      'i2tab5'
    )
    const fromR0 = clientOn(
      new FakeSw(hub, new FakeConn('c3', { installId: 'i1', runId: 'r0' })).panelChannel('panel:5')
        .channel,
      'r0tab5'
    )
    const subs = [
      fromI2.acquire<SessionView>(session('other')),
      fromI2.acquire<SessionView>(session('tab5')),
      fromR0.acquire<SessionView>(session('oldRun')),
      fromR0.acquire<SessionView>(session('tab5'))
    ]
    await settled(subs)
    expect(subs.map((sub) => sub.state())).toEqual([
      { status: 'live' },
      FORBIDDEN,
      { status: 'live' },
      FORBIDDEN
    ])
  })
})

describe('CI-2 派生 agent 目标一律不让看', () => {
  it('CI-2 根在自己标签页会话 / 根在别处 / 认不出 → 都是 forbidden；不解析、不 peek、不钉住、不发视图帧', async () => {
    const { host, server, hub } = rig()
    host.addAgent('ag5', 'tab5')
    host.addAgent('agDesk', 'desk')
    mocks.locate.mockImplementation((agentId: string) =>
      agentId === 'ag5' ? { sessionId: 'tab5', conversationId: 2 } : undefined
    )
    const p5 = new FakeSw(hub, new FakeConn('c1', I1R1)).panelChannel('panel:5')

    for (let round = 0; round < 6; round++) {
      const client = clientOn(p5.channel, `tab5r${round}`)
      const subs = ['ag5', 'agDesk', 'agUnknown'].map((id) => client.acquire<AgentView>(agent(id)))
      await settled(subs)
      for (const sub of subs) {
        expect(sub.state()).toEqual(FORBIDDEN)
        expect(sub.value()).toBeUndefined()
      }
      client.dispose()
    }

    expect(host.resolveCalls).toEqual([])
    expect(mocks.locate).not.toHaveBeenCalled()
    expect(host.peeks).toEqual([])
    expect(server.hasSubscribers('tab5')).toBe(false)
    expect(server.hasSubscribers('desk')).toBe(false)
    expect(viewFrames(p5.received)).toEqual([])
  })

  it('CI-2 同一个侧边栏同时看自己的会话：会话照常 live，agent 照样 forbidden，只 peek 自己的会话', async () => {
    const { host, hub } = rig()
    host.addAgent('ag5', 'tab5')
    const p5 = new FakeSw(hub, new FakeConn('c1', I1R1)).panelChannel('panel:5')
    const client = clientOn(p5.channel, 'tab5')
    const own = client.acquire<SessionView>(session('tab5'))
    const child = client.acquire<AgentView>(agent('ag5'))
    await settled([own, child])
    expect(own.state()).toEqual({ status: 'live' })
    expect(child.state()).toEqual(FORBIDDEN)
    expect(host.peeks).toEqual(['tab5'])
    expect(host.resolveCalls).toEqual([])
    expect(JSON.stringify(viewFrames(p5.received))).not.toContain('"agentId":"ag5"')
  })
})

describe('CI-3 侧边栏关了', () => {
  it('CI-3 SW 补 bye → 一个来回之内放掉持有与钉住；另一个侧边栏照旧', async () => {
    const { host, server, hub } = rig()
    const sw = new FakeSw(hub, new FakeConn('c1', I1R1))
    const p5 = sw.panelChannel('panel:5')
    const p7 = sw.panelChannel('panel:7')
    const client5 = clientOn(p5.channel, 'tab5')
    const client7 = clientOn(p7.channel, 'tab7')
    const own5 = client5.acquire<SessionView>(session('tab5'))
    const shared5 = client5.acquire<SessionView>(session('tab7'))
    const own7 = client7.acquire<SessionView>(session('tab7'))
    await until(
      () => [own5, shared5, own7].every((sub) => sub.state().status === 'live'),
      'all live'
    )
    const root5 = host.session('tab5')!.currentRoot()!
    const root7 = host.session('tab7')!.currentRoot()!
    expect(root5.refs).toBe(1)
    expect(hub.linkCount('c1')).toBe(2)

    sw.closePanel('panel:5')
    await settle(4)
    expect(hub.linkCount('c1')).toBe(1)
    expect(server.hasSubscribers('tab5')).toBe(false)
    expect(root5.refs).toBe(0)
    // tab7 还被侧边栏 7 看着：钉住、租约都在，修订照常到
    expect(server.hasSubscribers('tab7')).toBe(true)
    expect(root7.refs).toBe(1)
    expect(own7.state()).toEqual({ status: 'live' })
    root7.change((draft) => {
      draft.run = { state: 'busy' }
    })
    await until(() => own7.value()?.run.state === 'busy', 'panel 7 still updates')
  })
})

describe('CI-4 桥连接断了又连上', () => {
  it('CI-4 closeConnection → 链路结束、钉住松开、客户端 loading；新连接就绪 → 新链路、新快照', async () => {
    const { host, server, hub, principals } = rig()
    const c1 = new FakeConn('c1', I1R1)
    const sw = new FakeSw(hub, c1)
    const p5 = sw.panelChannel('panel:5')
    const client = clientOn(p5.channel, 'tab5')
    const sub = client.acquire<SessionView>(session('tab5'))
    const statuses: string[] = []
    sub.subscribe((event) => {
      if (event.kind === 'status') statuses.push(event.state.status)
    })
    await until(() => sub.state().status === 'live', 'live')
    const firstLink = [...p5.links][0]
    expect(firstLink).toMatch(/^tab5\./)

    sw.disconnect()
    const emittedOnC1 = c1.emitted.length
    expect(hub.linkCount('c1')).toBe(0)
    expect(sub.state()).toEqual({ status: 'loading' })
    expect(sub.value()).toBeUndefined()
    await until(() => !server.hasSubscribers('tab5'), 'unpinned')

    // 断着的时候会话往前走了一步；侧边栏什么也没往外发
    const sentWhileUp = p5.sent.length
    host.session('tab5')!.root.change((draft) => {
      draft.run = { state: 'busy' }
    })
    await settle()
    expect(p5.sent.length).toBe(sentWhileUp)
    expect(p5.dropped).toEqual([])

    const c2 = new FakeConn('c2', I1R1)
    sw.reconnect(c2)
    await until(() => sub.state().status === 'live', 'live again')
    expect(sub.value()?.run.state).toBe('busy')
    expect(server.hasSubscribers('tab5')).toBe(true)
    const newFrames = p5.sent.slice(sentWhileUp)
    const newLink = newFrames[0][0]
    expect(newLink).not.toBe(firstLink)
    expect((newFrames[0][1] as { t?: unknown }).t).toBe('hello')
    expect(principals.at(-1)).toStrictEqual({
      kind: 'chrome',
      installId: 'i1',
      runId: 'r1',
      connId: 'c2',
      tabId: 5
    })
    expect(hub.linkCount('c2')).toBe(1)
    // 旧连接上什么也不再发
    expect(c1.emitted.length).toBe(emittedOnC1)
    expect(statuses).toEqual(['live', 'loading', 'live'])
  })
})

describe('CI-5 标签页关了', () => {
  it('CI-5 tabs.removed → 会话删除（deleteSession）→ 侧边栏的绑定 unavailable、不再钉住', async () => {
    const { host, server, hub } = rig()
    const sw = new FakeSw(hub, new FakeConn('c1', I1R1))
    const p5 = sw.panelChannel('panel:5')
    const sub = clientOn(p5.channel, 'tab5').acquire<SessionView>(session('tab5'))
    await until(() => sub.state().status === 'live', 'live')

    // sessionService.delete 的次序：关停运行时（存储销毁）→ deleteSession → 删行
    host.closed('tab5', 'destroy')
    server.deleteSession('tab5')
    mocks.owners.delete('tab5')
    await until(() => sub.state().status === 'unavailable', 'unavailable')
    expect(sub.value()).toBeUndefined()
    expect(server.hasSubscribers('tab5')).toBe(false)
    await settle()
    expect(sub.state()).toEqual({ status: 'unavailable' })

    // 行已经删了：再要这条会话 → 不归你（forbidden），分不出删没删
    const again = clientOn(sw.panelChannel('panel:7').channel, 'tab7').acquire<SessionView>(
      session('tab5')
    )
    await settled([again])
    expect(again.state()).toEqual(FORBIDDEN)
  })
})

// ─── CI-6：真的桥连接上的分片 ─────────────────────────────

const MAX = CHROME_NATIVE_MESSAGE_MAX_BYTES
const TOKEN = 'tok-chrome-sync'
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

/** 扮演本地组件（native host）这一头：按行收，鉴权、握手 */
class NativeHostClient {
  readonly socket: Socket
  readonly lines: string[] = []
  #rest = ''
  readonly #lineListeners = new Set<(line: string) => void>()

  constructor(path: string) {
    this.socket = connect(path)
    this.socket.setEncoding('utf8')
    this.socket.on('data', (chunk: string) => {
      this.#rest += chunk
      const parts = this.#rest.split('\n')
      this.#rest = parts.pop() ?? ''
      for (const line of parts) {
        if (!line) continue
        this.lines.push(line)
        for (const listener of [...this.#lineListeners]) listener(line)
      }
    })
    this.socket.on('error', () => {})
  }

  send(value: unknown): void {
    this.socket.write(JSON.stringify(value) + '\n')
  }

  onLine(listener: (line: string) => void): void {
    this.#lineListeners.add(listener)
  }

  async ready(): Promise<void> {
    this.send({ auth: TOKEN })
    await until(() => this.lines.includes('{"auth":"ok"}'), 'auth ok')
    this.send({
      type: 'hello',
      protocol: CHROME_BRIDGE_PROTOCOL,
      extensionVersion: '0.3.0',
      installId: 'i1',
      runId: 'r1',
      browser: 'Chrome 140',
      openTabIds: [5]
    })
    await until(
      () =>
        this.lines.some((line) => {
          const message = JSON.parse(line) as { type?: string; ok?: boolean }
          return message.type === 'welcome' && message.ok === true
        }),
      'welcome'
    )
  }
}

function bigAssistant(sessionId: string, text: string): AssistantMessage {
  return {
    id: '42',
    sessionId,
    role: 'assistant',
    type: 'message',
    content: text,
    model: 'faux-1',
    createdAt: 1,
    blocks: [{ type: 'text', text }],
    metadata: null
  }
}

describe.skipIf(process.platform === 'win32')('CI-6 超过 1 MB 的帧经真的桥连接', () => {
  it('CI-6 每行不超上限、这一帧的每行都是分片，拼回的就是 sync.link 事件本身；侧边栏拿到完整的视图', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chrome-sync-'))
    const bridge = new ChromeBridgeServer()
    let native: NativeHostClient | undefined
    try {
      const { host, hub } = rig()
      const text = '中文テスト😀'.repeat(70_000)
      host.add('tab5', { ...durableView('tab5'), messages: [bigAssistant('tab5', text)] })
      bridge.setHandlers({
        onEvent: (conn, name, params) => {
          if (name === 'sync.link') hub.receive(conn, params)
        }
      })
      bridge.onConnectionClosed((conn) => hub.closeConnection(conn.id))
      await bridge.start({ socketPath: join(dir, 'b.sock'), getToken: () => TOKEN })

      native = new NativeHostClient(join(dir, 'b.sock'))
      await native.ready()
      const conn = bridge.connectionFor('i1')!
      expect(conn).toBeDefined()
      const emit = vi.spyOn(conn, 'emit')
      const linesBefore = native.lines.length

      // 侧边栏的链路渠道就是这条 socket（SW 那一段省掉：它不解析帧，原样转）
      const assembler = new BridgeChunkAssembler()
      const listeners = new Set<(link: string, frame: JsonValue) => void>()
      const deliver = (message: BridgeMessage): void => {
        if (message.type !== 'event' || message.name !== 'sync.link') return
        const params = message.params as { panelId: string; link: string; frame: JsonValue }
        if (params.panelId !== 'panel:5') return
        for (const listener of [...listeners]) listener(params.link, params.frame)
      }
      native.onLine((line) => {
        const message = JSON.parse(line) as BridgeMessage
        if (message.type === 'chunk') {
          const whole = assembler.push(message)
          if (whole) deliver(whole)
        } else deliver(message)
      })
      const native_ = native
      const channel: SyncLinkChannel = {
        send: (link, frame) =>
          native_.send({
            type: 'event',
            name: 'sync.link',
            params: { panelId: 'panel:5', link, frame }
          }),
        onFrame: (callback) => {
          listeners.add(callback)
          return () => {
            listeners.delete(callback)
          }
        }
      }
      const sub = clientOn(channel, 'tab5').acquire<SessionView>(session('tab5'))
      await until(() => sub.state().status === 'live', 'live', 15_000)
      expect(sub.value()!.messages[0]).toEqual(bigAssistant('tab5', text))

      const lines = native.lines.slice(linesBefore)
      for (const line of lines) expect(byteLength(line)).toBeLessThanOrEqual(MAX)

      // 桌面这一头发出的那一帧大事件
      const big = emit.mock.calls.filter(
        ([name, params]) =>
          name === 'sync.link' && byteLength(JSON.stringify({ type: 'event', name, params })) > MAX
      )
      expect(big).toHaveLength(1)
      const params = big[0][1] as { panelId: string; link: string; frame: unknown }
      expect(params.panelId).toBe('panel:5')
      expect(params.link).toMatch(/^tab5\./)

      // 它在线上全是分片（一组、连着、seq 连续），拼回来分毫不差
      const parsed = lines.map((line) => JSON.parse(line) as BridgeMessage)
      const chunks = parsed.filter((m): m is BridgeChunk => m.type === 'chunk')
      expect(chunks.length).toBeGreaterThanOrEqual(2)
      expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1)
      expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_, index) => index))
      const first = parsed.indexOf(chunks[0])
      expect(parsed.slice(first, first + chunks.length)).toEqual(chunks)
      const rebuild = new BridgeChunkAssembler()
      let whole: BridgeMessage | null = null
      for (const chunk of chunks) whole = rebuild.push(chunk) ?? whole
      expect(whole).toEqual({
        type: 'event',
        name: 'sync.link',
        params: JSON.parse(JSON.stringify(params))
      })
      // 别的行都是完整的小消息
      for (const message of parsed) {
        if (message.type !== 'chunk') expect(message.type).toBe('event')
      }
    } finally {
      native?.socket.destroy()
      bridge.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
