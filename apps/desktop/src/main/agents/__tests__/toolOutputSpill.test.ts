/**
 * AHS —— 「超长输出落不落盘」这个判断的**做出点**（桌面 `resolveTools`）。
 *
 * 规则一句话：落盘之后给模型的是「全文在这个路径，用 read 取回来」——**手里没有 read 的 agent
 * 取不回来**，那句指引就是死路，它还白白少拿了正文（预览只有 200 行 / 10KB，而内存截断能给到
 * 2000 行 / 50KB）。所以判断按**这一个 agent 自己的工具名单**做：名单里有 `read` 才落盘。
 *
 * 三件事容易在改动里悄悄丢掉，因此单独钉：
 *  - 判断按**各自的**名单做，不是按根会话做 —— 根 agent 有 read、它派出去的 titler 没有；
 *  - 名单里每一个工具都带上同一个答案（内置、MCP、skill、派发工具 `agent`、派发结果契约的
 *    extraTools 一个都不能漏）；
 *  - 工具自带的 `outputMaxBytes` / `outputMaxLines` 与这个开关同时存在，不互相顶掉；
 *  - 截断**策略**也是一工具一答案：交给包装器的是这个工具自己声明的那一个，不是一张表一个值
 *    （策略从声明走到「模型最后看到的文字」那一段在 tools/__tests__/toolOutputStrategy.test.ts）。
 *
 * 脚手架同 mcpToolInjection / skillToolInjection：顶掉 `createAgentFactory` 把 agentHost 交出来的
 * 适配面接住，包装器换成只记账的桩（于是能看见每一次包装收到的参数）。工具名单取**真的**内置档案。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentHostAdapter, ToolResolveRequest } from '@shuvix/agent-runtime'

/** 一次包装收到的参数 —— spill 就在 overrides 里 */
interface WrapCall {
  name: string
  sessionId: string
  strategy: string
  overrides?: { maxBytes?: number; maxLines?: number; spill?: boolean }
}

const mocks = vi.hoisted(() => ({
  host: { value: undefined as AgentHostAdapter | undefined },
  wrapCalls: [] as WrapCall[],
  /** 注册表里造得出来的内置工具名 */
  builtinNames: [] as string[],
  /** 某个内置工具身上额外挂的字段（outputMaxBytes / outputMaxLines） */
  builtinExtra: {} as Record<string, Record<string, unknown>>,
  /** `mcp:<server>` 交出来的工具 */
  mcpTools: [] as { name: string }[]
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

/**
 * 包装器换成记账的恒等桩：工具表里的还是原对象，但每一次包装的参数都留下了。
 * `getOutputStrategy` 用**真的**那一个（AHS-7 要看的正是「每个工具自己的声明有没有送到这里」，
 * 桩成恒定值会让 strategy 那一栏什么也不说）——真模块经 `../paths` 摸 electron.app.getPath，
 * 本文件下面已把 electron mock 掉。
 */
vi.mock('../../services/wrapToolOutput', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/wrapToolOutput')>()
  return {
    getOutputStrategy: actual.getOutputStrategy,
    wrapToolOutput: (
      tool: object,
      sessionId: string,
      strategy: string,
      overrides?: WrapCall['overrides']
    ) => {
      mocks.wrapCalls.push({
        name: (tool as { name?: string }).name ?? '<anonymous>',
        sessionId,
        strategy,
        overrides
      })
      return tool
    }
  }
})

vi.mock('../../services/toolRegistry', () => ({
  getBuiltinToolEntries: () =>
    mocks.builtinNames.map((name) => ({
      name,
      group: 'general' as const,
      getLabel: () => name,
      getHint: () => name,
      factory: () => ({ name, ...(mocks.builtinExtra[name] ?? {}) })
    }))
}))

vi.mock('../../services/mcpService', () => ({
  mcpService: {
    statusByName: () => 'disconnected',
    ensureServerByName: async () => ({ ok: true }),
    getAgentToolsByServerName: () => mocks.mcpTools
  }
}))

/** 名单里点了 `skill:` 就该上架 —— 桩自带 hasSkills，否则工具永不注入（见 STI 的 mock 陷阱） */
vi.mock('../../services/skillTool', () => ({
  SkillTool: class {
    readonly name = 'skill'
    readonly label = 'skill'
    readonly description = 'stub'
    get hasSkills(): boolean {
      return true
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

import { buildBuiltinProfiles } from '@shuvix/agent-runtime'
import { createInlineMdReader } from '@shuvix/agent-runtime/builtinAgents/inlineSources'
import '../agentHost'

const SID = 'sess-output-spill'

/** 真的内置档案名单（en）—— 判断读的就是它，不另写一份副本 */
const PROFILES = buildBuiltinProfiles({
  language: 'en',
  widgetsRoot: '/w/widgets',
  readMd: createInlineMdReader()
})
const toolsOf = (name: string): readonly string[] => {
  const profile = PROFILES.find((p) => p.name === name)
  expect(profile, `内置档案 ${name} 应存在`).toBeDefined()
  return profile!.tools
}

/** 名单里「不带前缀」的那部分；`agent` 走派发那条路注入，不经注册表 */
const registryNames = (names: readonly string[]): string[] =>
  names.filter((n) => !n.startsWith('mcp:') && !n.startsWith('skill:') && n !== 'agent')

const resolve = async (over: Partial<ToolResolveRequest>): Promise<void> => {
  const host = mocks.host.value
  expect(host, 'agentHost 应把适配面交给 createAgentFactory').toBeDefined()
  await host!.resolveTools({
    kind: 'root',
    rootSessionId: SID,
    selfSessionId: SID,
    profile: { name: 'work' } as ToolResolveRequest['profile'],
    names: [],
    getModelConfig: () =>
      ({ provider: 'p', model: 'm', capabilities: {} }) as ReturnType<
        ToolResolveRequest['getModelConfig']
      >,
    ...over
  })
}

/** 这一次解析里每个工具拿到的 spill */
const spillByName = (): Record<string, boolean | undefined> =>
  Object.fromEntries(mocks.wrapCalls.map((c) => [c.name, c.overrides?.spill]))

/** 这一次解析里每个工具拿到的截断策略 */
const strategyByName = (): Record<string, string> =>
  Object.fromEntries(mocks.wrapCalls.map((c) => [c.name, c.strategy]))

beforeEach(() => {
  mocks.wrapCalls.length = 0
  mocks.builtinNames = []
  mocks.builtinExtra = {}
  mocks.mcpTools = []
})

describe('AHS 基座档案', () => {
  it('AHS-1 tab 基座名单里没有 read → 每一个工具都 spill:false', async () => {
    const names = toolsOf('tab')
    // 这条先立住：哪天 tab.md 加了 read，这个用例要当场喊出来，而不是默默换一套行为
    expect(names, 'tab 基座不该有 read').not.toContain('read')
    expect(names).toContain('mcp:chrome')

    mocks.builtinNames = registryNames(names)
    mocks.mcpTools = [{ name: 'mcp__chrome__snapshot' }, { name: 'mcp__chrome__click' }]

    await resolve({ profile: { name: 'tab' } as ToolResolveRequest['profile'], names })

    expect(spillByName()).toEqual({
      ask: false,
      skill: false,
      mcp__chrome__snapshot: false,
      mcp__chrome__click: false
    })
    expect(mocks.wrapCalls.length).toBeGreaterThan(0)
  })

  it('AHS-2 work 基座名单里有 read → 每一个工具（含 agent 与 skill）都 spill:true', async () => {
    const names = toolsOf('work')
    expect(names).toContain('read')
    mocks.builtinNames = registryNames(names)

    await resolve({ profile: { name: 'work' } as ToolResolveRequest['profile'], names })

    const spills = spillByName()
    expect(
      Object.values(spills).every((v) => v === true),
      JSON.stringify(spills)
    ).toBe(true)
    expect(Object.keys(spills)).toEqual(expect.arrayContaining(['read', 'agent', 'skill']))
  })
})

describe('AHS 每个 agent 各按自己的名单判', () => {
  it('AHS-3 同一个根会话下：titler（只有 session）不落盘，explore（有 read）落盘', async () => {
    expect(toolsOf('titler'), 'titler 的名单').toEqual(['session'])
    expect(toolsOf('explore'), 'explore 的名单').toContain('read')

    mocks.builtinNames = ['session', 'read', 'ls', 'grep', 'glob']

    await resolve({
      kind: 'spawned',
      selfSessionId: 'agent-titler',
      profile: { name: 'titler' } as ToolResolveRequest['profile'],
      names: toolsOf('titler')
    })
    expect(spillByName()).toEqual({ session: false })
    // 落盘目录归根会话：派生 agent 的全文也落在根会话那一份下面
    expect(mocks.wrapCalls.every((c) => c.sessionId === SID)).toBe(true)

    mocks.wrapCalls.length = 0
    await resolve({
      kind: 'spawned',
      selfSessionId: 'agent-explore',
      profile: { name: 'explore' } as ToolResolveRequest['profile'],
      names: toolsOf('explore')
    })
    expect(spillByName()).toEqual({ read: true, ls: true, grep: true, glob: true })
    expect(mocks.wrapCalls.every((c) => c.sessionId === SID)).toBe(true)
  })
})

describe('AHS 与工具自带上限共存', () => {
  it('AHS-4 outputMaxBytes / outputMaxLines 与 spill 同时到达，不互相顶掉', async () => {
    mocks.builtinNames = ['read', 'ask']
    mocks.builtinExtra = { read: { outputMaxBytes: 81920 }, ask: { outputMaxLines: 10 } }

    await resolve({ names: ['read'] })
    expect(mocks.wrapCalls).toEqual([
      expect.objectContaining({
        name: 'read',
        overrides: { maxBytes: 81920, maxLines: undefined, spill: true }
      })
    ])

    mocks.wrapCalls.length = 0
    await resolve({ names: ['ask'] })
    expect(mocks.wrapCalls).toEqual([
      expect.objectContaining({
        name: 'ask',
        overrides: { maxBytes: undefined, maxLines: 10, spill: false }
      })
    ])
  })
})

describe('AHS 名单之外注入进来的工具', () => {
  it('AHS-5 派发工具 agent 与 extraTools 跟这个 agent 其余工具同一个答案', async () => {
    mocks.builtinNames = ['read', 'ask']

    await resolve({ names: ['read', 'agent'], extraTools: [{ name: 'next' } as never] })
    expect(spillByName()).toEqual({ read: true, agent: true, next: true })

    mocks.wrapCalls.length = 0
    await resolve({ names: ['ask', 'agent'], extraTools: [{ name: 'next' } as never] })
    expect(spillByName()).toEqual({ ask: false, agent: false, next: false })
  })

  it('AHS-6 只认完整的工具名：`mcp:read` / `skill:read` 不算手里有 read', async () => {
    mocks.mcpTools = [{ name: 'mcp__read__fetch' }]

    await resolve({ names: ['mcp:read', 'skill:read'] })

    expect(spillByName()).toEqual({ skill: false, mcp__read__fetch: false })
  })
})

describe('AHS 截断策略按工具各自的声明', () => {
  it('AHS-7 交给包装器的是这个工具自己声明的策略', async () => {
    // 一侧声明「保留开头」，另一侧什么也不声明（MCP / skill 工具都是后一种形状）
    mocks.builtinNames = ['read', 'ask']
    mocks.builtinExtra = { read: { outputStrategy: 'keep-start' } }

    await resolve({ names: ['read', 'ask'] })

    // 写死一个 'middle'、或把某一个工具的声明套给整张表，都要在这里当场红掉
    const strategies = strategyByName()
    expect(strategies.read).not.toBe(strategies.ask)
    expect(strategies).toEqual({ read: 'keep-start', ask: 'middle' })
  })
})
