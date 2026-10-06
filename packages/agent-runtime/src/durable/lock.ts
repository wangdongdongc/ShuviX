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
 *  - **锁住期间工具不变**：MCP 掉线不卸它的工具（调用时原地重连），list_changed 只在下次创建时生效，
 *    会话配置（勾选 / 模型）怎么改都不影响；思考档位例外，`pi.agent.thinkingLevel` 是活的（K9）。
 *  - **销毁**（agent 芯片的 X、回退、清空）：忙 / 被中断就先中止（K10），再一个提交删锁、卸掉按 agent
 *    的扩展。`pi.agent` 不清（下一次创建整份覆盖），`shuvix.builtin` 不动（下一次创建重装，K8）。
 *    销毁算一次显式喊停（到下一次用户发送之前不自动续跑）。
 *  - **重开**（K11/K12）：打开会话时、在任何续跑 / 发送之前，按锁记录重建同一组工具（不读会话配置、
 *    不连服务器、不写 `pi.agent`）。重建失败或锁记录写坏了：会话照样能打开、能看，锁经一个提交清掉
 *    （不续跑）并记警告，镜像对成 false，下一次发送重新创建。
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
import {
  configure,
  defineExtension,
  type Conversation,
  type ConversationId,
  type Extension,
  type Harness,
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
import { computeFrozenAgentPrompt, freezePersona } from './prompt/persona'
import type { PromptExtensions } from './prompt/sections'
import type { AgentConfig, AgentToolSet, ModelCatalog, ToolHost } from './seams'

// ─────────────────────────── 名字 ───────────────────────────

/** 内置工具扩展（打开会话时装，创建 agent 时按沙箱钉子重装） */
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

export type AgentCreationErrorCode = 'no_model' | 'cancelled' | 'extra_tools'

/**
 * 创建 agent 失败的那几种「不是意外」的原因：
 *  - `no_model`：模型选择被拒（K4/K5；`refusal` 给出细分），什么都没写；
 *  - `cancelled`：创建途中被中止 / 销毁（K13），什么都没写 —— 发送当作被中止；
 *  - `extra_tools`：root 的锁带了附加工具（K6）。
 * 其余失败（ToolHost / 变量表抛错、提交失败）原样上抛。
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

export function builtinExtension(tools: readonly ToolRegistration[]): Extension {
  return defineExtension({ name: SHUVIX_BUILTIN_EXTENSION, tools })
}

export function agentExtension(
  conversationId: ConversationId,
  tools: readonly ToolRegistration[]
): Extension {
  return defineExtension({ name: agentExtensionName(conversationId), tools })
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
  private disposed = false

  constructor(private readonly deps: AgentLockDeps) {}

  /** 此刻的锁记录（同步） */
  get current(): LockRecord | undefined {
    return this.record
  }

  /** 提交发布里看到的 `SessionStateDoc.lock`（同步，在 Session 串行线上） */
  observe(raw: JsonValue | undefined): void {
    this.record = raw === undefined ? undefined : parseLockRecord(raw)
  }

  // ─── 重开（K11/K12） ───────────────────────────

  /**
   * 打开会话时、在任何续跑 / 发送之前：装内置工具（有锁按锁的沙箱钉子），按锁重建按 agent 的扩展。
   * 锁写坏了（含 kind 不是 root，PIN-08）/ 重建失败：清锁（一个提交，不续跑）并记警告；会话照样可用。
   * 从不写 `pi.agent`。root 的重建上下文从不带附加工具。
   */
  async restore(): Promise<void> {
    const { sessionId, logger } = this.deps
    const raw = (await this.deps.harness.snapshot(SessionStateDoc, BG))?.lock
    let lock = raw === undefined ? undefined : parseSessionLock(raw)
    if (raw !== undefined && lock === undefined) {
      logger.warn(`session ${sessionId}: the agent lock is malformed; clearing it`)
      await this.clearStoredLock()
    }
    try {
      const builtin = await this.deps.toolHost.buildBuiltinTools({
        sessionId,
        sandboxed: lock?.sandboxed
      })
      this.deps.registry.install(builtinExtension(builtin))
    } catch (error) {
      logger.warn(`session ${sessionId}: building the builtin tools failed: ${errorText(error)}`)
      if (lock !== undefined) {
        await this.clearStoredLock()
        lock = undefined
      }
    }
    if (lock !== undefined) {
      try {
        const set = await this.deps.toolHost.rebuildAgentTools(lock, { sessionId })
        this.deps.registry.install(agentExtension(lock.conversationId, agentExtensionTools(set)))
      } catch (error) {
        logger.warn(
          `session ${sessionId}: rebuilding the locked agent's tools failed; the lock is cleared and the next send creates the agent again: ${errorText(error)}`
        )
        await this.clearStoredLock()
        lock = undefined
      }
    }
    this.record = lock
  }

  /** 镜像对账（K11：每次打开都调；从不发 agent_created） */
  reconcileMirror(): void {
    this.mirror(this.record !== undefined)
  }

  private async clearStoredLock(): Promise<void> {
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

  /** 取消在途的创建并等它落定（K13；中止与销毁都走这里） */
  async cancelCreation(): Promise<void> {
    const creating = this.creating
    if (creating === undefined) return
    this.creationAbort?.abort(new AgentCreationError('cancelled', 'Agent creation was cancelled'))
    await creating.catch(() => undefined)
  }

  /** 会话关停：取消在途的创建，之后不再创建 */
  dispose(): void {
    this.disposed = true
    this.creationAbort?.abort(new AgentCreationError('cancelled', 'The session is closing'))
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
    const builtin = await toolHost.buildBuiltinTools({ sessionId, sandboxed: resolved.sandboxed })
    cancelled()

    const composed = composeAgentTools({ names, builtin, set: resolved })
    const builtinExt = builtinExtension(builtin)
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
    this.mirror(true)
    this.broadcast({ type: 'agent_created', sessionId })
    return this.record!
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
    await this.cancelCreation()
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
