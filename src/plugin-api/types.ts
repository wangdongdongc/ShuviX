/**
 * 插件系统核心类型 — ShuviXPlugin、PluginContext、PluginContribution
 *
 * 此文件定义插件与主程序之间的合约。
 * 所有类型均为纯接口，零运行时代码，零主程序依赖。
 */

import type { PluginTool } from './tool'
import type { PluginEvent } from './events'
import type { HostEvent } from './hostEvents'

// ─── 日志 ──────────────────────────────────────────────

/** 插件日志接口（由主程序注入实现） */
export interface PluginLogger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
  debug(msg: string, ...args: unknown[]): void
}

// ─── 插件上下文 ──────────────────────────────────────────

/** 插件运行时上下文 — 由主程序构造并在 activate 时注入，全局唯一（不绑定特定 session） */
export interface PluginContext {
  /** 获取指定会话的工作目录 */
  getWorkingDirectory(sessionId: string): string

  /** 发出事件到 renderer（sessionId 指定目标会话） */
  emitEvent(sessionId: string, event: PluginEvent): void

  /** 获取插件独立资源路径（自动限定在插件自身的资源目录下） */
  getResourcePath(relativePath: string): string

  /** 作用域日志 */
  logger: PluginLogger
}

// ─── 用途引导 ──────────────────────────────────────────

/** 项目用途引导声明 — 插件可在新建项目向导中注册一个用途选项 */
export interface PluginPurpose {
  /** 用途 key（如 'ui'），用于预设映射 */
  key: string
  /** 图标名称（Lucide icon name，如 'Palette'） */
  icon: string
  /** 显示标签的 i18n key（如 'purposeUI'） */
  labelKey: string
  /** 提示文本的 i18n key（如 'purposeTipUi'） */
  tipKey: string
  /** 插件自带的 i18n 文本，按语言分组 */
  i18n: Record<string, Record<string, string>>
  /** 该用途预设启用的工具名列表（包含插件自身的工具） */
  enabledTools: string[]
}

// ─── 插件贡献 ──────────────────────────────────────────

/** 插件激活后返回的贡献声明 */
export interface PluginContribution {
  /** 插件贡献的工具 */
  tools?: PluginTool[]
  /** 项目用途引导（新建项目向导中的用途选项） */
  purpose?: PluginPurpose
  /** 事件消费者 — 接收主程序分发的业务事件（完整类型定义见 hostEvents.ts） */
  onEvent?: (event: HostEvent) => void
}

// ─── 插件入口 ──────────────────────────────────────────

/** ShuviX 插件接口 — 插件模块的默认导出必须实现此接口 */
export interface ShuviXPlugin {
  /** 插件唯一标识 */
  readonly id: string
  /** 显示名称 */
  readonly name: string
  /** 版本号 */
  readonly version: string

  /** 激活插件，返回贡献声明 */
  activate(ctx: PluginContext): Promise<PluginContribution> | PluginContribution

  /** 停用插件，清理资源（可选） */
  deactivate?(): Promise<void> | void
}
