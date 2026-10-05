/**
 * 会话宿主（SessionHost）的注入接口 —— durable 核心不认识 Electron、不认识 node:sqlite：
 * 存储怎么开、在哪、算不算临时会话、钉不钉住，都由宿主回答。
 *
 * 桌面（P1-10）：openStorage = 动态 import node:sqlite 打开 `<sessionsDir>/<id>.sqlite`（临时会话给
 * MemoryStorage）；isPinned = 会话有活着 / 在建 / 关停中的运行时；onRunStateChange 写 DB 的运行标记；
 * onLockChange 写 DB 的锁镜像（`settings.agentLocked`）。
 *
 * 系统提示词活段落的宿主 seam（`PromptHost`）也在这里定义（P1-08；桌面 P1-11 实现），
 * 以及创建 agent（锁，P1-09）要用的三组 seam：工具（`ToolHost`）、会话配置（`AgentConfig`）、
 * 模型目录（`ModelCatalog`）。桌面 P1-10 / P1-11 实现。
 */
import type { Models } from '@earendil-works/pi-ai'
import type {
  ConversationId,
  HarnessOptions,
  Registry,
  Storage,
  ToolRegistration
} from '@earendil-works/pi-durable'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import type { AgentKind, PromptVars, PromptVarsCtx } from '../agentProfile/promptVars'
import type { McpToolDeclaration } from '../mcpManager'
import type { LockModel, ModelSelection } from '../models/lockModel'
import type { ModelRegistry } from '../models/modelRegistry'
import type { ProviderCredentialPort } from '../models/port'
import type { InProcessAgentType } from '../subagent/types'
import type { RuntimeEventSink, RuntimeLogger } from '../types'
import type { SpawnedAgentRecord } from './agentRecord'
import type { DrivenSettledEvent } from './durableSession'
import type { LockRecord } from './lock'
import type { ShuviXSettingsOverrides } from './settings'

/**
 * 一条会话（一个存储）此刻的运行状态（裁决 R2）：
 *  - `busy`：调度器在跑且有活着的任务（运行中、后台压缩等）；
 *  - `interrupted`：存储里有未完成的 run，但调度器停着（上个进程中途退出，重新打开后从不自动续跑）；
 *  - `idle`：其余情况。
 */
export type RunState = 'idle' | 'busy' | 'interrupted'

/**
 * 中断会话上收到用户发送时怎么办（裁决 R5；用户 2026-10-04 定为 abort-then-send，另一种保留为可切换选项）：
 *  - `abort-then-send`（默认）：中止被中断的那件事（上个进程留下的排队输入随之撤回），再发送；
 *  - `continue-then-queue`：先让被中断的 run 跑完，用户的消息作为 follow-up 排在它后面。
 */
export type InterruptedSendPolicy = 'abort-then-send' | 'continue-then-queue'

export const DEFAULT_INTERRUPTED_SEND_POLICY: InterruptedSendPolicy = 'abort-then-send'

/** LRU 保留的空闲会话数上限（与旧 sessionTreeRegistry 相同） */
export const DEFAULT_MAX_IDLE_OPEN = 8

/** 系统通知自动续跑的合并窗口（几条后台任务同一时刻跑完时只起一轮） */
export const DEFAULT_NOTICE_COALESCE_MS = 500

export interface SessionHostDeps {
  /** pi-ai 模型访问（生成用；压缩窗口也按它查锁定模型的 contextWindow） */
  models: Models
  /**
   * 每会话一个扩展注册表（K1）：打开时调用，关闭 / 删除时丢弃。宿主可以预装别的扩展（不会被选中 ——
   * 锁总是配置显式的扩展清单）；段落扩展、`shuvix.builtin` 与 `shuvix.agent.<对话>` 由运行时装。
   * 缺省 = durable 的 `createRegistry()`。根对话的 id 在每个存储里都是 1，所以注册表不能跨会话共享。
   */
  createRegistry?: (sessionId: string) => Registry<ToolRegistration>
  /** 工具的宿主 seam（内置工具 / 按 agent 解析 / 按锁重建） */
  toolHost: ToolHost
  /** 创建 agent 那一刻读一次的会话配置（档案、扩展勾选、模型选择、思考档位、工作目录） */
  resolveAgentConfig: (sessionId: string) => AgentConfig | Promise<AgentConfig>
  /** 模型选择的解析（K5）：注册表 + provider 行（启用位现读） */
  modelCatalog: ModelCatalog
  /** 系统提示词活段落的 seam（缺省 = 都不实现，只有人设段落） */
  promptHost?: PromptHost
  /** 人设冻结时的变量表（缺省 = 空表） */
  promptVars?: (ctx: PromptVarsCtx) => PromptVars | Promise<PromptVars>
  /**
   * 锁状态镜像（K11）：创建后 true、销毁 / 打开时自动清锁后 false，**每次打开都调用一次**对账
   * （治好 DB 与存储之间的漂移）。抛错只记日志，从不影响创建 / 销毁本身。
   */
  onLockChange?: (sessionId: string, locked: boolean) => void
  /** 打开（不存在则创建）某会话的存储 */
  openStorage: (sessionId: string) => Promise<Storage>
  /** 该会话的存储是否存在（peek 用它判断「不创建」；临时会话 = 内存存储是否还在） */
  storageExists: (sessionId: string) => boolean | Promise<boolean>
  /** 删除该会话的存储（文件连同 -wal / -shm；临时会话丢弃内存存储）。调用时会话已关闭 */
  deleteStorage: (sessionId: string) => Promise<void>
  /** 临时（内存）会话：永不被 LRU 关闭，也不占名额 */
  isEphemeral?: (sessionId: string) => boolean
  /** 宿主钉住的会话不被 LRU 关闭（抛错按钉住处理） */
  isPinned?: (sessionId: string) => boolean
  /** LRU 保留的空闲会话数（只数可回收的那些）；缺省 8 */
  maxIdleOpen?: number
  /** 每个 Harness 的 settings 覆盖（测试关掉重试 / 自动压缩） */
  settingsOverrides?: ShuviXSettingsOverrides
  /** 执行环境构造（durable 的 `HarnessOptions.env`） */
  env?: HarnessOptions['env']
  /** 额外的对话创建钩子（ShuviX 文档补种之后运行） */
  conversationCreated?: HarnessOptions['conversationCreated']
  /** 询问的广播与「有没有前端能展示询问面板」 */
  eventSink: RuntimeEventSink
  /**
   * 运行状态变化（idle / busy / interrupted）。关停一个忙碌的会话**不**发事件（DB 里的运行标记
   * 要能熬过退出）；**每次打开都报一次**此刻的状态（PIN-R：空闲重开也报 `idle`，治好崩溃留下的
   * busy 标记；被中断的会话报 `interrupted`）。抛错只记日志。
   */
  onRunStateChange?: (sessionId: string, state: RunState) => void
  /** 中止时、在中止对话之前调用（桌面：abortSessionReviews —— 进行中的自动审查当场作废） */
  beforeAbort?: (sessionId: string) => void
  /** 起跑路径重新受理询问时调用（桌面：reopenSessionReviews） */
  onInputsReopened?: (sessionId: string) => void
  /** 中断会话上的用户发送策略；缺省 abort-then-send（R5） */
  interruptedSendPolicy?: InterruptedSendPolicy
  /**
   * 自动续跑开关（现读）：只有修剪后字面量为 'false'（或布尔 false）才关闭，缺省 / 写坏都按开。
   */
  autoResume?: (sessionId: string) => unknown
  /** 通知合并窗口（毫秒）；缺省 500 */
  noticeCoalesceMs?: number
  /** durable 报告的扩展失败（不影响调用本身） */
  onReport?: (sessionId: string, error: unknown) => void
  logger?: RuntimeLogger
  /** 时钟（durable 的 `now`；日期通知里「上一条消息在多久之前」也按它算） */
  now?: () => number
  /**
   * 今天的本地日期（`YYYY-MM-DD`，桌面传 `() => localDate()`）。给了才发日期通知：每次用户输入之前，
   * 对话里已有条目且日期与上次告知的不同 → 先写一条 `shuvix.notice`（kind `date`，裁决 Q14）。
   * 缺省 = 不发（测试默认关闭，需要的用例自己注入一个确定的日期）。
   */
  today?: () => string
  /**
   * 子会话被驱动的那一轮落定了（P2-09，`SessionState.driven`）：完成 / 出错 / 被中止都算。进程内由提交
   * 发布察觉，打开时由扫描察觉（`open()` 落定之后才调用，从不续跑任何东西）。**每个进程至多一次**；
   * 回调成功后运行时清掉标记，抛错 / 拒绝 = 记警告、留着标记，下次打开（新进程）再来。通知文案、
   * 前台等待者的去重、打开父会话并 `notify(text, { requestId: e.noticeRequestId })` 都是宿主的事。
   * 缺省 = 不察觉（标记留着，等接了它的进程打开时再送）。
   */
  onDrivenSettled?: (event: DrivenSettledEvent) => void | Promise<void>
  /**
   * 派生 agent 档案的 `shuvix-model`（原样值）→ 模型选择（provider = provider 行 id，P2-03；桌面
   * `resolveProfileModelSpec`）。选择再经 `resolveLockModel` 校验；返回 null / 抛错 / 被拒都回落调用方的
   * 模型并记一次警告。缺省 = 不支持档案模型（静默回落）。
   */
  resolveProfileModel?: (
    spec: string
  ) => ModelSelection | null | undefined | Promise<ModelSelection | null | undefined>
  /** 派生层级上限（缺省 `MAX_AGENT_DEPTH` = 2；根 = 0，它的子 agent = 1） */
  maxAgentDepth?: number
}

/** bot 段落的内容：一块（通常是 `renderBotContext` 的输出）、若干块、或者没有 */
export type BotContextBlocks = string | readonly string[] | null | undefined

/**
 * 系统提示词**活段落**的宿主 seam（P1-08；桌面在 P1-11 的 agentHost 里实现）。
 *
 * 人设在创建 agent 时冻结进 `AgentStateDoc`，不经这里；其余五段在**每次请求准备时**现调这些 seam
 * （durable 只把变化了的段落作为 `pi.system` 增量重发，所以内容不变就没有代价）。全部按根会话 id
 * 解析 —— 派生 agent 用它根会话的项目上下文。返回**原文**，围栏与修剪由段落统一加；
 * 不实现某个 seam = 那一段恒缺席。抛错时 durable 保留该段上一次的内容并报告。
 */
export interface PromptHost {
  /**
   * 指令文件：`candidates` 是档案 `shuvix-instruction-files` 的清单（顺序即优先级），宿主按序取第一个
   * 存在且非空的，至多一个。cwd 是对话 agent 的工作目录（未配置时为空串，宿主按会话兜底）。
   */
  resolveInstruction?: (
    rootSessionId: string,
    cwd: string,
    candidates: readonly string[]
  ) =>
    | { filename: string; content: string }
    | null
    | Promise<{ filename: string; content: string } | null>
  /** 项目提示词（项目设置里的纯文本；无项目 → null） */
  resolveProjectPrompt?: (rootSessionId: string) => string | null | Promise<string | null>
  /** 知识库引导（这条会话勾选的库；一个都没有 → null） */
  resolveKnowledgeBases?: (rootSessionId: string) => string | null | Promise<string | null>
  /** 只读的旧项目记忆索引（渲染好的正文；无项目 / 无记忆 → null） */
  resolveProjectMemory?: (rootSessionId: string) => string | null | Promise<string | null>
  /**
   * bot 会话根 agent 的 `<bot_profile>` 块（`renderBotContext` 的输出；绑定的 md 不在了 → null）。
   * 可以给多块：每块修剪、空白块跳过、块间空一行（旧 `systemContext` 的口径）。
   */
  resolveBotContext?: (rootSessionId: string) => BotContextBlocks | Promise<BotContextBlocks>
}

// ─────────────────────────── 锁（P1-09）的 seam ───────────────────────────

/** 模型目录：解析会话的模型选择用（`resolveLockModel` 的两个输入） */
export interface ModelCatalog {
  /** 模型注册表（`modelRefOf` 把 provider 行 id 译成 pi provider id；`models` 校验模型存在） */
  registry: Pick<ModelRegistry, 'models' | 'modelRefOf'>
  /** provider 行（启用位现读） */
  port: Pick<ProviderCredentialPort, 'listProviders'>
}

/**
 * 创建 agent 那一刻读一次的会话配置（桌面 P1-10：sessions.settings + 会话形态派生的基座档案）。
 * 锁住之后它怎么变都不影响这个 agent —— 要生效就销毁 agent，下一次发送按那时的配置重建。
 */
export interface AgentConfig {
  /** 会话的基座档案（form-derived：work / chat / notebook / bot / tab …） */
  profile: InProcessAgentType
  /** 会话的扩展勾选（`settings.enabledTools`，只收 mcp: / skill:） */
  toolOverlay?: readonly string[]
  /** 会话的模型选择（provider = provider 行 id）；默认模型由宿主先套上，没有就拒绝创建 */
  model?: ModelSelection
  /** 思考档位（锁里只记创建时的值；之后的调整走 `setThinkingLevel`，现读） */
  thinkingLevel?: ThinkingLevel
  /** 会话的工作目录（K17：写进 `pi.agent.cwd`；空串 = 不写，段落按会话兜底） */
  cwd?: string
}

/** 内置工具（`shuvix.builtin`）的构造请求：打开时 sandboxed 来自锁（没锁 = undefined），创建时来自解析结果 */
export interface BuiltinToolsRequest {
  sessionId: string
  /** 命令沙箱的钉子（K8）；undefined = 还没有 agent，宿主按当前设置给一份占位 */
  sandboxed?: boolean
}

/**
 * 按 agent 解析工具的请求（创建那一刻）。root 与派生 agent 共用这一个形状（平铺的可选字段，PIN-01）：
 *
 *  - **root**（锁）：带 `conversationId`；不带 `agentId` / `canSpawn` / `extraTools`（PIN-02）。名单含
 *    `agent` 就给派发工具 —— root 的派发工具不看 `canSpawn`。
 *  - **派生**（`kind: 'spawned'`，P2-03 的协调器发起）：**没有** `conversationId`（工具在创建子对话的
 *    那个提交之前解析，子对话还不存在）；`agentId` 是派生 agent 的 id，`selfSessionId` 暂与它相同
 *    （P2-05 去掉 selfSessionId）；`canSpawn` 决定给不给派发工具 —— 缺省按 false（失败即关）；
 *    `extraTools` 是运行时已实例化的附加工具（结果契约的 `next`），宿主包好原样交回。
 *
 * 派发工具给不给，宿主统一用 `offersDispatchTool(request)` 判。
 */
export interface AgentToolsRequest {
  /** 会话（存储）id —— 宿主资源（MCP、包装器、按 agent 的工具）都按它找，从不按 agentId（PIN-10） */
  sessionId: string
  /** 这个 agent 所在的对话（root = 上锁时的当前对话，K20）；派生 agent 解析时子对话还不存在 → 缺省 */
  conversationId?: ConversationId
  kind: AgentKind
  /** 询问 / 项目配置 / 输出落盘的归属会话（root = 自身） */
  rootSessionId: string
  /** 这个 agent 自己的 id（派发工具的 parentSessionId；root = 会话 id；派生 = agentId） */
  selfSessionId: string
  /** 派生 agent 的 id（`sub-<uuid>`）；root 不带 */
  agentId?: string
  /**
   * 派生 agent 还能不能再派生（`canSpawnAt(depth)`）：true 且名单含 `agent` 才给派发工具；缺省 = false。
   * root 不带，宿主对 root 也不看它（PIN-02）。
   */
  canSpawn?: boolean
  profile: InProcessAgentType
  /** 归一后的工具名单（档案全量 + 会话勾选，保序去重） */
  names: readonly string[]
  /** 锁定的模型（派发工具跟随它） */
  model: LockModel
  thinkingLevel?: ThinkingLevel
  /** 工作目录（可为空串） */
  cwd: string
  /**
   * 已实例化的附加工具（派生 agent 的 `next`）：宿主包好放进 `ResolvedAgentTools.extraTools`
   * （排在宿主自己的附加工具之前）；root 的锁拒绝附加工具
   */
  extraTools?: readonly ToolRegistration[]
}

/**
 * 派发工具（`agent`）给不给：名单含 `agent`，且是 root（root 不看 canSpawn，PIN-02）或 `canSpawn === true`
 * （派生 agent 缺省按 false，失败即关，PIN-01）。重建时传锁 / 记录的 `toolNames` 作 `names`。
 */
export function offersDispatchTool(input: {
  readonly kind: AgentKind
  readonly names: readonly string[]
  readonly canSpawn?: boolean
}): boolean {
  return input.names.includes('agent') && (input.kind === 'root' || input.canSpawn === true)
}

/** 一个 agent 的按 agent 工具（装进 `shuvix.agent.<对话>`）；运行时按 K6 的次序拼 */
export interface AgentToolSet {
  /** 派发工具（名单含 `agent` 时） */
  agent?: ToolRegistration
  /** 技能工具（有技能可给时） */
  skill?: ToolRegistration
  /** MCP 工具：服务器一台接一台，台内按工具次序 */
  mcp?: readonly { readonly server: string; readonly tools: readonly ToolRegistration[] }[]
  /** 宿主的其它按 agent 工具（排在 MCP 之后） */
  tools?: readonly ToolRegistration[]
  /**
   * 附加工具（同名者先从前面各段移除再追加，K6）：派生 agent 的 `next` —— 解析时来自请求的
   * `extraTools`，重建时来自重建上下文的 `extraTools`，宿主包好原样交回。root 的锁拒绝附加工具。
   */
  extraTools?: readonly ToolRegistration[]
}

/**
 * 重建（重开会话 / 派生 agent 复活）时的上下文：
 *  - `sessionId`：会话（根）id —— 宿主资源按它找，从不按 agentId（PIN-10）；
 *  - `extraTools`：运行时按记录造好的附加工具（`resultContractTools(record.resultContract)`，PIN-03 R）；
 *    宿主包好放进 `AgentToolSet.extraTools`。root 的锁重建从不带它。
 */
export interface AgentToolsRebuildContext {
  readonly sessionId: string
  readonly extraTools?: readonly ToolRegistration[]
}

/** 创建时的解析结果：工具 + 要记进锁里的东西 */
export interface ResolvedAgentTools extends AgentToolSet {
  /** 只含**连上了**的服务器（K7：连不上的不记，下次创建再试），各带声明快照（纯 JSON） */
  mcp?: readonly {
    readonly server: string
    readonly declarations: readonly McpToolDeclaration[]
    readonly tools: readonly ToolRegistration[]
  }[]
  /** 技能工具列出的技能（记进锁，重建时按它造技能工具） */
  skills?: readonly string[]
  /** 命令沙箱钉子（K8），记进锁；`shuvix.builtin` 按它重装 */
  sandboxed: boolean
}

/**
 * 工具的宿主 seam（桌面 P1-11：agentHost 改写）。
 *
 *  - `buildBuiltinTools`：平台内置工具（会话级 ToolContext，外面包好输出包装）。打开时装一次
 *    （有锁按锁的沙箱钉子），创建 agent 时按解析出的钉子重装。
 *  - `resolveAgentTools`：创建 agent 时按名单解析按 agent 的工具 —— 派发工具、技能工具、MCP（这一刻
 *    惰性连接；`mcp_connecting` / 连不上的 `error` 由宿主自己广播，K7）。`signal` 在创建被中止 / 销毁
 *    时触发（K13），要一路透传给 MCP 连接。
 *  - `rebuildAgentTools`：重开会话时**按记录**重建同一组工具 —— root 按锁记录，派生 agent 按它的
 *    `SpawnedAgentRecord`（`canSpawn` 决定派发工具；`context.extraTools` 是运行时按结果契约造好的
 *    `next`）。不连服务器（MCP 按声明快照建，第一次调用时原地连），不读会话配置。
 */
export interface ToolHost {
  buildBuiltinTools(
    request: BuiltinToolsRequest
  ): readonly ToolRegistration[] | Promise<readonly ToolRegistration[]>
  resolveAgentTools(
    request: AgentToolsRequest,
    options: { readonly signal: AbortSignal }
  ): Promise<ResolvedAgentTools>
  rebuildAgentTools(
    record: LockRecord | SpawnedAgentRecord,
    context: AgentToolsRebuildContext
  ): AgentToolSet | Promise<AgentToolSet>
}
