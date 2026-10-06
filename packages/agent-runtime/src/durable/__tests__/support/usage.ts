/**
 * 可定价的 faux（P3-13 监控快照）：faux 自己按字符估用量、花费恒为 0（`withUsageEstimate`），钉不住精确的
 * 缓存 / 上下文 / 花费数。这里把套件里的 faux provider 换成一层包装：每个请求的应答（流里的每个事件、最终
 * 消息）都盖上脚本给的用量 —— 按请求次序从队列里取，或按请求现算（`price`）。没给的请求保持 faux 的估算。
 *
 * 换的是 `kit.models` 里的 provider（模型目录与生成共用同一份 Models），所以在建 agent 之前或之后调用都行，
 * 只要在那次请求发出之前。
 */
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Usage
} from '@earendil-works/pi-ai'
import type { FauxKit } from './faux'

/** 用量的脚本：没给的计数为 0；`cost` = `cost.total`（其余的花费分项为 0） */
export interface UsageSpec {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly cost?: number
}

export function usageOf(spec: UsageSpec): Usage {
  const input = spec.input ?? 0
  const output = spec.output ?? 0
  const cacheRead = spec.cacheRead ?? 0
  const cacheWrite = spec.cacheWrite ?? 0
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: spec.cost ?? 0 }
  }
}

export interface UsageStamp {
  /** 接下来的请求依次盖这些用量 */
  queue(...specs: UsageSpec[]): void
  /** 按请求现算（优先于队列；返回 undefined = 走队列 / faux 的估算） */
  price(fn: ((context: Context) => UsageSpec | undefined) | undefined): void
  /** 已经盖过的用量（按请求次序） */
  readonly stamped: Usage[]
}

function stampMessage(message: AssistantMessage, usage: Usage): AssistantMessage {
  return { ...message, usage: structuredClone(usage) }
}

function stampEvent(event: AssistantMessageEvent, usage: Usage): AssistantMessageEvent {
  const stamped: Record<string, unknown> = { ...event }
  for (const key of ['partial', 'message', 'error'] as const) {
    const value = stamped[key] as AssistantMessage | undefined
    if (value !== undefined && typeof value === 'object') stamped[key] = stampMessage(value, usage)
  }
  return stamped as unknown as AssistantMessageEvent
}

/** 把 `kit` 的 faux provider 换成盖用量的包装 */
export function stampUsage(kit: FauxKit): UsageStamp {
  const pending: Usage[] = []
  const stamped: Usage[] = []
  let pricer: ((context: Context) => UsageSpec | undefined) | undefined
  const inner = kit.faux.provider
  const wrap = (
    context: Context,
    stream: AssistantMessageEventStream
  ): AssistantMessageEventStream => {
    const priced = pricer?.(context)
    const usage = priced !== undefined ? usageOf(priced) : pending.shift()
    if (usage === undefined) return stream
    stamped.push(usage)
    const outer = createAssistantMessageEventStream()
    void (async () => {
      for await (const event of stream) outer.push(stampEvent(event, usage))
      outer.end(stampMessage(await stream.result(), usage))
    })()
    return outer
  }
  kit.models.setProvider({
    ...inner,
    stream: (model, context, options) =>
      wrap(context as Context, inner.stream(model, context, options)),
    streamSimple: (model, context, options) =>
      wrap(context as Context, inner.streamSimple(model, context, options))
  })
  return {
    queue: (...specs) => pending.push(...specs.map(usageOf)),
    price: (fn) => {
      pricer = fn
    },
    stamped
  }
}
