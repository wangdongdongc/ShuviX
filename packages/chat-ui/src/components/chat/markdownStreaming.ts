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
