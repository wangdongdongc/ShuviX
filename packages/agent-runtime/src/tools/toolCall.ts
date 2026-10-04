/**
 * ToolCallScope —— 一次工具调用在 BaseTool 各钩子眼里的样子。
 *
 * pi-durable 的工具执行签名是 `execute(args, api, context)`：调用身份（callId / taskId /
 * conversationId）在 `api` 上，取消在 chord `context.abortSignal` 上。BaseTool 的模板把这两样
 * 收成一个 scope，作为每个钩子的最后一个参数交下去 —— 钩子的前几个参数仍是
 * `(toolCallId, params, signal)`，子类照旧只读自己用得上的那几个。
 *
 * 为什么要把 taskId 带下去：同一会话里 provider 的 toolCallId 可能重复（有的中转每轮从
 * `call_0` 数起），durable 的 tool task id 才是一次调用在存储里的唯一身份。安全模块的询问 /
 * 审查归属（EnforceOpts / PermissionRequestEvent）要按它认人 ——
 * TODO(pi-durable p1): P1-06 把 `call.taskId` / `call.conversationId` 穿进各 PEP 调用点。
 */
import type { Context } from '@earendil-works/chord'
import type { ConversationId, TaskId, ToolExecutionApi } from '@earendil-works/pi-durable'

export interface ToolCallScope {
  /** provider 给的工具调用 id（= `api.callId`）—— 询问卡片、落盘文件名、审查标记都按它认 */
  readonly callId: string
  /** 跑这次调用的 durable tool task（会话内唯一） */
  readonly taskId: TaskId
  /** 发起调用的对话（根会话 = 根对话；派生 agent 将来是它自己的子对话） */
  readonly conversationId: ConversationId
  /** 取消信号（= `context.abortSignal`；context 不带信号时为 undefined） */
  readonly signal: AbortSignal | undefined
  /** 本次调用的 durable api（output / diagnostic / details / agent / memo / commit …） */
  readonly api: ToolExecutionApi
  /** 本次调用所在的 chord context —— 调 api 的方法时原样传它 */
  readonly context: Context
}

/** 从 durable 交来的 api + context 拼出 scope */
export function toolCallScope(api: ToolExecutionApi, context: Context): ToolCallScope {
  return {
    callId: api.callId,
    taskId: api.taskId,
    conversationId: api.conversationId,
    signal: context.abortSignal,
    api,
    context
  }
}
