/**
 * P3-05-25 IPC 冒烟（docs/pi-durable/p3-050710a-test-design.md「End-to-end smoke」）：
 *
 * 假 ipcMain + 两个假 webContents（7、8）；真 `registerSyncHandlers`、真 hub（syncWiring 的单例）、真扇出 +
 * 宿主适配，宿主是假的（`peek` 交回 FakeSyncSession，它的投影器包着一个真的 `replicatedState(SessionView)`）；
 * 每个窗口一个真的 chord 绑定，传输是 preload 的 `createSyncBridge(假 ipcRenderer)` —— `invoke` 以
 * `event.sender = wc` 调记下的处理器，`wc.send` 结构化克隆之后交给那个窗口的监听器；客户端在 `activate`
 * 之前缓存帧。
 *
 *   1. 窗口 7 订阅 s1：绑定的值 = 投影器的值，钉住（hasSubscribers）为 true
 *   2. 'Hello' → 'Hello world'：wc7 收到 {target, subscriptionId, update} 帧、解码后的值 = 投影器的值；wc8 什么都没有
 *   3. 窗口 8 晚到：快照 = 当前值；下一次变化两边都到
 *   4. wc7 'destroyed'：钉住仍为 true（窗口 8 还在），变化只到 wc8
 *   5. 扇出 onSessionClosed('s1','remove')：wc8 收到 replaced，值是静态的最后一个值
 *   6. hub.deleteSession('s1')：wc8 收到 unavailable，绑定的视图为 undefined，钉住为 false
 *   每一帧都能 JSON 往返。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { stream } from '../../../../../../../packages/agent-runtime/src/sync/__tests__/support/rig'

const holder = vi.hoisted(() => ({ host: undefined as unknown }))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: vi.fn(() => undefined) }
}))
vi.mock('../../../services/sessionHost', () => ({
  getSessionHost: () => holder.host,
  peekSessionHost: () => holder.host
}))
vi.mock('../../../services/sessionRecords', () => ({
  sessionRecords: { pick: (id: string) => ({ id, storageKind: 'durable-sqlite-1' }) }
}))
vi.mock('../../../services/sessionStorage', () => ({ readLegacyTranscript: vi.fn(() => null) }))
vi.mock('../../../agents/AgentManager', () => ({ agentManager: { locate: () => undefined } }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

// eslint-disable-next-line boundaries/dependencies -- 同步通道的两半（frontend/sync 的 hub 与 ipc 的 sync:invoke 处理器）在一个用例里接起来
import { registerSyncHandlers } from '../../../ipc/syncHandlers'
import { peekSyncHub, resetSyncHubForTests, sessionHostHooks } from '../syncWiring'
import {
  FakeIpcMain,
  FakeWebContents,
  jsonRoundTrips,
  settle,
  syncWindow,
  type TestBinding
} from './support/ipcRig'
import { FakeSyncHost } from './support/fakeSync'

const S1 = { kind: 'session', sessionId: 's1' } as const

const types = (binding: TestBinding): string[] => binding.updates.map((update) => update.type)

beforeEach(() => {
  resetSyncHubForTests()
})

describe('P3-05-25 IPC 冒烟', () => {
  it('P3-05-25 两个窗口经 sync:invoke / sync:frame 走完订阅 → 流式 → 晚到 → 离开 → 关闭 → 删除', async () => {
    const host = new FakeSyncHost()
    const s1 = host.add('s1')
    holder.host = host
    const ipc = new FakeIpcMain()
    const wc7 = new FakeWebContents(7)
    const wc8 = new FakeWebContents(8)
    const table = new Map([
      [7, wc7],
      [8, wc8]
    ])
    registerSyncHandlers(ipc, { lookup: (id) => table.get(id) })
    const w7 = syncWindow(wc7, ipc)
    const w8 = syncWindow(wc8, ipc)
    const projector = (): SessionView => s1.root().state.value

    // 1. 窗口 7 订阅
    const a = w7.bind(S1)
    await a.ready()
    expect(a.value()).toEqual(projector())
    const hub = peekSyncHub()!
    expect(hub.hasSubscribers('s1')).toBe(true)
    expect(host.peeks).toEqual(['s1'])

    // 2. 流式：'Hello' → 'Hello world'
    const state = s1.root().state
    stream.start(state)
    stream.append(state, 'Hello')
    stream.append(state, ' world')
    await settle()
    expect(a.value()).toEqual(projector())
    expect((a.value() as SessionView).live?.message.content).toBe('Hello world')
    const frames7 = wc7.frames()
    expect(frames7.length).toBeGreaterThan(0)
    for (const frame of frames7) {
      expect(Object.keys(frame).sort()).toEqual(['subscriptionId', 'target', 'update'])
      expect(frame.target).toEqual(S1)
      expect(frame.subscriptionId).toBe(a.subscriptionIds[0])
    }
    expect(wc8.send).not.toHaveBeenCalled()

    // 3. 窗口 8 晚到：快照 = 当前值；下一次变化两边都到
    const b = w8.bind(S1)
    await b.ready()
    expect(b.value()).toEqual(projector())
    expect(b.snapshots[0]!.value).toEqual(projector())
    const before7 = wc7.frames().length
    stream.commit(state, 7)
    await settle()
    expect(a.value()).toEqual(projector())
    expect(b.value()).toEqual(projector())
    expect(wc7.frames().length).toBeGreaterThan(before7)
    expect(wc8.frames().length).toBeGreaterThan(0)

    // 4. wc7 离开：钉住仍在（窗口 8），变化只到 wc8
    wc7.destroy()
    expect(hub.hasSubscribers('s1')).toBe(true)
    const after7 = wc7.frames().length
    const before8 = wc8.frames().length
    s1.change((view) => void (view.run = { state: 'busy' }))
    await settle()
    expect(wc7.frames()).toHaveLength(after7)
    expect(wc8.frames().length).toBeGreaterThan(before8)
    expect(b.value()).toEqual(projector())

    // 5. 扇出报关闭：wc8 收到 replaced，值是静态的最后一个值
    const last = structuredClone(projector())
    sessionHostHooks.closed('s1', 'remove')
    await settle()
    expect(types(b).at(-1)).toBe('replaced')
    expect(b.value()).toEqual(last)
    // 静态拷贝：投影器之后的变化不再到达
    s1.change((view) => void (view.run = { state: 'idle' }))
    await settle()
    expect(b.value()).toEqual(last)

    // 6. 删除：unavailable、视图 undefined、钉住 false
    hub.deleteSession('s1')
    await settle()
    expect(types(b).at(-1)).toBe('unavailable')
    expect(b.value()).toBeUndefined()
    expect(hub.hasSubscribers('s1')).toBe(false)

    for (const frame of [...wc7.frames(), ...wc8.frames()]) {
      expect(jsonRoundTrips(frame)).toBe(true)
    }
    expect(a.errors).toEqual([])
    expect(b.errors).toEqual([])
    expect(w7.client.orphans).toEqual([])
  })
})
