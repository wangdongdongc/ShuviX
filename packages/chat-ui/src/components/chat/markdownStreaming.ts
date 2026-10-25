import { createContext, useContext } from 'react'

/**
 * 这段 markdown 此刻是否还在流式生成。
 *
 * 一个代码块自己看不出围栏写没写完：remark 把没闭合的围栏也当成一个到文末为止的代码块。
 * 大多数块不在乎（照帧渲染就是对的），但 mermaid 画不出来时要分清两种情况：流式中途画不出来
 * 不是错误，只是还没写完（它退回能画的那一帧）；写完了还画不出来才出错误卡，写完的图才能导出。
 * 所以由知道消息状态的那一层（AssistantBubble）告诉它。
 * 缺省 false：历史消息、过程区、通知行里的 markdown 都是写完了的。
 */
export const MarkdownStreamingContext = createContext(false)

export const useMarkdownStreaming = (): boolean => useContext(MarkdownStreamingContext)

/**
 * 这段 markdown 的源文本 —— 流式中判断某个围栏闭合没有要用。
 *
 * 交互图（```interactive）不能像 svg 那样逐帧画：半截脚本跑起来只会报错，也不能「源码停一会儿
 * 就当写完」—— 模型停顿时挂上一个半截的页面，下一帧又得整块重载。它要的是确切的答案：hast 节点的
 * position 切回这段源文本，看最后一行是不是闭合栅栏（fenceSourceIsClosed）。mermaid 也用这个答案：
 * 围栏开着时最后一行可能写到一半（帧里丢掉它），闭合了就整段画。
 * 只在流式中有意义，所以只有 AssistantBubble 在流式时提供；缺省 null = 当作已写完。
 */
export const MarkdownSourceContext = createContext<string | null>(null)

export const useMarkdownSource = (): string | null => useContext(MarkdownSourceContext)

/**
 * 这段 markdown 属于哪条消息（消息 id = 会话转写里那条回复的条目 id）。
 *
 * ```artifact 引用要显示的是**那条回复写下时**钉住的那一版，而不是文件现在的样子（宿主按回复钉版本，
 * 见桌面 `services/artifacts/pins.ts`）—— 引用块自己不知道自己在哪条回复里，由渲染回复的那一层告诉它：
 * 终答正文由 AssistantBubble 提供，过程区的中间文本由 StepGroupView 按块查（`noteTextBlockMessage`）。
 * 缺省 null = 不在某条回复里（或还在流式中，没有条目 id）：引用照当前内容显示。
 */
export const MarkdownMessageIdContext = createContext<string | null>(null)

export const useMarkdownMessageId = (): string | null => useContext(MarkdownMessageIdContext)

/**
 * 过程区的中间文本块 → 它所在那条回复的 id。块对象落盘后身份不变（分组的 memo 正是靠这一点不重画），
 * 所以按块对象记一张弱表，不必为了带一个 id 而给每个块造新对象。
 */
const textBlockMessage = new WeakMap<object, string>()

export function noteTextBlockMessage(block: object, messageId: string): void {
  textBlockMessage.set(block, messageId)
}

export function messageIdOfTextBlock(block: object): string | null {
  return textBlockMessage.get(block) ?? null
}
