/**
 * agent 规格派生（durable/agentSpec.ts）—— 从 createAgent.test.ts 拆过来的那一半（P1-01）。
 *
 * 旧用例 mock 掉 HarnessSession、从它收到的构造参数里读决策；pi-durable 切换后运行时还没重建，
 * 而这些决策本来就是纯派生：初始模型、思考档位、工具名单、系统提示词与 root / spawned 的
 * 运行期差异现在直接是 `deriveAgentSpec` 的产物，用例逐条照旧、断言落在规格上。
 * 依赖运行时本身的那几条（getModelConfig 惰性、运行时注册中心、网络 seam）留在 createAgent.test.ts
 * 里作 it.todo，或随模块删除。
 */
import { describe, it, expect, vi } from 'vitest'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import {
  deriveAgentSpec,
  type AgentSpec,
  type AgentSpecHost,
  type AgentSpecParams
} from '../agentSpec'
import type { PromptVarsCtx } from '../../agentProfile/promptVars'
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
  resolveInstruction: ReturnType<typeof vi.fn>
  resolveProjectPrompt: ReturnType<typeof vi.fn>
  resolveProjectMemory: ReturnType<typeof vi.fn>
  resolveKnowledgeBases: ReturnType<typeof vi.fn>
  resolveProfileModel: ReturnType<typeof vi.fn>
  logger: {
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
}

function makeHost(): HostBundle {
  const resolveInstruction = vi.fn().mockResolvedValue({ filename: 'CLAUDE.md', content: 'INS' })
  const resolveProjectPrompt = vi.fn().mockResolvedValue('PROJ-PROMPT')
  const resolveProjectMemory = vi.fn().mockResolvedValue('PROJ-MEMORY')
  // 知识库围栏 seam：只有档案的工具清单里有 `knowledge` 时才被调用
  //（PROFILE 不带这个工具 —— 既有用例零影响）
  const resolveKnowledgeBases = vi.fn().mockResolvedValue('KB-GUIDE')
  // 缺省不解析（返回 null = 档案模型当前不可用）；声明模型的用例各自 mockResolvedValue
  const resolveProfileModel = vi.fn().mockResolvedValue(null)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const host: AgentSpecHost = {
    promptVars: () => ({ persona: 'PERSONA' }),
    resolveProfileModel,
    logger,
    resolveInstruction,
    resolveProjectPrompt,
    resolveProjectMemory,
    resolveKnowledgeBases
  }
  return {
    host,
    resolveInstruction,
    resolveProjectPrompt,
    resolveProjectMemory,
    resolveKnowledgeBases,
    resolveProfileModel,
    logger
  }
}

const rootSpec = (b: HostBundle, over: Partial<AgentSpecParams> = {}): Promise<AgentSpec> =>
  deriveAgentSpec(b.host, {
    kind: 'root',
    sessionId: 's1',
    profile: PROFILE,
    model: MODEL_CFG,
    cwd: '/w',
    ...over
  })

const spawnedSpec = (b: HostBundle, over: Partial<AgentSpecParams> = {}): Promise<AgentSpec> =>
  deriveAgentSpec(b.host, {
    kind: 'spawned',
    sessionId: 'sub-1',
    profile: PROFILE,
    model: MODEL_CFG,
    thinkingLevel: 'off',
    cwd: '',
    spawn: SPAWN,
    ...over
  })

describe('deriveAgentSpec — root 决策列', () => {
  it('root：持久化 / 自动压缩 / 广播 user 消息 / 自有输入面板 / 应用工具结果变换 / 日志归自身', async () => {
    const b = makeHost()
    const spec = await rootSpec(b, { thinkingLevel: 'medium', toolOverlay: ['mcp:ctx', 'read'] })

    expect(spec.decisions).toEqual({
      persistent: true,
      autoCompact: true,
      broadcastUserMessages: true,
      ownsUserInput: true,
      applyToolResultTransform: true,
      logSessionId: 's1'
    })
    expect(spec.thinkingLevel).toBe('medium')
    // 清单非空 → 指令文件带围栏 append 在基座后（项目提示词开关未开不追加）
    const fencedIns = '<project_instructions file="CLAUDE.md">\nINS\n</project_instructions>'
    expect(spec.systemPrompt).toBe(`BASE PERSONA\n\n${fencedIns}`)
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
  it('spawned：内存 / 不压缩 / 不广播 user 消息 / 无自有输入面板 / 不应用变换 / 日志归根会话', async () => {
    const b = makeHost()
    const spec = await spawnedSpec(b, { profile: { ...PROFILE, instructionFiles: [] } })
    expect(spec.decisions).toEqual({
      persistent: false,
      autoCompact: false,
      broadcastUserMessages: false,
      ownsUserInput: false,
      applyToolResultTransform: false,
      logSessionId: 'root-s'
    })
  })

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
        model: MODEL_CFG,
        cwd: ''
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

describe('deriveAgentSpec — 上下文注入', () => {
  it('清单为空/开关关闭 → 不解析、系统提示词纯基座', async () => {
    const b = makeHost()
    const spec = await rootSpec(b, {
      sessionId: 's2',
      profile: { ...PROFILE, instructionFiles: [] }
    })
    expect(b.resolveInstruction).not.toHaveBeenCalled()
    expect(b.resolveProjectPrompt).not.toHaveBeenCalled()
    expect(b.resolveProjectMemory).not.toHaveBeenCalled()
    expect(spec.systemPrompt).toBe('BASE PERSONA')
  })

  it('spawned 全开 → 按根会话 id 解析、按序 append(指令文件→项目提示词→项目记忆)', async () => {
    const b = makeHost()
    const spec = await spawnedSpec(b, {
      sessionId: 'sub-9',
      profile: { ...PROFILE, projectAwareness: true }
    })
    // 派生解析恒用根会话 id（spawn.rootSessionId），而非自身 agentId
    // 档案清单原样透传给宿主 —— 「读哪些文件」的决定权全在档案
    expect(b.resolveInstruction).toHaveBeenCalledWith('root-s', '', ['AGENTS.md', 'CLAUDE.md'])
    // 项目感知是一个开关带两段注入 —— 提示词与记忆索引同开同关
    expect(b.resolveProjectPrompt).toHaveBeenCalledWith('root-s')
    expect(b.resolveProjectMemory).toHaveBeenCalledWith('root-s')
    // 直接 append 到系统提示词,不落任何消息；三段各自被围栏包住
    expect(spec.systemPrompt).toBe(
      'BASE PERSONA\n\n' +
        '<project_instructions file="CLAUDE.md">\nINS\n</project_instructions>\n\n' +
        '<project_prompt>\nPROJ-PROMPT\n</project_prompt>\n\n' +
        '<project_memory>\nPROJ-MEMORY\n</project_memory>'
    )
  })
})

describe('deriveAgentSpec —— 指令文件注入的接缝口径', () => {
  it('IF-U-17 root 列同样按档案清单解析：(sessionId, cwd, 清单) 恰调一次，清单原样透传', async () => {
    const b = makeHost()
    await rootSpec(b)

    // 「读哪些文件」的决定权全在档案，两列都不得夹带宿主自己的候选名表
    expect(b.resolveInstruction).toHaveBeenCalledTimes(1)
    expect(b.resolveInstruction).toHaveBeenCalledWith('s1', '/w', ['AGENTS.md', 'CLAUDE.md'])

    // 顺序即优先级 —— 不排序、不去重、不截断，宿主收到的就是档案里写的
    const scrambled = ['z.md', 'a.md', 'z.md', 'docs/house.md']
    await rootSpec(b, { profile: { ...PROFILE, instructionFiles: scrambled } })
    expect(b.resolveInstruction.mock.calls[1][2]).toEqual(scrambled)
  })

  it('IF-U-18 宿主解析不出（null）→ 系统提示词逐字节等于纯基座（不留空围栏/尾随空行）', async () => {
    const b = makeHost()
    b.resolveInstruction.mockResolvedValue(null)
    const spec = await rootSpec(b)
    expect(spec.systemPrompt).toBe('BASE PERSONA')
  })

  it('IF-U-19 命中了但内容为空串 → 同样不加围栏（空围栏比不注入更糟：模型会当成"项目没规矩"）', async () => {
    const b = makeHost()
    b.resolveInstruction.mockResolvedValue({ filename: 'X', content: '' })
    const spec = await rootSpec(b)
    expect(spec.systemPrompt).toBe('BASE PERSONA')
    expect(spec.systemPrompt).not.toContain('project_instructions')
  })

  it('IF-U-20 档案有清单但宿主没注入 resolveInstruction（可选注入）→ 不抛、纯基座', async () => {
    const b = makeHost()
    delete (b.host as { resolveInstruction?: unknown }).resolveInstruction
    const spec = await rootSpec(b)
    expect(spec.systemPrompt).toBe('BASE PERSONA')
  })

  it('IF-U-21 档案未声明清单（undefined）→ 解析器零调用、不抛', async () => {
    const b = makeHost()
    const spec = await rootSpec(b, { profile: { ...PROFILE, instructionFiles: undefined } })
    expect(b.resolveInstruction).not.toHaveBeenCalled()
    expect(spec.systemPrompt).toBe('BASE PERSONA')
  })
})

/**
 * 知识库围栏 `<knowledge_bases>` —— 这条会话手头有哪几个库。
 *
 * 它**不跟项目感知走**；唯一的门是**档案的工具清单里有没有 `knowledge`**。位置钉在项目提示词之后、
 * 项目记忆之前：前者是在用的库，后者是只读的旧档，旧档的表头指回前者。
 */
describe('deriveAgentSpec —— 知识库围栏（KB-U）', () => {
  const KB_FENCE = '<knowledge_bases>\nKB-GUIDE\n</knowledge_bases>'
  /** 带 knowledge 工具的档案；注入开关由各用例覆盖 */
  const KB_PROFILE: InProcessAgentType = {
    ...PROFILE,
    tools: [...PROFILE.tools, 'knowledge'],
    instructionFiles: []
  }

  it('KB-U-1 围栏不跟项目感知走：项目感知关着、档案带 knowledge → 照样注入', async () => {
    const b = makeHost()
    const spec = await rootSpec(b, { profile: { ...KB_PROFILE, projectAwareness: false } })

    expect(b.resolveKnowledgeBases).toHaveBeenCalledTimes(1)
    expect(b.resolveKnowledgeBases).toHaveBeenCalledWith('s1')
    expect(spec.systemPrompt).toBe(`BASE PERSONA\n\n${KB_FENCE}`)
    // 项目感知那两段确实没被顺带打开
    expect(b.resolveProjectPrompt).not.toHaveBeenCalled()
    expect(b.resolveProjectMemory).not.toHaveBeenCalled()
  })

  it('KB-U-2 唯一的门是工具清单：档案不带 knowledge（项目感知全开）→ seam 零调用、无围栏', async () => {
    const b = makeHost()
    const spec = await rootSpec(b, {
      profile: { ...PROFILE, instructionFiles: [], projectAwareness: true }
    })

    expect(b.resolveKnowledgeBases).not.toHaveBeenCalled()
    expect(spec.systemPrompt).not.toContain('knowledge_bases')
    // 对照：同一次派生里项目提示词 / 记忆照常 —— 少的只有围栏这一段
    expect(spec.systemPrompt).toBe(
      'BASE PERSONA\n\n' +
        '<project_prompt>\nPROJ-PROMPT\n</project_prompt>\n\n' +
        '<project_memory>\nPROJ-MEMORY\n</project_memory>'
    )
  })

  it('KB-U-3 四段注入顺序钉板：指令文件 → 项目提示词 → 知识库 → 项目记忆；派生按根会话 id 解析', async () => {
    const b = makeHost()
    const spec = await spawnedSpec(b, {
      sessionId: 'sub-9',
      profile: { ...PROFILE, tools: [...PROFILE.tools, 'knowledge'], projectAwareness: true }
    })

    expect(spec.systemPrompt).toBe(
      'BASE PERSONA\n\n' +
        '<project_instructions file="CLAUDE.md">\nINS\n</project_instructions>\n\n' +
        '<project_prompt>\nPROJ-PROMPT\n</project_prompt>\n\n' +
        `${KB_FENCE}\n\n` +
        '<project_memory>\nPROJ-MEMORY\n</project_memory>'
    )
    // 派生 agent 既无会话也无项目：库按**根会话**解析（与其余三段同口径）
    expect(b.resolveKnowledgeBases).toHaveBeenCalledTimes(1)
    expect(b.resolveKnowledgeBases).toHaveBeenCalledWith('root-s')
  })

  it('KB-U-4 解析出 null / 纯空白 → 不加空围栏', async () => {
    for (const value of [null, '   \n\t']) {
      const b = makeHost()
      b.resolveKnowledgeBases.mockResolvedValue(value)
      const spec = await rootSpec(b, { profile: { ...KB_PROFILE, projectAwareness: false } })
      // 空围栏比不注入更糟：模型会当成「这条会话一个库都没有，但好像应该有」
      expect(spec.systemPrompt, JSON.stringify(value)).toBe('BASE PERSONA')
    }
  })

  it('KB-U-5 宿主没实现这个可选 seam → 不抛、纯基座（即便档案带 knowledge）', async () => {
    const b = makeHost()
    delete (b.host as { resolveKnowledgeBases?: unknown }).resolveKnowledgeBases
    const spec = await rootSpec(b, { profile: { ...KB_PROFILE, projectAwareness: false } })
    expect(spec.systemPrompt).toBe('BASE PERSONA')
  })
})

/**
 * `systemContext` —— 调用方随本次创建给的上下文块（已围栏）。逐块以空行分隔追加在**项目注入之后**，
 * 空白块跳过。
 */
describe('deriveAgentSpec —— systemContext（调用方追加的上下文块）', () => {
  const BLOCK_A = '<bot_profile name="scout" file="/b/scout.md">\nP\n</bot_profile>'
  const BLOCK_B = '<extra>\nE\n</extra>'
  /** spawned 全开时的系统提示词（「spawned 全开」那条钉过的形状） */
  const FULL_APPENDS =
    'BASE PERSONA\n\n' +
    '<project_instructions file="CLAUDE.md">\nINS\n</project_instructions>\n\n' +
    '<project_prompt>\nPROJ-PROMPT\n</project_prompt>\n\n' +
    '<project_memory>\nPROJ-MEMORY\n</project_memory>'

  const spawnFull = (b: HostBundle, systemContext?: readonly string[]): Promise<AgentSpec> =>
    spawnedSpec(b, {
      sessionId: 'sub-9',
      profile: { ...PROFILE, projectAwareness: true },
      systemContext
    })

  it('CTX-1 各块按序追加在项目注入之后，逐块以空行分隔', async () => {
    const b = makeHost()
    const spec = await spawnFull(b, [BLOCK_A, BLOCK_B])
    expect(spec.systemPrompt).toBe(`${FULL_APPENDS}\n\n${BLOCK_A}\n\n${BLOCK_B}`)
  })

  it('CTX-2 空白块跳过（不留空段落）；块两端空白被 trim', async () => {
    const b = makeHost()
    const spec = await spawnFull(b, ['', '   \n\t', `\n  ${BLOCK_A}  \n`])
    expect(spec.systemPrompt).toBe(`${FULL_APPENDS}\n\n${BLOCK_A}`)
  })

  it('CTX-3 不传 / 空数组 / 全是空白块 → 系统提示词逐字节不变', async () => {
    for (const systemContext of [undefined, [], ['', '  ']]) {
      const b = makeHost()
      const spec = await spawnFull(b, systemContext)
      expect(spec.systemPrompt, JSON.stringify(systemContext)).toBe(FULL_APPENDS)
    }
  })

  it('CTX-4 root 列同样追加（与项目注入同一机制，不分 root/spawned）', async () => {
    const b = makeHost()
    const spec = await rootSpec(b, {
      profile: { ...PROFILE, instructionFiles: [] },
      systemContext: [BLOCK_A]
    })
    expect(spec.systemPrompt).toBe(`BASE PERSONA\n\n${BLOCK_A}`)
  })
})

/**
 * 工具名单归一（TN）—— 档案 `shuvix-tools` 声明的一切（内置名 / mcp: / skill:）对 root 与 spawned
 * **恒生效**；root 会话的勾选（`toolOverlay`，只收 mcp:/skill:）只能往上**加**：既去不掉档案声明的
 * 项，也带不进一个内置工具名。同一份名单喂给变量表（`promptVars` 的 `toolNames`）与工具解析。
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

  it('TN-5 变量表与规格读同一份名单：promptVars 恰调一次，toolNames 等于规格的 toolNames', async () => {
    const root = makeHost()
    const rootVars = vi.fn((_ctx: PromptVarsCtx) => ({ persona: 'PERSONA' }))
    root.host.promptVars = rootVars
    const rootSpecOut = await createRoot(root, ['skill:sel', 'bash'])
    expect(rootVars).toHaveBeenCalledTimes(1)
    expect(rootVars).toHaveBeenCalledWith({
      sessionId: 's1',
      kind: 'root',
      cwd: '/w',
      toolNames: rootSpecOut.toolNames
    })
    // 被 overlay 滤掉的内置名同样不会出现在变量表的判断依据里
    const rootCtx = rootVars.mock.calls[0][0]
    expect(rootCtx.toolNames).toEqual(['read', 'mcp:prof', 'skill:prof', 'agent', 'skill:sel'])
    expect(rootCtx.toolNames).not.toContain('bash')

    const spawned = makeHost()
    const spawnedVars = vi.fn((_ctx: PromptVarsCtx) => ({ persona: 'PERSONA' }))
    spawned.host.promptVars = spawnedVars
    const spawnedSpecOut = await createSpawned(spawned)
    expect(spawnedVars).toHaveBeenCalledTimes(1)
    expect(spawnedVars).toHaveBeenCalledWith({
      sessionId: 'sub-1',
      kind: 'spawned',
      cwd: '',
      toolNames: P
    })
    expect(spawnedSpecOut.toolNames).toEqual(P)
  })
})

/**
 * 内置权限审查员（permission-reviewer）走同一条派生 —— 它的「什么都不要」全由档案表达，这里验的是
 * 派生照办：宿主的注入 seam 备好了内容也一个都不调、系统提示词就是正文、工具名单为空、档位按档案压到 low。
 */
describe('deriveAgentSpec —— 内置权限审查员（permission-reviewer）', () => {
  it('PRV-C1 内置 md → toInProcessAgentType → spawned 派生：四个注入 seam 都有内容可给也零调用；系统提示词逐字节等于正文；名单为空；派发方 high → 运行时 low', async () => {
    const built = buildBuiltinProfile(PERMISSION_REVIEWER_SPEC, { readMd: createInlineMdReader() })
    expect(built).not.toBeNull()
    // makeHost 的四个注入 seam 缺省都答得出内容 —— 零调用因此只能是档案不要，不是宿主没给
    const b = makeHost()
    const spec = await spawnedSpec(b, {
      sessionId: 'sub-reviewer',
      profile: toInProcessAgentType(built!),
      model: { ...MODEL_CFG, thinkingLevel: 'high' },
      thinkingLevel: 'high'
    })

    expect(b.resolveInstruction).not.toHaveBeenCalled()
    expect(b.resolveProjectPrompt).not.toHaveBeenCalled()
    expect(b.resolveKnowledgeBases).not.toHaveBeenCalled()
    expect(b.resolveProjectMemory).not.toHaveBeenCalled()
    // 没有占位符、没有注入、没有调用方上下文块：系统提示词就是那段审查规则
    expect(spec.systemPrompt).toBe(built!.systemPrompt)
    expect(spec.toolNames).toEqual([])
    // 档案的 shuvix-thinking: low 压过派发方的 high
    expect(spec.thinkingLevel).toBe('low')
  })
})
