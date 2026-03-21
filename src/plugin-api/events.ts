/**
 * PluginEvent — 插件→主程序的事件协议
 *
 * 插件通过 PluginContext.emitEvent() 发出事件，
 * 主程序负责将其转换为 ChatEvent 并广播到 renderer。
 */

/** 面板事件 — 打开/关闭 URL 面板（泛化了 ChatDesignEvent） */
export interface PluginPanelEvent {
  type: 'plugin_panel'
  /** 打开或关闭面板 */
  action: 'open' | 'close'
  /** 面板中加载的 URL（仅 open 时需要） */
  url?: string
  /** 面板标题 */
  title?: string
}

/** 状态事件 — 通用生命周期通知 */
export interface PluginStatusEvent {
  type: 'plugin_status'
  /** 自定义动作标识 */
  action: string
  /** 附加数据 */
  data?: Record<string, unknown>
}

/** 插件可发出的事件联合类型 */
export type PluginEvent = PluginPanelEvent | PluginStatusEvent
