/**
 * MTI —— MCP 工具的**注入点**（桌面 `resolveTools`）：`mcp:<server>` 连哪份实例、从哪份实例取工具，
 * 以及取的时候报上的调用方是谁。
 *
 * 两个 id 各有各的用处，不能互换：
 *  - **实例按根会话取**（`ensureServerByName` 的 sessionId、`getAgentToolsByServerName` 的第二参
 *    都是 rootSessionId）：内置能力服务器按会话实例化，派生 agent 与根 agent 共用同一份
 *    （ssh 的 control socket、浏览器的 tab 都是会话级的）；
 *  - **调用方按这一个 agent 报**（`callerId` = selfSessionId）：一份实例由根 agent 与它派出的
 *    agent 共用，实例里按调用方分开的状态（浏览器「距上次快照几次操作」、快照差异的基线）只能靠它。
 * 传反了不报错、工具照样能用 —— 只是派生 agent 会拿根 agent 的快照基线做差异，或者干脆连到一份
 * 以 agentId 为「会话」的孤儿实例上。所以钉在注入点这一层。
 *
 * 脚手架同 skillToolInjection.test.ts：顶掉 `createAgentFactory`，把 agentHost 传进去的适配面接住；
 * 其余 mock 只为让模块能加载（dao 会开 SQLite，electron 在 node 下起不来）。mcpService 桩成三个
 * 可观察的函数，包装器走恒等 —— 于是工具表里拿到的就是桩返回的那个对象本身。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentHostAdapter, ToolResolveRequest } from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  host: { value: undefined as AgentHostAdapter | undefined },
  statusByName: vi.fn(),
  ensureServerByName: vi.fn(),
  getAgentToolsByServerName: vi.fn(),
  broadcast: vi.fn()
}))

vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  return {
    ...actual,
    createAgentFactory: (host: AgentHostAdapter) => {
      mocks.host.value = host
      return { createAgent: vi.fn() }
    }
  }
})

vi.mock('../../services/mcpService', () => ({
  mcpService: {
    statusByName: mocks.statusByName,
    ensureServerByName: mocks.ensureServerByName,
    getAgentToolsByServerName: mocks.getAgentToolsByServerName
  }
}))

/** 名单里没有 `skill:`，SkillTool 不会被构造；桩在这里只为不加载真模块 */
vi.mock('../../services/skillTool', () => ({ SkillTool: class {} }))
vi.mock('../../services/skillService', () => ({ skillService: { findEnabled: () => [] } }))
vi.mock('../../services/toolRegistry', () => ({ getBuiltinToolEntries: () => [] }))
/** 包装器走恒等：工具表里的就是 getAgentToolsByServerName 返回的对象本身 */
vi.mock('../../services/wrapToolOutput', () => ({
  wrapToolOutput: (tool: object) => tool,
  getOutputStrategy: () => 'middle'
}))
vi.mock('../AgentTool', () => ({ createAgentTool: () => ({ name: 'agent' }) }))

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9', getPath: () => '/tmp/x' } }))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pick: () => undefined, pickSettings: () => undefined }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: { findAllEnabledModels: () => [] } }))
vi.mock('../../services/agentModelResolver', () => ({ resolveModel: vi.fn() }))
vi.mock('../../services/providerOAuthService', () => ({ providerOAuthService: {} }))
vi.mock('../../services/sessionStorage', () => ({ ensureSessionTree: vi.fn() }))
vi.mock('../../services/instruction', () => ({ resolveInstructionContent: vi.fn() }))
vi.mock('../../services/memory', () => ({ resolveProjectMemoryIndex: vi.fn() }))
vi.mock('../../services/httpLogService', () => ({ httpLogService: {} }))
vi.mock('../../services/llmNetwork', () => ({ llmNetwork: {} }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: mocks.broadcast } }))
vi.mock('../../services/agentRuntimeAdapters', () => ({
  electronEventSink: {},
  electronToolResultTransform: vi.fn(),
  runtimeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: vi.fn(),
  resolveProjectConfig: vi.fn()
}))
vi.mock('../../services/knowledge', () => ({ enabledBaseChoices: () => [] }))
vi.mock('@earendil-works/pi-agent-core/node', () => ({ NodeExecutionEnv: class {} }))

import { LAZY_CONNECT_TIMEOUT_MS } from '@shuvix/agent-runtime'
import '../agentHost'

/** 桩 server 交出来的那一个工具 —— 断言它原样出现在工具表里 */
const SSH_TOOL = { name: 'mcp__ssh__exec' }

const resolveTools = async (over: Partial<ToolResolveRequest>): Promise<unknown[]> => {
  const host = mocks.host.value
  expect(host, 'agentHost 应把适配面交给 createAgentFactory').toBeDefined()
  return host!.resolveTools({
    kind: 'root',
    rootSessionId: 'sess-1',
    selfSessionId: 'sess-1',
    profile: { name: 'work' } as ToolResolveRequest['profile'],
    systemPrompt: '',
    names: ['mcp:ssh'],
    getModelConfig: () =>
      ({ provider: 'p', model: 'm', capabilities: {} }) as ReturnType<
        ToolResolveRequest['getModelConfig']
      >,
    ...over
  })
}

beforeEach(() => {
  mocks.statusByName.mockReset()
  mocks.statusByName.mockReturnValue('disconnected')
  mocks.ensureServerByName.mockReset()
  mocks.ensureServerByName.mockResolvedValue({ ok: true })
  mocks.getAgentToolsByServerName.mockReset()
  mocks.getAgentToolsByServerName.mockReturnValue([SSH_TOOL])
  mocks.broadcast.mockReset()
})

describe('MTI mcp:<server> 的实例与调用方', () => {
  it('MTI-1 派生 agent：连接与取工具都按根会话，调用方报的是它自己的 agentId', async () => {
    const tools = await resolveTools({
      kind: 'spawned',
      rootSessionId: 'sess-1',
      selfSessionId: 'agent-7',
      names: ['mcp:ssh']
    })

    // 实例归根会话：派生 agent 与根 agent 共用同一份，而不是以 agentId 另起一份
    expect(mocks.ensureServerByName.mock.calls).toStrictEqual([
      ['ssh', { timeoutMs: LAZY_CONNECT_TIMEOUT_MS, sessionId: 'sess-1' }]
    ])
    // 取工具：实例仍按根会话找，调用方按这一个 agent 报
    expect(mocks.getAgentToolsByServerName.mock.calls).toStrictEqual([
      ['ssh', 'sess-1', { callerId: 'agent-7' }]
    ])
    expect(tools).toContain(SSH_TOOL)
  })

  it('MTI-2 根 agent：调用方就是会话 id 本身', async () => {
    const tools = await resolveTools({
      kind: 'root',
      rootSessionId: 'sess-1',
      selfSessionId: 'sess-1',
      names: ['mcp:ssh']
    })

    expect(mocks.ensureServerByName.mock.calls).toStrictEqual([
      ['ssh', { timeoutMs: LAZY_CONNECT_TIMEOUT_MS, sessionId: 'sess-1' }]
    ])
    expect(mocks.getAgentToolsByServerName.mock.calls).toStrictEqual([
      ['ssh', 'sess-1', { callerId: 'sess-1' }]
    ])
    expect(tools).toContain(SSH_TOOL)
  })
})
