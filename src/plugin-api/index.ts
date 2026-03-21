/**
 * ShuviX Plugin API — 插件与主程序之间的唯一合约
 *
 * 依赖方向：main → plugin-api ← plugins
 * 插件只能 import 此模块，不可 import 主程序代码。
 */

// 工具接口
export type { PluginTool } from './tool'

// 事件类型
export type { PluginEvent, PluginPanelEvent, PluginStatusEvent } from './events'

// 核心类型
export type {
  ShuviXPlugin,
  PluginContext,
  PluginContribution,
  PluginLogger,
  PluginPurpose
} from './types'

// Re-export 插件常用的外部类型，避免插件直接依赖这些包
export type { TSchema, Static } from '@sinclair/typebox'
export type { AgentToolResult } from '@mariozechner/pi-agent-core'
