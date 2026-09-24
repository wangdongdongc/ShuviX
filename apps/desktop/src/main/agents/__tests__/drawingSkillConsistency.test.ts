/**
 * DSC —— 「提示里指路」与「货架上真有」是同一个判断。
 *
 * 作图技能在桌面上出现在两处，由两段代码各自决定：
 *  - 变量表（`desktopPromptVars`）：名单点了 `skill:builtin:drawing` 且 findEnabled 里有它 →
 *    visualGuide / visualCraft 带一句「先加载 `builtin:drawing`」的指路；否则两个值都是空串
 *    （2026-09-24 起契约、预算与范例只在技能里，整份作图说明都挂在「技能在架」上）；
 *  - 工具解析（`resolveTools` → 真的 `SkillTool`）：名单点了名的 ∩ findEnabled → 技能进货架索引。
 * 两边读的是同一份名单（createAgent 先算好名单，再分别交给两处）。这一组把两边放在同一组输入下
 * 逐格比对：指路出现的地方技能一定加载得到，加载得到的地方提示一定指了路 —— 任何一边自己改了
 * 判断（例如又给 root 恒挂一个 SkillTool、或变量表按宿主而不是按名单判），矩阵里就会有一格对不上。
 *
 * 取 host 适配面的办法同 skillToolInjection：顶掉 `createAgentFactory`，接住 agentHost 交出来的
 * 那个对象。与那边不同的是这里用**真的 SkillTool** —— 要比的正是它装配出的货架；于是桩
 * skillService（可控的 findEnabled）、`../../i18n`（顶层 import electron）与 ripgrep（真二进制），
 * 注册表桩要带 `registerBuiltinTool`（skillTool.ts 加载即自注册）。
 *
 * 2026-09-24 DSC-1 同号改写：从前「不指路时手艺范例常驻」，如今不指路时两个值都是空串，
 * 指路时恰好一次、不带范例。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentHostAdapter, PromptVars, ToolResolveRequest } from '@shuvix/agent-runtime'
import type { Skill } from '../../types/skill'

const mocks = vi.hoisted(() => ({
  host: { value: undefined as AgentHostAdapter | undefined },
  findEnabled: vi.fn(),
  findByName: vi.fn(),
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

vi.mock('../../services/skillService', () => ({
  skillService: { findEnabled: mocks.findEnabled, findByName: mocks.findByName }
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/toolUtils/ripgrep', () => ({
  rgFiles: async function* () {
    /* 目录采样不在本组射程内：真 rg 二进制不进单测 */
  }
}))

/** 名单里只有 `read` 一个内置工具；`registerBuiltinTool` 给真 skillTool.ts 加载期自注册用 */
vi.mock('../../services/toolRegistry', () => ({
  getBuiltinToolEntries: () => [
    {
      name: 'read',
      group: 'general' as const,
      getLabel: () => 'read',
      getHint: () => 'read',
      factory: () => ({ name: 'read' })
    }
  ],
  registerBuiltinTool: vi.fn()
}))

/** 包装器走恒等：拿到的就是真 SkillTool 实例本身，description 即货架索引 */
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

import '../agentHost'

const SID = 'sess-drawing-consistency'
const AGENT_ID = 'agent-dsc-1'
const DRAWING = 'skill:builtin:drawing'
const POINTER = 'builtin:drawing'
const EXAMPLE = '```svg\n<svg'
const INDEX_LINE = '<name>builtin:drawing</name>'
const countOf = (text: string, needle: string): number => text.split(needle).length - 1

const BUILTIN: Skill = {
  name: 'builtin:drawing',
  description: 'builtin drawing description',
  content: 'BUILTIN DRAWING BODY',
  basePath: '/fixture/builtin-drawing',
  isEnabled: true,
  source: 'builtin',
  dirName: 'builtin'
}

type Kind = 'root' | 'spawned'

/** 同一组输入下的两边：变量表（按 agent 自己的身份）与工具解析（名单同一份） */
async function bothSides(
  kind: Kind,
  names: string[]
): Promise<{ vars: PromptVars; tools: Array<{ name?: string; description?: string }> }> {
  const host = mocks.host.value
  expect(host, 'agentHost 应把适配面交给 createAgentFactory').toBeDefined()
  const selfId = kind === 'root' ? SID : AGENT_ID
  const vars = await host!.promptVars({
    sessionId: selfId,
    kind,
    cwd: kind === 'root' ? '/w/proj' : '',
    toolNames: names
  })
  const tools = await host!.resolveTools({
    kind,
    rootSessionId: SID,
    selfSessionId: selfId,
    profile: { name: kind === 'root' ? 'work' : 'coding' } as ToolResolveRequest['profile'],
    names,
    getModelConfig: () =>
      ({ provider: 'p', model: 'm', capabilities: {} }) as ReturnType<
        ToolResolveRequest['getModelConfig']
      >
  })
  return { vars, tools: tools as Array<{ name?: string; description?: string }> }
}

beforeEach(() => {
  mocks.findEnabled.mockReset()
  mocks.findByName.mockReset()
  // 缺省：会话不属于任何项目
  mocks.pick.mockReturnValue(undefined)
  mocks.pickSettings.mockReturnValue(undefined)
  mocks.projectPick.mockReturnValue(undefined)
})

describe('DSC 指路与货架同一个判断', () => {
  const MATRIX: Array<[kind: Kind, named: boolean, enabled: boolean]> = (
    ['root', 'spawned'] as const
  ).flatMap((kind) =>
    [true, false].flatMap((named) =>
      [true, false].map((enabled): [Kind, boolean, boolean] => [kind, named, enabled])
    )
  )

  it.each(MATRIX)(
    'DSC-1 kind=%s 名单点名=%s 技能在架=%s：提示指路 ⇔ 货架索引里有它 ⇔ 点名且在架；不指路时整份作图说明是空串，指路时恰好一次、不带范例',
    async (kind, named, enabled) => {
      mocks.findEnabled.mockReturnValue(enabled ? [BUILTIN] : [])
      const names = named ? ['read', DRAWING] : ['read']
      const { vars, tools } = await bothSides(kind, names)

      // (a) 两个出口都指了路
      const pointed = vars.visualGuide.includes(POINTER) && vars.visualCraft.includes(POINTER)
      // (b) 真的 SkillTool 进了工具表，且索引里有这一本
      const shelved = tools.some(
        (tool) => tool.name === 'skill' && (tool.description ?? '').includes(INDEX_LINE)
      )
      // (c) 期望：名单点了名且没被停用
      const expected = named && enabled

      expect(pointed, '(a) 提示里的指路').toBe(expected)
      expect(shelved, '(b) 货架上的技能').toBe(expected)

      for (const name of ['visualGuide', 'visualCraft'] as const) {
        if (!expected) {
          // 货架上没有它：契约只在技能里，提示里就一个字都不讲（指向拿不到的技能是死路）
          expect(vars[name], `${name} 应为空串`).toBe('')
          continue
        }
        // 货架上有它：指路恰好一次，范例图不在提示里（它在技能里）
        expect(countOf(vars[name], POINTER), `${name} 的指路`).toBe(1)
        expect(vars[name], `${name} 的范例`).not.toContain(EXAMPLE)
      }
      // 根会话（不是 Chrome 标签页）连交互段一起给：交互段也指向技能 —— 上面的「恰好一次」
      // 因此覆盖了它不重复点名这一点
      if (expected && kind === 'root') expect(vars.visualGuide).toContain('```interactive')
    }
  )

  it('DSC-2 点了名但被停用、名单里又没有别的 skill → 连 skill 工具都不挂（空手的工具是噪音）', async () => {
    mocks.findEnabled.mockReturnValue([])
    for (const kind of ['root', 'spawned'] as const) {
      const { vars, tools } = await bothSides(kind, ['read', DRAWING])
      expect(
        tools.map((tool) => tool.name),
        kind
      ).not.toContain('skill')
      // 对照：同一次提示里也没有指路
      expect(vars.visualGuide, kind).not.toContain(POINTER)
    }
  })
})
