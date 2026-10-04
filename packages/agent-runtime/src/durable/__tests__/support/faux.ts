/**
 * faux 模型套件：每个「模拟进程」一份（重启 = 新套件，旧套件里排着的应答不会串进新进程）。
 *
 * 每个应答步骤都经 `record` 包一层，把这次请求看到的消息与选项记下来；`held` / `stalled` 的步骤
 * **必须观察 signal** —— faux 只在流式输出时检查中止，一个对 signal 充耳不闻的闸门会让
 * `Harness.close()` 永远等下去（照抄 pi/durable/test/harness-inbox.test.ts 的 `gated()`）。
 */
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseStep,
  type Message,
  type Models,
  type SimpleStreamOptions
} from '@earendil-works/pi-ai'
import type { JsonObject } from '@earendil-works/pi-durable'
import { aborted, deferred } from './wait'

export const FAUX_MODEL = { provider: 'faux', modelId: 'faux-1' } as const

export interface FauxRequest {
  readonly messages: Message[]
  readonly options: SimpleStreamOptions | undefined
}

export interface FauxKit {
  readonly faux: FauxProviderHandle
  readonly models: Models
  readonly model: typeof FAUX_MODEL
  /** 每个被应答的请求（按顺序） */
  readonly requests: FauxRequest[]
  /** 包一层记录 */
  record(step: FauxResponseStep): FauxResponseStep
  /** 追加应答（自动记录） */
  queue(...steps: FauxResponseStep[]): void
  /** faux 被调用的次数（含没有应答排队的那些） */
  readonly callCount: number
}

export function fauxKit(
  options: { tokensPerSecond?: number; contextWindow?: number } = {}
): FauxKit {
  const faux = fauxProvider({
    models: [
      {
        id: 'faux-1',
        reasoning: true,
        ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow })
      }
    ],
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond })
  })
  const models = createModels()
  models.setProvider(faux.provider)
  const requests: FauxRequest[] = []
  const record =
    (step: FauxResponseStep): FauxResponseStep =>
    async (context, streamOptions, state, model) => {
      requests.push({ messages: [...context.messages], options: streamOptions })
      return typeof step === 'function' ? step(context, streamOptions, state, model) : step
    }
  return {
    faux,
    models,
    model: FAUX_MODEL,
    requests,
    record,
    queue: (...steps) => faux.appendResponses(steps.map(record)),
    get callCount() {
      return faux.state.callCount
    }
  }
}

export function answer(text: string): AssistantMessage {
  return fauxAssistantMessage([fauxText(text)])
}

export function callTool(
  name: string,
  args: JsonObject = {},
  id = `call-${name}`
): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: 'toolUse' })
}

/** provider 错误（stopReason 'error'）；文案含 'overloaded' 时可重试 */
export function modelError(message: string): AssistantMessage {
  return fauxAssistantMessage([], { stopReason: 'error', errorMessage: message })
}

export interface Held {
  readonly step: FauxResponseStep
  /** 请求已发出（步骤开始执行） */
  readonly reached: Promise<void>
  /** 放行，交回 message */
  release(): void
}

/** 应答被扣住，直到 release 或请求被取消（观察 signal） */
export function held(message: AssistantMessage): Held {
  const reached = deferred()
  const gate = deferred()
  const step: FauxResponseStep = async (_context, streamOptions) => {
    reached.resolve()
    await Promise.race([gate.promise, aborted(streamOptions!.signal!)])
    return message
  }
  return { step, reached: reached.promise, release: () => gate.resolve() }
}

/** 永不应答，直到请求被取消 */
export function stalled(): { readonly step: FauxResponseStep; readonly reached: Promise<void> } {
  const reached = deferred()
  const step: FauxResponseStep = async (_context, streamOptions) => {
    reached.resolve()
    return aborted(streamOptions!.signal!)
  }
  return { step, reached: reached.promise }
}
