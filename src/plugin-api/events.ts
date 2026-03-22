/**
 * PluginEvent — 插件→主程序的事件定义
 *
 * 插件通过 PluginContext.emitEvent() 发出事件，
 * 主程序消费事件并翻译为自己的 ChatEvent 广播到 renderer。
 *
 * 所有事件结构在此完整定义，每增加新的插件需求，在此添加具体的事件类型。
 */

/** 插件请求打开预览面板 */
export interface PluginPreviewPanelOpenEvent {
  type: 'plugin:preview_panel_open'
  /** 面板中加载的 URL */
  url: string
  /** 面板标题 */
  title?: string
}

/** 插件请求关闭预览面板 */
export interface PluginPreviewPanelCloseEvent {
  type: 'plugin:preview_panel_close'
}

/** 插件通知预览服务器已启动 */
export interface PluginPreviewServerStartedEvent {
  type: 'plugin:preview_server_started'
  /** dev server URL */
  url: string
}

/** 插件通知预览服务器已停止 */
export interface PluginPreviewServerStoppedEvent {
  type: 'plugin:preview_server_stopped'
}

// ─── Runtime 状态上报 ──────────────────────────────────

/** 插件 runtime 描述信息（展示在 StatusBanner 上） */
export interface PluginRuntimeInfo {
  /** 状态标签显示名（如 'Python WASM'） */
  label: string
  /** lucide 图标名（如 'Code'） */
  icon?: string
  /** 图标/标签颜色（CSS 颜色值，如 '#eab308'） */
  color?: string
  /** 附加描述（如 'memory mode'，显示在标签内） */
  description?: string
}

/** 插件上报 runtime 生命周期状态 — status 为 null 表示已销毁 */
export interface PluginRuntimeStatusEvent {
  type: 'plugin:runtime_status'
  /** 运行时标识（如 'python'、'sql'），同一插件可有多个 runtime */
  runtimeId: string
  /** 运行时信息，null 表示该 runtime 已销毁 */
  status: PluginRuntimeInfo | null
}

/** plugin→main 事件联合类型 */
export type PluginEvent =
  | PluginPreviewPanelOpenEvent
  | PluginPreviewPanelCloseEvent
  | PluginPreviewServerStartedEvent
  | PluginPreviewServerStoppedEvent
  | PluginRuntimeStatusEvent
