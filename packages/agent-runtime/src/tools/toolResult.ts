/**
 * ShuviX 自己的工具形状 —— 过渡期替代 pi 0.80 agent 包的 `AgentTool` / `AgentToolResult`。
 *
 * P1-01 删掉 pi 0.80 的 agent 包时，三十多个工具文件只需把类型 import 换到这里：字段与旧形状
 * 逐一对应（结果 = content + details + 可选的 addedToolNames / terminate；工具 = pi-ai 的
 * `Tool` + label / execute / prepareArguments / executionMode），工具今天返回什么照旧返回什么。
 *
 * TODO(pi-durable p1): P1-04 把 BaseTool 改成 pi-durable 原生的 `ToolRegistration`，
 * 届时本文件收窄成 durable 结果的辅助类型，`AgentTool` / `AnyTool` 随之退场。
 */
import type { ImageContent, Static, TextContent, Tool, TSchema } from '@earendil-works/pi-ai'

/** 工具的最终或中间结果 */
export interface AgentToolResult<T> {
  /** 交给模型的文本 / 图片内容 */
  content: (TextContent | ImageContent)[]
  /** 给日志与界面的结构化细节 */
  details: T
  /** 本结果引入、从这一处起可用的工具名 */
  addedToolNames?: string[]
  /** 提示本批工具跑完后停下（整批每条结果都置真才生效） */
  terminate?: boolean
}

/** 工具流式汇报中间结果的回调（只在本次 execute 期间有效） */
export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void

/** 同批工具的执行方式：并行，或按调用顺序逐个 */
export type ToolExecutionMode = 'sequential' | 'parallel'

/** 可执行的工具定义 */
export interface AgentTool<
  TParameters extends TSchema = TSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 与旧形状一致：details 由各工具自定
  TDetails = any
> extends Tool<TParameters> {
  /** 界面显示名 */
  label: string
  /** 校验前修整模型常写错的参数（须返回符合 schema 的对象） */
  prepareArguments?: (args: unknown) => Static<TParameters>
  /** 执行。失败时抛错，不要把错误编码进 content */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>
  ) => Promise<AgentToolResult<TDetails>>
  /** 单个工具覆盖同批执行方式 */
  executionMode?: ToolExecutionMode
}

/** 任意参数 / 细节类型的工具（工具表、注册表里混放各种工具时用） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 混放各种 schema 的工具表
export type AnyTool = AgentTool<any, any>
