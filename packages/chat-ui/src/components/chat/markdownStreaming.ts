import { createContext, useContext } from 'react'

/**
 * 这段 markdown 此刻是否还在流式生成。
 *
 * 一个代码块自己看不出围栏写没写完：remark 把没闭合的围栏也当成一个到文末为止的代码块。
 * 大多数块不在乎（照帧渲染就是对的），但 mermaid 必须拿到完整源码才能解析 —— 流式中途
 * 解析失败不是错误，只是还没写完。所以由知道消息状态的那一层（AssistantBubble）告诉它。
 * 缺省 false：历史消息、过程区、通知行里的 markdown 都是写完了的。
 */
export const MarkdownStreamingContext = createContext(false)

export const useMarkdownStreaming = (): boolean => useContext(MarkdownStreamingContext)

/**
 * 这段 markdown 的源文本 —— 流式中判断某个围栏闭合没有要用。
 *
 * 交互图（```interactive）不能像 svg 那样逐帧画：半截脚本跑起来只会报错，也不能像 mermaid 那样
 * 「源码停一会儿就当写完」—— 模型停顿时挂上一个半截的页面，下一帧又得整块重载。它要的是确切的
 * 答案：hast 节点的 position 切回这段源文本，看最后一行是不是闭合栅栏（fenceSourceIsClosed）。
 * 只在流式中有意义，所以只有 AssistantBubble 在流式时提供；缺省 null = 当作已写完。
 */
export const MarkdownSourceContext = createContext<string | null>(null)

export const useMarkdownSource = (): string | null => useContext(MarkdownSourceContext)
