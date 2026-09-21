/**
 * 扩展端根会话的工具装配（agentHost 的 `resolveTools`，root 分支）—— 浏览器从「按名装配的内置工具」
 * 变成了一台恒启用的内置 MCP 能力服务器（`mcp__browser__*`）之后，装配这一刻要做对的几件事：
 *
 *   - 档案名单里残留的裸 `browser`（包括退役前的用户覆盖副本）什么也不装 —— 没有别名；
 *   - MCP 惰性启动**带着会话 id**：内置 server 按会话实例化，不带会话 id 时 ensureEnabled 与
 *     getAllAgentTools 都会把 inproc 跳过 —— 扩展就一个浏览器工具都没有了；取工具时调用方身份是根会话；
 *   - 这条会话的询问通道在这里登记进 userInputBroker（browser 的安全门按会话 id 取它）；运行时没给
 *     通道时登记的是一个以 `NO_INTERACTIVE_INPUT` 拒绝的替身 —— 门据此 fail-closed；
 *   - 连接期间给会话推 `mcp_connecting`（只推还没连上的），连不上的落一条 `chat.mcpConnectFailed`。
 *
 * 取 host 适配面的办法同 promptVarsWiring.test.ts：顶掉 `createAgentFactory`，把 agentHost 传进去的
 * 对象接住。userInputBroker 用真件（要从它那头验证登记）；其余本地模块一律替身 —— agentHost 的
 * import 图带 IndexedDB / chrome.* / OPFS / CDP，node 环境下起不来。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import {
  LAZY_CONNECT_TIMEOUT_MS,
  type AgentHostAdapter,
  type AnyAgentTool,
  type ToolResolveRequest
} from '@shuvix/agent-runtime'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

const mocks = vi.hoisted(() => ({
  host: { value: undefined as unknown },
  getById: vi.fn(),
  getTempWorkspaceHandle: vi.fn(),
  createFileTools: vi.fn(),
  emit: vi.fn(),
  getEnabledToolNames: vi.fn(),
  statusByName: vi.fn(),
  ensureEnabled: vi.fn(),
  getAllAgentTools: vi.fn(),
  registerSessionTools: vi.fn()
}))

vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  return {
    ...actual,
    createAgentFactory: (host: unknown) => {
      mocks.host.value = host
      return { createAgent: vi.fn() }
    }
  }
})

vi.mock('../../storage/sessionStore', () => ({ sessionStore: { getById: mocks.getById } }))
vi.mock('../../storage/projectStore', () => ({
  projectStore: { loadState: async () => {}, getHandle: () => undefined }
}))
vi.mock('../../storage/settingsStore', () => ({ settingsStore: {} }))
vi.mock('../../storage/sessionEntryStore', () => ({ ensureSessionTree: vi.fn() }))
vi.mock('../../storage/opfsWorkspace', () => ({
  getTempWorkspaceHandle: mocks.getTempWorkspaceHandle
}))
vi.mock('../eventBus', () => ({ eventBus: { emit: mocks.emit, hasListeners: () => true } }))
vi.mock('../mcpRuntime', () => ({
  mcpManager: {
    getEnabledToolNames: mocks.getEnabledToolNames,
    statusByName: mocks.statusByName,
    ensureEnabled: mocks.ensureEnabled,
    getAllAgentTools: mocks.getAllAgentTools
  }
}))
vi.mock('../fileTools', () => ({ createFileTools: mocks.createFileTools }))
vi.mock('../opfsSpillSink', () => ({ createSpillSink: () => ({}) }))
vi.mock('../wrapToolOutput', () => ({ wrapToolsOutput: (tools: unknown[]) => [...tools] }))
vi.mock('../securityProvider', () => ({ createExtensionSecurityContext: () => ({}) }))
vi.mock('../resolveSessionModel', () => ({ resolveSessionModel: vi.fn(), capsFor: () => ({}) }))
vi.mock('../instructionFilesRuntime', () => ({ resolveInstructionForSession: vi.fn() }))
// subAgent 反向 import agentHost —— 顶掉它才不会在加载期绕回来
vi.mock('../subAgent', () => ({
  getSessionTools: () => undefined,
  registerSessionTools: mocks.registerSessionTools,
  createExtensionDispatchTool: vi.fn()
}))

import { requestUserInputFor } from '../userInputBroker'
import '../agentHost'

const fakeTool = (name: string): AnyAgentTool =>
  ({ name, label: name, description: name, parameters: {}, execute: vi.fn() }) as never

const host = (): AgentHostAdapter => {
  expect(mocks.host.value, 'agentHost 应把适配面交给 createAgentFactory').toBeDefined()
  return mocks.host.value as AgentHostAdapter
}

/** 根会话的一次装配请求（名单里故意留着退役的裸 `browser`） */
const rootRequest = (
  sessionId: string,
  extra: Partial<ToolResolveRequest> = {}
): ToolResolveRequest => ({
  kind: 'root',
  rootSessionId: sessionId,
  selfSessionId: sessionId,
  profile: {} as ToolResolveRequest['profile'],
  systemPrompt: '',
  names: ['ask', 'read', 'browser', 'bash', 'mcp:browser'],
  getModelConfig: () => ({}) as ReturnType<ToolResolveRequest['getModelConfig']>,
  ...extra
})

const namesOf = (tools: readonly AnyAgentTool[]): string[] =>
  tools.map((t) => (t as { name?: string }).name ?? '')

const askReq = (id: string): InputRequest => ({
  id,
  kind: 'ask',
  toolName: 'mcp__browser__open_tab',
  command: 'https://a.example/',
  createdAt: 0
})

beforeAll(async () => {
  await i18next.init({ lng: 'zh', resources: { zh: { translation: zh } } })
})

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === 'function') m.mockReset()
  mocks.getById.mockResolvedValue({ id: 's', projectId: null, settings: {} })
  mocks.getTempWorkspaceHandle.mockResolvedValue({ name: 'scratch' })
  mocks.createFileTools.mockReturnValue([fakeTool('read'), fakeTool('write'), fakeTool('edit')])
  mocks.getEnabledToolNames.mockReturnValue(['mcp:browser', 'mcp:tavily'])
  mocks.statusByName.mockImplementation((name: string) =>
    name === 'tavily' ? 'connected' : 'disconnected'
  )
  mocks.ensureEnabled.mockResolvedValue([
    { name: 'browser', result: { ok: true } },
    { name: 'tavily', result: { ok: true } }
  ])
  mocks.getAllAgentTools.mockReturnValue([
    fakeTool('mcp__browser__click'),
    fakeTool('mcp__tavily__search')
  ])
})

describe('根会话装配：浏览器来自内置 MCP，不再是按名装配的工具', () => {
  it('AHT-1 带会话 id 惰性启动（恰一次）、按根会话身份取工具；MCP 工具进了结果，裸 browser 什么也没装', async () => {
    const tools = await host().resolveTools(rootRequest('s1', { requestUserInput: vi.fn() }))
    expect(mocks.ensureEnabled).toHaveBeenCalledTimes(1)
    expect(mocks.ensureEnabled).toHaveBeenCalledWith({
      timeoutMs: LAZY_CONNECT_TIMEOUT_MS,
      sessionId: 's1'
    })
    expect(mocks.getAllAgentTools).toHaveBeenCalledTimes(1)
    expect(mocks.getAllAgentTools).toHaveBeenCalledWith('s1', { callerId: 's1' })
    expect(namesOf(tools)).toEqual(['ask', 'read', 'mcp__browser__click', 'mcp__tavily__search'])
    expect(namesOf(tools)).not.toContain('browser')
    // 工具池（派生 agent 复用）里也没有它
    const registered = mocks.registerSessionTools.mock.calls[0][1] as AnyAgentTool[]
    expect(mocks.registerSessionTools.mock.calls[0][0]).toBe('s1')
    expect(namesOf(registered)).not.toContain('browser')
    expect(namesOf(registered)).toContain('mcp__browser__click')
  })

  it('AHT-2 这条会话的询问通道被登记：browser 的门按会话 id 能问到它', async () => {
    const channel = vi.fn(
      async (_req: InputRequest): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
    )
    await host().resolveTools(rootRequest('s-ask', { requestUserInput: channel }))
    const req = askReq('tc-1')
    await expect(requestUserInputFor('s-ask', req)).resolves.toEqual({
      kind: 'ask',
      allowed: true
    })
    expect(channel).toHaveBeenCalledWith(req)
  })

  it('AHT-3 运行时没给询问通道：登记的替身以 NO_INTERACTIVE_INPUT 拒绝（门据此 fail-closed）', async () => {
    await host().resolveTools(rootRequest('s-noask'))
    await expect(requestUserInputFor('s-noask', askReq('tc-2'))).rejects.toThrow(
      'NO_INTERACTIVE_INPUT'
    )
  })
})

describe('根会话装配：连接状态推给会话', () => {
  /** eventBus 收到的本会话事件（按到达顺序） */
  const events = (type: string): Array<Record<string, unknown>> =>
    mocks.emit.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((e) => e.type === type)

  it('AHT-4 逐台按（名字, 会话 id）问状态；mcp_connecting 只推还没连上的那台（先 true 后 false）', async () => {
    await host().resolveTools(rootRequest('s1', { requestUserInput: vi.fn() }))
    expect(mocks.statusByName).toHaveBeenCalledWith('browser', 's1')
    expect(mocks.statusByName).toHaveBeenCalledWith('tavily', 's1')
    expect(events('mcp_connecting')).toEqual([
      { type: 'mcp_connecting', sessionId: 's1', server: 'browser', connecting: true },
      { type: 'mcp_connecting', sessionId: 's1', server: 'browser', connecting: false }
    ])
    // 「开始连接」在 ensureEnabled 之前，「连接结束」在它之后
    const [on, off] = mocks.emit.mock.invocationCallOrder.filter(
      (_, i) => (mocks.emit.mock.calls[i][0] as { type: string }).type === 'mcp_connecting'
    )
    expect(on).toBeLessThan(mocks.ensureEnabled.mock.invocationCallOrder[0])
    expect(off).toBeGreaterThan(mocks.ensureEnabled.mock.invocationCallOrder[0])
    expect(events('error')).toEqual([])
  })

  it('AHT-5 连不上的那台落一条 chat.mcpConnectFailed（带名字与原因），装配照常完成', async () => {
    mocks.ensureEnabled.mockResolvedValue([
      { name: 'browser', result: { ok: false, error: 'boom' } },
      { name: 'tavily', result: { ok: true } }
    ])
    const tools = await host().resolveTools(rootRequest('s1', { requestUserInput: vi.fn() }))
    const expected = i18next.t('chat.mcpConnectFailed', { name: 'browser', error: 'boom' })
    expect(expected).toContain('browser')
    expect(expected).toContain('boom')
    expect(events('error')).toEqual([{ type: 'error', sessionId: 's1', error: expected }])
    expect(namesOf(tools)).toContain('ask')
  })
})
