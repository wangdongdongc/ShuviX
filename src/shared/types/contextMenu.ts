/** 右键上下文菜单 — 渲染进程 ↔ 主进程通信类型 */

export interface ContextMenuItem {
  /** 唯一动作标识 */
  id: string
  /** 显示文本（由渲染进程预翻译） */
  label: string
  /** 菜单项类型，默认 'normal' */
  type?: 'normal' | 'separator'
  /** 是否可用，默认 true */
  enabled?: boolean
}

export interface ContextMenuRequest {
  items: ContextMenuItem[]
}

export interface ContextMenuResult {
  /** 被点击的菜单项 id，用户取消则为 null */
  actionId: string | null
}
