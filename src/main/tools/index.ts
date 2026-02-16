/**
 * 工具统一出口 — 提供工具创建工厂
 */

import type { AgentTool } from '@mariozechner/pi-agent-core'
import { getCurrentTimeTool } from './getCurrentTime'
import { createBashTool, type BashOperations } from './bash'
import { createReadTool } from './read'
import { createWriteTool } from './write'
import { createEditTool } from './edit'

export interface CreateToolsOptions {
  /** 自定义 bash 操作实现（Docker 模式下传入） */
  bashOperations?: BashOperations
  /** bash 工具专用 cwd（Docker 模式下为容器内路径，与宿主机路径不同） */
  bashCwd?: string
}

/**
 * 创建所有编码工具
 * @param cwd 工作目录（宿主机路径，用于 read/write/edit）
 * @param options 可选配置
 */
export function createCodingTools(cwd: string, options?: CreateToolsOptions): AgentTool[] {
  const bashCwd = options?.bashCwd ?? cwd
  // 使用 as any 绕过 AgentTool 泛型参数不兼容问题
  return [
    getCurrentTimeTool as any,
    createBashTool(bashCwd, { operations: options?.bashOperations }) as any,
    createReadTool(cwd) as any,
    createWriteTool(cwd) as any,
    createEditTool(cwd) as any
  ]
}

export { createBashTool, createReadTool, createWriteTool, createEditTool, getCurrentTimeTool }
export type { BashOperations }
