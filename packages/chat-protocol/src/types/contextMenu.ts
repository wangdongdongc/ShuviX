/** 右键上下文菜单 — 渲染进程 ↔ 主进程通信类型 */

/** 原生编辑角色：由 OS 直接处理（系统剪贴板 + 本地化文案 + macOS 服务），无需 actionId */
export type ContextMenuRole =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pasteAndMatchStyle'
  | 'selectAll'
  | 'delete'

export interface ContextMenuItem {
  /** 唯一动作标识（自定义项需要；role / separator 可省略） */
  id?: string
  /** 显示文本（由渲染进程预翻译；role 项省略时用 OS 本地化文案） */
  label?: string
  /** 菜单项类型，默认 'normal' */
  type?: 'normal' | 'separator'
  /** 是否可用，默认 true */
  enabled?: boolean
  /** 原生编辑角色（cut/copy/paste/selectAll 等） */
  role?: ContextMenuRole
  /** 子菜单 */
  submenu?: ContextMenuItem[]
}

export interface ContextMenuRequest {
  items: ContextMenuItem[]
}

export interface ContextMenuResult {
  /** 被点击的菜单项 id，用户取消或点击 role 项则为 null */
  actionId: string | null
}
