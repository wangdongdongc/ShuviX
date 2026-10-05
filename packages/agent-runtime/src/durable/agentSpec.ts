/**
 * agent 规格的纯派生 —— 从 agentProfile/createAgent.ts 抽出来的那一半（P1-01）。
 *
 * 以 agent 档案（md 基座）+ 运行时选择（模型 / 思考档位 / 会话工具 overlay）派生出「这个 agent 是什么」：
 * 初始模型、思考档位、归一后的工具名单。这里不碰任何运行时 —— 构造运行时（根 agent 的锁、今后派生
 * agent 的 durable 子对话）是调用方的事。
 *
 * root（会话根 agent）与 spawned（派生 agent）的差异集中在一张决策表里，不散落 if-else：
 *
 * | 项        | root                                    | spawned                             |
 * |-----------|-----------------------------------------|-------------------------------------|
 * | 初始模型   | params.model（会话设置为准）             | 档案 shuvix-model 优先，否则继承     |
 * | 思考档位   | params.thinkingLevel                    | 档案 shuvix-thinking 优先，否则继承  |
 * | 工具名单   | 档案全量 + 会话勾选（只收 mcp:/skill:）  | 档案全量 + overlay                  |
 *
 * 系统提示词不在这里拼：人设在创建 agent 时冻结（`prompt/persona.ts`），其余注入各是一个现解析的段落扩展
 * （`prompt/sections.ts`，选择 = `promptExtensionsFor(spec)`），逐字节对照 `__tests__/fixtures/system-prompts/`。
 * 锁（`lock.ts`，P1-09）取这里的 `normalizeToolNames` / `resolveThinkingLevel`。旧运行时的那半张表（会话存储、
 * 自动压缩、广播 user_message、输入面板、工具结果变换、请求日志归属）随 HarnessSession 一起退场了。
 */
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import type { RuntimeLogger } from '../types'
import type { InProcessAgentType, SubAgentModelConfig } from '../subagent/types'
import type { SpawnContext } from '../agentProfile/createAgent'
import type { AgentKind } from '../agentProfile/promptVars'

/** 派生规格要用到的宿主 seam（AgentHostAdapter 的子集） */
export interface AgentSpecHost {
  /**
   * 解析档案声明的模型（`shuvix-model` 原样值 → provider/model/能力点）。
   * 仅 spawned 调用（root 的模型以会话设置为准）。宿主对着自己的模型目录解析
   * （规则见 `@shuvix/chat-protocol/agentModelRef`）；不可用（提供商停用 / 模型已删）
   * 返回 null —— 此时回落派发方传入的模型，不阻断派发。
   */
  resolveProfileModel?: (
    spec: string
  ) => SubAgentModelConfig | null | Promise<SubAgentModelConfig | null>
  logger?: RuntimeLogger
}

/** 派生规格的输入（CreateAgentParams 里与「这个 agent 是什么」有关的那几项） */
export interface AgentSpecParams {
  kind: AgentKind
  /** root=会话 id；spawned=agentId（sub-<uuid>） */
  sessionId: string
  /** 运行投影（getAgentProfile(...) 经 toInProcessAgentType 投影，或宿主就地组装） */
  profile: InProcessAgentType
  /** 初始模型配置（会话解析值 / 派发方传入） */
  model: SubAgentModelConfig
  /** 已解析的思考档位（root=会话设置；spawned=派发方的，缺省 'off'） */
  thinkingLevel?: ThinkingLevel
  /** 会话级工具 overlay（mcp:/skill: 勾选）；spawned 缺省 [] */
  toolOverlay?: readonly string[]
  /** kind='spawned' 必传 */
  spawn?: SpawnContext
}

/** 派生出来的 agent 规格 */
export interface AgentSpec {
  kind: AgentKind
  sessionId: string
  /** 询问 / 项目配置 / 输出落盘的归属会话（root=自身；spawned=所属根会话） */
  rootSessionId: string
  profile: InProcessAgentType
  /** 初始模型（决策表的模型一行） */
  model: SubAgentModelConfig
  /** 运行时档位（决策表的思考一行） */
  thinkingLevel?: ThinkingLevel
  /** 归一后的工具名单（保序去重）—— 变量表与工具解析读的是同一份 */
  toolNames: string[]
}

/** 会话级工具（用户能在工具选择器里勾选的那两类）；其余为内置工具名 + 'agent' */
const isSessionScopedTool = (name: string): boolean =>
  name.startsWith('mcp:') || name.startsWith('skill:')

/**
 * 名单归一：档案白名单 + 会话勾选 overlay，去重保序。
 *
 * 档案的 `shuvix-tools` 对内置 / mcp / skill 三类是**一并声明**的，而且三类都**恒生效** ——
 * root 与 spawned 同一条规则：档案写了什么，这个 agent 就带什么。会话勾选只能往上**加**：
 *  - 内置工具名恒由档案决定（选择器里本就看不到它们）；
 *  - mcp: / skill: 档案声明的那截恒在，会话勾选在其上叠加。选择器与会话设置把档案声明的项
 *    画成「已勾、锁住」（`tools.list` 的 `declaredBy`）—— 界面上取消不了，也就不存在
 *    「取消了却被档案并集加回来」的假勾选。要去掉一项，路径是覆盖这份档案 md。
 *  - root 的 overlay **只收** mcp: / skill:：勾选里混进一个内置名（手改的设置、被新会话继承的
 *    项目配置）不能借 overlay 越过档案 —— bot 基座的窄名单因此是结构保证。
 *  - spawned 没有选择器也没有会话设置，档案即全部（overlay 恒为空）。
 *
 * 于是 `shuvix-tools` 加上会话勾选就是 agent 工具表的完整列举：宿主不在这份名单之外另挂工具
 * （内置技能也要档案点名 `skill:builtin:<name>` 才上架）。
 */
export function normalizeToolNames(
  kind: AgentKind,
  profileTools: readonly string[],
  overlay: readonly string[] | undefined
): string[] {
  const added = kind === 'root' ? (overlay ?? []).filter(isSessionScopedTool) : (overlay ?? [])
  return [...new Set([...profileTools, ...added])]
}

/**
 * 初始模型（决策表的模型一行）。
 *
 * root：以传入值为准（会话设置是唯一事实源；档案模型在「钉档案」时作为种子写进去，
 *       否则每次重建都会把用户手选的模型默默还原）。
 * spawned：档案声明优先于派发方继承 —— 派生 agent 既无会话设置也无模型选择器。
 *       思考档位是独立的一行（见 resolveThinkingLevel），档案不声明时仍随派发方。
 * 宿主没注入解析器（resolveProfileModel 可选）时同样回落，但不告警 ——
 * 那是「本端不支持档案模型」，不是「这个模型不可用」，混为一谈会误导排障。
 */
export async function resolveInitialModel(
  host: Pick<AgentSpecHost, 'resolveProfileModel' | 'logger'>,
  params: Pick<AgentSpecParams, 'kind' | 'profile' | 'model'>
): Promise<SubAgentModelConfig> {
  const { kind, profile } = params
  const canResolveDeclared = kind === 'spawned' && !!profile.model && !!host.resolveProfileModel
  const declaredModel = canResolveDeclared ? await host.resolveProfileModel!(profile.model!) : null
  if (canResolveDeclared && !declaredModel) {
    host.logger?.warn(
      `agent "${profile.name}" 声明的模型 "${profile.model}" 当前不可用，回落派发方模型`
    )
  }
  return declaredModel
    ? { ...declaredModel, thinkingLevel: params.model.thinkingLevel }
    : params.model
}

/**
 * 思考档位（决策表的思考一行，与模型一行同一口径）。
 *
 * root：以传入值为准（会话设置；档案的 `shuvix-thinking` 只在钉档案时作为种子写进去）。
 * spawned：档案声明优先于派发方继承。没有可用性问题要处理：档位是个枚举值，模型不支持
 *       思考时与界面选了档位同一条路径（pi 按模型能力取舍）。
 */
export function resolveThinkingLevel(
  kind: AgentKind,
  profile: InProcessAgentType,
  requested: ThinkingLevel | undefined
): ThinkingLevel | undefined {
  return kind === 'spawned' && profile.thinkingLevel ? profile.thinkingLevel : requested
}

/** 派生完整的 agent 规格 */
export async function deriveAgentSpec(
  host: AgentSpecHost,
  params: AgentSpecParams
): Promise<AgentSpec> {
  const { kind, sessionId, profile, spawn } = params
  if (kind === 'spawned' && !spawn) {
    throw new Error('createAgent: kind="spawned" requires spawn context')
  }
  const rootSessionId = kind === 'root' ? sessionId : spawn!.rootSessionId
  const model = await resolveInitialModel(host, params)
  const thinkingLevel = resolveThinkingLevel(kind, profile, params.thinkingLevel)
  // 变量表（人设冻结时）与工具解析读的是**同一份**名单：提示词里提到某项能力（去加载哪个技能、
  // 用哪个工具改图）只能以它真在这份名单上为前提 —— 两边各算各的，迟早一边指向另一边没有的东西
  const toolNames = normalizeToolNames(kind, profile.tools, params.toolOverlay)
  return { kind, sessionId, rootSessionId, profile, model, thinkingLevel, toolNames }
}
