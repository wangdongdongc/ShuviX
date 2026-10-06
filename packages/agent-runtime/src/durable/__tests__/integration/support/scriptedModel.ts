/**
 * 按内容分派的 faux 应答器（设计 §1.4）：同一个应答函数登记约 200 次，每次请求按**内容**路由 ——
 * 第一条消息是 system 且含 `context summarization assistant` → 摘要处理；否则从聊天脚本队列取下一步。
 *
 * 为什么不用 faux 自己的有序队列：后台压缩的摘要请求与聊天请求会并发，有序队列下谁先到谁拿走下一个
 * 应答，脚本就串了。这里两条队列各走各的。
 *
 *  - 聊天步骤可以是一条消息，也可以是上下文的函数（「上一条工具结果含 `was interrupted` 就再调一次
 *    write」）；`held` / `stalled` 这类步骤必须观察 `options.signal`（见 support/faux.ts）。
 *  - 摘要步骤同理；队列空了就给一份缺省摘要（`## Goal\nsummary #n`）。
 *  - 每次请求都记下 `{ kind, messages, options, tools, modelId, at }`（`at` = 世界时钟）。
 *  - 聊天脚本用完时回 `answer('(script exhausted)')` 并立旗 —— afterEach 断言旗子没立。
 */
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseFactory,
  type FauxResponseStep,
  type Message,
  type SimpleStreamOptions
} from '@earendil-works/pi-ai'
import type { JsonObject } from '@earendil-works/pi-durable'
import { answer } from '../../support/faux'

const SUMMARY_MARKER = 'context summarization assistant'
const RESPONDERS = 200

export interface ScriptedRequest {
  readonly kind: 'chat' | 'summary'
  readonly messages: Message[]
  readonly options: SimpleStreamOptions | undefined
  /** 这次请求提供的工具名（按次序） */
  readonly tools: string[]
  readonly modelId: string
  /** 请求到达时的世界时钟 */
  readonly at: number
  /** 这次请求走的车道（没登记车道时恒为 `root`；摘要请求为 `summary`） */
  readonly lane: string
  /** 这次请求的完整系统提示词 */
  readonly systemPrompt: string
  /** 这次请求的思考档位（`options.reasoning`） */
  readonly reasoning: string | undefined
}

/** 车道的匹配：看这次请求的消息与系统提示词 */
export type LaneMatch = (request: { messages: Message[]; systemPrompt: string }) => boolean

export interface ScriptedModel {
  readonly requests: ScriptedRequest[]
  /** 只看聊天请求 / 只看摘要请求 */
  readonly chats: ScriptedRequest[]
  readonly summaries: ScriptedRequest[]
  /** 追加聊天步骤（`root` 车道） */
  chat(...steps: FauxResponseStep[]): void
  /**
   * 登记一条车道（P2-11 PIN-01）：聊天请求按登记次序找第一条匹配的车道、从它的队列取步骤。一条车道都没
   * 登记时一切照旧（全进 `root`）；登记过之后，没有车道匹配的请求立旗 `exhausted`（带「unmatched」）。
   * 名字 `root` 的车道用 `chat()` 的那条队列。
   */
  lane(name: string, match: LaneMatch): void
  /** 给某条车道追加聊天步骤 */
  chatIn(lane: string, ...steps: FauxResponseStep[]): void
  /** 某条车道的请求 */
  laneRequests(lane: string): ScriptedRequest[]
  /** 立旗的原因（车道名 / `unmatched`） */
  readonly exhaustedBy: string[]
  /** 追加摘要步骤（缺省摘要之前先用这些） */
  summary(...steps: FauxResponseStep[]): void
  /** 聊天脚本是否被用完过 */
  readonly exhausted: boolean
  /** 还没用掉的聊天步骤数 */
  readonly pendingChat: number
}

function systemText(message: Message | undefined): string {
  if (message?.role !== 'system') return ''
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : JSON.stringify(content ?? '')
}

export function isSummaryRequest(messages: readonly Message[]): boolean {
  return systemText(messages[0]).includes(SUMMARY_MARKER)
}

/** 给一个 faux provider 装上脚本（每个「进程」一份） */
export function scriptedModel(faux: FauxProviderHandle, now: () => number): ScriptedModel {
  const requests: ScriptedRequest[] = []
  const chatQueue: FauxResponseStep[] = []
  const summaryQueue: FauxResponseStep[] = []
  const lanes: { name: string; match: LaneMatch }[] = []
  const queues = new Map<string, FauxResponseStep[]>([['root', chatQueue]])
  const exhaustedBy: string[] = []
  let summaries = 0
  const queueOf = (lane: string): FauxResponseStep[] => {
    let queue = queues.get(lane)
    if (queue === undefined) {
      queue = []
      queues.set(lane, queue)
    }
    return queue
  }

  const respond: FauxResponseFactory = async (context, options, state, model) => {
    const messages = [...context.messages]
    const kind = isSummaryRequest(messages) ? 'summary' : 'chat'
    const systemPrompt = kind === 'chat' ? getCurrentSystemPrompt(messages) : ''
    let lane = kind === 'summary' ? 'summary' : 'root'
    if (kind === 'chat' && lanes.length > 0) {
      lane = lanes.find((candidate) => candidate.match({ messages, systemPrompt }))?.name ?? ''
    }
    requests.push({
      kind,
      messages,
      options,
      tools: kind === 'chat' ? getCurrentTools(messages).map((tool) => tool.name) : [],
      modelId: model.id,
      at: now(),
      lane: lane === '' ? 'unmatched' : lane,
      systemPrompt,
      reasoning: (options as { reasoning?: string } | undefined)?.reasoning
    })
    let step: FauxResponseStep | undefined
    if (kind === 'summary') {
      summaries++
      step = summaryQueue.shift() ?? answer(`## Goal\nsummary #${summaries}`)
    } else {
      step = lane === '' ? undefined : queueOf(lane).shift()
      if (step === undefined) {
        exhaustedBy.push(lane === '' ? 'unmatched' : lane)
        step = answer('(script exhausted)')
      }
    }
    return typeof step === 'function' ? step(context, options, state, model) : step
  }
  faux.appendResponses(Array.from({ length: RESPONDERS }, () => respond))

  return {
    requests,
    get chats() {
      return requests.filter((request) => request.kind === 'chat')
    },
    get summaries() {
      return requests.filter((request) => request.kind === 'summary')
    },
    chat: (...steps) => void chatQueue.push(...steps),
    summary: (...steps) => void summaryQueue.push(...steps),
    lane: (name, match) => {
      lanes.push({ name, match })
      queueOf(name)
    },
    chatIn: (lane, ...steps) => void queueOf(lane).push(...steps),
    laneRequests: (lane) => requests.filter((request) => request.lane === lane),
    exhaustedBy,
    get exhausted() {
      return exhaustedBy.length > 0
    },
    get pendingChat() {
      return chatQueue.length
    }
  }
}

/** 一条消息的文本（user / toolResult 的文本块拼起来；assistant 的文本，没有就 `[tool:name]`） */
export function textOf(message: Message | undefined): string {
  if (message === undefined || message.role === 'system') return ''
  if (message.role === 'user') {
    return typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  }
  if (message.role === 'toolResult') {
    return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  }
  const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  return text.length > 0
    ? text
    : message.content
        .map((part) => (part.type === 'toolCall' ? `[tool:${part.name}]` : ''))
        .join('')
}

/** 一次请求里不含 system 的消息，`<role>:<text>` */
export function lines(request: ScriptedRequest): string[] {
  return request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => `${message.role}:${textOf(message)}`)
}

/** 一条消息里的几个工具调用（同一轮；durable 缺省并行执行，F11） */
export function callTools(
  ...calls: readonly [name: string, args: JsonObject, id: string][]
): AssistantMessage {
  return fauxAssistantMessage(
    calls.map(([name, args, id]) => fauxToolCall(name, args, { id })),
    { stopReason: 'toolUse' }
  )
}

/** 某次请求里最后一条（某工具的）工具结果的文本 */
export function lastToolResult(
  messages: readonly Message[],
  toolName?: string
): string | undefined {
  const found = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'toolResult' && (toolName === undefined || message.toolName === toolName)
    )
  return found === undefined ? undefined : textOf(found)
}

/** 一条脚本步骤：看上下文决定交什么 */
export function when(
  decide: (messages: Message[]) => AssistantMessage | Promise<AssistantMessage>
): FauxResponseStep {
  return (context) => decide([...context.messages])
}
