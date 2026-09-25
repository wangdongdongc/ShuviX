/**
 * 桌面 `resolveTools` 按平台装配命令工具 —— 内置档案同时列 `bash, powershell`，宿主只装配**这台机器上
 * 存在**的那一个；另一个平台的版本与「未知名」走同一条路：静默跳过、不抛。
 *
 *  - B1 名单同时有 bash 与 powershell：darwin / linux 只装 bash，win32 只装 powershell；
 *  - B2 win32 上名单只点了 bash（用户在 macOS 上写的 agent md 拷过来）：bash 缺位、read 照装、不报错。
 *
 * 注册表用**真的**（过滤的就是 `isToolOnPlatform` 那一条），往里注册的是桩工厂 —— 真工具模块会
 * 拖进 bgTaskService / toolContext。其余脚手架同 toolOutputSpill：顶掉 `createAgentFactory` 接住
 * agentHost 交出来的适配面，包装器换成恒等桩。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentHostAdapter, ToolResolveRequest } from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  host: { value: undefined as AgentHostAdapter | undefined }
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

vi.mock('../../services/wrapToolOutput', () => ({
  getOutputStrategy: () => 'middle',
  wrapToolOutput: (tool: object) => tool
}))
vi.mock('../../services/mcpService', () => ({
  mcpService: {
    statusByName: () => 'disconnected',
    ensureServerByName: async () => ({ ok: true }),
    getAgentToolsByServerName: () => []
  }
}))
vi.mock('../../services/skillTool', () => ({
  SkillTool: class {
    readonly name = 'skill'
    get hasSkills(): boolean {
      return false
    }
  }
}))
vi.mock('../../services/skillService', () => ({ skillService: { findEnabled: () => [] } }))
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
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: vi.fn() } }))
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

import { registerBuiltinTool, unregisterBuiltinTool } from '../../services/toolRegistry'
import { BASH_PLATFORMS, POWERSHELL_PLATFORMS } from '../../utils/toolUtils/shell'
import type { ToolPlatform } from '@shuvix/chat-protocol/chatApi'
import '../agentHost'

const SID = 'sess-platform-tools'

/** 桩注册项：平台声明与真工具一致，工厂只交出一个带名字的对象 */
const STUBS: { name: string; platforms?: readonly ToolPlatform[] }[] = [
  { name: 'read' },
  { name: 'bash', platforms: BASH_PLATFORMS },
  { name: 'powershell', platforms: POWERSHELL_PLATFORMS }
]

const REAL_PLATFORM_DESC = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM_DESC, value: platform })
}

beforeAll(() => {
  for (const stub of STUBS) {
    registerBuiltinTool({
      name: stub.name,
      group: 'general',
      platforms: stub.platforms,
      getLabel: () => stub.name,
      getHint: () => stub.name,
      factory: () => ({ name: stub.name })
    })
  }
})

afterAll(() => {
  for (const stub of STUBS) unregisterBuiltinTool(stub.name)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', REAL_PLATFORM_DESC)
})

/** 按名单解析一次，交回装配出来的工具名（名单序） */
async function resolveNames(names: string[]): Promise<string[]> {
  const host = mocks.host.value
  expect(host, 'agentHost 应把适配面交给 createAgentFactory').toBeDefined()
  const tools = await host!.resolveTools({
    kind: 'root',
    rootSessionId: SID,
    selfSessionId: SID,
    profile: { name: 'work' } as ToolResolveRequest['profile'],
    names,
    getModelConfig: () =>
      ({ provider: 'p', model: 'm', capabilities: {} }) as ReturnType<
        ToolResolveRequest['getModelConfig']
      >
  })
  return tools.map((tool) => (tool as { name: string }).name)
}

describe('resolveTools —— 命令工具按平台二选一', () => {
  it.each(['darwin', 'linux'])(
    'B1 — %s：名单里 bash 与 powershell 都有 → 只装 bash，不抛',
    async (platform) => {
      setPlatform(platform)
      const names = await resolveNames(['read', 'bash', 'powershell'])
      expect(names).toEqual(['read', 'bash'])
    }
  )

  it('B1 — win32：名单里 bash 与 powershell 都有 → 只装 powershell，不抛', async () => {
    setPlatform('win32')
    const names = await resolveNames(['read', 'bash', 'powershell'])
    expect(names).toEqual(['read', 'powershell'])
  })

  it('B1 — 名单里两者的先后不影响结果：装配出来的那一个留在它自己在名单里的位置', async () => {
    setPlatform('win32')
    expect(await resolveNames(['powershell', 'read', 'bash'])).toEqual(['powershell', 'read'])
    setPlatform('darwin')
    expect(await resolveNames(['powershell', 'read', 'bash'])).toEqual(['read', 'bash'])
  })

  it('B2 — win32 上名单只点了 bash（另一台机器写的 agent md）与一个不存在的名字 → 只剩 read，不报错', async () => {
    setPlatform('win32')
    await expect(resolveNames(['read', 'bash', 'nonexistent'])).resolves.toEqual(['read'])
  })
})
