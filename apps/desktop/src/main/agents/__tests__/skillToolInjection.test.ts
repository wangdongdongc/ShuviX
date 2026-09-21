/**
 * STI —— SkillTool 的**注入点**（桌面 `resolveTools`）：什么时候把 `skill` 挂上工具表，
 * 以及挂的时候交给 SkillTool 的是哪一份参数。
 *
 * 规则只有一条，root / spawned 相同：归一名单里点了名的 `skill:<name>`（档案声明的 —— 含内置的
 * `skill:builtin:drawing` —— 与会话勾选的一视同仁）去掉前缀、按名单顺序交给 SkillTool；名单里一个
 * `skill:` 都没有就**根本不构造**；构造了但这一次没有可给的（`hasSkills=false`）就不挂。宿主不在
 * 名单之外另挂工具 —— `shuvix-tools` 加上会话勾选就是 agent 工具表的完整列举。
 *
 * 分工：货架本身（谁进索引、按名加载给不给）在 `services/__tests__/skillToolShelf.test.ts`；
 * 这里只钉注入点自己的判断 —— **挂不挂**与**交给 SkillTool 的参数**（永远两个：名单 + 项目路径）。
 *
 * ⚠️ **mock 陷阱**：隔壁 promptVarsWiring.test.ts 里那句
 * `vi.mock('../../services/skillTool', () => ({ SkillTool: class {} }))` 会让 `hasSkills`
 * 恒为 `undefined`（falsy），于是工具**永不注入** —— 照抄过来这一组会全绿且什么都没测。
 * 这里的桩必须自带可控的 `hasSkills`。
 *
 * agentHost 现在 import 了 skillService（变量表判断作图技能在不在架）：不桩它，真服务的构造函数
 * 会去碰真实 HOME 下的 `~/.shuvix/skills`。
 *
 * 取 host 适配面的办法同 promptVarsWiring：顶掉 `createAgentFactory`，把 agentHost 传进去的
 * 那个对象接住。其余 mock 只为让模块能加载。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentHostAdapter, ToolResolveRequest } from '@shuvix/agent-runtime'

interface SkillToolCall {
  names: string[]
  projectPath?: string
  /** 构造时实际传了几个参数 —— 第三个参数（includeBuiltin）已随「内置恒在架」的特例一起删掉 */
  argc: number
}

const mocks = vi.hoisted(() => ({
  host: { value: undefined as AgentHostAdapter | undefined },
  skillToolCalls: [] as SkillToolCall[],
  hasSkills: true,
  builtinNames: [] as string[],
  findEnabled: vi.fn(),
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
    constructor(...args: unknown[]) {
      mocks.skillToolCalls.push({
        names: args[0] as string[],
        projectPath: args[1] as string | undefined,
        argc: args.length
      })
    }
    get hasSkills(): boolean {
      return mocks.hasSkills
    }
  }
}))

/** 注入点本身不读技能目录（那是 SkillTool 的事）；桩在这里是为了不让真服务碰真实 HOME */
vi.mock('../../services/skillService', () => ({
  skillService: { findEnabled: mocks.findEnabled }
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
const DRAWING = 'skill:builtin:drawing'

/** bot 基座那份刻意很窄的工具名单（见 STI-6）—— 它自己点了作图技能的名 */
const BOT_TOOLS = buildBuiltinProfiles({
  language: 'en',
  widgetsRoot: '/w/widgets',
  readMd: createInlineMdReader()
}).find((p) => p.name === 'bot')!.tools

/** 名单里「不带前缀」的那部分 —— 内置工具名与派发 opt-in（mcp:/skill: 不是注册表里的工具） */
const unprefixed = (names: readonly string[]): string[] =>
  names.filter((n) => !n.startsWith('mcp:') && !n.startsWith('skill:'))

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
  mocks.findEnabled.mockReset()
  mocks.findEnabled.mockReturnValue([])
  // 缺省：会话不属于任何项目
  mocks.pick.mockReturnValue(undefined)
  mocks.pickSettings.mockReturnValue(undefined)
  mocks.projectPick.mockReturnValue(undefined)
})

describe('STI 根会话', () => {
  it('STI-1 名单里一个 `skill:` 都没有 → 根本不构造 SkillTool，工具表里也没有 skill', async () => {
    // 内置技能没有「root 恒在架」的特例了：档案不点名，这个 agent 就没有技能货架
    const names = await resolveToolNames({ kind: 'root', names: [] })
    expect(names).not.toContain('skill')
    expect(mocks.skillToolCalls).toEqual([])
  })

  it('STI-2 点了内置的名、但这一次真的没有技能可给（hasSkills=false）→ 构造一次，不挂', async () => {
    mocks.hasSkills = false
    mocks.builtinNames = ['read']
    const names = await resolveToolNames({ kind: 'root', names: ['read', DRAWING] })
    expect(names).not.toContain('skill')
    // 仍然构造过一次 —— 「有没有可给的」只有构造完才知道（例如内置技能在侧栏被停用了）
    expect(mocks.skillToolCalls).toHaveLength(1)
    expect(mocks.skillToolCalls[0].names).toEqual(['builtin:drawing'])
  })

  it('STI-3 带项目的根会话：名单去掉前缀、projectPath 传下去，恰好两个参数', async () => {
    mocks.pick.mockReturnValue({ projectId: 'proj-1' })
    mocks.projectPick.mockReturnValue({ name: 'Proj', path: '/w/proj' })
    await resolveToolNames({ kind: 'root', names: [DRAWING] })
    expect(mocks.skillToolCalls).toEqual([
      { names: ['builtin:drawing'], projectPath: '/w/proj', argc: 2 }
    ])
  })

  it('STI-7 名单里两个 skill → 只构造一次，两个名字按名单顺序交过去', async () => {
    const names = await resolveToolNames({ kind: 'root', names: [DRAWING, 'skill:foo'] })
    expect(mocks.skillToolCalls).toHaveLength(1)
    expect(mocks.skillToolCalls[0].names).toEqual(['builtin:drawing', 'foo'])
    expect(names.filter((n) => n === 'skill')).toHaveLength(1)
  })
})

describe('STI 派生 agent', () => {
  it('STI-4 没点名任何 `skill:` → 根本不构造 SkillTool，工具表里也没有 skill', async () => {
    // 这条同时是 titler / knowledge-writer 不会被塞进作图工具的守护：它们的档案没点这个名。
    const names = await resolveToolNames({ kind: 'spawned', selfSessionId: 'agent-1', names: [] })
    expect(names).not.toContain('skill')
    expect(mocks.skillToolCalls).toEqual([])
  })

  it('STI-5 点名了 `skill:foo` → 挂上，只拿它点的那个，内置不顺带加进来', async () => {
    const names = await resolveToolNames({
      kind: 'spawned',
      selfSessionId: 'agent-1',
      names: ['skill:foo']
    })
    expect(names).toContain('skill')
    expect(mocks.skillToolCalls).toEqual([{ names: ['foo'], projectPath: undefined, argc: 2 }])
    expect(mocks.skillToolCalls[0].names).not.toContain('builtin:drawing')
  })

  it('STI-5b 派生档案同时点了内置与用户 skill → 一次构造拿到两者，工具表里恰好一个 skill', async () => {
    // 与 root 同一条规则：派发出来的 coding 点了作图技能的名，它就有这本手艺
    const list = ['read', DRAWING, 'skill:foo']
    mocks.builtinNames = unprefixed(list)
    const names = await resolveToolNames({
      kind: 'spawned',
      selfSessionId: 'agent-1',
      names: list
    })
    expect(mocks.skillToolCalls).toHaveLength(1)
    expect(mocks.skillToolCalls[0].names).toEqual(['builtin:drawing', 'foo'])
    expect(names.filter((n) => n === 'skill')).toHaveLength(1)
    expect(names).toEqual(['read', 'skill'])
  })
})

describe('STI 名单即全部：宿主不在名单之外另挂工具', () => {
  it('STI-6 bot 基座的窄名单点了作图技能 → 挂上 skill，SkillTool 只拿到 builtin:drawing；工具表恰为名单的投影', async () => {
    expect(BOT_TOOLS, 'bot 基座的名单里点了作图技能').toContain(DRAWING)
    expect(BOT_TOOLS, 'bot 基座的名单里本来就不该有 skill 这个工具名').not.toContain('skill')
    // agent 由派发工具那条路注入（桩出来的 createAgentTool），不走注册表
    mocks.builtinNames = unprefixed(BOT_TOOLS).filter((n) => n !== 'agent')

    const names = await resolveToolNames({
      kind: 'root',
      profile: { name: 'bot' } as ToolResolveRequest['profile'],
      names: BOT_TOOLS
    })
    expect(names).toContain('skill')
    expect(mocks.skillToolCalls).toHaveLength(1)
    expect(mocks.skillToolCalls[0].names).toEqual(['builtin:drawing'])
    // 名单本身照常生效：白名单外的工具不会因此冒出来，skill 也是名单点名换来的
    expect([...names].sort()).toEqual([...unprefixed(BOT_TOOLS), 'skill'].sort())
  })

  it('STI-6b 同一份 bot 名单去掉作图技能 → 没有 skill，SkillTool 一次都没构造', async () => {
    // 以前 root 恒挂 SkillTool（不看档案）—— 那个例外已经删了：不点名就没有
    const withoutDrawing = BOT_TOOLS.filter((n) => n !== DRAWING)
    mocks.builtinNames = unprefixed(withoutDrawing).filter((n) => n !== 'agent')

    const names = await resolveToolNames({
      kind: 'root',
      profile: { name: 'bot' } as ToolResolveRequest['profile'],
      names: withoutDrawing
    })
    expect(names).not.toContain('skill')
    expect(mocks.skillToolCalls).toEqual([])
    expect([...names].sort()).toEqual([...unprefixed(withoutDrawing)].sort())
  })
})
