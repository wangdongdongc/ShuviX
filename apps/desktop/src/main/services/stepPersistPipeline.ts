/**
 * 工具结果广播瘦身管线
 *
 * 某些工具的运行时返回对"发给模型"非常有价值（如 read 工具返回的图片 base64，
 * 让多模态模型直接看），但**不适合原样推给渲染进程**：几十万字符的 base64 经 IPC
 * 灌进 renderer 再铺到工具卡片上，卡的是 UI 而不是模型。
 *
 * 该模块提供一条可扩展的转换管线，按需对 tool result 做瘦身
 * （例如把 ImageContent 替换成一句占位文本）。
 *
 * **作用域只有广播路径（UI 展示）**：entry 树里存的、以及后续每轮发给模型的，
 * 都是原始 toolResult —— 本管线够不着，也不该够得着。
 * （历史：迁移到 AgentHarness 之前这里还兼着"入库瘦身"，message_steps 表随
 * v14 一起没了，那条职责也就没了。）
 *
 * 设计要点：
 * - 运行时路径不变：agent 当前轮及之后各轮看到的都是原始结果
 * - 注册制 + 谓词匹配，支持后续按工具/内容类型追加更多规则
 */

import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type { ToolResultDetails } from '@shuvix/chat-protocol/types/chatMessage'

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
// 占位文本是写给**用户**看的：模型读的是 entry 树里的原图，永远看不到这句。
// 措辞别说成「这里看不到图」—— 工具卡片会另外把 details.image 那张图显示出来
// （ToolImageThumb），这句只解释「base64 没在这儿重复一遍」。
const stripImagesToPlaceholder: StepPersistTransformer = (ctx) => {
  if (!ctx.content.some((c) => c.type === 'image')) return ctx
  const rewritten = ctx.content.map<TextContent | ImageContent>((c) => {
    if (c.type !== 'image') return c
    return {
      type: 'text',
      text:
        `[image (${c.mimeType}) — delivered to the model in full; ` +
        `the base64 is not repeated in the UI.]`
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
