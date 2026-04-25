/**
 * Step 持久化改写管线
 *
 * 某些工具的运行时返回对"当前轮 LLM + 实时 UI"非常有价值（如 read 工具返回的
 * 图片 base64，让多模态模型直接看），但**不适合原样入库**：
 * - 巨大的 base64 写进 SQLite 会撑爆 message_steps 行
 * - 对话历史中永久保留 base64，回读时成本极高
 *
 * 该模块在"工具结果 → DB 入库"之间插入一条可扩展的转换管线，按需对
 * tool result 做瘦身（例如把 ImageContent 替换为一句"用 read 工具重读"）。
 *
 * 设计要点：
 * - 运行时路径不变：agent 当前轮看到的仍是原始结果
 * - 广播路径（broadcastEvent）保留原始内容（UI 实时渲染需要）
 * - 仅 DB 持久化路径（messageStepDao.updateContent / patchMetadata）走本管线
 * - 注册制 + 谓词匹配，支持后续按工具/内容类型追加更多规则
 */

import type { ImageContent, TextContent } from '@mariozechner/pi-ai'
import type { ToolResultDetails } from '../../shared/types/chatMessage'

/** 传入管线的原始上下文（不可变——transformer 应返回新对象） */
export interface ToolResultPersistContext {
  readonly toolName: string
  readonly toolCallId: string
  readonly sessionId: string
  readonly isError: boolean
  /** 原样的 pi-ai content 数组 */
  readonly content: ReadonlyArray<TextContent | ImageContent>
  readonly details?: ToolResultDetails
}

/** 管线输出：入库用的 content 字符串 + details */
export interface ToolResultPersistOutput {
  content: string
  details?: ToolResultDetails
}

/**
 * 一个转换器 = (ctx) => ctx'
 * - 返回与入参相同的引用 → 视为未改动
 * - 返回新对象 → 覆盖 content / details
 *
 * 重要契约（保证不干扰正在运行的 agent）：
 * - 绝对不要原地修改 ctx.content 数组（push / splice / index 赋值等）—— 管线
 *   入口已做浅拷贝，但若你尝试深层 mutation（如 `ctx.content[i].data = ''`）仍会
 *   污染 agent 的 state.messages 里的同一对象。务必用 `.map()` + 对象字面量
 *   产出新元素。
 * - 同理，不要原地修改 ctx.details；要改就 `return { ...ctx, details: { ...ctx.details, x: y } }`。
 */
export type StepPersistTransformer = (ctx: ToolResultPersistContext) => ToolResultPersistContext

const transformers: StepPersistTransformer[] = []

/**
 * 注册一个 transformer。调用顺序即注册顺序。
 * 建议在各自工具模块中按需注册（import 时触发副作用）。
 */
export function registerStepPersistTransformer(transformer: StepPersistTransformer): void {
  transformers.push(transformer)
}

/** 仅供测试：清空注册表 */
export function _clearStepPersistTransformersForTest(): void {
  transformers.length = 0
}

// ───── 内置 transformer：ImageContent → 文本占位符 ─────
// 说明：只改 content 数组，不修改 details；details 里如果另有 base64
// 字段（目前没有），由各自的工具自行加自己的 transformer 清理。
const stripImagesToPlaceholder: StepPersistTransformer = (ctx) => {
  if (!ctx.content.some((c) => c.type === 'image')) return ctx
  const rewritten = ctx.content.map<TextContent | ImageContent>((c) => {
    if (c.type !== 'image') return c
    return {
      type: 'text',
      text:
        `[image (${c.mimeType}) omitted from persisted history to save space; ` +
        `the runtime already delivered it to the model. ` +
        `Use the \`read\` tool on the file path shown above if you need to view it again.]`
    }
  })
  return { ...ctx, content: rewritten }
}

registerStepPersistTransformer(stripImagesToPlaceholder)

/**
 * 把 pi-ai content 数组序列化成一个字符串（与 agentEventHandler 原生逻辑一致：
 * 文本直取，非文本 JSON.stringify）——作为管线的收尾步骤。
 */
function serializeContent(content: ReadonlyArray<TextContent | ImageContent>): string {
  return content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
}

/**
 * 运行完整管线：依次执行所有已注册的 transformer，然后序列化为入库字符串。
 *
 * 防御性：入口对 content 数组做浅拷贝——即使某个 transformer 不小心
 * 对数组本身做了 push/splice/index 赋值，也只会影响管线自己的副本，
 * 不会污染 pi-agent-core 内部的 state.messages（因为 agent 那边仍持有
 * 原引用）。**对象字段级的 mutation 仍需要 transformer 作者按契约自守**。
 */
export function transformToolResultForPersist(
  ctx: ToolResultPersistContext
): ToolResultPersistOutput {
  let working: ToolResultPersistContext = { ...ctx, content: [...ctx.content] }
  for (const t of transformers) {
    working = t(working)
  }
  return {
    content: serializeContent(working.content),
    details: working.details
  }
}
