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
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseStep,
  type Message,
  type MutableModels,
  type SimpleStreamOptions
} from '@earendil-works/pi-ai'
import type { JsonObject } from '@earendil-works/pi-durable'
import { aborted, deferred } from './wait'

export const FAUX_MODEL = { provider: 'faux', modelId: 'faux-1' } as const

/** 一次请求里提供的一个工具（只记模型看得见的那几项） */
export interface FauxRequestTool {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

export interface FauxRequest {
  readonly messages: Message[]
  readonly options: SimpleStreamOptions | undefined
  /** 这次请求提供的工具（按次序；由 system 消息的增量重放得出） */
  readonly tools: FauxRequestTool[]
  /** 这次请求的完整系统提示词 */
  readonly systemPrompt: string
  /** 这次请求用的模型 id */
  readonly modelId: string
}

export interface FauxModelSpec {
  readonly id: string
  readonly contextWindow?: number
  /** 模型的输出上限（压缩的摘要请求取 min(⌊0.8·reserve⌋, maxTokens)） */
  readonly maxTokens?: number
}

export interface FauxKit {
  readonly faux: FauxProviderHandle
  /** 可变的模型集合（用例可以 deleteProvider） */
  readonly models: MutableModels
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

/**
 * faux 套件。`models` 给出多个模型（第一个应是 faux-1 —— `kit.model` 恒指它）；缺省只有 faux-1
 * （`contextWindow` 给它的窗口）。
 */
export function fauxKit(
  options: {
    tokensPerSecond?: number
    contextWindow?: number
    models?: readonly FauxModelSpec[]
  } = {}
): FauxKit {
  const specs: readonly FauxModelSpec[] = options.models ?? [
    {
      id: 'faux-1',
      ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow })
    }
  ]
  const faux = fauxProvider({
    models: specs.map((spec) => ({
      id: spec.id,
      reasoning: true,
      ...(spec.contextWindow === undefined ? {} : { contextWindow: spec.contextWindow }),
      ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens })
    })),
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond })
  })
  const models = createModels()
  models.setProvider(faux.provider)
  const requests: FauxRequest[] = []
  const record =
    (step: FauxResponseStep): FauxResponseStep =>
    async (context, streamOptions, state, model) => {
      const messages = [...context.messages]
      requests.push({
        messages,
        options: streamOptions,
        tools: getCurrentTools(messages).map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as unknown
        })),
        systemPrompt: getCurrentSystemPrompt(messages),
        modelId: model.id
      })
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

/** 第 n 个请求提供的工具 */
export function requestTools(kit: FauxKit, n: number): FauxRequestTool[] {
  const request = kit.requests[n]
  if (request === undefined) throw new Error(`request ${n} was not made (${kit.requests.length})`)
  return request.tools
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
