/**
 * invokeTool —— 单测里调一次工具（仅测试用；产品代码不得 import，见 __tests__/invokeTool.test.ts 的守卫）。
 *
 * durable 工具的执行签名是 `execute(args, api, context)`，api 由 durable 的 tool task 现造。这里造
 * 一份假的：调用身份（callId / taskId / conversationId）、chord context（带上给定的 signal），
 * 并把工具经 api 汇报的东西记下来 —— `output()` 的文本、`diagnostic()` 的附注、`details()` 的每一版。
 * 返回值里的 `result` 按 durable 结算的口径补齐（tool.ts 的 finalResult，不含截断与 afterTool）：
 * 没给 content 就用 output 文本，没给 details 就用最后一次 `details()`，api 记下的诊断排在结果自带的之前。
 *
 * 两种形状都收：旧形状工具（ask / git / MCP 桥接层，P1-05 之前）经 `fromAgentTool` 走同一条路，
 * 抛错照样按裁定 Q12 收成 isError 结果。
 *
 * 假 api 兑现不了的成员（commit / createTask / snapshot …）一调就抛，说清楚要经 `options.api` 自己给；
 * `memo` 是一张进程内的表（先到的候选值胜出，同 durable）；`agent()` 缺省回一个只装着这个工具的
 * agent。调用结束之后再碰 api 也会抛（durable 的约束：调用结算后 api 失效）。
 */
import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import {
  ROOT_CONVERSATION_ID,
  type Agent,
  type ConversationId,
  type RegistrySnapshot,
  type TaskId,
  type ToolControl,
  type ToolDiagnostic,
  type ToolExecutionApi
} from '@earendil-works/pi-durable'
import type { Static, TSchema, Usage } from '@earendil-works/pi-ai'
import {
  asToolRegistration,
  type AgentTool,
  type AnyLegacyAgentTool,
  type AnyTool,
  type ToolContent
} from '../toolResult'

/** 能交给 invokeTool 的工具：durable 注册项（BaseTool 子类等）或旧形状工具 */
export type InvokableTool = AnyTool | AnyLegacyAgentTool

/** 工具参数的类型（按它的 parameters 推） */
export type InvokeArgs<T> = T extends { parameters: infer P extends TSchema }
  ? Static<P>
  : Record<string, unknown>

/** 旧形状工具带着自己的 details 类型；durable 的一律 unknown（与旧 BaseTool.execute 一致） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 只为从旧形状里推出 details 类型
export type InvokeDetails<T> = T extends AgentTool<any, infer D> ? D : unknown

export interface InvokeToolOptions {
  /** provider 的工具调用 id（缺省 `call-<n>`） */
  callId?: string
  /** durable tool task id（缺省 1） */
  taskId?: number
  /** 发起调用的对话（缺省根对话） */
  conversationId?: number
  /** 取消信号 —— 成为 `context.abortSignal` */
  signal?: AbortSignal
  /** 补上或替换假 api 的成员（agent() / commit() / memo() …） */
  api?: Partial<ToolExecutionApi>
}

/** 按 durable 结算口径补齐后的结果 */
export interface InvokedToolResult<TDetails = unknown> {
  content: ToolContent[]
  details?: TDetails
  isError?: boolean
  control?: ToolControl
  diagnostics?: readonly ToolDiagnostic[]
  usage?: Usage
}

export interface ToolInvocation<TDetails = unknown> {
  /** 工具交回的结果（content / details / diagnostics 按 durable 结算口径补齐，其余原样） */
  result: InvokedToolResult<TDetails>
  /** 经 `api.output()` 汇报的文本（按顺序拼接） */
  output: string
  /** 经 `api.diagnostic()` 汇报的附注（按顺序） */
  diagnostics: ToolDiagnostic[]
  /** 经 `api.details()` 汇报的每一版（按顺序，已收成严格 JSON） */
  details: JsonValue[]
  /** 工具拿到的那份 api（断言调用身份用） */
  api: ToolExecutionApi
  /** 工具拿到的那份 context */
  context: Context
}

let callCounter = 0

function unsupported(member: string): never {
  throw new Error(
    `invokeTool: api.${member}() is not available in this test helper — pass it through options.api`
  )
}

export async function invokeTool<T extends InvokableTool>(
  tool: T,
  args: InvokeArgs<T>,
  options: InvokeToolOptions = {}
): Promise<ToolInvocation<InvokeDetails<T>>> {
  const registration = asToolRegistration(tool)
  const callId = options.callId ?? `call-${++callCounter}`
  const context = options.signal
    ? withAbortSignal(options.signal, BACKGROUND_CONTEXT)
    : BACKGROUND_CONTEXT

  let ended = false
  const assertLive = (): void => {
    if (ended) throw new Error(`Tool call ${callId} has settled`)
  }
  const decoder = new TextDecoder()
  let output = ''
  const diagnostics: ToolDiagnostic[] = []
  const details: JsonValue[] = []
  const memos = new Map<string, JsonValue>()

  const registry: RegistrySnapshot = {
    installed: () => [],
    extension: () => undefined,
    tools: () => [],
    sections: () => [],
    tasks: () => [],
    task: () => undefined
  }
  const agent: Agent = { thinkingLevel: 'off', extensions: [], tools: [registration], sections: [] }

  const base = {
    taskId: (options.taskId ?? 1) as TaskId,
    conversationId: (options.conversationId ?? ROOT_CONVERSATION_ID) as ConversationId,
    callId,
    registry,
    env: undefined,
    agent: async () => {
      assertLive()
      return agent
    },
    output: (chunk: string | Uint8Array) => {
      assertLive()
      output += typeof chunk === 'string' ? chunk : decoder.decode(chunk)
    },
    diagnostic: (diagnostic: ToolDiagnostic) => {
      assertLive()
      diagnostics.push(copyJson(diagnostic, { omitUndefinedProperties: true }) as ToolDiagnostic)
    },
    details: async (value: JsonValue, detailsContext: Context) => {
      assertLive()
      detailsContext.abortSignal?.throwIfAborted()
      details.push(copyJson(value, { omitUndefinedProperties: true }))
    },
    memo: async (name: string, ...rest: unknown[]) => {
      assertLive()
      // memo(name, context) 读；memo(name, candidate, context) 先到的候选值胜出
      if (rest.length < 2) return memos.get(name)
      if (!memos.has(name)) memos.set(name, copyJson(rest[0]))
      return memos.get(name)
    },
    commit: () => unsupported('commit'),
    createTask: () => unsupported('createTask'),
    getTask: () => unsupported('getTask'),
    waitForTask: () => unsupported('waitForTask'),
    conversation: () => unsupported('conversation'),
    snapshot: () => unsupported('snapshot'),
    snapshotAsOf: () => unsupported('snapshotAsOf'),
    watchDoc: () => unsupported('watchDoc')
  }
  const api = { ...base, ...options.api } as unknown as ToolExecutionApi

  let raw
  try {
    raw = await registration.execute(args, api, context)
  } finally {
    ended = true
  }

  const merged = [...diagnostics, ...(raw.diagnostics ?? [])]
  const lastDetails = details.length > 0 ? details[details.length - 1] : undefined
  const result: InvokedToolResult = {
    ...raw,
    content: raw.content ?? (output === '' ? [] : [{ type: 'text', text: output }])
  }
  if (raw.details === undefined && lastDetails !== undefined) result.details = lastDetails
  if (merged.length > 0) result.diagnostics = merged
  return {
    result: result as InvokedToolResult<InvokeDetails<T>>,
    output,
    diagnostics,
    details,
    api,
    context
  }
}

/**
 * 旧调用形状的薄壳：`executeTool(tool, callId, args, signal)` 对应迁移前的
 * `tool.execute(callId, args, signal)`，只交回（按 durable 口径补齐的）结果。
 */
export async function executeTool<T extends InvokableTool>(
  tool: T,
  callId: string,
  args: InvokeArgs<T>,
  signal?: AbortSignal
): Promise<InvokedToolResult<InvokeDetails<T>>> {
  return (await invokeTool(tool, args, { callId, signal })).result
}

/** 结果里所有文本块按顺序拼起来 */
export function resultText(result: { content: readonly ToolContent[] }): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

/**
 * 一次失败调用交回的文字（裁定 Q12：工具抛错收成 `isError` 结果，文字即错误消息）。
 * 不是失败结果、或调用以抛错收场（取消）都判失败 —— 取消该用 `rejects` 断言。
 */
export async function failureText(work: Promise<InvokedToolResult<unknown>>): Promise<string> {
  const result = await work
  if (result.isError !== true) {
    throw new Error(`expected an isError result, got: ${resultText(result).slice(0, 200)}`)
  }
  return resultText(result)
}
