/**
 * syncClient 用例的服务端一侧（P3-08 设计稿「Conventions · fakeServer」）：**真的** chord 服务端 —— 每个目标
 * 一个 `RemoteServiceProvider([shuvix.chat.view])` 交出 `replicatedState<SessionView | AgentView>`，一个
 * `createRemoteServiceEndpoint`，每个订阅一个 `createServiceStateEncoder` —— 包成一条 `SyncChannel`：
 *
 *  - `invoke` 把调用 JSON 往返一遍交给端点；订阅的回复用该订阅的编码器 `encodeSnapshot`；
 *  - 更新经编码器 `encodeUpdate`，在微任务里作为帧交给 `onFrame` 的监听器（与 IPC 一样异步到达）。
 *
 * 旋钮：
 *  - `framesBeforeReply`：订阅回复交出之前先发 n 帧（每帧一次 `beforeReplyChange`）—— 帧早于回复到达；
 *  - `failSubscribe(code)`：下一次订阅以带 `.code` 的 Error 拒绝（`code` 为 undefined → 不带码）；
 *  - `reset(subId)`：在这个订阅上发一帧 `{type:'reset', snapshot}`（当前值整份，序号接着走）；
 *  - `replace(target, view)` / `withdraw(target)`：换实现（`replaced`）/ 撤下（`unavailable`）；
 *  - `holdFrames()` / `release()`：先攒着帧、放手时按序送出；
 *  - `dropNext(subId)`：丢掉这个订阅的下一帧（造一次断档）；
 *  - `change(target, draft => …)`：改服务端的值（一次发布）；
 *  - `inject(frame)`：原样送一帧（孤儿帧 / 坏帧）。
 *
 * 只引 chord 与 chat-protocol（chord 是 chat-ui 的依赖）；不引 agent-runtime。
 */
import {
  createRemoteServiceEndpoint,
  createServiceStateEncoder,
  defineService,
  decodeServiceControlCall,
  parseServiceCall,
  RemoteServiceProvider,
  replicatedState,
  type Draft,
  type JsonValue,
  type MutableReplicatedState,
  type ReplicatedState,
  type RemoteServiceEndpoint,
  type ServiceProviderUpdate,
  type ServiceStateEncoder,
  type ServiceSubscriptionSnapshot
} from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  CHAT_VIEW_SERVICE_ID,
  syncTargetKey,
  type SyncChannel,
  type SyncFrame,
  type SyncTarget
} from '@shuvix/chat-protocol/sync'
import type { AgentView, SessionView } from '@shuvix/chat-protocol/types/sessionView'

type View = SessionView | AgentView

const ChatView = defineService<{ readonly view: ReplicatedState<View> }>(CHAT_VIEW_SERVICE_ID)

function json<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

interface Subscription {
  readonly id: string
  readonly target: SyncTarget
  readonly encoder: ServiceStateEncoder
  /** 这个订阅上 view 成员的最新序号（reset 的基线） */
  sequence: number
  /** 订阅回复的解码前快照（reset 照它的形状造） */
  snapshot: ServiceSubscriptionSnapshot
  open: boolean
  drop: number
}

interface TargetEntry {
  readonly target: SyncTarget
  readonly provider: RemoteServiceProvider
  state: MutableReplicatedState<View>
  endpoint: RemoteServiceEndpoint
}

export interface FakeServerOptions {
  /** 订阅回复交出之前先发几帧（P3-08-01） */
  framesBeforeReply?: number
  /** 回复之前的那几帧各做什么改动（缺省：给实时卡追加一个字） */
  beforeReplyChange?: (draft: Draft<View>, index: number) => void
}

export interface FakeServer {
  readonly channel: SyncChannel
  /** 每次 invoke 的记录：`subscribe:<id>` / `unsubscribe:<id>` / `call:<member>` / `fail:<id>` */
  readonly calls: string[]
  /** 送出的帧（按序） */
  readonly frames: SyncFrame[]
  /** onFrame 登记 / 注销的次数 */
  readonly frameListeners: { registered: number; unregistered: number; active: number }
  /** 给一个目标装上初始值（第一次订阅之前调） */
  serve(target: SyncTarget, view: View): void
  /** 服务端此刻的值 */
  value(target: SyncTarget): View
  change(target: SyncTarget, mutate: (draft: Draft<View>) => void): void
  replace(target: SyncTarget, view: View): void
  withdraw(target: SyncTarget): void
  failSubscribe(code?: string): void
  reset(subscriptionId: string): void
  dropNext(subscriptionId: string): void
  holdFrames(): void
  release(): Promise<void>
  /** 活着的订阅 id（按目标） */
  subscriptions(target?: SyncTarget): string[]
  /** 原样送一帧给前端（造孤儿 / 坏帧） */
  inject(frame: SyncFrame): void
  /** 等微任务 / 宏任务都跑完 */
  settle(): Promise<void>
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export function fakeServer(options: FakeServerOptions = {}): FakeServer {
  const entries = new Map<string, TargetEntry>()
  const subscriptions = new Map<string, Subscription>()
  const listeners = new Set<(frame: SyncFrame) => void>()
  const calls: string[] = []
  const frames: SyncFrame[] = []
  const frameListeners = { registered: 0, unregistered: 0, active: 0 }
  let failNext: { code?: string } | undefined
  let held: SyncFrame[] | undefined

  function deliver(frame: SyncFrame): void {
    frames.push(frame)
    const copy = json(frame)
    queueMicrotask(() => {
      for (const listener of [...listeners]) listener(copy)
    })
  }

  function emit(sub: Subscription, update: ServiceProviderUpdate): void {
    if (update.type === 'state') sub.sequence = update.sequence
    if (update.type === 'replaced') {
      const member = update.snapshot.members.find((m) => m.kind === 'state')
      if (member && member.kind === 'state') sub.sequence = member.sequence
    }
    if (update.type === 'reset') {
      const member = update.snapshot.instances[0]?.members.find((m) => m.kind === 'state')
      if (member && member.kind === 'state') sub.sequence = member.sequence
    }
    const encoded = sub.encoder.encodeUpdate(update)
    if (sub.drop > 0) {
      sub.drop -= 1
      return
    }
    const frame: SyncFrame = { target: sub.target, subscriptionId: sub.id, update: encoded }
    if (held) held.push(frame)
    else deliver(frame)
  }

  function entryOf(target: SyncTarget): TargetEntry {
    const entry = entries.get(syncTargetKey(target))
    if (!entry) throw new Error(`fakeServer: no view served for ${syncTargetKey(target)}`)
    return entry
  }

  function publisher(subscriptionId: string, update: ServiceProviderUpdate): void {
    const sub = subscriptions.get(subscriptionId)
    if (sub === undefined || !sub.open) return
    emit(sub, update)
  }

  const defaultChange = (draft: Draft<View>): void => {
    const live = (draft as Draft<SessionView>).live
    if (live) {
      const block = live.message.blocks[live.message.blocks.length - 1]
      if (block && block.type === 'text') block.text += '.'
    }
  }

  const channel: SyncChannel = {
    invoke: async (rawTarget, rawCall) => {
      const target = json(rawTarget)
      const call = parseServiceCall(json(rawCall))
      const control = call.serviceId === '$chord.service' ? decodeServiceControlCall(call) : undefined
      const entry = entryOf(target)
      if (control?.type === 'subscribe') {
        const id = control.subscriptionId
        if (failNext) {
          const { code } = failNext
          failNext = undefined
          calls.push(`fail:${id}`)
          const error = new Error(`subscribe refused (${code ?? 'no code'})`) as Error & {
            code?: string
          }
          if (code !== undefined) error.code = code
          throw error
        }
        calls.push(`subscribe:${id}`)
        const sub: Subscription = {
          id,
          target,
          encoder: createServiceStateEncoder(),
          sequence: 0,
          snapshot: undefined as unknown as ServiceSubscriptionSnapshot,
          open: false,
          drop: 0
        }
        subscriptions.set(id, sub)
        const snapshot = (await entry.endpoint.invoke(
          call,
          publisher,
          BACKGROUND_CONTEXT
        )) as unknown as ServiceSubscriptionSnapshot
        sub.snapshot = snapshot
        const member = snapshot.instances[0]?.members.find((m) => m.kind === 'state')
        if (member && member.kind === 'state') sub.sequence = member.sequence
        const reply = sub.encoder.encodeSnapshot(snapshot)
        sub.open = true
        const early = options.framesBeforeReply ?? 0
        for (let index = 0; index < early; index++) {
          entry.state.change(BACKGROUND_CONTEXT, (draft) =>
            (options.beforeReplyChange ?? defaultChange)(draft as Draft<View>, index)
          )
        }
        if (early > 0) {
          // 让早到的帧先于回复送达
          await tick()
        }
        return json(reply) as unknown as JsonValue
      }
      if (control?.type === 'unsubscribe') {
        calls.push(`unsubscribe:${control.subscriptionId}`)
        const sub = subscriptions.get(control.subscriptionId)
        if (sub) sub.open = false
        subscriptions.delete(control.subscriptionId)
        return json(
          await entry.endpoint.invoke(call, publisher, BACKGROUND_CONTEXT)
        ) as JsonValue | undefined
      }
      calls.push(`call:${call.member}`)
      return json(await entry.endpoint.invoke(call, publisher, BACKGROUND_CONTEXT)) as
        | JsonValue
        | undefined
    },
    onFrame: (callback) => {
      frameListeners.registered += 1
      frameListeners.active += 1
      const entry = (frame: SyncFrame): void => callback(frame)
      listeners.add(entry)
      let removed = false
      return () => {
        if (removed) return
        removed = true
        frameListeners.unregistered += 1
        frameListeners.active -= 1
        listeners.delete(entry)
      }
    }
  }

  return {
    channel,
    calls,
    frames,
    frameListeners,
    serve: (target, view) => {
      const provider = new RemoteServiceProvider([ChatView])
      const state = replicatedState<View>(json(view))
      provider.provide(ChatView, { view: state })
      entries.set(syncTargetKey(target), {
        target,
        provider,
        state,
        endpoint: createRemoteServiceEndpoint(provider)
      })
    },
    value: (target) => entryOf(target).state.value,
    change: (target, mutate) =>
      entryOf(target).state.change(BACKGROUND_CONTEXT, (draft) => mutate(draft as Draft<View>)),
    replace: (target, view) => {
      const entry = entryOf(target)
      const state = replicatedState<View>(json(view))
      entry.state = state
      entry.provider.replace(ChatView, { view: state })
    },
    withdraw: (target) => entryOf(target).provider.withdraw(ChatView),
    failSubscribe: (code) => {
      failNext = code === undefined ? {} : { code }
    },
    reset: (subscriptionId) => {
      const sub = subscriptions.get(subscriptionId)
      if (!sub) throw new Error(`fakeServer: no subscription ${subscriptionId}`)
      const value = entryOf(sub.target).state.value
      const instance = sub.snapshot.instances[0]!
      const snapshot: ServiceSubscriptionSnapshot = {
        ...sub.snapshot,
        instances: [
          {
            ...instance,
            members: instance.members.map((m) =>
              m.kind === 'state'
                ? { ...m, sequence: sub.sequence, ops: [['r', json(value) as JsonValue]] }
                : m
            )
          }
        ]
      }
      emit(sub, { type: 'reset', snapshot })
    },
    dropNext: (subscriptionId) => {
      const sub = subscriptions.get(subscriptionId)
      if (sub) sub.drop += 1
    },
    holdFrames: () => {
      held ??= []
    },
    release: async () => {
      const pending = held ?? []
      held = undefined
      for (const frame of pending) deliver(frame)
      await tick()
    },
    subscriptions: (target) =>
      [...subscriptions.values()]
        .filter((s) => target === undefined || syncTargetKey(s.target) === syncTargetKey(target))
        .map((s) => s.id),
    inject: (frame) => deliver(frame),
    settle: async () => {
      for (let i = 0; i < 4; i++) await tick()
    }
  }
}
