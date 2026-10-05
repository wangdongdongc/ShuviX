/**
 * agent 规格的纯派生 —— 从 agentProfile/createAgent.ts 抽出来的那一半（P1-01）。
 *
 * 以 agent 档案（md 基座，内嵌 {{shuvix:*}} 占位符）+ 运行时选择（模型 / 思考档位 / 会话工具
 * overlay）派生出「这个 agent 是什么」：初始模型、思考档位、归一后的工具名单、组装好的系统提示词，
 * 以及 root（会话根 agent）与 spawned（派生 agent）的运行期差异。这里不碰任何运行时 ——
 * 构造运行时（旧 HarnessSession，今后的 pi-durable 会话）是调用方的事。
 *
 * root / spawned 的差异集中在一张决策表里，不散落 if-else：
 *
 * | 项                        | root                         | spawned                          |
 * |---------------------------|------------------------------|----------------------------------|
 * | 初始模型                   | params.model（会话设置为准）  | 档案 shuvix-model 优先，否则继承  |
 * | 思考档位                   | params.thinkingLevel         | 档案 shuvix-thinking 优先，否则继承 |
 * | 工具名单                   | 档案全量 + 会话勾选（只收 mcp:/skill:） | 档案全量 + overlay       |
 * | 会话存储                   | 持久化                        | 内存（销毁即消失）                |
 * | 自动压缩                   | 开                            | 关                               |
 * | 广播 user_message          | 开                            | 关（面板经 sub_session_* 展示）   |
 * | 自己的用户输入面板          | 有                            | 无（询问经 helpers 路由到根会话）  |
 * | 宿主的工具结果变换          | 应用                          | 不应用（现状）                    |
 * | LLM 请求日志归属            | 自身 sessionId               | spawn.rootSessionId              |
 *
 * 系统提示词的 durable 形态在 `prompt/`（P1-08）：人设创建时冻结（`prompt/persona.ts`），其余注入各是
 * 一个现解析的段落扩展（`prompt/sections.ts`，选择 = `promptExtensionsFor(spec)`），逐字节对照
 * `__tests__/fixtures/system-prompts/`。这里的 `assembleSystemPrompt` 是一次拼完的旧口径（指令文件不修剪），
 * 只剩 `AgentSpec.systemPrompt` 还在用它 —— 锁（`lock.ts`，P1-09）不用它：根 agent 的名单与思考档位取自
 * 这里的 `normalizeToolNames` / `resolveThinkingLevel`，提示词走分段。TODO(pi-durable p1): P1-13 删掉
 * `assembleSystemPrompt` 与 `AgentSpec.systemPrompt`。
 */
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { KNOWLEDGE_TOOL_NAME } from '../knowledge/knowledgeTool'
import type { RuntimeLogger } from '../types'
import type { InProcessAgentType, SubAgentModelConfig } from '../subagent/types'
import type { SpawnContext } from '../agentProfile/createAgent'
import {
  renderProfileSystemPrompt,
  type AgentKind,
  type PromptVars,
  type PromptVarsCtx
} from '../agentProfile/promptVars'
import {
  fenceInstructionFile,
  fenceKnowledgeBases,
  fenceProjectMemory,
  fenceProjectPrompt
} from './prompt/fences'

/** 派生规格要用到的宿主 seam（AgentHostAdapter 的子集） */
export interface AgentSpecHost {
  /** 创建期变量表（md body 经 {{shuvix:name}} 占位符引用；每次派生现算） */
  promptVars: (ctx: PromptVarsCtx) => PromptVars | Promise<PromptVars>
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
  /**
   * 指令文件解析（档案声明了非空清单时调用；同步 / 异步均可）。
   * sessionId 恒为根会话 id（派生 agent 按其根会话的项目上下文解析）；cwd 可为空串
   * （派生现状），宿主自行按 sessionId 兜底解析工作目录。
   *
   * `candidates` 是档案 `shuvix-instruction-files` 的清单（已归一的相对路径，
   * **顺序即优先级**）：宿主按序找第一个存在且非空的读出来，至多一个。
   * 「读哪些文件」的决定权全在档案，宿主没有自己的候选名表。返回**原文**，不要自带前缀 ——
   * 围栏由 fenceInstructionFile 统一加。
   */
  resolveInstruction?: (
    sessionId: string,
    cwd: string,
    candidates: readonly string[]
  ) =>
    | { filename: string; content: string }
    | null
    | Promise<{ filename: string; content: string } | null>
  /**
   * 项目提示词解析（profile.projectAwareness 时调用）：返回原文或 null，
   * 围栏由 fenceProjectPrompt 统一加。
   */
  resolveProjectPrompt?: (rootSessionId: string) => string | null | Promise<string | null>
  /**
   * 项目记忆索引解析（同样受 profile.projectAwareness 门控）：返回**渲染好的索引正文**或 null，
   * 围栏由 fenceProjectMemory 统一加。
   *
   * 与项目提示词共用一个开关、分成两个 seam：一个开关是因为它们表达同一个意图
   * （这个 agent 要不要知道自己在哪个项目里），两个 seam 是因为数据源与围栏都不同 ——
   * 一个来自项目设置的纯文本，一个是现扫记忆目录渲染出来的索引，且宿主可以只实现其中一个。
   *
   * 只收 rootSessionId、不收 cwd —— 记忆按项目绑定（无项目会话解析为 null）。
   */
  resolveProjectMemory?: (rootSessionId: string) => string | null | Promise<string | null>
  /**
   * 知识库引导解析（档案带 `knowledge` 工具时调用）：返回围栏正文或 null，围栏由
   * fenceKnowledgeBases 统一加。
   *
   * **不跟项目感知走**：库是用户按会话选的，与「知不知道自己在哪个项目里」无关。
   * 门只剩一道工具清单：这段文案通篇是 `knowledge` 工具的用法，档案不带这个工具时
   * 注入它就是在教一个够不着的东西。只收 rootSessionId（派生按根会话解析）。
   */
  resolveKnowledgeBases?: (rootSessionId: string) => string | null | Promise<string | null>
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
  /** 工作目录（root 必给；spawned 传 '' —— 工具自带执行环境） */
  cwd: string
  /** 会话级工具 overlay（mcp:/skill: 勾选）；spawned 缺省 [] */
  toolOverlay?: readonly string[]
  /** kind='spawned' 必传 */
  spawn?: SpawnContext
  /** 调用方追加到系统提示词末尾的上下文块（已围栏，逐块以空行分隔，排在项目注入之后） */
  systemContext?: readonly string[]
}

/** root / spawned 的运行期差异（决策表的后半张） */
export interface AgentRuntimeDecisions {
  /** 会话存储落盘（root）还是只在内存（spawned） */
  persistent: boolean
  /** 自动压缩（root 开；派生 agent 生命周期短，不开） */
  autoCompact: boolean
  /** user 消息落定后广播 user_message（派生 agent 的面板经 sub_session_* 展示，关） */
  broadcastUserMessages: boolean
  /** 自己有用户输入面板（root）；派生 agent 的询问经 helpers 路由到根会话 */
  ownsUserInput: boolean
  /** 应用宿主注入的工具结果变换（root；派生 agent 维持默认 passthrough，现状） */
  applyToolResultTransform: boolean
  /** LLM 请求日志的归属会话（root 记自身；spawned 归到根会话，在日志页可见） */
  logSessionId: string
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
  /** 组装好的完整系统提示词（档案正文 + 各注入围栏 + 调用方上下文块） */
  systemPrompt: string
  decisions: AgentRuntimeDecisions
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

/** root / spawned 的运行期差异（决策表的后半张） */
export function runtimeDecisions(
  kind: AgentKind,
  sessionId: string,
  rootSessionId: string
): AgentRuntimeDecisions {
  const root = kind === 'root'
  return {
    persistent: root,
    autoCompact: root,
    broadcastUserMessages: root,
    ownsUserInput: root,
    applyToolResultTransform: root,
    logSessionId: root ? sessionId : rootSessionId
  }
}

/**
 * 组装系统提示词：档案正文（占位符经变量表替换）→ 指令文件 → 项目提示词 → 知识库 → 项目记忆
 * → 调用方上下文块，各段以空行分隔、各自围栏。
 *
 * 不落独立消息。顺序不声明优先级（见 fences.ts）—— 只是固定的拼接次序。系统提示词不参与
 * 滚动压缩，天然免重注入；root / spawned 同管线，派生按根会话解析。
 */
export async function assembleSystemPrompt(
  host: AgentSpecHost,
  input: {
    kind: AgentKind
    sessionId: string
    rootSessionId: string
    profile: InProcessAgentType
    cwd: string
    toolNames: readonly string[]
    systemContext?: readonly string[]
  }
): Promise<string> {
  const { kind, sessionId, rootSessionId, profile, cwd, toolNames } = input
  let systemPrompt = renderProfileSystemPrompt(
    profile,
    await host.promptVars({ sessionId, kind, cwd, toolNames }),
    host.logger
  )
  if (profile.instructionFiles?.length && host.resolveInstruction) {
    const resolved = await host.resolveInstruction(rootSessionId, cwd, profile.instructionFiles)
    if (resolved?.content) {
      systemPrompt += `\n\n${fenceInstructionFile(resolved.filename, resolved.content)}`
    }
  }
  // 项目感知一个开关带两段注入（项目提示词、只读的旧项目记忆）：数据源与围栏各自独立，但
  // 「要不要知道自己在哪个项目里」只是一个决定；宿主未实现某个 seam 时那一段自然缺席。
  if (profile.projectAwareness && host.resolveProjectPrompt) {
    const text = (await host.resolveProjectPrompt(rootSessionId))?.trim()
    if (text) systemPrompt += `\n\n${fenceProjectPrompt(text)}`
  }
  // 知识库在前、项目记忆在后：前者是在用的库，后者是只读的旧档 —— 旧档的表头指回前者。
  // 这一段**不跟项目感知走**：库是按会话选的，无项目的会话照样有用户自己的库
  if (host.resolveKnowledgeBases && profile.tools?.includes(KNOWLEDGE_TOOL_NAME)) {
    const text = (await host.resolveKnowledgeBases(rootSessionId))?.trim()
    if (text) systemPrompt += `\n\n${fenceKnowledgeBases(text)}`
  }
  if (profile.projectAwareness && host.resolveProjectMemory) {
    const text = (await host.resolveProjectMemory(rootSessionId))?.trim()
    if (text) systemPrompt += `\n\n${fenceProjectMemory(text)}`
  }
  // 调用方给的上下文块（已围栏）：排在项目注入之后，同样住在系统提示词里、免重注入
  for (const block of input.systemContext ?? []) {
    const text = block.trim()
    if (text) systemPrompt += `\n\n${text}`
  }
  return systemPrompt
}

/** 派生完整的 agent 规格 */
export async function deriveAgentSpec(
  host: AgentSpecHost,
  params: AgentSpecParams
): Promise<AgentSpec> {
  const { kind, sessionId, profile, cwd, spawn } = params
  if (kind === 'spawned' && !spawn) {
    throw new Error('createAgent: kind="spawned" requires spawn context')
  }
  const rootSessionId = kind === 'root' ? sessionId : spawn!.rootSessionId
  const model = await resolveInitialModel(host, params)
  const thinkingLevel = resolveThinkingLevel(kind, profile, params.thinkingLevel)
  // 名单先于提示词算好：变量表与工具解析读的是**同一份**。提示词里提到某项能力（去加载哪个
  // 技能、用哪个工具改图）只能以它真在这份名单上为前提 —— 两边各算各的，迟早一边指向另一边没有的东西
  const toolNames = normalizeToolNames(kind, profile.tools, params.toolOverlay)
  const systemPrompt = await assembleSystemPrompt(host, {
    kind,
    sessionId,
    rootSessionId,
    profile,
    cwd,
    toolNames,
    systemContext: params.systemContext
  })
  return {
    kind,
    sessionId,
    rootSessionId,
    profile,
    model,
    thinkingLevel,
    toolNames,
    systemPrompt,
    decisions: runtimeDecisions(kind, sessionId, rootSessionId)
  }
}
