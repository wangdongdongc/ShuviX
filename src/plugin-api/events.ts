/**
 * PluginEvent — 插件→主程序的事件定义
 *
 * 插件通过 PluginContext.emitEvent() 发出事件，
 * 主程序消费事件并翻译为自己的 ChatEvent 广播到 renderer。
 *
 * 所有事件结构在此完整定义，每增加新的插件需求，在此添加具体的事件类型。
 */

/** 插件请求打开 URL 面板 */
export interface PluginPanelOpenEvent {
  type: 'plugin:panel_open'
  /** 面板中加载的 URL */
  url: string
  /** 面板标题 */
  title?: string
}

/** 插件请求关闭面板 */
export interface PluginPanelCloseEvent {
  type: 'plugin:panel_close'
}

/** plugin→main 事件联合类型 */
export type PluginEvent = PluginPanelOpenEvent | PluginPanelCloseEvent
