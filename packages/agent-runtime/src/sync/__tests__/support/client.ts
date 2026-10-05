/**
 * SyncHub 用例的客户端一侧 —— **真的** chord 绑定（`createRemoteServiceBinding`）跑在一个
 * `RemoteServiceTransport` 适配器上，就是 chat-ui 的 syncClient（P3-08）将来要做的事：
 *  - `invoke` 把调用 JSON 往返一遍交给 `hub.invoke(clientId, target, call)`；
 *  - `subscribe` 先登记订阅（帧可能早于回复到达），回复用该订阅自己的解码器 `decodeSnapshot`，
 *    帧用同一个解码器 `decodeUpdate`；`activate()` 之前到的帧先缓存（PIN-11）。
 *
 * 浏览器安全：只引 chord 的根入口与 `/context`、chat-protocol —— 不引 agent-runtime（P3-04-20）。
 */
import {
  createRemoteServiceBinding,
  createServiceStateDecoder,
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
  defineService,
  parseWireServiceProviderUpdate,
  parseWireServiceSubscriptionSnapshot,
  type JsonValue,
  type RemoteServiceBinding,
  type RemoteServiceTransport,
  type ReplicatedState,
  type ServiceProviderUpdate,
  type ServiceStateDecoder,
  type WireServiceProviderUpdate
} from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { CHAT_VIEW_SERVICE_ID, type SyncFrame, type SyncTarget } from '@shuvix/chat-protocol/sync'
import type { AgentView, SessionView } from '@shuvix/chat-protocol/types/sessionView'

type View = SessionView | AgentView

/** 前端自己的服务身份：与服务端同一个 id */
export const ChatView = defineService<{ readonly view: ReplicatedState<View> }>(
  CHAT_VIEW_SERVICE_ID
)

/** 服务端的最小面：只要 `invoke` */
export interface HubLike {
  invoke(clientId: string, target: unknown, call: unknown): Promise<JsonValue | undefined>
}

/** 帧的来源：按客户端登记一个接收者 */
export interface FrameSource {
  attach(clientId: string, receiver: (frame: SyncFrame<WireServiceProviderUpdate>) => void): void
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 订阅 id 全局唯一（同一个客户端 id 离开后再来，也不会和旧绑定撞 id） */
let nextSubscription = 0

interface SubscriptionState {
  /** 解码失败记到所属绑定的 errors */
  readonly errors: Error[]
  readonly decoder: ServiceStateDecoder
  listener: ((update: ServiceProviderUpdate) => void) | undefined
  readonly buffer: SyncFrame<WireServiceProviderUpdate>[]
  active: boolean
}

export interface TestBinding {
  readonly target: SyncTarget
  readonly binding: RemoteServiceBinding
  /** 这个绑定开过的全部订阅 id（按次序） */
  readonly subscriptionIds: string[]
  /** 交给 chord 的解码后更新（按次序） */
  readonly updates: ServiceProviderUpdate[]
  /** 收到的快照：订阅 id、序号、值 */
  readonly snapshots: { subscriptionId: string; sequence: number; value: unknown }[]
  /** chord 报告的错误（解码失败、序号断档 …） */
  readonly errors: Error[]
  /** `$chord.service` 控制调用：`subscribe:<id>` / `unsubscribe:<id>` */
  readonly controlCalls: string[]
  /** 远程门面（同一个绑定里一直是同一个对象） */
  facade(): { readonly view: ReplicatedState<View> }
  value(): View | undefined
  ready(): Promise<void>
  dispose(): Promise<void>
}

export class TestClient {
  /** `reply:<sub>` / `frame:<sub>:<type>`，按到达次序 */
  readonly events: string[] = []
  /** 到达的原始帧（JSON 往返之后） */
  readonly frames: SyncFrame<WireServiceProviderUpdate>[] = []
  /** 到达时没有对应订阅的帧 */
  readonly orphans: SyncFrame<WireServiceProviderUpdate>[] = []
  readonly #subscriptions = new Map<string, SubscriptionState>()

  constructor(
    readonly id: string,
    private readonly hub: HubLike,
    source: FrameSource
  ) {
    source.attach(id, (frame) => this.#receive(frame))
  }

  /** 为一个目标建一个 chord 绑定，并立刻 `use` 视图服务（订阅随之开始） */
  bind(target: SyncTarget): TestBinding {
    const subscriptionIds: string[] = []
    const updates: ServiceProviderUpdate[] = []
    const snapshots: TestBinding['snapshots'] = []
    const errors: Error[] = []
    const controlCalls: string[] = []
    const transport: RemoteServiceTransport = {
      invoke: async (call) =>
        json(await this.hub.invoke(this.id, json(target), json(call))) as JsonValue | undefined,
      subscribe: async (serviceId, mode, listener) => {
        const subscriptionId = `${this.id}#${++nextSubscription}`
        const state: SubscriptionState = {
          errors,
          decoder: createServiceStateDecoder(),
          listener: undefined,
          buffer: [],
          active: false
        }
        this.#subscriptions.set(subscriptionId, state)
        subscriptionIds.push(subscriptionId)
        controlCalls.push(`subscribe:${subscriptionId}`)
        try {
          const reply = json(
            await this.hub.invoke(
              this.id,
              json(target),
              json(createServiceSubscribeCall(subscriptionId, serviceId, mode))
            )
          )
          this.events.push(`reply:${subscriptionId}`)
          const snapshot = state.decoder.decodeSnapshot(parseWireServiceSubscriptionSnapshot(reply))
          const member = snapshot.instances[0]?.members.find((entry) => entry.kind === 'state')
          if (member !== undefined && member.kind === 'state') {
            snapshots.push({
              subscriptionId,
              sequence: member.sequence,
              value: member.ops[0]?.[0] === 'r' ? member.ops[0][1] : undefined
            })
          }
          state.listener = (update) => {
            updates.push(update)
            listener(update, BACKGROUND_CONTEXT)
          }
          return {
            snapshot,
            activate: () => {
              state.active = true
              for (const frame of state.buffer.splice(0)) this.#deliver(state, frame)
            },
            close: async () => {
              this.#subscriptions.delete(subscriptionId)
              controlCalls.push(`unsubscribe:${subscriptionId}`)
              await this.hub.invoke(
                this.id,
                json(target),
                json(createServiceUnsubscribeCall(subscriptionId))
              )
            }
          }
        } catch (error) {
          this.#subscriptions.delete(subscriptionId)
          throw error
        }
      }
    }
    const binding = createRemoteServiceBinding({
      services: [ChatView],
      transport,
      onError: (error) => errors.push(error)
    })
    const self: TestBinding = {
      target,
      binding,
      subscriptionIds,
      updates,
      snapshots,
      errors,
      controlCalls,
      facade: () => binding.use(ChatView),
      value: () => binding.use(ChatView).view.value,
      ready: () => binding.ready(BACKGROUND_CONTEXT),
      dispose: () => binding.dispose(BACKGROUND_CONTEXT)
    }
    binding.use(ChatView)
    return self
  }

  #receive(frame: SyncFrame<WireServiceProviderUpdate>): void {
    this.frames.push(frame)
    this.events.push(`frame:${frame.subscriptionId}:${frame.update.type}`)
    const state = this.#subscriptions.get(frame.subscriptionId)
    if (state === undefined) {
      this.orphans.push(frame)
      return
    }
    if (!state.active) {
      state.buffer.push(frame)
      return
    }
    this.#deliver(state, frame)
  }

  #deliver(state: SubscriptionState, frame: SyncFrame<WireServiceProviderUpdate>): void {
    let update: ServiceProviderUpdate
    try {
      update = state.decoder.decodeUpdate(parseWireServiceProviderUpdate(frame.update))
    } catch (error) {
      state.errors.push(error instanceof Error ? error : new Error(String(error)))
      return
    }
    state.listener?.(update)
  }
}
