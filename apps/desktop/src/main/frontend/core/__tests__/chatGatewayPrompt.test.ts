/**
 * DefaultChatGateway.prompt 不入账：ensure 失败不会落树，网关本身也不 touchActive。
 * 入账在门面里、用户条目落下那一刻（onAdmitted / onPlaced 的 entryId，P3-07，见 agentSessionFacade.test.ts
 * 与 projectionReads.test.ts）；旧格式会话只读，不再入账。
 *
 *   IO-G1 输入来源（2026-10-21）：网关按这次操作的上下文（真 operationContext 与它的工厂，没有替身）给
 *         `session.prompt` 的第 5 个参数盖章 —— 窗口 → local、网络客户端 → remote、Chrome（空 installId）→ 不带
 *         installId、Telegram → 三个 id；不在任何上下文里 → undefined；被驱动的发送不盖（来源由门面按 drive 记）
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { ClientContext } from '../../../ipc/registry'
import {
  createChromeContext,
  createClientContext,
  createTelegramContext,
  operationContext,
  type OperationContext
} from '../../../utils/operationContext'

const mocks = vi.hoisted(() => ({
  ensureAgentSession: vi.fn(),
  recordUserEntry: vi.fn(),
  touchActive: vi.fn(),
  frontendBroadcast: vi.fn()
}))

vi.mock('../../../tools/allTools', () => ({}))
vi.mock('../../../services/toolRegistry', () => ({
  getBuiltinToolEntries: () => [],
  getPlatformBuiltinToolEntries: () => []
}))
// 会话权限表（services/acl）不在这组用例里：空表（真的那份落 SQLite，这里不起库）
vi.mock('../../../services/acl', () => ({
  sessionAcl: { pathView: () => ({ read: [], write: [] }), sandboxEntries: () => [] }
}))
vi.mock('../../../services/sessionService', () => ({
  sessionService: {
    ensureAgentSession: mocks.ensureAgentSession,
    getAgentSession: vi.fn(),
    resolveAgentProfileName: vi.fn()
  }
}))
vi.mock('../../../services/messageService', () => ({ messageService: {} }))
vi.mock('../../../services/sessionStorage', () => ({
  storageRefusalOf: () => undefined,
  recordSessionModel: vi.fn(),
  recordSessionThinkingLevel: vi.fn()
}))
vi.mock('../../../services/userInputBroker', () => ({ respondToUserInput: vi.fn() }))
vi.mock('../../../services/builtinMcp/dbConnections', () => ({
  dbManager: { getConnectionInfo: vi.fn() }
}))
vi.mock('../../../services/mcpService', () => ({ mcpService: { getAllToolInfos: () => [] } }))
vi.mock('../../../services/skillService', () => ({ skillService: { findEnabled: () => [] } }))
vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: { findById: vi.fn(), touchActive: mocks.touchActive }
}))
vi.mock('../../../dao/projectDao', () => ({ projectDao: { pick: vi.fn() } }))
vi.mock('../../../services/agentService', () => ({ agentService: { getProfile: vi.fn() } }))
vi.mock('../ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: mocks.frontendBroadcast }
}))
vi.mock('../../../services/sessionDayPromptService', () => ({
  recordUserEntry: mocks.recordUserEntry
}))

let chatGateway: (typeof import('../DefaultChatGateway'))['chatGateway']

beforeAll(async () => {
  ;({ chatGateway } = await import('../DefaultChatGateway'))
})

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
})

describe('DefaultChatGateway.prompt 不入账', () => {
  it('ensure 失败：不入账、不 touchActive，只广播 error', async () => {
    mocks.ensureAgentSession.mockResolvedValue(undefined)
    const result = await chatGateway.prompt('s1', 'hello')
    expect(result).toEqual({ error: 'Agent 未初始化' })
    expect(mocks.frontendBroadcast).toHaveBeenCalledWith({
      type: 'error',
      sessionId: 's1',
      error: 'Agent 未初始化'
    })
    expect(mocks.recordUserEntry).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })

  it('ensure 成功：发送交给 session.prompt，网关本身不入账、不 touchActive', async () => {
    const prompt = vi.fn(async () => ({}))
    mocks.ensureAgentSession.mockResolvedValue({ prompt })
    await chatGateway.prompt('s1', 'hello')
    expect(prompt).toHaveBeenCalled()
    expect(mocks.recordUserEntry).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })
})

describe('IO-G1 prompt 的来源按这次操作的上下文盖章', () => {
  const winCtx: ClientContext = {
    client: { kind: 'window', id: 'ipc:7', webContentsId: 7 },
    transport: 'ipc'
  }
  const netCtx: ClientContext = {
    client: { kind: 'network', id: 'ws:4', remoteAddress: '192.168.1.20', userAgent: 'UA' },
    transport: 'network'
  }
  const REMOTE = {
    kind: 'remote',
    clientId: 'ws:4',
    address: '192.168.1.20',
    userAgent: 'UA'
  } as const
  const DRIVE = { requestId: 'subsession:P1:3', driven: { parentId: 'P1', background: false } }

  let prompt: ReturnType<typeof vi.fn>

  beforeEach(() => {
    prompt = vi.fn(async () => ({}))
    mocks.ensureAgentSession.mockResolvedValue({ prompt })
  })

  it.each<[string, () => OperationContext, unknown]>([
    ['窗口', () => createClientContext(winCtx, 's1'), { kind: 'local' }],
    ['网络客户端', () => createClientContext(netCtx, 's1'), REMOTE],
    ["Chrome（installId 是 ''）", () => createChromeContext('', 's1'), { kind: 'chrome' }],
    [
      'Telegram',
      () => createTelegramContext('b1', 'u1', 'c1', 's1'),
      { kind: 'telegram', botId: 'b1', userId: 'u1', chatId: 'c1' }
    ]
  ])('IO-G1 在%s的上下文里 → 第 5 个参数是它的来源，其余照旧', async (_label, context, origin) => {
    await operationContext.run(context(), () => chatGateway.prompt('s1', 'hello'))
    expect(prompt.mock.calls).toHaveLength(1)
    expect(prompt.mock.calls[0]).toStrictEqual(['hello', undefined, undefined, undefined, origin])
  })

  it('IO-G1 不在任何操作上下文里（主进程自己发的）→ 第 5 个参数 undefined', async () => {
    await chatGateway.prompt('s1', 'hello')
    expect(prompt.mock.calls[0]).toStrictEqual([
      'hello',
      undefined,
      undefined,
      undefined,
      undefined
    ])
  })

  it('IO-G1 被驱动的发送在网络客户端的上下文里 → 不盖章（来源由门面按 drive 记），drive 原样', async () => {
    await operationContext.run(createClientContext(netCtx, 's1'), () =>
      chatGateway.prompt('s1', 'task', undefined, undefined, DRIVE)
    )
    expect(prompt.mock.calls[0]).toStrictEqual(['task', undefined, undefined, DRIVE, undefined])
  })
})
