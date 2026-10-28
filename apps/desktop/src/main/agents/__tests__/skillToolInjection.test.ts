/**
 * STI —— SkillTool 的**注入点**（P1-11 起是桌面 ToolHost 的 `resolveAgentTools`）：什么时候把 `skill`
 * 挂上，挂的时候交给 SkillTool 的是哪一份参数，以及记进锁的 `skills` 是哪几个。
 *
 * 规则只有一条（2026-10-28 起按 Claude Code / Codex 的用法）：归一名单里有技能工具 `skill`，就构造一次
 * `new SkillTool('enabled', projectPath)` —— 货架是此刻侧栏里启用着、模型可调用的全部技能，档案不逐个
 * 点名、会话也不勾选；名单里没有 `skill` 就**根本不构造**；构造了但这一次没有可给的（`hasSkills=false`）
 * 就不挂、`skills` 为空。宿主不在名单之外另挂工具 —— `shuvix-tools` 加上会话勾选就是 agent 工具表的
 * 完整列举（STI-6 / 6b 用运行时的 `composeAgentTools` 把内置工具与解析结果拼起来看）。
 *
 * 分工：货架本身（谁进索引、按名加载给不给）在 `services/__tests__/skillToolShelf.test.ts`；
 * 这里只钉注入点自己的判断 —— **挂不挂**与**交给 SkillTool 的参数**（创建时永远两个：`'enabled'` +
 * 项目路径）。
 *
 * ⚠️ **mock 陷阱**：`vi.mock('../../services/skillTool', () => ({ SkillTool: class {} }))` 会让 `hasSkills`
 * 恒为 `undefined`（falsy），于是工具**永不注入** —— 照抄过来这一组会全绿且什么都没测。
 * 这里的桩必须自带可控的 `hasSkills`（与 `skillNames`）。
 *
 * 派生 agent 的三条（STI-4 / 5 / 5b，P2-04-32…34）：同一条规则，名单是派生 agent 自己的；SkillTool 的
 * projectPath 取**根会话**的项目（按 agentId 查不到项目）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

interface SkillToolCall {
  shelf: unknown
  projectPath?: string
  /** 构造时实际传了几个参数 —— 创建时恰好两个（货架 + 项目路径） */
  argc: number
}

const mocks = vi.hoisted(() => ({
  skillToolCalls: [] as SkillToolCall[],
  hasSkills: true,
  /** 桩货架这一次「上架」的技能（真 SkillTool 由 findModelInvocable 给出） */
  shelfSkills: ['builtin:drawing', 'pdf'] as string[],
  pick: vi.fn(),
  projectPick: vi.fn()
}))

/** 可控的 SkillTool 桩：记下这一次装配收到的参数，`hasSkills` 与上架的技能由用例决定 */
vi.mock('../../services/skillTool', () => ({
  SkillTool: class {
    readonly name = 'skill'
    readonly label = 'skill'
    readonly description = 'stub'
    constructor(...args: unknown[]) {
      mocks.skillToolCalls.push({
        shelf: args[0],
        projectPath: args[1] as string | undefined,
        argc: args.length
      })
    }
    get hasSkills(): boolean {
      return mocks.hasSkills
    }
    get skillNames(): string[] {
      return mocks.hasSkills ? [...mocks.shelfSkills] : []
    }
  }
}))

/** 注入点本身不读技能目录（那是 SkillTool 的事）；桩在这里是为了不让真服务碰真实 HOME */
vi.mock('../../services/skillService', () => ({
  skillService: { findEnabled: () => [], findAll: () => [], findModelInvocable: () => [] }
}))
vi.mock('../../services/wrapToolOutput', () => ({ wrapDurableTool: (tool: object) => tool }))
vi.mock('../AgentTool', () => ({ createAgentTool: () => ({ name: 'agent' }) }))
vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9', getPath: () => '/tmp/x' } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../services/sessionRecords', () => ({
  sessionRecords: { pick: mocks.pick, pickSettings: () => undefined }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: { findAllEnabledModels: () => [] } }))
vi.mock('../../services/mcpService', () => ({ mcpService: {} }))
vi.mock('../../services/instruction', () => ({ resolveInstructionContent: vi.fn() }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: vi.fn() } }))
vi.mock('../../services/agentRuntimeAdapters', () => ({
  electronEventSink: {},
  runtimeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: vi.fn(),
  resolveProjectConfig: vi.fn()
}))
vi.mock('../../services/userInputBroker', () => ({ requestUserInputFor: vi.fn() }))
vi.mock('../../services/sandbox', () => ({ sandboxGloballyActive: () => false }))
vi.mock('../../services/botService', () => ({ botService: { forSession: () => null } }))
vi.mock('../../utils/toolUtils/fileTime', () => ({ recordRead: vi.fn() }))
vi.mock('../../services/knowledge', () => ({ enabledBaseChoices: () => [] }))

import {
  composeAgentTools,
  normalizeToolNames,
  parseAgentDefinitionFile,
  type InProcessAgentType,
  type ResolvedAgentTools
} from '@shuvix/agent-runtime'
import { createDesktopToolHost } from '../agentHost'
import {
  SR_D,
  inProcess,
  profileOf,
  registerStubBuiltins,
  requestD
} from './support/toolHostFixtures'

const SID = 's1'
/** 技能工具在档案 `shuvix-tools` 里的写法 */
const SKILL = 'skill'

/** bot 基座那份刻意很窄的工具名单（见 STI-6）—— 它写了技能工具 */
const BOT_TOOLS = profileOf('bot').tools

const host = createDesktopToolHost({ sessionOf: () => undefined })

const resolve = (names: readonly string[], profile = 'work'): Promise<ResolvedAgentTools> =>
  host.resolveAgentTools(requestD({ names: [...names], profile: inProcess(profileOf(profile)) }), {
    signal: new AbortController().signal
  })

/** 解析结果里按 agent 的工具名（agent / skill …） */
const agentToolNames = (resolved: ResolvedAgentTools): string[] =>
  [resolved.agent, resolved.skill].filter((t) => t !== undefined).map((t) => t!.name)

let unregister: () => void

beforeAll(() => {
  unregister = registerStubBuiltins()
})
afterAll(() => unregister())

beforeEach(() => {
  mocks.skillToolCalls.length = 0
  mocks.hasSkills = true
  mocks.shelfSkills = ['builtin:drawing', 'pdf']
  // 缺省：会话不属于任何项目
  mocks.pick.mockReset().mockReturnValue(undefined)
  mocks.projectPick.mockReset().mockReturnValue(undefined)
})

describe('STI 根 agent', () => {
  it('STI-1 名单里没有技能工具 `skill` → 根本不构造 SkillTool，没有 skill，skills 为空', async () => {
    // 内置技能没有「root 恒在架」的特例：档案不写 `skill`，这个 agent 就没有技能货架
    const resolved = await resolve(['read'])
    expect(agentToolNames(resolved)).not.toContain('skill')
    expect(resolved.skills ?? []).toEqual([])
    expect(mocks.skillToolCalls).toEqual([])
  })

  it('STI-2 名单有 `skill`、但这一次真的没有技能可给（hasSkills=false）→ 构造一次，不挂，skills 为空', async () => {
    mocks.hasSkills = false
    const resolved = await resolve(['read', SKILL])
    expect(resolved.skill).toBeUndefined()
    expect(resolved.skills).toEqual([])
    // 仍然构造过一次 —— 「有没有可给的」只有构造完才知道（例如侧栏把技能全停用了）
    expect(mocks.skillToolCalls).toHaveLength(1)
    expect(mocks.skillToolCalls[0].shelf).toBe('enabled')
  })

  it("STI-3 带项目的根会话：货架 'enabled'、projectPath 传下去，恰好两个参数；skills 记的是上架的那几个", async () => {
    mocks.pick.mockReturnValue({ projectId: 'proj-1' })
    mocks.projectPick.mockReturnValue({ name: 'Proj', path: '/w/proj' })
    const resolved = await resolve([SKILL])
    expect(mocks.skillToolCalls).toEqual([{ shelf: 'enabled', projectPath: '/w/proj', argc: 2 }])
    expect(resolved.skills).toEqual(['builtin:drawing', 'pdf'])
  })

  it("STI-7 会话勾选里的 `skill:foo` / `-skill:builtin:drawing` 不改货架：归一名单里没有它们，仍是一次 'enabled'；名单里只剩旧写法 `skill:foo`（没有 `skill`）→ 不构造", async () => {
    const names = normalizeToolNames('root', profileOf('work').tools, [
      'skill:foo',
      '-skill:builtin:drawing'
    ])
    expect(names.filter((n) => n.startsWith('skill:') || n.startsWith('-skill:'))).toEqual([])
    const resolved = await resolve(names)
    expect(mocks.skillToolCalls).toEqual([{ shelf: 'enabled', projectPath: undefined, argc: 2 }])
    expect(agentToolNames(resolved).filter((n) => n === 'skill')).toHaveLength(1)
    expect(resolved.skills).toEqual(['builtin:drawing', 'pdf'])

    mocks.skillToolCalls.length = 0
    const legacy = await resolve(['read', 'skill:foo'])
    expect(mocks.skillToolCalls).toEqual([])
    expect(legacy.skill).toBeUndefined()
    expect(legacy.skills ?? []).toEqual([])
  })

  it("STI-8 用户档案旧写法 `shuvix-tools: read, skill:pdf`：读成 read + skill，归一（空勾选）进注入点 → 构造一次 'enabled'，上架的是启用着的全部（不只点过名的 pdf）", async () => {
    const parsed = parseAgentDefinitionFile(
      ['---', 'name: helper', 'shuvix-tools: read, skill:pdf', '---', 'You help.'].join('\n'),
      'helper'
    )!
    expect(parsed.tools).toEqual(['read', SKILL])
    const names = normalizeToolNames('root', parsed.tools, [])
    expect(names).toEqual(['read', SKILL])

    // 桩货架 = findModelInvocable 此刻给出的：内置的、点过名的、没点过名的都在
    mocks.shelfSkills = ['builtin:drawing', 'pdf', 'foo']
    const profile: InProcessAgentType = {
      name: parsed.name,
      displayName: parsed.displayName,
      description: parsed.description,
      tools: [...parsed.tools],
      systemPrompt: parsed.systemPrompt,
      instructionFiles: [...parsed.instructionFiles],
      projectAwareness: parsed.projectAwareness
    }
    const resolved = await host.resolveAgentTools(requestD({ names, profile }), {
      signal: new AbortController().signal
    })
    expect(mocks.skillToolCalls).toEqual([{ shelf: 'enabled', projectPath: undefined, argc: 2 }])
    expect(agentToolNames(resolved)).toEqual(['skill'])
    expect(resolved.skills).toEqual(['builtin:drawing', 'pdf', 'foo'])
  })
})

describe('STI 派生 agent', () => {
  /** 派生 agent（根会话 s1、agent sub-a1）按名单解析 */
  const resolveSpawned = (
    names: readonly string[],
    profile = 'coding'
  ): Promise<ResolvedAgentTools> =>
    host.resolveAgentTools(
      SR_D({ names: [...names], profile: inProcess(profileOf(profile)), canSpawn: false }),
      { signal: new AbortController().signal }
    )

  it('P2-04-32 STI-4 派生档案没写 `skill`（titler 只有 session）→ 不构造 SkillTool，没有 skill，skills 为空', async () => {
    const resolved = await resolveSpawned(['session'], 'titler')
    expect(mocks.skillToolCalls).toEqual([])
    expect(agentToolNames(resolved)).not.toContain('skill')
    expect(resolved.skills ?? []).toEqual([])
  })

  it("P2-04-33 STI-5 派生档案写了 `skill` → 货架同根（'enabled'）；projectPath 是根会话的项目（只按 s1 查）", async () => {
    mocks.pick.mockImplementation((id: string) =>
      id === SID ? { projectId: 'proj-1' } : undefined
    )
    mocks.projectPick.mockReturnValue({ name: 'Proj', path: '/w/proj' })
    const resolved = await resolveSpawned([SKILL])
    expect(mocks.skillToolCalls).toEqual([{ shelf: 'enabled', projectPath: '/w/proj', argc: 2 }])
    expect(resolved.skills).toEqual(['builtin:drawing', 'pdf'])
    expect(mocks.pick.mock.calls.map(([id]) => id)).toEqual([SID])
  })

  it('P2-04-34 STI-5b 派生名单 read + skill → 一次构造；恰好一个 skill；拼出来是 read + skill', async () => {
    const names = ['read', SKILL]
    const resolved = await resolveSpawned(names)
    expect(mocks.skillToolCalls).toHaveLength(1)
    expect(mocks.skillToolCalls[0].shelf).toBe('enabled')
    expect(agentToolNames(resolved).filter((n) => n === 'skill')).toHaveLength(1)
    const builtin = await host.buildBuiltinTools({ sessionId: SID, sandboxed: false })
    expect(composeAgentTools({ names, builtin, set: resolved }).toolNames).toEqual([
      'read',
      'skill'
    ])
  })
})

describe('STI 名单即全部：宿主不在名单之外另挂工具', () => {
  /** 运行时的拼法：内置工具（会话级）+ 解析结果 → 提供给模型的工具名 */
  async function offered(names: readonly string[]): Promise<string[]> {
    const builtin = await host.buildBuiltinTools({ sessionId: SID, sandboxed: false })
    const resolved = await resolve(names, 'bot')
    return composeAgentTools({ names, builtin, set: resolved }).toolNames
  }

  /** 名单里「不带前缀」、注册表里有的那部分（agent / skill 由解析结果那条路注入） */
  const unprefixed = (names: readonly string[]): string[] =>
    names.filter((n) => !n.startsWith('mcp:') && n !== SKILL)

  it("STI-6 bot 基座的窄名单写了 `skill` → 挂上 skill，SkillTool 构造一次（'enabled'）；工具表恰为名单的投影", async () => {
    expect(BOT_TOOLS, 'bot 基座的名单里写了技能工具').toContain(SKILL)
    expect(
      BOT_TOOLS.filter((n) => n.startsWith('skill:')),
      'bot 基座不再逐个点名技能'
    ).toEqual([])

    const names = await offered(BOT_TOOLS)
    expect(names).toContain('skill')
    expect(mocks.skillToolCalls).toHaveLength(1)
    expect(mocks.skillToolCalls[0].shelf).toBe('enabled')
    // 名单本身照常生效：白名单外的工具不会因此冒出来，skill 也是名单写了才有的
    expect([...names].sort()).toEqual([...unprefixed(BOT_TOOLS), 'skill'].sort())
  })

  it('STI-6b 同一份 bot 名单去掉 `skill` → 没有 skill，SkillTool 一次都没构造', async () => {
    // 以前 root 恒挂 SkillTool（不看档案）—— 那个例外已经删了：不写就没有
    const withoutSkill = BOT_TOOLS.filter((n) => n !== SKILL)
    const names = await offered(withoutSkill)
    expect(names).not.toContain('skill')
    expect(mocks.skillToolCalls).toEqual([])
    expect([...names].sort()).toEqual([...unprefixed(withoutSkill)].sort())
  })
})
