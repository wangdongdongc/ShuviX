/**
 * PluginToolAdapter — 将 PluginTool 接口包装为 BaseTool 实例
 *
 * 使插件贡献的工具兼容现有的 wrapToolForParallel 和 agent 系统。
 */

import type { TSchema, Static } from '@sinclair/typebox'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import { BaseTool } from '../tools/types'
import type { ToolContext } from '../tools/types'
import type { PluginTool } from '../../plugin-api/tool'

export class PluginToolAdapter extends BaseTool {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly parameters: TSchema

  constructor(
    private pluginTool: PluginTool,
    private ctx: ToolContext
  ) {
    super()
    this.name = pluginTool.name
    this.label = pluginTool.label
    this.description = pluginTool.description
    this.parameters = pluginTool.parameters
  }

  async preExecute(toolCallId: string, params: Record<string, unknown>): Promise<void> {
    await this.pluginTool.preExecute?.(toolCallId, params)
  }

  protected async securityCheck(
    toolCallId: string,
    params: Static<TSchema>,
    signal?: AbortSignal
  ): Promise<void> {
    await this.pluginTool.securityCheck?.(toolCallId, params, signal)
  }

  protected async executeInternal(
    toolCallId: string,
    params: Static<TSchema>,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<unknown>) => void
  ): Promise<AgentToolResult<unknown>> {
    return this.pluginTool.execute(toolCallId, params, signal, onUpdate, this.ctx.sessionId)
  }
}
