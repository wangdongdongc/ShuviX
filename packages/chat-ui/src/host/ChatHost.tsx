import { ChatHostContext, type ChatHostValue } from './chatHostContext'

/** 宿主在挂载对话框前用它包裹，向 chat-ui 注入外观 / 模型选择 / 语音配置 */
export function ChatHostProvider({
  value,
  children
}: {
  value: ChatHostValue
  children: React.ReactNode
}): React.JSX.Element {
  return <ChatHostContext.Provider value={value}>{children}</ChatHostContext.Provider>
}
