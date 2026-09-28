/**
 * 桌面 `resolveTools` 按平台装配命令工具 —— 内置档案同时列 `bash, powershell`，宿主只装配**这台机器上
 * 存在**的那一个；另一个平台的版本与「未知名」走同一条路：静默跳过、不抛。
 *
 *  - B1 名单同时有 bash 与 powershell：darwin / linux 只装 bash，win32 只装 powershell；
 *  - B2 win32 上名单只点了 bash（用户在 macOS 上写的 agent md 拷过来）：bash 缺位、read 照装、不报错。
 *
 * 同一份装配顺带钉住**安全主体的来源**（AH-S1）：工具工厂拿到的 ctx 带着这个 agent 的档案名与
 * root / spawned（`ctx.agent`），`sessionId` 恒为根会话；L1 门的 `getDesktopSecurityContext` 用的是
 * **同一个** ctx，门面交给包装器。询问点的审查靠这个主体认出「审查员自己在要权限」（防递归）——
 * 所以 permission-reviewer 那一行是这里的主角。
 *
 * 注册表用**真的**（过滤的就是 `isToolOnPlatform` 那一条），往里注册的是桩工厂 —— 真工具模块会
 * 拖进 bgTaskService / toolContext。其余脚手架同 toolOutputSpill：顶掉 `createAgentFactory` 接住
 * agentHost 交出来的适配面，包装器换成恒等桩（顺手记下它收到的 security）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PERMISSION_REVIEWER_PROFILE_NAME,
  type AgentHostAdapter,
  type SubAgentModelConfig,
  type ToolResolveRequest
} from '@shuvix/agent-runtime'
import type { ToolContext } from '../../services/toolContext'

const mocks = vi.hoisted(() => ({
  host: { value: undefined as AgentHostAdapter | undefined },
  /** L1 门的评估门面（AH-S1 让它交回一个哨兵，好认出包装器拿到的是不是它） */
  getDesktopSecurityContext: vi.fn(),
  /** 包装器（恒等桩）每次收到的工具、归属会话与 security */
  wraps: [] as Array<{ tool: object; sessionId: string; security: unknown }>
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
  wrapToolOutput: (
    tool: object,
    sessionId: string,
    _strategy: unknown,
    _overrides: unknown,
    security: unknown
  ) => {
    mocks.wraps.push({ tool, sessionId, security })
    return tool
  }
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
  getDesktopSecurityContext: mocks.getDesktopSecurityContext,
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

describe('resolveTools —— 工具与 L1 门拿到的是同一个 ctx，带着这个 agent 的身份', () => {
  const PROBE = 'ctx-probe'
  /** 桩工厂收到的 ctx（按构造顺序） */
  const seen: ToolContext[] = []
  /** L1 门的门面哨兵：包装器拿到的必须就是它 */
  const SECURITY = { sentinel: 'l1-gate' }

  beforeAll(() => {
    registerBuiltinTool({
      name: PROBE,
      group: 'general',
      getLabel: () => PROBE,
      getHint: () => PROBE,
      factory: (ctx) => {
        seen.push(ctx)
        return { name: PROBE }
      }
    })
  })

  afterAll(() => unregisterBuiltinTool(PROBE))

  beforeEach(() => {
    seen.length = 0
    mocks.wraps.length = 0
    mocks.getDesktopSecurityContext.mockReset()
    mocks.getDesktopSecurityContext.mockReturnValue(SECURITY)
  })

  it.each([
    ['spawned', PERMISSION_REVIEWER_PROFILE_NAME, 'agent-child-1'],
    ['root', 'work', 'sess-subject-root']
  ] as const)(
    'AH-S1 %s（%s）：ctx.agent = {档案名, kind}、sessionId 恒为根会话；getDesktopSecurityContext 用同一个 ctx，门面交给每个包装器',
    async (kind, profileName, selfSessionId) => {
      const rootSessionId = 'sess-subject-root'
      const getModelConfig = (): SubAgentModelConfig => ({
        provider: 'p',
        model: 'm',
        capabilities: {}
      })
      const requestUserInput = vi.fn()
      // 审查员唯一的工具是结果契约附带的 next（extraTools）：它过的也得是同一道门
      const next = { name: 'next' }

      const host = mocks.host.value
      expect(host, 'agentHost 应把适配面交给 createAgentFactory').toBeDefined()
      await host!.resolveTools({
        kind,
        rootSessionId,
        selfSessionId,
        profile: { name: profileName } as ToolResolveRequest['profile'],
        names: [PROBE],
        getModelConfig,
        requestUserInput,
        extraTools: [next] as unknown as ToolResolveRequest['extraTools']
      })

      expect(seen).toHaveLength(1)
      const [ctx] = seen
      // 派生 agent 的工具 ctx 也挂在根会话上（会话授权因此对它同样生效），身份则是它自己的
      expect(ctx.sessionId).toBe(rootSessionId)
      expect(ctx.agent).toStrictEqual({ profileName, kind, getModelConfig })
      expect(ctx.requestUserInput).toBe(requestUserInput)

      // L1 门的主体就是从这个 ctx 来的 —— 同一个对象，而不是另造一份丢了 agent 的
      expect(mocks.getDesktopSecurityContext).toHaveBeenCalledTimes(1)
      expect(mocks.getDesktopSecurityContext.mock.calls[0][0]).toBe(ctx)
      expect(mocks.wraps).toEqual([
        { tool: { name: PROBE }, sessionId: rootSessionId, security: SECURITY },
        { tool: next, sessionId: rootSessionId, security: SECURITY }
      ])
      for (const wrap of mocks.wraps) expect(wrap.security).toBe(SECURITY)
    }
  )
})
