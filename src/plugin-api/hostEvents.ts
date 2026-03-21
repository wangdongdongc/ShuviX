/**
 * HostEvent — 主程序→插件的事件定义
 *
 * 主程序根据业务逻辑在合适的时机构造 HostEvent 并分发给插件。
 * 插件通过 PluginContribution.onEvent 消费这些事件。
 *
 * 所有事件结构在此完整定义，主程序和插件共用，交互细节一览无余。
 */

/** 预览面板启动请求 — 用户点击了预览面板的"启动"按钮 */
export interface PreviewStartEvent {
  type: 'preview:start'
  sessionId: string
  workingDir: string
}

/** 预览面板停止请求 — 用户点击了预览面板的"停止"按钮 */
export interface PreviewStopEvent {
  type: 'preview:stop'
  sessionId: string
}

/** 用户请求销毁某个插件 runtime（如关闭 Python 运行时） */
export interface RuntimeDestroyEvent {
  type: 'runtime:destroy'
  sessionId: string
  /** 对应 PluginRuntimeStatusEvent.runtimeId */
  runtimeId: string
}

/** 主程序→插件的事件联合类型 */
export type HostEvent = PreviewStartEvent | PreviewStopEvent | RuntimeDestroyEvent

/** 事件类型常量（方便 switch 匹配） */
export const HostEventType = {
  PREVIEW_START: 'preview:start',
  PREVIEW_STOP: 'preview:stop',
  RUNTIME_DESTROY: 'runtime:destroy'
} as const
