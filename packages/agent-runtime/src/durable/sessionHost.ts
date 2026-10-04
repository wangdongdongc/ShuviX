/**
 * SessionHost —— 打开着的会话存储（Harness）的簿记：打开 / 窥视 / 关闭 / 全部关闭 / 删除，外加 LRU。
 *
 * 一条会话一个存储、一个 Harness，**同一时刻只能有一个**：两个 Harness 开着同一个存储 = 两条
 * 互不知情的提交线写同一份数据。所以打开与关停复用 `SessionManager` 的闸门（关停中的会话必须
 * 等它彻底关完才能再开；打开在途时关停先等它出生再关）。
 *
 * 几条规矩：
 *  - **打开从不 `resume()`**：上个进程留下的 run 停在原地（会话报 interrupted），等用户继续或发送。
 *  - **peek 从不创建**：存储不存在就是 undefined；存在则照常打开（只读用途同样要 Harness）。
 *  - **LRU**（旧 sessionTreeRegistry 的算法）：只数「可回收」的会话 —— 不忙（后台压缩也算忙）、
 *    没钉住、不是临时会话、没有挂起的询问、没有进行中的调用；超过 `maxIdleOpen` 就关最久没用的。
 *    被中断的会话可以回收（什么都没在跑，一切都已落盘）。修剪发生在打开之后、忙→闲之后，以及
 *    一个会话的进行中调用全部结束时（发送要等它的 submission 落定才算结束，忙→闲那一刻它还
 *    算「进行中」）；关之前在同一个同步段里再判一次（不会和刚起跑的一轮赛跑）。
 *  - **全部关闭之后封存**：退出路径上不再接受打开（拒绝并报清楚的错）。
 *  - **删除**：先关（等在途的打开），再删存储；删除期间对同一会话的打开 / 窥视排在它后面。
 *  - **每会话一个注册表**（K1）：打开时 `createRegistry(sessionId)` 造一个、装上系统提示词的段落扩展
 *    （K21），会话自己再装 `shuvix.builtin` 与按锁重建的 `shuvix.agent.<对话>`；关闭 / 删除时随会话丢弃。
 *    根对话 id 在每个存储里都是 1，共享注册表会让两条会话的 `shuvix.agent.1` 互相覆盖。
 *  - **压缩余量按锁定模型的窗口算**（K14）：settings 的 getter 现读会话的锁、按 `models.getModel` 查
 *    上下文窗口（未锁 / 查不到 → 32768）。
 */
import {
  createRegistry,
  Harness,
  type Registry,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import { SessionManager } from '../sessionManager'
import type { RuntimeLogger } from '../types'
import { backgroundContext as BG, errorText } from './context'
import { seedConversationDocs } from './docs'
import { DurableSessionImpl, type DurableSession, type SessionCloseReason } from './durableSession'
import { createPromptExtensions, type PromptExtensions } from './prompt/sections'
import {
  DEFAULT_INTERRUPTED_SEND_POLICY,
  DEFAULT_MAX_IDLE_OPEN,
  DEFAULT_NOTICE_COALESCE_MS,
  type RunState,
  type SessionHostDeps
} from './seams'
import { createShuviXSettings } from './settings'

const noopLogger: RuntimeLogger = { info: () => {}, warn: () => {}, error: () => {} }

/** 宿主已封存（closeAll 之后，退出中）：不再打开任何会话 */
export class SessionHostSealedError extends Error {
  readonly code = 'sealed' as const
  constructor(readonly sessionId: string) {
    super(`Session host is closed; cannot open session ${sessionId}`)
    this.name = 'SessionHostSealedError'
  }
}

export interface SessionHost {
  /** 打开（必要时创建存储）；已打开 / 打开在途的复用同一个实例 */
  open(sessionId: string): Promise<DurableSession>
  /** 打开已存在的会话；存储不存在返回 undefined（从不创建）。封存后返回 undefined */
  peek(sessionId: string): Promise<DurableSession | undefined>
  /** 此刻已打开的实例（同步；不打开） */
  get(sessionId: string): DurableSession | undefined
  /** 关闭（未打开则无操作；等在途的打开出生再关） */
  close(sessionId: string): Promise<void>
  /** 关闭全部并封存（之后的 open 被拒绝）；并发调用共享同一次 */
  closeAll(): Promise<void>
  /** 关闭并删除存储 */
  delete(sessionId: string): Promise<void>
  /** 此刻打开着的会话 id */
  openSessionIds(): string[]
  /** 是否已封存 */
  readonly sealed: boolean
}

export function createSessionHost(deps: SessionHostDeps): SessionHost {
  return new SessionHostImpl(deps)
}

class SessionHostImpl implements SessionHost {
  private readonly logger: RuntimeLogger
  private readonly maxIdleOpen: number
  private readonly manager: SessionManager<DurableSessionImpl>
  /** LRU 新近度：单调计数（不用时钟，避免同毫秒并列） */
  private readonly recency = new Map<string, number>()
  private tick = 0
  /** 正在 create 的会话（closeAll 要连它们一起关） */
  private readonly opening = new Set<string>()
  private readonly deleting = new Map<string, Promise<void>>()
  private trimScheduled = false
  private sealedFlag = false
  private closingAll: Promise<void> | undefined
  /** 段落扩展：每个会话的注册表都装同一组对象（它们按 AgentStateDoc.rootSessionId 路由） */
  private readonly promptExtensions: PromptExtensions

  constructor(private readonly deps: SessionHostDeps) {
    this.logger = deps.logger ?? noopLogger
    this.promptExtensions = createPromptExtensions(deps.promptHost ?? {})
    const max = deps.maxIdleOpen ?? DEFAULT_MAX_IDLE_OPEN
    this.maxIdleOpen = Number.isFinite(max) && max >= 0 ? Math.floor(max) : DEFAULT_MAX_IDLE_OPEN
    this.manager = new SessionManager<DurableSessionImpl>({
      create: (sessionId) => this.create(sessionId),
      dispose: (_sessionId, session, reason: SessionCloseReason) => session.close(reason)
    })
  }

  get sealed(): boolean {
    return this.sealedFlag
  }

  async open(sessionId: string): Promise<DurableSession> {
    for (;;) {
      if (this.sealedFlag) throw new SessionHostSealedError(sessionId)
      const deleting = this.deleting.get(sessionId)
      if (deleting) {
        await deleting.catch(() => undefined)
        continue
      }
      // 闸门检查与 ensure 在同一个同步段：之后开始的删除一定看得见这次打开（并等它）
      const session = await this.manager.ensure(sessionId)
      if (session === undefined) throw new SessionHostSealedError(sessionId)
      this.touch(sessionId)
      this.scheduleTrim()
      return session
    }
  }

  async peek(sessionId: string): Promise<DurableSession | undefined> {
    for (;;) {
      if (this.sealedFlag) return undefined
      const deleting = this.deleting.get(sessionId)
      if (deleting) {
        await deleting.catch(() => undefined)
        continue
      }
      const existing = this.manager.get(sessionId)
      if (existing) {
        this.touch(sessionId)
        return existing
      }
      // 打开在途 / 关停中：共享它（关停中的会话之前打开过，存储必然存在）
      if (!this.manager.tracked(sessionId)) {
        if (!(await this.deps.storageExists(sessionId))) return undefined
        if (this.sealedFlag) return undefined
        if (this.deleting.has(sessionId)) continue
      }
      const session = await this.manager.ensure(sessionId)
      if (session === undefined) return undefined
      this.touch(sessionId)
      this.scheduleTrim()
      return session
    }
  }

  get(sessionId: string): DurableSession | undefined {
    return this.manager.get(sessionId)
  }

  openSessionIds(): string[] {
    return [...this.manager.entries()].map(([sessionId]) => sessionId)
  }

  close(sessionId: string): Promise<void> {
    return this.manager.remove(sessionId, 'remove')
  }

  closeAll(): Promise<void> {
    this.sealedFlag = true
    this.closingAll ??= (async () => {
      const ids = new Set([...this.manager.entries()].map(([sessionId]) => sessionId))
      for (const sessionId of this.opening) ids.add(sessionId)
      await Promise.all([...ids].map((sessionId) => this.manager.remove(sessionId, 'remove')))
      await Promise.all([...this.deleting.values()].map((p) => p.catch(() => undefined)))
    })()
    return this.closingAll
  }

  delete(sessionId: string): Promise<void> {
    const previous = this.deleting.get(sessionId)
    const run = (async () => {
      if (previous) await previous.catch(() => undefined)
      await this.manager.remove(sessionId, 'destroy')
      await this.deps.deleteStorage(sessionId)
      this.recency.delete(sessionId)
    })()
    const tracked: Promise<void> = run.finally(() => {
      if (this.deleting.get(sessionId) === tracked) this.deleting.delete(sessionId)
    })
    this.deleting.set(sessionId, tracked)
    return tracked
  }

  // ─── 打开 ───────────────────────────────────────

  private async create(sessionId: string): Promise<DurableSessionImpl | undefined> {
    if (this.sealedFlag) return undefined
    this.opening.add(sessionId)
    try {
      // SessionManager 的 ensure 在关停结束后会自己重建：删除那一侧此时可能还在删文件 ——
      // 等它删完再开（删除只等它调用 remove 那一刻在途的创建，所以这里不会互等）
      const deleting = this.deleting.get(sessionId)
      if (deleting) await deleting.catch(() => undefined)
      if (this.sealedFlag) return undefined
      const storage = await this.deps.openStorage(sessionId)
      let registry: Registry<ToolRegistration>
      try {
        registry = (this.deps.createRegistry ?? (() => createRegistry()))(sessionId)
        for (const extension of this.promptExtensions.all) registry.install(extension)
      } catch (error) {
        await storage.close(BG).catch(() => undefined)
        throw error
      }
      // 压缩窗口按锁定模型现查（K14）：会话出生之前（打开途中）没有锁 → 未知
      let lockedSession: DurableSessionImpl | undefined
      const settings = createShuviXSettings({
        contextWindow: () => {
          const model = lockedSession?.lock?.model
          return model === undefined
            ? undefined
            : this.deps.models.getModel(model.provider, model.modelId)?.contextWindow
        },
        overrides: () => this.deps.settingsOverrides
      })
      let harness: Harness
      try {
        harness = await Harness.open(
          storage,
          {
            models: this.deps.models,
            registry,
            settings,
            ...(this.deps.env === undefined ? {} : { env: this.deps.env }),
            conversationCreated: async (tx, record) => {
              await seedConversationDocs(tx, record)
              await this.deps.conversationCreated?.(tx, record)
            },
            onReport: (error) => this.report(sessionId, error),
            ...(this.deps.now === undefined ? {} : { now: this.deps.now })
          },
          BG
        )
      } catch (error) {
        // Harness.open 失败时自己会关掉存储；构造之前就失败（如注册表缺内置任务）则由这里关
        await storage.close(BG).catch(() => undefined)
        throw error
      }
      try {
        // 根对话首次打开时创建（ShuviX 文档随创建提交补种）；只是一次提交，不开启调度器
        await harness.root(BG)
        const session = await DurableSessionImpl.attach({
          sessionId,
          harness,
          eventSink: this.deps.eventSink,
          interruptedSendPolicy: this.deps.interruptedSendPolicy ?? DEFAULT_INTERRUPTED_SEND_POLICY,
          autoResume: () => autoResumeAllowed(this.deps.autoResume?.(sessionId)),
          noticeCoalesceMs: this.deps.noticeCoalesceMs ?? DEFAULT_NOTICE_COALESCE_MS,
          beforeAbort: () => this.deps.beforeAbort?.(sessionId),
          onInputsReopened: () => this.deps.onInputsReopened?.(sessionId),
          onStateChange: (state, previous) => this.onStateChange(sessionId, state, previous),
          onUse: () => this.touch(sessionId),
          onSettled: () => this.scheduleTrim(),
          logger: this.logger,
          now: this.deps.now ?? Date.now,
          ...(this.deps.today === undefined ? {} : { today: this.deps.today }),
          registry,
          toolHost: this.deps.toolHost,
          resolveAgentConfig: this.deps.resolveAgentConfig,
          modelCatalog: this.deps.modelCatalog,
          promptExtensions: this.promptExtensions,
          promptVars: this.deps.promptVars ?? (() => ({})),
          ...(this.deps.onLockChange === undefined ? {} : { onLockChange: this.deps.onLockChange }),
          settings
        })
        lockedSession = session
        if (this.sealedFlag) {
          await session.close('remove')
          return undefined
        }
        // 打开时总报一次此刻的运行状态（PIN-R，与锁镜像的 K11 同理）：崩溃可能把 DB 里的运行标记留在
        // busy（后台压缩中、最后一次提交与转闲的微任务之间），空闲重开若不报，那个标记永远好不了
        this.reportRunState(sessionId, session.runState)
        return session
      } catch (error) {
        await harness.close(BG).catch(() => undefined)
        throw error
      }
    } finally {
      this.opening.delete(sessionId)
    }
  }

  // ─── 运行状态 / LRU ─────────────────────────────

  private onStateChange(sessionId: string, state: RunState, previous: RunState): void {
    this.reportRunState(sessionId, state)
    // 忙 → 闲：可回收的会话多了一个
    if (previous === 'busy' && state !== 'busy') this.scheduleTrim()
  }

  private reportRunState(sessionId: string, state: RunState): void {
    try {
      this.deps.onRunStateChange?.(sessionId, state)
    } catch (error) {
      this.logger.warn(`onRunStateChange failed session=${sessionId}: ${errorText(error)}`)
    }
  }

  private touch(sessionId: string): void {
    this.recency.set(sessionId, ++this.tick)
  }

  private scheduleTrim(): void {
    if (this.trimScheduled) return
    this.trimScheduled = true
    queueMicrotask(() => {
      this.trimScheduled = false
      this.trim()
    })
  }

  private trim(): void {
    if (this.sealedFlag) return
    const candidates: [string, DurableSessionImpl][] = []
    for (const entry of this.manager.entries()) {
      if (this.evictable(entry[0], entry[1])) candidates.push(entry)
    }
    candidates.sort(([a], [b]) => (this.recency.get(a) ?? 0) - (this.recency.get(b) ?? 0))
    const excess = candidates.length - this.maxIdleOpen
    for (let index = 0; index < excess; index++) {
      const [sessionId, session] = candidates[index]!
      // 关之前再判一次（同一同步段内 remove 立即摘牌，不会与刚起跑的调用赛跑）
      if (!this.evictable(sessionId, session)) continue
      this.logger.info(`session host: closing idle session ${sessionId} (LRU)`)
      void this.manager.remove(sessionId, 'remove')
    }
  }

  private evictable(sessionId: string, session: DurableSessionImpl): boolean {
    if (this.deps.isEphemeral?.(sessionId)) return false
    let pinned: boolean
    try {
      pinned = this.deps.isPinned?.(sessionId) ?? false
    } catch {
      pinned = true
    }
    return !pinned && session.evictable
  }

  private report(sessionId: string, error: unknown): void {
    try {
      if (this.deps.onReport) this.deps.onReport(sessionId, error)
      else this.logger.warn(`durable report session=${sessionId}: ${errorText(error)}`)
    } catch {
      /* onReport must not throw */
    }
  }
}

/** 自动续跑开关的口径：只有修剪后字面量 'false'（或布尔 false）才关；缺省 / 写坏都按开 */
export function autoResumeAllowed(raw: unknown): boolean {
  if (raw === false) return false
  if (typeof raw === 'string' && raw.trim() === 'false') return false
  return true
}
