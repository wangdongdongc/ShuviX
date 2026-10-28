/**
 * 锁 —— 「这条会话有 agent」的显式状态（P1-09；裁决 Mapping #6、Q5、Q7、K1–K21）。
 *
 * durable 没有「运行时对象」可以创建 / 销毁：一个对话靠什么跑，全写在它的 `pi.agent` 文档里。
 * ShuviX 的「agent 存在」于是落成会话文档上的一条**锁记录**（`SessionStateDoc.lock`，权威来源；
 * DB 镜像 `settings.agentLocked` 只为界面便宜地读，经 `onLockChange` 同步）：
 *
 *  - **创建**（下一次发送 / steer / followUp / 自动续跑 / 继续时如果还没锁，K3；或显式 `createAgent()`）：
 *    读一次会话配置 → 解析模型（停用 / 未知 / 没选 → 拒绝，什么都不写，K4/K5）→ 按名单解析按 agent 的
 *    工具（这一刻惰性连 MCP）→ 在提交之外算好冻结的人设（变量表可能做 I/O）→ 重装 `shuvix.builtin`
 *    （沙箱钉子）并装上 `shuvix.agent.<对话>` → **一个提交**里写 `pi.agent`（模型、思考档位、显式扩展
 *    清单、显式工具清单、cwd）、冻结人设（AgentStateDoc）、锁记录。提交失败就把装上的扩展撤回 ——
 *    要么全有，要么全无。
 *  - **锁住期间工具只随重配而变**：MCP 掉线不卸它的工具（调用时原地重连），list_changed 只在下次创建时生效；
 *    思考档位是活的（K9，`pi.agent.thinkingLevel`）。会话的模型与扩展勾选改了 → **重配**（`reconfigure`，
 *    2026-10-26，规则见 `reconfigure.ts`）：一个提交里改 `pi.agent` 的模型与工具、锁记录（必要时人设），从
 *    下一次请求起生效（运行中也是）。锁里已有的工具原样沿用、新工具追加，次序按最小差异排；档案、工作目录、
 *    沙箱钉子不在重配之列（要变就销毁）。重配与创建 / 销毁串行；发送等在途的重配落定再起跑。
 *  - **销毁**（agent 芯片的 X、回退、清空）：忙 / 被中断就先中止（K10），再一个提交删锁、卸掉按 agent
 *    的扩展。`pi.agent` 不清（下一次创建整份覆盖），`shuvix.builtin` 不动（下一次创建重装，K8）。
 *    销毁算一次显式喊停（到下一次用户发送之前不自动续跑）。
 *  - **锁 = 「agent 在本进程里初始化过」**（option A，用户 2026-10-07）：宿主按会话记一份进程内记录
 *    （`SessionProcessRecord.agentInitialized`，LRU 关了再开也还在、换进程即空）；创建、打开时的完整初始化
 *    记下它，销毁 / 清锁撤掉它。
 *  - **重开**（K11/K12 + option A）：打开会话时、在任何续跑 / 发送之前，按存着的锁和进程内记录三选一：
 *    - 本进程里初始化过（LRU 关了再开）：按锁记录重建同一组工具（不读会话配置、不连服务器、不写
 *      `pi.agent`），与从前一样；
 *    - 不是（重启 / 崩溃之后），但有可续的工作（被中断、或有活着的派生子 agent / 工具任务 —— 由会话判定）：
 *      保留锁并**完整初始化**，等同创建那一刻 —— 重建工具、当场连锁记着的 MCP（连不上照样起来），记进
 *      进程内记录；
 *    - 不是，也没有可续的工作（空闲）：一个提交清掉锁（不续跑），什么都不建（连 `shuvix.builtin` 都不建），
 *      镜像对成 false，下一次发送按那时的配置重新创建。
 *    重建失败或锁记录写坏了：会话照样能打开、能看，锁经一个提交清掉（不续跑）并记警告，镜像对成
 *    false，下一次发送重新创建。
 *  - **内置工具是惰性的**：创建时按解析出的钉子装、保留锁时按锁的钉子装、派生 agent（创建 / 重建 / 面板
 *    追问 / 宿主派发）要用而还没装时按根锁的钉子（没锁 = 占位）装（`ensureBuiltin`）。
 *  - **创建与销毁串行**（每会话一把互斥）：并发的创建合流成一次；销毁先取消在途的创建（AbortSignal
 *    一路透传给 ToolHost / MCP 连接，K13）—— 被取消的创建什么都不写，发送当作被中止（`{}`）。
 *
 * 工具次序（K6）由这里拼：内置名按归一名单的次序（只收装了的 / 本平台有的）→ `agent` → `skill` →
 * MCP（服务器一台接一台、台内按工具）→ 宿主的其它按 agent 工具 → 附加工具（先移除同名再追加；root
 * 的锁拒绝附加工具 —— 重开时重建不出来，它们属于派生 agent，phase 2）。扩展清单：`shuvix.builtin`、
 * 段落扩展（`promptExtensionsFor` 的次序）、`shuvix.agent.<对话>` —— 永远显式（durable 的缺省是
 * 「全部已安装的扩展」）。
 */
import type { JsonValue } from '@earendil-works/chord'
import { getCurrentTools, type Message } from '@earendil-works/pi-ai'
import {
  configure,
  defineExtension,
  type Conversation,
  type ConversationId,
  type Extension,
  type Harness,
  type HookRegistration,
  type Registry,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import type { AgentKind, PromptVars, PromptVarsCtx } from '../agentProfile/promptVars'
import { resolveLockModel, type LockModelRefusalKind } from '../models/lockModel'
import type { RuntimeEventSink, RuntimeLogger } from '../types'
import { lockRecordJson, parseLockRecord, type LockRecord } from './agentRecord'
import { normalizeToolNames, resolveThinkingLevel } from './agentSpec'
import { backgroundContext as BG, errorText } from './context'
import { SessionStateDoc } from './docs'
import { emptyReplyHook } from './emptyReply'
import { computeFrozenAgentPrompt, freezePersona, type FrozenAgentPrompt } from './prompt/persona'
import type { PromptExtensions } from './prompt/sections'
import type { SessionProcessRecord } from './processRecord'
import {
  composeReconfiguredTools,
  orderForMinimalDiff,
  predictCacheImpact,
  type CacheImpact,
  type SkillToolChange
} from './reconfigure'
import type {
  AgentConfig,
  AgentToolSet,
  ModelCatalog,
  ReconfiguredAgentTools,
  ToolHost
} from './seams'

// ─────────────────────────── 名字 ───────────────────────────

/** 内置工具扩展（惰性：创建 agent / 保留锁 / 派生 agent 要用时装，创建 agent 时按沙箱钉子重装） */
export const SHUVIX_BUILTIN_EXTENSION = 'shuvix.builtin'

/** 按 agent 的工具扩展名前缀：`shuvix.agent.<conversationId>` */
export const AGENT_EXTENSION_PREFIX = 'shuvix.agent.'

export function agentExtensionName(conversationId: ConversationId): string {
  return `${AGENT_EXTENSION_PREFIX}${conversationId}`
}

// ─────────────────────────── 锁记录 ───────────────────────────

// 锁记录的类型与校验 / 序列化在 `agentRecord.ts`（与派生 agent 记录共用一个校验器）；这里原样转出
export { lockRecordJson, parseLockRecord, type LockRecord } from './agentRecord'

/**
 * 重开时读 `SessionStateDoc.lock`：只认 root（PIN-08）。`parseLockRecord` 也认 kind `spawned`（派生 agent
 * 记录的锁字段部分），但派生 agent 从不住在会话锁里 —— 重开时那里出现 spawned 按「写坏了」处理（K12）。
 * 只在 `restore()` 用：进程内的提交发布（`observe`）照旧按 `parseLockRecord` 读（提示词 golden 用例
 * 手工写的 spawned 锁靠这一点）。
 */
function parseSessionLock(raw: unknown): LockRecord | undefined {
  const lock = parseLockRecord(raw)
  return lock?.kind === 'root' ? lock : undefined
}

/** `createAgent()` 的选项 */
export interface CreateAgentOptions {
  /** 附加工具：root 的锁拒绝（K6；派生 agent 的 `next` 等属于 phase 2） */
  extraTools?: readonly ToolRegistration[]
}

/** 重配的结果：有 agent 并且这次真改了它才 `applied`（没 agent = 下一次发送按设置创建，什么都不用做） */
export interface ReconfigureOutcome {
  applied: boolean
  record?: LockRecord
}

/** 预判的结果：`locked = false` = 没有 agent（改动在下一次创建时生效，缓存无从谈起） */
export interface ReconfigurePreview extends CacheImpact {
  locked: boolean
}

export type AgentCreationErrorCode = 'no_model' | 'cancelled' | 'extra_tools' | 'unsupported'

/**
 * 创建 agent 失败的那几种「不是意外」的原因：
 *  - `no_model`：模型选择被拒（K4/K5；`refusal` 给出细分），什么都没写；
 *  - `cancelled`：创建途中被中止 / 销毁（K13），什么都没写 —— 发送当作被中止；
 *  - `extra_tools`：root 的锁带了附加工具（K6）；
 *  - `unsupported`：宿主没实现重配（`ToolHost.reconfigureAgentTools`），锁照旧。
 * 创建与重配共用它。其余失败（ToolHost / 变量表抛错、提交失败）原样上抛。
 */
export class AgentCreationError extends Error {
  constructor(
    readonly code: AgentCreationErrorCode,
    message: string,
    readonly refusal?: LockModelRefusalKind
  ) {
    super(message)
    this.name = 'AgentCreationError'
  }
}

// ─────────────────────────── 工具次序（K6，纯函数） ───────────────────────────

/** 按 agent 扩展里的工具：agent → skill → MCP（逐台）→ 宿主其它；同名只留第一个 */
export function agentExtensionTools(set: AgentToolSet): ToolRegistration[] {
  const candidates: (ToolRegistration | undefined)[] = [
    set.agent,
    set.skill,
    ...(set.mcp ?? []).flatMap((entry) => entry.tools),
    ...(set.tools ?? [])
  ]
  const seen = new Set<string>()
  const tools: ToolRegistration[] = []
  for (const tool of candidates) {
    if (tool === undefined || seen.has(tool.name)) continue
    seen.add(tool.name)
    tools.push(tool)
  }
  return tools
}

export interface ComposedAgentTools {
  /** 提供给模型的工具名，按次序 */
  toolNames: string[]
  /** 与 toolNames 一一对应的注册项（同名时按 agent 扩展的那个 —— 后装的扩展赢） */
  tools: ToolRegistration[]
  /** 装进 `shuvix.agent.<对话>` 的工具 */
  agentTools: ToolRegistration[]
}

/**
 * 拼工具次序（K6）：内置名按归一名单次序（只收 `builtin` 里有的）→ agent → skill → MCP 逐台逐个 →
 * 宿主其它 → 附加工具（先移除同名再追加；同名的附加工具只留最后一个）。附加工具只看 `extraTools`
 * 参数，不读 `set.extraTools`（调用方显式传：创建时 `resolved.extraTools`，重建时 `set.extraTools`）。
 * `agent` 只来自 `set.agent` —— 名单里有 `agent` 不会把它带回来，所以不给 `set.agent` 就足以关掉它。
 */
export function composeAgentTools(input: {
  names: readonly string[]
  builtin: readonly ToolRegistration[]
  set: AgentToolSet
  extraTools?: readonly ToolRegistration[]
}): ComposedAgentTools {
  const builtinByName = new Map<string, ToolRegistration>()
  for (const tool of input.builtin)
    if (!builtinByName.has(tool.name)) builtinByName.set(tool.name, tool)
  // 同名的附加工具只留最后一个（PIN-07：与 tools[] 及 durable 的「后者赢」一致，agentTools 里名字唯一）
  const lastExtra = new Map<string, ToolRegistration>()
  for (const tool of input.extraTools ?? []) {
    lastExtra.delete(tool.name)
    lastExtra.set(tool.name, tool)
  }
  const extras = [...lastExtra.values()]
  const extraNames = new Set(lastExtra.keys())
  const agentTools = [
    ...agentExtensionTools(input.set).filter((tool) => !extraNames.has(tool.name)),
    ...extras
  ]
  const agentByName = new Map(agentTools.map((tool) => [tool.name, tool]))
  const toolNames: string[] = []
  const seen = new Set<string>()
  const offer = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    toolNames.push(name)
  }
  // 附加工具的名字从前面各段里拿掉（先移除），在末尾追加
  for (const name of input.names) {
    if (builtinByName.has(name) && !extraNames.has(name)) offer(name)
  }
  for (const tool of agentTools) if (!extraNames.has(tool.name)) offer(tool.name)
  for (const tool of extras) offer(tool.name)
  const tools = toolNames.map((name) => (agentByName.get(name) ?? builtinByName.get(name))!)
  return { toolNames, tools, agentTools }
}

/**
 * 内置扩展：内置工具 + 宿主的 generation hook（空回复追问）。每个对话都选中它（根对话的锁、派生 agent
 * 的记录），所以 hook 对根对话与派生 agent 一并生效
 */
export function builtinExtension(
  tools: readonly ToolRegistration[],
  hooks: readonly HookRegistration[] = []
): Extension {
  return defineExtension({
    name: SHUVIX_BUILTIN_EXTENSION,
    tools,
    ...(hooks.length === 0 ? {} : { hooks })
  })
}

export function agentExtension(
  conversationId: ConversationId,
  tools: readonly ToolRegistration[]
): Extension {
  return defineExtension({ name: agentExtensionName(conversationId), tools })
}

/** 名单里带某个前缀的那几项（去掉前缀，名单序） */
function prefixed(names: readonly string[], prefix: 'mcp:' | 'skill:'): string[] {
  return names.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length))
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/** 同一把锁（同一次创建）：提交发布会换出新的记录对象，所以不按对象比 */
function sameLock(a: LockRecord | undefined, b: LockRecord): boolean {
  return a !== undefined && a.conversationId === b.conversationId && a.createdAt === b.createdAt
}

// ─────────────────────────── 每会话的锁 ───────────────────────────

export interface AgentLockDeps {
  sessionId: string
  /** 未包装的 Harness：这里的提交与快照都不开启调度器 */
  harness: Harness
  /** 这条会话自己的注册表（K1） */
  registry: Registry<ToolRegistration>
  toolHost: ToolHost
  resolveAgentConfig: (sessionId: string) => AgentConfig | Promise<AgentConfig>
  modelCatalog: ModelCatalog
  promptExtensions: PromptExtensions
  promptVars: (ctx: PromptVarsCtx) => PromptVars | Promise<PromptVars>
  eventSink: RuntimeEventSink
  onLockChange?: (sessionId: string, locked: boolean) => void
  logger: RuntimeLogger
  now: () => number
  /** 会话的当前对话（上锁对着它，K20） */
  currentConversation: () => Promise<Conversation>
  /**
   * 销毁之前让会话停下：忙 / 被中断就中止（取消询问、作废审查……）；空闲不中止（K10）。
   * 同时记一次显式喊停（自动续跑到下一次用户发送之前关闭）。
   */
  stopForDestroy: () => Promise<void>
  /** 这条会话在本进程里的记录（`agentInitialized` 在这里记 / 撤） */
  processRecord: SessionProcessRecord
  /** 内置扩展再带上的 hook（自动脱敏的 afterTool） */
  extraHooks?: readonly HookRegistration[]
}

/**
 * 打开时的重建该怎么做（`restore()` 的输入，由会话判定）：
 *  - `inProcess`：根 agent 在本进程里初始化过（进程内记录）；
 *  - `resumable`：存储里有可续的工作（被中断、活着的派生子 agent / 工具任务……）。
 */
export interface LockRestoreOptions {
  inProcess: boolean
  resumable: boolean
}

/**
 * 一条会话的锁：缓存的锁记录（同步读）、创建 / 销毁的互斥、重开时的重建。
 * 由 DurableSession 持有；提交发布（`observe`）是缓存的唯一更新途径之外的那一份兜底 ——
 * 谁写了 `SessionStateDoc.lock`，缓存都跟着变。
 */
export class AgentLock {
  private record: LockRecord | undefined
  private creating: Promise<LockRecord> | undefined
  private creationAbort: AbortController | undefined
  private destroying: Promise<void> | undefined
  /** 在途的重配与它的中止；在途时又来的请求合流成排在它后面的一次（`reconfigureQueued`） */
  private reconfiguring: Promise<ReconfigureOutcome> | undefined
  private reconfigureAbort: AbortController | undefined
  private reconfigureQueued: Promise<ReconfigureOutcome> | undefined
  /** 取消纪元：`cancelPending` 加一；排着的重配起跑前看到它变了就作罢 */
  private reconfigureEpoch = 0
  /** 在途的 `ensureBuiltin`（并发的合流成一次） */
  private installingBuiltin: Promise<void> | undefined
  /** 打开时完整初始化（连 MCP）的中止：会话关停时触发 */
  private readonly restoreAbort = new AbortController()
  private disposed = false
  /** 内置扩展带的 generation hook（每会话建一次，三处装内置扩展共用） */
  private readonly hooks: readonly HookRegistration[]

  constructor(private readonly deps: AgentLockDeps) {
    this.hooks = [
      emptyReplyHook({ harness: deps.harness, sessionId: deps.sessionId, logger: deps.logger }),
      ...(deps.extraHooks ?? [])
    ]
  }

  /** 此刻的锁记录（同步） */
  get current(): LockRecord | undefined {
    return this.record
  }

  /**
   * 提交发布里看到的 `SessionStateDoc.lock`（同步，在 Session 串行线上）。在本进程里写下的锁就是本进程
   * 初始化的（创建之外只有测试会直接写它）
   */
  observe(raw: JsonValue | undefined): void {
    this.record = raw === undefined ? undefined : parseLockRecord(raw)
    if (this.record !== undefined) this.deps.processRecord.agentInitialized = true
  }

  // ─── 重开（K11/K12 + option A） ───────────────────

  /**
   * 打开会话时、在任何续跑 / 发送之前，按存着的锁与 `options` 三选一（option A）：
   *  - 没有锁 → 什么都不建（内置工具也不建，惰性）；
   *  - 本进程里初始化过 → 装内置工具（按锁的沙箱钉子）、按锁重建按 agent 的扩展（不连服务器）；
   *  - 不是，但有可续的工作 → 同上，外加当场连锁记着的 MCP（`connect`，连不上照样起来）—— 完整初始化，
   *    记进进程内记录；
   *  - 不是，也没有可续的工作 → 一个提交清掉锁（不续跑）、什么都不建。
   * 锁写坏了（含 kind 不是 root，PIN-08）/ 内置工具或重建失败：清锁（一个提交，不续跑）并记警告；会话
   * 照样可用。从不写 `pi.agent`。root 的重建上下文从不带附加工具。
   */
  async restore(options: LockRestoreOptions): Promise<void> {
    const { sessionId, logger } = this.deps
    const raw = (await this.deps.harness.snapshot(SessionStateDoc, BG))?.lock
    const lock = raw === undefined ? undefined : parseSessionLock(raw)
    this.record = undefined
    if (raw !== undefined && lock === undefined) {
      logger.warn(`session ${sessionId}: the agent lock is malformed; clearing it`)
      await this.clearStoredLock()
      return
    }
    if (lock === undefined) return
    if (!options.inProcess && !options.resumable) {
      logger.info(
        `session ${sessionId}: the stored agent lock was not initialized in this process and there is no work to resume; clearing it (the next send creates the agent)`
      )
      await this.clearStoredLock()
      return
    }
    const initialize = !options.inProcess
    try {
      const builtin = await this.deps.toolHost.buildBuiltinTools({
        sessionId,
        sandboxed: lock.sandboxed,
        skills: lock.skills
      })
      this.deps.registry.install(builtinExtension(builtin, this.hooks))
    } catch (error) {
      logger.warn(`session ${sessionId}: building the builtin tools failed: ${errorText(error)}`)
      await this.clearStoredLock()
      return
    }
    try {
      const set = await this.deps.toolHost.rebuildAgentTools(lock, {
        sessionId,
        ...(initialize ? { connect: { signal: this.restoreAbort.signal } } : {})
      })
      this.deps.registry.install(agentExtension(lock.conversationId, agentExtensionTools(set)))
    } catch (error) {
      // 会话在关停：存着的锁原样留着（不是重建失败），下一次打开再判
      if (this.restoreAbort.signal.aborted) return
      logger.warn(
        `session ${sessionId}: rebuilding the locked agent's tools failed; the lock is cleared and the next send creates the agent again: ${errorText(error)}`
      )
      await this.clearStoredLock()
      return
    }
    this.record = lock
    if (initialize) {
      this.deps.processRecord.agentInitialized = true
      logger.info(
        `session ${sessionId}: the stored agent lock has work to resume; the agent was initialized at open`
      )
    }
  }

  /** 镜像对账（K11：每次打开都调；从不发 agent_created） */
  reconcileMirror(): void {
    this.mirror(this.record !== undefined)
  }

  /**
   * 内置工具没装就装上（惰性，option A）：按根锁的沙箱钉子（没锁 = 宿主给一份占位）。派生 agent 的创建 /
   * 重建 / 面板追问、宿主派发都先调它 —— 子 agent 的内置工具按名从 `shuvix.builtin` 解析。并发的合流成
   * 一次；构造期间别人（创建 agent）先装上了，就不覆盖它。失败原样抛出。
   */
  async ensureBuiltin(): Promise<void> {
    const { registry, toolHost, sessionId } = this.deps
    if (registry.snapshot().extension(SHUVIX_BUILTIN_EXTENSION) !== undefined) return
    if (this.installingBuiltin === undefined) {
      const tracked: Promise<void> = (async () => {
        const builtin = await toolHost.buildBuiltinTools({
          sessionId,
          sandboxed: this.record?.sandboxed,
          ...(this.record ? { skills: this.record.skills } : {})
        })
        if (registry.snapshot().extension(SHUVIX_BUILTIN_EXTENSION) === undefined) {
          registry.install(builtinExtension(builtin, this.hooks))
        }
      })().finally(() => {
        if (this.installingBuiltin === tracked) this.installingBuiltin = undefined
      })
      this.installingBuiltin = tracked
    }
    return this.installingBuiltin
  }

  private async clearStoredLock(): Promise<void> {
    this.deps.processRecord.agentInitialized = false
    await this.deps.harness.commit(async (tx) => {
      const state = await tx.doc(SessionStateDoc)
      delete state.lock
    }, BG)
  }

  // ─── 创建 ───────────────────────────────────────

  /**
   * 确保有锁：已锁返回现有记录（不调任何 seam）；销毁在途先等它完；创建在途合流。
   * 失败抛 `AgentCreationError`（拒绝 / 取消 / 附加工具）或原样的错误。
   */
  async ensure(options: CreateAgentOptions = {}): Promise<LockRecord> {
    if ((options.extraTools?.length ?? 0) > 0) {
      throw new AgentCreationError(
        'extra_tools',
        'A session root agent cannot carry extra tools (they could not be rebuilt on reopen)'
      )
    }
    for (;;) {
      if (this.destroying !== undefined) {
        await this.destroying.catch(() => undefined)
        continue
      }
      // 刚改的模型 / 勾选还在重配（连 MCP 最多几秒）：等它落定，这次发送就按改过的跑
      const reconfiguring = this.reconfigureQueued ?? this.reconfiguring
      if (reconfiguring !== undefined) {
        await reconfiguring.catch(() => undefined)
        continue
      }
      if (this.record !== undefined) return this.record
      if (this.disposed) throw new AgentCreationError('cancelled', 'The session is closing')
      if (this.creating === undefined) {
        const controller = new AbortController()
        const tracked: Promise<LockRecord> = this.create(controller.signal).finally(() => {
          if (this.creating === tracked) {
            this.creating = undefined
            this.creationAbort = undefined
          }
        })
        this.creating = tracked
        this.creationAbort = controller
      }
      return await this.creating
    }
  }

  /** 取消在途的创建并等它落定（K13；中止、销毁、回退都走这里） */
  async cancelCreation(): Promise<void> {
    const creating = this.creating
    if (creating === undefined) return
    this.creationAbort?.abort(new AgentCreationError('cancelled', 'Agent creation was cancelled'))
    await creating.catch(() => undefined)
  }

  /**
   * 取消在途的创建**与重配**并等它们落定（销毁、回退、分支走这里 —— 它们之后锁不在了 / 换了对话）。被取消的
   * 重配什么都不写，设置里的改动留着，下一次创建按它建。中止（停下这一轮）只取消创建：用户刚改的模型 / 勾选
   * 不该因为按了停止就悄悄作废。
   */
  async cancelPending(): Promise<void> {
    const reconfiguring = [this.reconfiguring, this.reconfigureQueued]
    if (reconfiguring.some((work) => work !== undefined)) {
      // 排着的那一次见到纪元变了就不起跑
      this.reconfigureEpoch++
      this.reconfigureAbort?.abort(
        new AgentCreationError('cancelled', 'Agent reconfiguration was cancelled')
      )
    }
    await this.cancelCreation()
    for (const work of reconfiguring) await work?.catch(() => undefined)
  }

  /** 会话关停：取消在途的创建、重配与打开时的连接，之后不再创建 */
  dispose(): void {
    this.disposed = true
    this.creationAbort?.abort(new AgentCreationError('cancelled', 'The session is closing'))
    this.reconfigureAbort?.abort(new AgentCreationError('cancelled', 'The session is closing'))
    this.restoreAbort.abort(new AgentCreationError('cancelled', 'The session is closing'))
  }

  private async create(signal: AbortSignal): Promise<LockRecord> {
    try {
      return await this.createUnguarded(signal)
    } catch (error) {
      if (signal.aborted && !(error instanceof AgentCreationError && error.code !== 'cancelled')) {
        throw new AgentCreationError('cancelled', 'Agent creation was cancelled')
      }
      throw error
    }
  }

  private async createUnguarded(signal: AbortSignal): Promise<LockRecord> {
    const { sessionId, registry, toolHost, logger } = this.deps
    const cancelled = (): void => {
      if (signal.aborted) throw new AgentCreationError('cancelled', 'Agent creation was cancelled')
    }
    const config = await this.deps.resolveAgentConfig(sessionId)
    cancelled()
    const resolution = resolveLockModel(
      this.deps.modelCatalog.registry,
      this.deps.modelCatalog.port,
      config.model
    )
    if (!resolution.ok) {
      throw new AgentCreationError('no_model', resolution.message, resolution.kind)
    }
    const conversation = await this.deps.currentConversation()
    const kind: AgentKind = 'root'
    const { profile } = config
    const names = normalizeToolNames(kind, profile.tools, config.toolOverlay)
    const thinkingLevel = resolveThinkingLevel(kind, profile, config.thinkingLevel)
    const cwd = config.cwd ?? ''

    const resolved = await toolHost.resolveAgentTools(
      {
        sessionId,
        conversationId: conversation.id,
        kind,
        rootSessionId: sessionId,
        selfSessionId: sessionId,
        profile,
        names,
        model: resolution.model,
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        cwd
      },
      { signal }
    )
    cancelled()
    if ((resolved.extraTools?.length ?? 0) > 0) {
      throw new AgentCreationError(
        'extra_tools',
        'A session root agent cannot carry extra tools (they could not be rebuilt on reopen)'
      )
    }
    // 人设在提交之外算（变量表可能做 I/O），在上锁的提交里冻结（K21）
    const frozen = await computeFrozenAgentPrompt(
      { promptVars: this.deps.promptVars, logger },
      { kind, sessionId, rootSessionId: sessionId, cwd, toolNames: names, profile }
    )
    cancelled()
    const builtin = await toolHost.buildBuiltinTools({
      sessionId,
      sandboxed: resolved.sandboxed,
      skills: resolved.skills
    })
    cancelled()

    const composed = composeAgentTools({ names, builtin, set: resolved })
    const builtinExt = builtinExtension(builtin, this.hooks)
    const agentExt = agentExtension(conversation.id, composed.agentTools)
    const extensions: Extension[] = [
      builtinExt,
      ...this.deps.promptExtensions.select({ kind, profile, toolNames: names }),
      agentExt
    ]
    const mcp: LockRecord['mcp'] = {}
    for (const entry of resolved.mcp ?? []) mcp[entry.server] = [...entry.declarations]
    const record: LockRecord = {
      conversationId: conversation.id,
      profileName: profile.name,
      kind,
      model: { ...resolution.model },
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      toolNames: composed.toolNames,
      extensions: extensions.map((extension) => extension.name),
      sandboxed: resolved.sandboxed,
      mcp,
      skills: [...(resolved.skills ?? [])],
      // 按哪份勾选建的（`agent.init` 锁着时报它，option A）；配置没给勾选就不记
      ...(config.toolOverlay === undefined ? {} : { selection: [...new Set(config.toolOverlay)] }),
      createdAt: this.deps.now()
    }

    // 先装扩展再提交：提交一落定，任何解析都看得到这些工具；提交失败就撤回（全有或全无）
    const previousBuiltin = registry.snapshot().extension(SHUVIX_BUILTIN_EXTENSION)
    const rollback = (): void => {
      registry.uninstall(agentExt)
      if (previousBuiltin !== undefined) registry.install(previousBuiltin)
      else registry.uninstall(builtinExt)
    }
    try {
      registry.install(builtinExt)
      registry.install(agentExt)
      cancelled()
      await this.deps.harness.commit(async (tx) => {
        const json = lockRecordJson(record)
        await configure(tx, conversation.id, {
          model: record.model,
          thinkingLevel: thinkingLevel ?? null,
          extensions,
          tools: composed.tools,
          instructions: null,
          cwd: cwd.length > 0 ? cwd : null
        })
        await freezePersona(tx, conversation.id, frozen)
        const state = await tx.doc(SessionStateDoc)
        state.lock = json
      }, BG)
    } catch (error) {
      rollback()
      throw error
    }
    // 发布已经同步更新了缓存；以防万一（发布被跳过）再按本地记录兜一次
    this.record ??= parseLockRecord(lockRecordJson(record))
    // 锁 = 「agent 在本进程里初始化过」（option A）
    this.deps.processRecord.agentInitialized = true
    this.mirror(true)
    this.broadcast({ type: 'agent_created', sessionId })
    return this.record!
  }

  // ─── 重配（2026-10-26） ─────────────────────────

  /**
   * 按会话此刻的配置重配锁住的 agent（模型、扩展勾选）。在途的创建先等它（它读的可能是改之前的设置）；
   * 在途的重配之后再来的请求合流成排在后面的一次（读最新的设置）。没锁 → `{ applied: false }`。
   * 失败抛 `AgentCreationError`（`no_model` / `cancelled` / `unsupported`）或原样的错误 —— 什么都不写，锁照旧。
   */
  reconfigure(): Promise<ReconfigureOutcome> {
    if (this.reconfiguring === undefined) return this.startReconfigure()
    if (this.reconfigureQueued === undefined) {
      const epoch = this.reconfigureEpoch
      const queued: Promise<ReconfigureOutcome> = this.reconfiguring
        .catch(() => undefined)
        .then(() => {
          if (this.reconfigureQueued === queued) this.reconfigureQueued = undefined
          if (epoch !== this.reconfigureEpoch) {
            throw new AgentCreationError('cancelled', 'Agent reconfiguration was cancelled')
          }
          return this.reconfiguring ?? this.startReconfigure()
        })
      this.reconfigureQueued = queued
    }
    return this.reconfigureQueued
  }

  /**
   * 预判（不连服务器、不写）：照 `config`（调用方把想改成的样子套在会话配置上）重配的话，下一次请求还能不能
   * 命中缓存。没锁 → `locked: false`、`cache: 'none'`。模型选不出来也按 `none` 答 —— 真改时由重配报错。
   */
  async preview(config: AgentConfig): Promise<ReconfigurePreview> {
    const lock = this.record
    const none: ReconfigurePreview = {
      locked: lock !== undefined,
      cache: 'none',
      reasons: [],
      promptTokens: 0
    }
    if (lock === undefined || this.deps.toolHost.reconfigureAgentTools === undefined) return none
    const resolution = resolveLockModel(
      this.deps.modelCatalog.registry,
      this.deps.modelCatalog.port,
      config.model
    )
    if (!resolution.ok) return none
    const plan = await this.planReconfigure(lock, config, resolution.model, {
      connect: false,
      signal: new AbortController().signal
    })
    const nextModel = resolution.model
    const impact = predictCacheImpact({
      messages: plan.messages,
      nextModel,
      nextModelInfo: this.deps.modelCatalog.registry.models.getModel(
        nextModel.provider,
        nextModel.modelId
      ),
      tools: plan.tools,
      pendingServers: plan.resolved.pending ?? [],
      sectionsChange: plan.persona !== undefined
    })
    return { locked: true, ...impact }
  }

  private startReconfigure(): Promise<ReconfigureOutcome> {
    const controller = new AbortController()
    const run = async (): Promise<ReconfigureOutcome> => {
      try {
        return await this.runReconfigure(controller.signal)
      } catch (error) {
        // 中止之后宿主抛出的随便什么错（连接被掐断……）都按取消算（与创建同一口径）
        if (
          (controller.signal.aborted || this.disposed) &&
          !(error instanceof AgentCreationError && error.code !== 'cancelled')
        ) {
          throw new AgentCreationError('cancelled', 'Agent reconfiguration was cancelled')
        }
        throw error
      }
    }
    const tracked: Promise<ReconfigureOutcome> = run().finally(() => {
      if (this.reconfiguring === tracked) {
        this.reconfiguring = undefined
        this.reconfigureAbort = undefined
      }
    })
    this.reconfiguring = tracked
    this.reconfigureAbort = controller
    return tracked
  }

  private async runReconfigure(signal: AbortSignal): Promise<ReconfigureOutcome> {
    const { sessionId, registry, logger } = this.deps
    const cancelled = (): void => {
      if (signal.aborted || this.disposed) {
        throw new AgentCreationError('cancelled', 'Agent reconfiguration was cancelled')
      }
    }
    if (this.creating !== undefined) await this.creating.catch(() => undefined)
    // 先看是不是被取消了，再去等销毁：取消我们的正是那次销毁（cancelPending 在等我们落定），反过来等它就是死锁
    cancelled()
    if (this.destroying !== undefined) await this.destroying.catch(() => undefined)
    cancelled()
    const lock = this.record
    if (lock === undefined) return { applied: false }
    if (this.deps.toolHost.reconfigureAgentTools === undefined) {
      throw new AgentCreationError('unsupported', 'This host cannot change a running agent')
    }
    const config = await this.deps.resolveAgentConfig(sessionId)
    cancelled()
    const resolution = resolveLockModel(
      this.deps.modelCatalog.registry,
      this.deps.modelCatalog.port,
      config.model
    )
    if (!resolution.ok) {
      throw new AgentCreationError('no_model', resolution.message, resolution.kind)
    }
    const plan = await this.planReconfigure(lock, config, resolution.model, {
      connect: true,
      signal
    })
    cancelled()
    // 锁在计划期间换了（被销毁 / 重建）：这份计划作废，设置留着给下一次创建
    if (!sameLock(this.record, lock)) return { applied: false }

    const record: LockRecord = plan.record
    const unchanged =
      JSON.stringify(lockRecordJson(record)) === JSON.stringify(lockRecordJson(lock)) &&
      plan.persona === undefined
    if (unchanged) return { applied: false, record: lock }

    const name = agentExtensionName(lock.conversationId)
    const previous = registry.snapshot().extension(name)
    const builtin = new Set(registry.snapshot().extension(SHUVIX_BUILTIN_EXTENSION)?.tools ?? [])
    const next = agentExtension(
      lock.conversationId,
      plan.tools.filter((tool) => !builtin.has(tool))
    )
    try {
      // 先装扩展再提交（与创建同一条纪律）：提交一落定，下一次解析就看得到新工具；提交失败就装回原来那份
      registry.install(next)
      cancelled()
      await this.deps.harness.commit(async (tx) => {
        await configure(tx, lock.conversationId, { model: record.model, tools: plan.tools })
        if (plan.persona !== undefined) await freezePersona(tx, lock.conversationId, plan.persona)
        const state = await tx.doc(SessionStateDoc)
        state.lock = lockRecordJson(record)
      }, BG)
    } catch (error) {
      if (previous !== undefined) registry.install(previous)
      else registry.uninstall(next)
      throw error
    }
    this.record ??= parseLockRecord(lockRecordJson(record))
    logger.info(
      `session ${sessionId}: the agent was reconfigured (model ${record.model.provider}/${record.model.modelId}, ${record.toolNames.length} tools)`
    )
    return { applied: true, record: this.record ?? record }
  }

  /**
   * 重配的计划（预判与真重配共用）：新名单 → 宿主解析变了的那几样 → 拼出新的工具（锁里已有的沿用此刻装着
   * 的注册项，新的追加，按最小差异排）、新锁记录，以及人设要不要换（只在技能那几项变了时才算：人设里只有
   * 作图说明随名单而变）。
   */
  private async planReconfigure(
    lock: LockRecord,
    config: AgentConfig,
    model: LockRecord['model'],
    options: { connect: boolean; signal: AbortSignal }
  ): Promise<{
    tools: ToolRegistration[]
    record: LockRecord
    resolved: ReconfiguredAgentTools
    persona: FrozenAgentPrompt | undefined
    messages: readonly Message[]
  }> {
    const { sessionId, registry, toolHost, logger } = this.deps
    const { profile } = config
    const names = normalizeToolNames('root', profile.tools, config.toolOverlay)
    // 上一次（创建 / 重配）要过的名单；锁里没记勾选（旧锁）就按锁里接上了的那些算
    const before =
      lock.selection === undefined
        ? undefined
        : normalizeToolNames('root', profile.tools, lock.selection)
    const lockServers = Object.keys(lock.mcp)
    const desiredServers = prefixed(names, 'mcp:')
    const removedServers = new Set(lockServers.filter((server) => !desiredServers.includes(server)))
    // 只接这一次新要的服务器：上一次就要过、没连上的（不在锁里）不跟着别的改动反复重试、反复报错 —— 想重试就
    // 取消再勾上，或者销毁 agent（与「锁住期间连不上的下次创建再试」同一口径）
    const requestedBefore = new Set(before === undefined ? lockServers : prefixed(before, 'mcp:'))
    const servers = desiredServers.filter(
      (server) => !lockServers.includes(server) && !requestedBefore.has(server)
    )
    const resolved = await toolHost.reconfigureAgentTools!(
      { sessionId, names, servers },
      { signal: options.signal, connect: options.connect }
    )

    const snapshot = registry.snapshot()
    const installed = new Map<string, ToolRegistration>()
    for (const extension of [
      snapshot.extension(SHUVIX_BUILTIN_EXTENSION),
      snapshot.extension(agentExtensionName(lock.conversationId))
    ]) {
      for (const tool of extension?.tools ?? []) installed.set(tool.name, tool)
    }
    const current = lock.toolNames
      .map((name) => installed.get(name))
      .filter((tool): tool is ToolRegistration => tool !== undefined)
    const skillsChanged = !sameList(resolved.skills, lock.skills)
    const skill: SkillToolChange<ToolRegistration> = skillsChanged
      ? { change: 'replace', tool: resolved.skill }
      : { change: 'keep' }
    const unordered = composeReconfiguredTools({
      current,
      removedServers,
      skill,
      addedMcp: resolved.mcp
    })
    const conversation = await this.deps.harness.conversation(lock.conversationId, BG)
    const messages: readonly Message[] =
      conversation === undefined ? [] : (await conversation.context(BG)).messages
    const tools = orderForMinimalDiff(getCurrentTools(messages), unordered)

    const mcp: LockRecord['mcp'] = {}
    for (const [server, declarations] of Object.entries(lock.mcp)) {
      if (!removedServers.has(server)) mcp[server] = declarations
    }
    for (const entry of resolved.mcp) mcp[entry.server] = [...entry.declarations]
    const record: LockRecord = {
      ...lock,
      model: { ...model },
      toolNames: tools.map((tool) => tool.name),
      mcp,
      skills: skillsChanged ? [...resolved.skills] : [...lock.skills],
      ...(config.toolOverlay === undefined ? {} : { selection: [...new Set(config.toolOverlay)] })
    }

    // 人设：技能那几项变了才可能变。新旧名单在此刻的变量表下各渲染一遍，不一样才换（日期之类的环境波动
    // 两边相同，不会因此重发人设）。锁里没记勾选（旧锁）就不动人设
    let persona: FrozenAgentPrompt | undefined
    if (before !== undefined) {
      if (!sameList(prefixed(before, 'skill:'), prefixed(names, 'skill:'))) {
        const input = {
          kind: 'root' as const,
          sessionId,
          rootSessionId: sessionId,
          cwd: config.cwd ?? '',
          profile
        }
        const host = { promptVars: this.deps.promptVars, logger }
        const [old, fresh] = await Promise.all([
          computeFrozenAgentPrompt(host, { ...input, toolNames: before }),
          computeFrozenAgentPrompt(host, { ...input, toolNames: names })
        ])
        if (old.persona !== fresh.persona) persona = fresh
      }
    }
    return { tools, record, resolved, persona, messages }
  }

  // ─── 销毁 ───────────────────────────────────────

  /**
   * 销毁（K10/K13）：并发调用共享同一次；没锁 = 无操作（不发事件、不写、不调镜像，`stop` 也不调）。
   * `stop` 换掉缺省的「销毁之前让会话停下」（回退用不送达的那一版，P3-10a PIN-23）；共享到在途的那一次时
   * 不起作用。
   */
  destroy(stop?: () => Promise<void>): Promise<void> {
    if (this.destroying !== undefined) return this.destroying
    const tracked: Promise<void> = this.runDestroy(stop ?? this.deps.stopForDestroy).finally(() => {
      if (this.destroying === tracked) this.destroying = undefined
    })
    this.destroying = tracked
    return tracked
  }

  private async runDestroy(stop: () => Promise<void>): Promise<void> {
    await this.cancelPending()
    const lock = this.record
    if (lock === undefined) return
    const { sessionId } = this.deps
    this.broadcast({ type: 'agent_closing', sessionId, closing: true })
    try {
      await stop()
      await this.clearStoredLock()
      this.record = undefined
      this.deps.registry.uninstall({ name: agentExtensionName(lock.conversationId) })
      this.mirror(false)
    } finally {
      this.broadcast({ type: 'agent_closing', sessionId, closing: false })
    }
  }

  // ─── 杂项 ───────────────────────────────────────

  private mirror(locked: boolean): void {
    try {
      this.deps.onLockChange?.(this.deps.sessionId, locked)
    } catch (error) {
      this.deps.logger.warn(
        `onLockChange failed session=${this.deps.sessionId} locked=${locked}: ${errorText(error)}`
      )
    }
  }

  private broadcast(event: Parameters<RuntimeEventSink['broadcast']>[0]): void {
    try {
      this.deps.eventSink.broadcast(event)
    } catch (error) {
      this.deps.logger.warn(`broadcast failed session=${this.deps.sessionId}: ${errorText(error)}`)
    }
  }
}
