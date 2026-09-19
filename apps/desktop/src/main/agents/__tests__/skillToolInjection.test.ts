/**
 * STI —— SkillTool 的**注入点**（桌面 `resolveTools`）：什么时候把 `skill` 挂上工具表，
 * 以及挂的时候交给 SkillTool 的是哪一份参数。
 *
 * 分工：货架本身（谁进索引、按名加载给不给）在 `services/__tests__/skillToolShelf.test.ts`；
 * 这里只钉注入点自己的两个判断 —— **挂不挂**（`kind` + `hasSkills`）与 **includeBuiltin 给谁**。
 * 「includeBuiltin=false 时索引里真的没有内置」是货架那边的 STS-6，不在这里重复。
 *
 * ⚠️ **mock 陷阱**：隔壁 promptVarsWiring.test.ts 里那句
 * `vi.mock('../../services/skillTool', () => ({ SkillTool: class {} }))` 会让 `hasSkills`
 * 恒为 `undefined`（falsy），于是工具**永不注入** —— 照抄过来这一组会全绿且什么都没测。
 * 这里的桩必须自带可控的 `hasSkills`。
 *
 * 取 host 适配面的办法同 promptVarsWiring：顶掉 `createAgentFactory`，把 agentHost 传进去的
 * 那个对象接住。其余 mock 只为让模块能加载。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentHostAdapter, ToolResolveRequest } from '@shuvix/agent-runtime'

interface SkillToolCall {
  names: string[]
  projectPath?: string
  options?: { includeBuiltin?: boolean }
}

const mocks = vi.hoisted(() => ({
  host: { value: undefined as AgentHostAdapter | undefined },
  skillToolCalls: [] as SkillToolCall[],
  hasSkills: true,
  builtinNames: [] as string[],
  pick: vi.fn(),
  pickSettings: vi.fn(),
  projectPick: vi.fn()
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

/** 可控的 SkillTool 桩：记下这一次装配收到的参数，`hasSkills` 由用例决定 */
vi.mock('../../services/skillTool', () => ({
  SkillTool: class {
    readonly name = 'skill'
    readonly label = 'skill'
    readonly description = 'stub'
    constructor(names: string[], projectPath?: string, options?: { includeBuiltin?: boolean }) {
      mocks.skillToolCalls.push({ names, projectPath, options })
    }
    get hasSkills(): boolean {
      return mocks.hasSkills
    }
  }
}))

/** 名单里的内置工具都造得出来，这样工具表里的名字就是 `names` 的投影 */
vi.mock('../../services/toolRegistry', () => ({
  getBuiltinToolEntries: () =>
    mocks.builtinNames.map((name) => ({
      name,
      group: 'general' as const,
      getLabel: () => name,
      getHint: () => name,
      factory: () => ({ name })
    }))
}))

/** 包装器走恒等：本组只关心工具表里有哪些名字 */
vi.mock('../../services/wrapToolOutput', () => ({
  wrapToolOutput: (tool: object) => tool,
  getOutputStrategy: () => 'middle'
}))
vi.mock('../AgentTool', () => ({ createAgentTool: () => ({ name: 'agent' }) }))

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9', getPath: () => '/tmp/x' } }))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pick: mocks.pick, pickSettings: mocks.pickSettings }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: { findAllEnabledModels: () => [] } }))
vi.mock('../../services/mcpService', () => ({ mcpService: {} }))
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

import { buildBuiltinProfiles } from '@shuvix/agent-runtime'
import { createInlineMdReader } from '@shuvix/agent-runtime/builtinAgents/inlineSources'
import '../agentHost'

const SID = 'sess-skill-injection'

/** bot 基座那份刻意很窄的工具名单（见 STI-5） */
const BOT_TOOLS = buildBuiltinProfiles({
  language: 'en',
  widgetsRoot: '/w/widgets',
  readMd: createInlineMdReader()
}).find((p) => p.name === 'bot')!.tools

const resolveToolNames = async (over: Partial<ToolResolveRequest> = {}): Promise<string[]> => {
  const host = mocks.host.value
  expect(host, 'agentHost 应把适配面交给 createAgentFactory').toBeDefined()
  const tools = await host!.resolveTools({
    kind: 'root',
    rootSessionId: SID,
    selfSessionId: SID,
    profile: { name: 'work' } as ToolResolveRequest['profile'],
    systemPrompt: '',
    names: [],
    getModelConfig: () =>
      ({ provider: 'p', model: 'm', capabilities: {} }) as ReturnType<
        ToolResolveRequest['getModelConfig']
      >,
    ...over
  })
  return tools.map((tool) => (tool as { name?: string }).name ?? '<anonymous>')
}

beforeEach(() => {
  mocks.skillToolCalls.length = 0
  mocks.hasSkills = true
  mocks.builtinNames = []
  // 缺省：会话不属于任何项目
  mocks.pick.mockReturnValue(undefined)
  mocks.pickSettings.mockReturnValue(undefined)
  mocks.projectPick.mockReturnValue(undefined)
})

describe('STI 根会话', () => {
  it('STI-1 没有任何 `skill:` 勾选、也没有项目 → 仍然挂上 skill，且 includeBuiltin=true', async () => {
    // 本轮的核心：内置技能无条件在架，于是无项目的 chat 会话也够得到作图手艺。
    const names = await resolveToolNames({ kind: 'root', names: [] })
    expect(names).toContain('skill')
    expect(mocks.skillToolCalls).toEqual([
      { names: [], projectPath: undefined, options: { includeBuiltin: true } }
    ])
  })

  it('STI-2 这一次真的没有技能可给（hasSkills=false）→ 不挂（空手的工具是噪音）', async () => {
    mocks.hasSkills = false
    const names = await resolveToolNames({ kind: 'root', names: [] })
    expect(names).not.toContain('skill')
    // 仍然构造过一次 —— 「有没有可给的」只有构造完才知道
    expect(mocks.skillToolCalls).toHaveLength(1)
  })

  it('STI-3 带项目的根会话把 projectPath 传下去（项目级 .claude/skills 因此可见）', async () => {
    mocks.pick.mockReturnValue({ projectId: 'proj-1' })
    mocks.projectPick.mockReturnValue({ name: 'Proj', path: '/w/proj' })
    await resolveToolNames({ kind: 'root', names: [] })
    expect(mocks.skillToolCalls[0].projectPath).toBe('/w/proj')
  })
})

describe('STI 派生 agent', () => {
  it('STI-4 没点名任何 `skill:` → 根本不构造 SkillTool，工具表里也没有 skill', async () => {
    // 这条同时是 titler / knowledge-writer 不会被塞进作图工具的守护：只有 root 的散文是
    // 用户直接读到的，派生 agent 的产出要经父会话转述。
    const names = await resolveToolNames({ kind: 'spawned', selfSessionId: 'agent-1', names: [] })
    expect(names).not.toContain('skill')
    expect(mocks.skillToolCalls).toEqual([])
  })

  it('STI-5 点名了 `skill:foo` → 挂上，但只拿它点的那个，不顺带收下整架内置', async () => {
    const names = await resolveToolNames({
      kind: 'spawned',
      selfSessionId: 'agent-1',
      names: ['skill:foo']
    })
    expect(names).toContain('skill')
    expect(mocks.skillToolCalls).toEqual([
      { names: ['foo'], projectPath: undefined, options: { includeBuiltin: false } }
    ])
  })
})

describe('STI 一个刻意的例外', () => {
  it('STI-6 **故意如此**：root 恒挂 SkillTool，不看档案的 shuvix-tools 白名单', async () => {
    // 这是产品决定 —— 内置技能不是「扩展」，它随包发布、只读、不引入任何新能力（注入的
    // 只有文本），所以不走 `enabledTools` 那道门，也不走档案白名单那道门。
    //
    // 代价要说清楚：`createAgent.ts` 的 normalizeToolNames 注释写着「bot 基座的窄名单因此是
    // 结构保证」，那句话**现在被注入点从旁边绕过去了** —— bot 的名单里没有 `skill`，工具表里
    // 却有一个。下一个人读那条注释时它已经不成立，所以这条用例把它钉成白纸黑字，而不是让它
    // 在某次「修 bug」里被悄悄抹平。
    mocks.builtinNames = BOT_TOOLS.filter((n) => n !== 'agent')
    expect(BOT_TOOLS, 'bot 基座的名单里本来就不该有 skill').not.toContain('skill')

    const names = await resolveToolNames({
      kind: 'root',
      profile: { name: 'bot' } as ToolResolveRequest['profile'],
      names: BOT_TOOLS
    })
    expect(names).toContain('skill')
    expect(mocks.skillToolCalls[0].options).toEqual({ includeBuiltin: true })
    // 名单本身照常生效：白名单外的工具不会因此冒出来
    expect(names.filter((n) => n !== 'skill').sort()).toEqual([...BOT_TOOLS].sort())
  })
})
