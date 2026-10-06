/**
 * P3-03 用例的共用夹具（对着设计稿的约定）：
 *
 *  - `opsOf(state)`：把复制状态包进一个一次性的 `RemoteServiceProvider`（服务 `t`，`{view: state}`）并订阅
 *    —— 唯一能拿到**精确操作流**的通道（公共 subscribe 会合并）。记下快照、每次修订的 `{sequence, ops}`
 *    与那一刻的值；`replay()` 从快照起用 chord 的 `applyImmutable` 逐条重放（P3-03-54）。
 *  - `attachOracle(session, state)`：身份预言（PIN-10 修订版）—— 在投影**之后**挂一个独立的 watch，每一帧
 *    记下帧值、那一刻的 `runState` / 询问与投影的状态值；`verify()` 事后用纯投影 + `resolveDisplayItems`
 *    （P3-02 的共享解析）+ 独立的排队侧车查询逐帧重算并深比较。投影换挂载（`["r"]`）时预言跟着换。
 *  - `freshMount(session)`：一个新建、不共享的投影实例此刻挂载的值（读完拆掉）；`freshAgentMount` 同理。
 *  - `reopenMount(t, id)`：`host.close` → `host.open` → `freshMount`。
 *  - `recordLifecycle(proj, state?)`：运行生命周期信号（连同信号到达那一刻的视图）。
 *  - `liveCommit(session, mutate)`：直接写当前对话的 `pi.live`（精确控制流式中间态的用例用）。
 *  - 测试工具：`readTool`、`streamTool`（逐段 `api.output`）、`spillTool`（带落盘诊断的结果）。
 */
import {
  RemoteServiceProvider,
  defineService,
  type MutableReplicatedState,
  type ReplicatedState,
  type Service
} from '@earendil-works/chord'
import { applyImmutable, type Op } from '@earendil-works/chord/delta'
import { Type } from '@earendil-works/pi-ai'
import {
  LiveDoc,
  defineTool,
  type ConversationId,
  type ConversationView,
  type InboxState,
  type LiveState,
  type ToolRegistration,
  type WatchHandle
} from '@earendil-works/pi-durable'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { AgentView, RunViewState, SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { isJsonOnly } from '@shuvix/chat-protocol/utils/jsonOnly'
import { expect } from 'vitest'
import { truncationDiagnostic } from '../../../toolOutput/spill'
import { backgroundContext as BG } from '../../context'
import { DisplayDoc } from '../../docs'
import type { DurableSession } from '../../durableSession'
import type { TestHost } from '../../__tests__/support/host'
import { sleep } from '../../__tests__/support/wait'
import { AgentProjectorImpl } from '../agentProjector'
import { displayItemOf, resolveDisplayItems, type DisplayItem } from '../display'
import { projectSessionView } from '../project'
import {
  SessionProjectorImpl,
  type ProjectorHandle,
  type ProjectorHost,
  type ProjectorMount,
  type RunLifecycleSignal,
  type SessionProjector
} from '../sessionProjector'

// ─────────────────────────── 操作流 ───────────────────────────

/** 一次性的视图服务 `t`（`{view: state}`） */
function viewService<V>(): Service<{ view: ReplicatedState<V> }> {
  return (defineService as (id: string) => Service<{ view: ReplicatedState<V> }>)('t')
}

export interface Revision<V> {
  readonly sequence: number
  readonly ops: readonly Op[]
  /** 这次修订之后状态的值（监听在 change 里同步调用） */
  readonly value: V
}

export interface OpsRecorder<V> {
  readonly snapshot: { readonly sequence: number; readonly value: V }
  readonly revisions: Revision<V>[]
  /** 每一条操作（拍平），带着它所在修订的下标 */
  allOps(): { readonly index: number; readonly op: Op }[]
  /** 从快照起逐条 applyImmutable，每一步都必须等于那次修订记下的值 */
  replay(): void
  stop(): void
}

export function opsOf<V extends object>(
  state: ReplicatedState<V> | MutableReplicatedState<V>,
  onRevision?: (revision: Revision<V>) => void
): OpsRecorder<V> {
  const service = viewService<V>()
  const provider = new RemoteServiceProvider([{ id: 't' }])
  provider.provide(service, { view: state as ReplicatedState<V> } as never)
  const revisions: Revision<V>[] = []
  const subscription = provider.subscribe('t', 'singleton', (update) => {
    if (update.type === 'state') {
      const revision = { sequence: update.sequence, ops: update.ops, value: state.value as V }
      revisions.push(revision)
      onRevision?.(revision)
    } else {
      throw new Error(`unexpected provider update ${update.type}`)
    }
  })
  const member = subscription.snapshot.instances[0]!.members[0]!
  if (member.kind !== 'state') throw new Error('expected a state member')
  const root = member.ops[0] as Op
  const snapshot = { sequence: member.sequence, value: (root as ['r', V])[1] }
  subscription.activate()
  return {
    snapshot,
    revisions,
    allOps: () => revisions.flatMap((revision, index) => revision.ops.map((op) => ({ index, op }))),
    replay: () => {
      let value: V = snapshot.value
      for (const [index, revision] of revisions.entries()) {
        value = applyImmutable(value, revision.ops)
        expect(value, `replay at revision ${index}`).toStrictEqual(revision.value)
      }
    },
    stop: () => {
      void subscription.close()
      provider.dispose()
    }
  }
}

/**
 * 一个每次更新都抛错的服务订阅（SyncHub 的发送同步抛错的角色，PIN-03 / PIN-12）：chord 把它收集起来
 * 重抛给调用 `state.change` 的人 —— 也就是投影。返回退订函数。
 */
export function throwingSubscriber<V extends object>(
  state: ReplicatedState<V> | MutableReplicatedState<V>
): () => void {
  const service = viewService<V>()
  const provider = new RemoteServiceProvider([{ id: 't' }])
  provider.provide(service, { view: state as ReplicatedState<V> } as never)
  const subscription = provider.subscribe('t', 'singleton', () => {
    throw new Error('downstream boom')
  })
  subscription.activate()
  return () => {
    void subscription.close()
    provider.dispose()
  }
}

/** 一条操作的路径（`r` 没有路径 → []） */
export function opPath(op: Op): readonly (string | number)[] {
  return op[0] === 'r' ? [] : (op[1] as readonly (string | number)[])
}

/** 路径以 `prefix` 开头 */
export function under(op: Op, ...prefix: (string | number)[]): boolean {
  const path = opPath(op)
  return prefix.every((segment, index) => path[index] === segment)
}

// ─────────────────────────── 宿主 / 新挂载 ───────────────────────────

/** 会话交给投影的那份 ProjectorHost（内部方法；测试用它造不共享的投影实例） */
export function projectorHostOf(session: DurableSession): ProjectorHost {
  return (session as unknown as { projectorHost(): ProjectorHost }).projectorHost()
}

/** 新建、不共享的 SessionProjector 此刻挂载的值（读完拆掉） */
export async function freshMount(session: DurableSession): Promise<SessionView> {
  const projector = new SessionProjectorImpl(projectorHostOf(session))
  try {
    await projector.start()
    return projector.value
  } finally {
    projector.dispose()
  }
}

/** 新建、不共享的 AgentProjector 此刻挂载的值 */
export async function freshAgentMount(
  session: DurableSession,
  agentId: string,
  conversationId: number
): Promise<AgentView> {
  const projector = new AgentProjectorImpl(
    projectorHostOf(session),
    agentId,
    conversationId as ConversationId
  )
  try {
    await projector.start()
    return projector.value
  } finally {
    projector.dispose()
  }
}

/**
 * 带探针的 SessionProjector（P3-03-50）：每次投影（挂载 / 帧 / 刷新）都把那一刻的帧值与算出的视图交给
 * `spy` —— 帧处理器里调用，看得到旁路此刻记下了什么。
 */
export class SpyProjector extends SessionProjectorImpl {
  constructor(
    host: ProjectorHost,
    private readonly spy: (frame: ConversationView, view: SessionView) => void
  ) {
    super(host)
  }

  protected override project(mount: ProjectorMount, runState: RunViewState): SessionView {
    const view = super.project(mount, runState)
    this.spy(mount.value, view)
    return view
  }
}

/** 用例里「开一个会话 + 它的投影 + 一个句柄」的那一组 */
export interface OpenedProjector {
  readonly t: TestHost
  readonly session: DurableSession
  readonly proj: SessionProjector
  readonly h: ProjectorHandle<SessionView>
}

/** `host.close` → `host.open` → freshMount */
export async function reopenMount(
  t: TestHost,
  sessionId: string
): Promise<{ session: DurableSession; view: SessionView }> {
  await t.host.close(sessionId)
  const session = await t.host.open(sessionId)
  return { session, view: await freshMount(session) }
}

/** 视图里去掉询问（询问随进程消失：重开之后的比较不含它们） */
export function withoutAsks(view: SessionView): SessionView {
  return { ...view, asks: [] }
}

// ─────────────────────────── 身份预言（PIN-10） ───────────────────────────

export interface OracleRecord {
  readonly conversationId: number
  readonly frame: ConversationView
  readonly runState: RunViewState
  readonly asks: InputRequest[]
  readonly view: SessionView
}

export interface Oracle {
  readonly records: OracleRecord[]
  /** 逐帧重算并深比较；返回比较过的帧数 */
  verify(): Promise<number>
  stop(): Promise<void>
}

/**
 * 在投影之后挂一个独立的 watch（同一个视图挂载上的第二个观察者，帧紧跟着投影的帧到达）。投影换挂载
 * （操作流里的 `["r"]`）之后预言换到新对话 —— 投影的新 watch 已经挂上，预言仍排在它后面。
 */
export async function attachOracle(
  session: DurableSession,
  state: MutableReplicatedState<SessionView>
): Promise<Oracle> {
  const records: OracleRecord[] = []
  let watch: WatchHandle<ConversationView> | undefined
  let generation = 0
  let attaching: Promise<void> = Promise.resolve()
  const attach = async (conversationId: number): Promise<void> => {
    const mine = ++generation
    const previous = watch
    watch = undefined
    await previous?.stop()
    const conversation = await session.harness.conversation(conversationId as ConversationId, BG)
    const next = await conversation!.watch(BG)
    if (mine !== generation) {
      await next.stop()
      return
    }
    watch = next
    next.start(async (frame) => {
      records.push({
        conversationId,
        frame,
        runState: session.runState,
        asks: JSON.parse(JSON.stringify(session.pendingInputs())) as InputRequest[],
        view: state.value
      })
    })
  }
  // 换挂载：操作流里出现 `["r"]` → 预言跟过去
  const ops = opsOf(state, (revision) => {
    if (revision.ops.some((op) => op[0] === 'r')) {
      attaching = attaching.then(() => attach(revision.value.conversationId!))
    }
  })
  await attach(state.value.conversationId!)
  return {
    records,
    verify: async () => {
      await attaching
      let compared = 0
      const queueMaps = new Map<number, Map<number, DisplayItem>>()
      for (const [index, record] of records.entries()) {
        // 换挂载的窗口里（预言还在旧对话上）不比较
        if (record.view.conversationId !== record.conversationId) continue
        const { entries, docs } = record.frame
        const display = await resolveDisplayItems(
          session.harness,
          record.conversationId as ConversationId,
          entries
        )
        let queueDisplay = queueMaps.get(record.conversationId)
        if (queueDisplay === undefined) {
          queueDisplay = await queueDisplayOf(session, record.conversationId)
          queueMaps.set(record.conversationId, queueDisplay)
        }
        const expected = projectSessionView(
          { sessionId: session.sessionId, conversationId: record.conversationId },
          entries,
          docs[LiveDoc.definition.kind] as LiveState | undefined,
          docs['pi.inbox'] as InboxState | undefined,
          display,
          record.asks,
          record.runState,
          queueDisplay
        )
        expect(record.view, `oracle frame ${index}`).toStrictEqual(expected)
        compared++
      }
      return compared
    },
    stop: async () => {
      generation++
      ops.stop()
      await watch?.stop()
    }
  }
}

/** 排队输入 → 显示侧车（独立查询：DisplayDoc 的每一份按 requestId 找 submission id；映射不会变） */
export async function queueDisplayOf(
  session: DurableSession,
  conversationId: number
): Promise<Map<number, DisplayItem>> {
  const doc = await session.harness.snapshot(DisplayDoc, conversationId as ConversationId, BG)
  const items: [string, DisplayItem][] = []
  for (const [requestId, item] of Object.entries(doc?.items ?? {})) {
    const parsed = displayItemOf(item)
    if (parsed !== undefined) items.push([requestId, parsed])
  }
  const map = new Map<number, DisplayItem>()
  if (items.length === 0) return map
  await session.harness.commit(async (tx) => {
    for (const [requestId, item] of items) {
      const record = await tx.submissionByRequest(conversationId as ConversationId, requestId)
      if (record !== undefined) map.set(record.id, item)
    }
  }, BG)
  return map
}

// ─────────────────────────── 生命周期 ───────────────────────────

export type LifecycleRecord = RunLifecycleSignal & { readonly view?: SessionView }

/** 信号去掉 view 之后（按 kind 分开，`reason` 只在 ended 上） */
export type BareSignal = RunLifecycleSignal

export function recordLifecycle(
  projector: SessionProjector,
  state?: MutableReplicatedState<SessionView>
): { readonly signals: LifecycleRecord[]; stop(): void } {
  const signals: LifecycleRecord[] = []
  const stop = projector.onRunLifecycle((signal) => {
    signals.push(state === undefined ? signal : { ...signal, view: state.value })
  })
  return { signals, stop }
}

/** 信号去掉 view，只留设计稿记录的那几项 */
export function bare(records: readonly LifecycleRecord[]): BareSignal[] {
  return records.map(({ view: _view, ...signal }) => signal as BareSignal)
}

// ─────────────────────────── 直接写 pi.live ───────────────────────────

/** 在当前对话的 `pi.live` 上提交一次修改（一次发布 → 一帧） */
export async function liveCommit(
  session: DurableSession,
  mutate: (live: LiveState) => void
): Promise<void> {
  const conversation = await session.currentConversation()
  await session.harness.commit(async (tx) => {
    mutate((await tx.doc(LiveDoc, conversation.id)) as LiveState)
  }, BG)
}

/** 等投影把挂起的帧都处理完（真实时钟：几个宏任务） */
export async function settleFrames(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index++) await sleep(5)
}

// ─────────────────────────── 测试工具 ───────────────────────────

/** `read`：返回 `read <path>` */
export function readTool(): ToolRegistration {
  return defineTool({
    name: 'read',
    description: 'read: reads a file',
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: async (args) => ({ content: [{ type: 'text', text: `read ${args.path ?? '?'}` }] })
  })
}

/** `bash`：逐段输出（每段之间等 `gapMs`），最后返回 `ok` */
export function streamTool(chunks: readonly string[], gapMs = 150): ToolRegistration {
  return defineTool({
    name: 'bash',
    description: 'bash: runs a command',
    parameters: Type.Object({ command: Type.Optional(Type.String()) }),
    execute: async (_args, api) => {
      for (const chunk of chunks) {
        api.output(chunk)
        await sleep(gapMs)
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
  })
}

/** 落盘的位置（`spillTool` 的诊断里的 locator） */
export const SPILL_PATH = '/tmp/shuvix spill/c2.txt'

/** `dump`：预览文本 + 一条落盘诊断（pi 把 `<harness>` 段追加在内容末尾） */
export function spillTool(): ToolRegistration {
  return defineTool({
    name: 'dump',
    description: 'dump: prints a lot',
    parameters: Type.Object({}),
    execute: async (_args, api) => {
      api.diagnostic(
        truncationDiagnostic({
          text: '',
          truncated: true,
          persisted: true,
          originalLines: 900,
          originalBytes: 90000,
          locator: SPILL_PATH
        })!
      )
      return { content: [{ type: 'text', text: 'preview' }] }
    }
  })
}

/** 严格 JSON 且 JSON 往返深相等（P3-03-55） */
export function expectJson(value: unknown, label = 'view'): void {
  expect(isJsonOnly(value), label).toBe(true)
  expect(JSON.parse(JSON.stringify(value)), label).toStrictEqual(value)
}

/** 每一条修订都是严格 JSON（P3-03-55） */
export function expectJsonRevisions(recorder: OpsRecorder<object>): void {
  expectJson(recorder.snapshot.value, 'snapshot')
  for (const [index, revision] of recorder.revisions.entries()) {
    expectJson(revision.value, `revision ${index}`)
  }
}
