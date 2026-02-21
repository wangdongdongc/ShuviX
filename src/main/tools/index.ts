/**
 * 工具统一出口 — 提供工具创建工厂
 * 所有工具通过 ToolContext 获取运行时上下文
 */

import type { AgentTool } from '@mariozechner/pi-agent-core'
import { nowTool } from './now'
import { createBashTool } from './bash'
import { createReadTool } from './read'
import { createWriteTool } from './write'
import { createEditTool } from './edit'
import type { ToolContext } from './types'

/**
 * 创建所有编码工具
 * @param ctx 工具上下文（共享运行时信息）
 */
export function createCodingTools(ctx: ToolContext): AgentTool[] {
  // 使用 as any 绕过 AgentTool 泛型参数不兼容问题
  return [
    nowTool as any,
    createBashTool(ctx) as any,
    createReadTool(ctx) as any,
    createWriteTool(ctx) as any,
    createEditTool(ctx) as any
  ]
}

export { createBashTool, createReadTool, createWriteTool, createEditTool, nowTool }
export type { ToolContext, ProjectConfig } from './types'
export { resolveProjectConfig } from './types'
