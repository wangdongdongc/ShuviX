/**
 * agent 规格派生（durable/agentSpec.ts）—— 从 createAgent.test.ts 拆过来的那一半（P1-01）。
 *
 * 初始模型、思考档位、工具名单是纯派生，断言落在 `deriveAgentSpec` 的规格上。系统提示词的
 * 一次拼完（assembleSystemPrompt）与旧运行时的那半张决策表随 P1-13 删了：提示词的注入规则由
 * `promptSections.test.ts` / `persona.test.ts` 钉（段落扩展 + 冻结人设）。依赖运行时本身的那几条
 *（getModelConfig 惰性）留在 createAgent.test.ts 里作 it.todo。
 */
import { describe, it, expect, vi } from 'vitest'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import {
  deriveAgentSpec,
  type AgentSpec,
  type AgentSpecHost,
  type AgentSpecParams
} from '../agentSpec'
import type { InProcessAgentType, SubAgentModelConfig } from '../../subagent/types'
import type { SpawnContext } from '../../agentProfile/createAgent'
import { buildBuiltinProfile, PERMISSION_REVIEWER_SPEC } from '../../subagent/builtinAgents'
import { createInlineMdReader } from '../../subagent/builtinAgents/inlineSources'
import { toInProcessAgentType } from '../../subagent/dispatchTool'

// ── fakes ──
const PROFILE: InProcessAgentType = {
  name: 'default',
  displayName: 'Default',
  description: '',
  tools: ['read', 'grep', 'agent'],
  systemPrompt: 'BASE {{shuvix:persona}}',
  instructionFiles: ['AGENTS.md', 'CLAUDE.md']
}
const MODEL_CFG: SubAgentModelConfig = { provider: 'p1', model: 'm1', capabilities: {} }
const SPAWN: SpawnContext = {
  agentId: 'sub-1',
  depth: 1,
  parentAgentId: 'root-s',
  rootSessionId: 'root-s',
  modelConfig: MODEL_CFG,
  canSpawn: true
}

interface HostBundle {
  host: AgentSpecHost
  resolveProfileModel: ReturnType<typeof vi.fn>
  logger: {
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
}

function makeHost(): HostBundle {
  // 缺省不解析（返回 null = 档案模型当前不可用）；声明模型的用例各自 mockResolvedValue
  const resolveProfileModel = vi.fn().mockResolvedValue(null)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const host: AgentSpecHost = { resolveProfileModel, logger }
  return { host, resolveProfileModel, logger }
}

const rootSpec = (b: HostBundle, over: Partial<AgentSpecParams> = {}): Promise<AgentSpec> =>
  deriveAgentSpec(b.host, {
    kind: 'root',
    sessionId: 's1',
    profile: PROFILE,
    model: MODEL_CFG,
    ...over
  })

const spawnedSpec = (b: HostBundle, over: Partial<AgentSpecParams> = {}): Promise<AgentSpec> =>
  deriveAgentSpec(b.host, {
    kind: 'spawned',
    sessionId: 'sub-1',
    profile: PROFILE,
    model: MODEL_CFG,
    thinkingLevel: 'off',
    spawn: SPAWN,
    ...over
  })

describe('deriveAgentSpec — root 决策列', () => {
  it('root：思考档位就是传入值（会话设置）', async () => {
    const b = makeHost()
    const spec = await rootSpec(b, { thinkingLevel: 'medium', toolOverlay: ['mcp:ctx', 'read'] })
    expect(spec.thinkingLevel).toBe('medium')
  })

  it('身份与名单：归一名单保序去重、root overlay 只收 mcp:/skill:、root 身份', async () => {
    const b = makeHost()
    // bash 不在档案白名单里：勾选里混进的内置名不能借 overlay 越过档案
    const spec = await rootSpec(b, { toolOverlay: ['mcp:ctx', 'bash', 'skill:pdf', 'mcp:ctx'] })
    expect(spec.kind).toBe('root')
    expect(spec.sessionId).toBe('s1')
    expect(spec.rootSessionId).toBe('s1')
    expect(spec.toolNames).toEqual(['read', 'grep', 'agent', 'mcp:ctx', 'skill:pdf'])
  })
})

describe('deriveAgentSpec — spawned 决策列', () => {
  it('身份：sessionId 是自身 agentId，rootSessionId 来自 spawn 上下文', async () => {
    const b = makeHost()
    const spec = await spawnedSpec(b)
    expect(spec.kind).toBe('spawned')
    expect(spec.sessionId).toBe('sub-1')
    expect(spec.rootSessionId).toBe('root-s')
  })

  it('缺 spawn 上下文即抛错', async () => {
    const b = makeHost()
    await expect(
      deriveAgentSpec(b.host, {
        kind: 'spawned',
        sessionId: 'sub-1',
        profile: PROFILE,
        model: MODEL_CFG
      })
    ).rejects.toThrow('requires spawn context')
  })
})

/** 档案声明的模型经宿主解析后的产物（档案模型 / 档案思考档位两组共用） */
const DECLARED: SubAgentModelConfig = {
  provider: 'p-declared',
  model: 'm-declared',
  capabilities: { reasoning: true }
}

describe('deriveAgentSpec — 档案模型（shuvix-model）', () => {
  /** 派生的固定形状；profile 由各用例就地覆盖 */
  const spawnWith = (
    b: HostBundle,
    profile: InProcessAgentType,
    model: SubAgentModelConfig = { ...MODEL_CFG, thinkingLevel: 'low' }
  ): Promise<AgentSpec> => spawnedSpec(b, { profile, model })

  it('spawned + 档案模型可解析：以原样字符串调用一次解析器，初始模型全部来自解析产物', async () => {
    const b = makeHost()
    b.resolveProfileModel.mockResolvedValue(DECLARED)
    const spec = await spawnWith(b, { ...PROFILE, model: 'p-declared/m-declared' })

    expect(b.resolveProfileModel).toHaveBeenCalledTimes(1)
    expect(b.resolveProfileModel).toHaveBeenCalledWith('p-declared/m-declared')
    expect(spec.model.provider).toBe('p-declared')
    expect(spec.model.model).toBe('m-declared')
    expect(spec.model.capabilities).toEqual({ reasoning: true })
    expect(b.logger.warn).not.toHaveBeenCalled()
  })

  it('spawned + 档案模型不可用：回落派发方模型、不抛错，且 warn 含档案名与原始声明值', async () => {
    const b = makeHost()
    b.resolveProfileModel.mockResolvedValue(null)
    const spec = await spawnWith(b, { ...PROFILE, name: 'explore', model: 'gone/model' })

    expect(spec.model).toEqual({ ...MODEL_CFG, thinkingLevel: 'low' })
    expect(b.logger.warn).toHaveBeenCalledTimes(1)
    const msg = String(b.logger.warn.mock.calls[0][0])
    expect(msg).toContain('explore')
    expect(msg).toContain('gone/model')
  })

  it('spawned + 未声明模型：解析器零调用，直接用派发方模型', async () => {
    const b = makeHost()
    const spec = await spawnWith(b, PROFILE)

    expect(b.resolveProfileModel).not.toHaveBeenCalled()
    expect(spec.model).toEqual({ ...MODEL_CFG, thinkingLevel: 'low' })
    expect(b.logger.warn).not.toHaveBeenCalled()
  })

  it('root + 档案声明了模型：解析器零调用，初始模型仍是会话传入值（会话设置为准）', async () => {
    const b = makeHost()
    b.resolveProfileModel.mockResolvedValue(DECLARED)
    const spec = await rootSpec(b, {
      profile: { ...PROFILE, model: 'p-declared/m-declared' },
      thinkingLevel: 'medium'
    })

    expect(b.resolveProfileModel).not.toHaveBeenCalled()
    expect(spec.model).toBe(MODEL_CFG)
    expect(b.logger.warn).not.toHaveBeenCalled()
  })

  it('档案模型生效后规格里的模型是档案模型（孙代理继承它，不是派发方模型），档位仍取派发方模型配置的', async () => {
    const b = makeHost()
    b.resolveProfileModel.mockResolvedValue(DECLARED)
    const spec = await spawnWith(b, { ...PROFILE, model: 'p-declared/m-declared' })

    expect(spec.model).toEqual({ ...DECLARED, thinkingLevel: 'low' })
  })

  it('宿主未注入 resolveProfileModel（可选注入）：不抛错、回落派发方模型、不告警', async () => {
    const b = makeHost()
    // 「本端不支持档案模型」≠「这个模型不可用」——混为一谈会误导排障
    delete (b.host as { resolveProfileModel?: unknown }).resolveProfileModel

    const spec = await spawnWith(b, { ...PROFILE, model: 'p-declared/m-declared' })
    expect(spec.model).toEqual({ ...MODEL_CFG, thinkingLevel: 'low' })
    expect(b.logger.warn).not.toHaveBeenCalled()
  })
})

/**
 * 决策表的思考一行（`shuvix-thinking`），与模型一行同一口径：
 *   - spawned：档案声明压过派发方传入的档位 —— 派生 agent 没有思考选择器，档案是唯一能说话的地方；
 *     没声明 → 随派发方；
 *   - root：以传入值为准（会话设置）。档案的声明只在钉档案时作为种子写进去 —— 每次重建都按档案覆盖，
 *     会把用户在会话里手选的档位默默还原。
 * 断言落在规格的 `thinkingLevel`（运行时真正用的档位），不是模型配置上顺带的 thinkingLevel ——
 * 两者各走各的，TH-4b 把它们分开钉。
 */
describe('deriveAgentSpec — 档案思考档位（shuvix-thinking）', () => {
  /** 派生；dispatcherLevel = 派发方传入的 params.thinkingLevel（与模型配置上的档位分开给） */
  const spawnAt = (
    b: HostBundle,
    profile: InProcessAgentType,
    dispatcherLevel: ThinkingLevel,
    model: SubAgentModelConfig = { ...MODEL_CFG, thinkingLevel: 'low' }
  ): Promise<AgentSpec> => spawnedSpec(b, { profile, model, thinkingLevel: dispatcherLevel })

  it.each<[string, ThinkingLevel, ThinkingLevel]>([
    ['声明 off / 派发方 high', 'off', 'high'],
    ['声明 xhigh / 派发方 off', 'xhigh', 'off']
  ])(
    'TH-1 spawned 且档案声明（%s）：运行时档位 = 声明值，压过派发方',
    async (_label, declared, dispatcher) => {
      // 两个方向都要：只测「往低压」的话，一个「取两者较低者」的实现也能蒙混过去
      const b = makeHost()
      const spec = await spawnAt(b, { ...PROFILE, thinkingLevel: declared }, dispatcher)
      expect(spec.thinkingLevel).toBe(declared)
    }
  )

  it('TH-2 spawned 且未声明：运行时档位 = 派发方传入的', async () => {
    const b = makeHost()
    const spec = await spawnAt(b, PROFILE, 'low')
    expect(spec.thinkingLevel).toBe('low')
  })

  it('TH-3 root：档案声明 off、会话传入 high → high（会话设置为准，档案不在重建时覆盖用户的选择）', async () => {
    const b = makeHost()
    const spec = await rootSpec(b, {
      profile: { ...PROFILE, thinkingLevel: 'off' },
      thinkingLevel: 'high'
    })
    expect(spec.thinkingLevel).toBe('high')
  })

  it('TH-4a 两行互不牵连：声明的模型不可用（回落派发方模型、恰一条 warn）时，声明的档位照样生效', async () => {
    const b = makeHost()
    b.resolveProfileModel.mockResolvedValue(null)
    const spec = await spawnAt(b, { ...PROFILE, model: 'gone/model', thinkingLevel: 'high' }, 'off')

    expect(spec.model).toEqual({ ...MODEL_CFG, thinkingLevel: 'low' })
    expect(b.logger.warn).toHaveBeenCalledTimes(1)
    // 档位是枚举值，没有「不可用」一说 —— 模型那一行的回落不该把它一起带回派发方
    expect(spec.thinkingLevel).toBe('high')
  })

  it('TH-4b 只声明可解析的模型、不声明档位：档案模型的解析产物不夹带档位 —— 运行时档位随派发方', async () => {
    const b = makeHost()
    // 宿主的解析产物上带着一个档位：它是模型目录那边的事，不是档案的声明
    b.resolveProfileModel.mockResolvedValue({ ...DECLARED, thinkingLevel: 'high' })
    const spec = await spawnAt(b, { ...PROFILE, model: 'p-declared/m-declared' }, 'low', {
      ...MODEL_CFG,
      thinkingLevel: 'medium'
    })

    expect(spec.thinkingLevel).toBe('low')
    // 初始模型配置上的档位同样不取解析产物的，仍是派发方模型配置里那个
    expect(spec.model.provider).toBe('p-declared')
    expect(spec.model.thinkingLevel).toBe('medium')
  })
})

/**
 * 工具名单归一（TN）—— 档案 `shuvix-tools` 声明的一切（内置名 / mcp: / skill:）对 root 与 spawned
 * **恒生效**；root 会话的勾选（`toolOverlay`，只收 mcp:/skill:）只能往上**加**：既去不掉档案声明的
 * 项，也带不进一个内置工具名。同一份名单喂给人设冻结时的变量表（`promptVars` 的 `toolNames`）与工具解析
 *（都在锁里，见 lock.create.test.ts）。
 */
describe('deriveAgentSpec —— 工具名单归一（TN）', () => {
  /** P：内置名、mcp、skill、派发四类各一 */
  const P = ['read', 'mcp:prof', 'skill:prof', 'agent']
  const EXT_PROFILE: InProcessAgentType = { ...PROFILE, tools: P }

  const createRoot = (b: HostBundle, toolOverlay?: readonly string[]): Promise<AgentSpec> =>
    rootSpec(b, { profile: EXT_PROFILE, toolOverlay })
  const createSpawned = (b: HostBundle): Promise<AgentSpec> =>
    spawnedSpec(b, { profile: EXT_PROFILE })

  it('TN-1 root 带勾选：档案声明的 mcp:/skill: 原位留着，勾选的接在末尾', async () => {
    const spec = await createRoot(makeHost(), ['skill:sel'])
    expect(spec.toolNames).toEqual(['read', 'mcp:prof', 'skill:prof', 'agent', 'skill:sel'])
  })

  it('TN-2 root 不带勾选 / 勾选为空：档案全量照样生效 —— 勾选去不掉档案声明的项', async () => {
    for (const overlay of [undefined, []]) {
      const spec = await createRoot(makeHost(), overlay)
      expect(spec.toolNames, JSON.stringify(overlay)).toEqual(P)
    }
  })

  it('TN-3 root 勾选里的脏数据：声明项保位、重复塌缩、内置名（bash / write / read）一个都进不来', async () => {
    const spec = await createRoot(makeHost(), [
      'skill:prof',
      'bash',
      'mcp:new',
      'write',
      'read',
      'mcp:prof',
      'mcp:new'
    ])
    const names = spec.toolNames
    expect(names).toEqual(['read', 'mcp:prof', 'skill:prof', 'agent', 'mcp:new'])
    // 勾选混进内置名（手改的设置、被新会话继承的项目配置）不能借 overlay 越过档案
    expect(names).not.toContain('bash')
    expect(names).not.toContain('write')
    expect(names.filter((n) => n === 'read')).toHaveLength(1)
  })

  it('TN-4 spawned 没有勾选：名单恰为档案全量、保持档案顺序；root 不带勾选时与之逐项相同', async () => {
    const spawned = await createSpawned(makeHost())
    expect(spawned.toolNames).toEqual(P)
    const root = await createRoot(makeHost())
    // 同一条规则：档案写了什么，这个 agent 就带什么 —— 不再分 root / spawned 两套
    expect(root.toolNames).toEqual(spawned.toolNames)
  })
})

/**
 * 内置权限审查员（permission-reviewer）走同一条派生 —— 它的「什么都不要」全由档案表达，这里验的是
 * 派生照办：工具名单为空、档位按档案压到 low。
 */
describe('deriveAgentSpec —— 内置权限审查员（permission-reviewer）', () => {
  it('PRV-C1 内置 md → toInProcessAgentType → spawned 派生：名单为空；派发方 high → 运行时 low', async () => {
    const built = buildBuiltinProfile(PERMISSION_REVIEWER_SPEC, { readMd: createInlineMdReader() })
    expect(built).not.toBeNull()
    const b = makeHost()
    const spec = await spawnedSpec(b, {
      sessionId: 'sub-reviewer',
      profile: toInProcessAgentType(built!),
      model: { ...MODEL_CFG, thinkingLevel: 'high' },
      thinkingLevel: 'high'
    })

    expect(spec.toolNames).toEqual([])
    // 档案的 shuvix-thinking: low 压过派发方的 high
    expect(spec.thinkingLevel).toBe('low')
  })
})
