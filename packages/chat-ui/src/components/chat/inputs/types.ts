/**
 * 用户输入子表单(Ask / Choice / SshCredentials)的通用 props 协议
 *
 * 设计原则:
 * - 父组件(`PendingInputsPanel`)负责持有"草稿"状态(按 sessionId+requestId 隔离)
 * - 子表单是受控组件:接收 draft 和 onChange,所有改动回调到父级 store
 * - 子表单提供静态 helper `<Form>.buildResponse(draft)`,父级在"一键提交全部已填"
 *   时遍历所有 draft 调用此 helper,返回 null 表示"未填写完整,跳过"
 */
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

/** 通用子表单 props */
export interface InputFormProps<TRequest, TDraft> {
  request: TRequest
  draft: TDraft
  onDraftChange: (next: TDraft) => void
  /** 用户在表单内点击"提交"或"取消"等终态按钮时调用 */
  onSubmit: (response: InputResponse) => void
  /**
   * 标题行右端插槽(多条 pending 时父级塞入步进器)。
   * 表单已并入输入框卡片,不再有自己的外框/标题栏 —— 标题行是唯一能挂全局操作的位置。
   */
  titleAccessory?: React.ReactNode
}
