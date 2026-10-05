/**
 * P3-08-62 IPC 端到端 —— 真 hub（syncWiring 的单例）+ 真 `registerSyncHandlers`（假 ipcMain / webContents）+
 * agent-runtime 的测试宿主（真 DurableSession、faux 模型），渲染端是 **chat-ui 真的 syncClient** 跑在 preload 的
 * `createSyncBridge` 上，值经 `applySessionView` 写进 chat-ui 真的 chatStore：
 *
 *  - 一轮脚本：先发工具调用、再出终答；
 *  - 稳定之后 store 的视图 = `viewSnapshot()`，`messages` = 视图的消息；
 *  - 助手卡的 key 一路不变（turn:1.0），从不出现第二张卡；
 *  - 放手之后 `hub.hasSubscribers('s1')` 落回 false。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

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
// eslint-disable-next-line boundaries/dependencies -- 冒烟用例让真的 preload 桥（渲染进程那一侧）接主进程的处理器
import { createSyncBridge } from '../../../../preload/syncBridge'
import { peekSyncHub, resetSyncHubForTests, sessionHostHooks } from '../syncWiring'
import { FakeIpcMain, FakeWebContents, fakeIpcRenderer, settle } from './support/ipcRig'
import {
  makeHost,
  primeRoot,
  registerHostCleanup
} from '../../../../../../../packages/agent-runtime/src/durable/__tests__/support/host'
import {
  answer,
  callTool
} from '../../../../../../../packages/agent-runtime/src/durable/__tests__/support/faux'
import { readTool } from '../../../../../../../packages/agent-runtime/src/durable/projection/__tests__/projectorSupport'
import { createSyncClient } from '../../../../../../../packages/chat-ui/src/sync/syncClient'
import {
  applySessionView,
  releaseSessionView,
  selectIsStreaming,
  selectPendingPrompt,
  useChatStore
} from '../../../../../../../packages/chat-ui/src/stores/chatStore'
import { buildVisibleItems } from '../../../../../../../packages/chat-ui/src/components/chat/conversationItems'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'

registerHostCleanup()

afterEach(() => {
  resetSyncHubForTests()
})

describe('P3-08-62 IPC 端到端（chat-ui syncClient ↔ 真 hub）', () => {
  it('一轮工具 + 终答：store = viewSnapshot；卡片 key 一路不变；放手之后不再钉住', async () => {
    const t = await makeHost({
      ephemeral: ['s1'],
      tools: [readTool()],
      onSessionOpened: (session) => sessionHostHooks.opened(session),
      onSessionClosed: (id, reason) => sessionHostHooks.closed(id, reason)
    })
    holder.host = t.host
    const session = await t.open('s1')
    await primeRoot(session)

    const ipc = new FakeIpcMain()
    const wc = new FakeWebContents(7)
    registerSyncHandlers(ipc, { lookup: (id) => (id === 7 ? wc : undefined) })
    const channel = createSyncBridge(fakeIpcRenderer(wc, ipc))
    const client = createSyncClient({ channel, logger: { warn: () => {} } })

    useChatStore.setState({ sessionViews: {}, sessionStreams: {}, messages: [] })
    useChatStore.getState().setActiveSessionId('s1')
    const sub = client.acquire<SessionView>({ kind: 'session', sessionId: 's1' })
    const stop = sub.subscribe((event) => {
      if (event.kind === 'value') applySessionView('s1', event.value)
    })
    await settle(8)
    expect(peekSyncHub()!.hasSubscribers('s1')).toBe(true)

    const keys: string[][] = []
    const off = useChatStore.subscribe((s) => {
      const items = buildVisibleItems(s.messages, selectIsStreaming(s), selectPendingPrompt(s))
      keys.push(items.filter((i) => i.key.startsWith('turn:')).map((i) => i.key))
    })

    t.kit.queue(callTool('read', { path: 'a.txt' }, 'c1'), answer('final words'))
    expect(await session.submitUser('go')).toEqual({})
    await settle(12)
    off()

    const snapshot = await session.viewSnapshot()
    expect(useChatStore.getState().sessionViews.s1).toEqual(snapshot)
    expect(useChatStore.getState().messages).toEqual(snapshot.messages)
    expect(snapshot.messages.at(-1)!.content).toBe('final words')
    // 卡片 key：有卡的每个状态里都恰是 turn:1.0
    const withCard = keys.filter((k) => k.length > 0)
    expect(withCard.length).toBeGreaterThan(0)
    expect(withCard.every((k) => k.length === 1 && k[0] === 'turn:1.0')).toBe(true)

    stop()
    expect(sub.release()).toBe(true)
    releaseSessionView('s1')
    await settle(8)
    expect(peekSyncHub()!.hasSubscribers('s1')).toBe(false)
  })
})
