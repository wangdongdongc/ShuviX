/**
 * ShuviX Project 工具 — 让 AI 读取/修改当前会话所属项目的配置
 * 写操作（action=update）必须经用户审批
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ToolContext } from './types'
import { sessionService } from '../services/sessionService'
import { projectService, KNOWN_PROJECT_FIELDS } from '../services/projectService'
import { t } from '../i18n'

const ShuvixProjectParamsSchema = Type.Object({
  action: Type.Union([Type.Literal('get'), Type.Literal('update')], {
    description: 'Action to perform: "get" to read current project config, "update" to modify fields (requires user approval)'
  }),
  name: Type.Optional(Type.String({ description: 'Project display name' })),
  systemPrompt: Type.Optional(Type.String({ description: 'Project-level system prompt (applied together with global prompt)' })),
  dockerEnabled: Type.Optional(Type.Boolean({ description: 'Enable Docker isolation for bash commands' })),
  dockerImage: Type.Optional(Type.String({ description: 'Docker image name (e.g. "python:latest", "node:20")' })),
  sandboxEnabled: Type.Optional(Type.Boolean({ description: 'Enable sandbox mode (restrict file access + bash approval)' })),
  enabledTools: Type.Optional(Type.Array(Type.String(), { description: 'List of enabled tool names for new sessions in this project' }))
})

/** 创建 shuvix-project 工具实例 */
export function createShuvixProjectTool(ctx: ToolContext): AgentTool<typeof ShuvixProjectParamsSchema> {
  return {
    name: 'shuvix-project',
    label: t('tool.shuvixProjectLabel'),
    description:
      `Read or update the current project configuration. Use action="get" to view all project settings. Use action="update" with any combination of optional fields to modify them (requires user approval). Updatable fields: ${Object.keys(KNOWN_PROJECT_FIELDS).join(', ')}. Only works when the current session is linked to a project.`,
    parameters: ShuvixProjectParamsSchema,
    execute: async (
      toolCallId: string,
      params: {
        action: 'get' | 'update'
        name?: string
        systemPrompt?: string
        dockerEnabled?: boolean
        dockerImage?: string
        sandboxEnabled?: boolean
        enabledTools?: string[]
      }
    ) => {
      // 查找当前会话所属项目
      const session = sessionService.getById(ctx.sessionId)
      if (!session?.projectId) {
        return {
          content: [{ type: 'text' as const, text: t('tool.shuvixProjectNoProject') }],
          details: undefined
        }
      }
      const project = projectService.getById(session.projectId)
      if (!project) {
        return {
          content: [{ type: 'text' as const, text: t('tool.shuvixProjectNoProject') }],
          details: undefined
        }
      }

      if (params.action === 'get') {
        // 读取项目配置（无需审批）
        let enabledTools: string[] = []
        try {
          const settings = JSON.parse(project.settings || '{}')
          enabledTools = settings.enabledTools || []
        } catch { /* 忽略 */ }

        const info = {
          id: project.id,
          name: project.name,
          path: project.path,
          systemPrompt: project.systemPrompt || '(empty)',
          dockerEnabled: project.dockerEnabled === 1,
          dockerImage: project.dockerImage,
          sandboxEnabled: project.sandboxEnabled === 1,
          enabledTools
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
          details: info
        }
      }

      // action === 'update'：需要审批
      const updates: Record<string, any> = {}
      if (params.name !== undefined) updates.name = params.name
      if (params.systemPrompt !== undefined) updates.systemPrompt = params.systemPrompt
      if (params.dockerEnabled !== undefined) updates.dockerEnabled = params.dockerEnabled
      if (params.dockerImage !== undefined) updates.dockerImage = params.dockerImage
      if (params.sandboxEnabled !== undefined) updates.sandboxEnabled = params.sandboxEnabled
      if (params.enabledTools !== undefined) updates.enabledTools = params.enabledTools

      if (Object.keys(updates).length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No fields to update. Specify at least one field.' }],
          details: undefined
        }
      }

      // 构建可读预览文本用于审批弹窗
      const preview = Object.entries(updates)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join('\n')

      if (ctx.requestApproval) {
        const approval = await ctx.requestApproval(toolCallId, preview)
        if (!approval.approved) {
          throw new Error(approval.reason || t('tool.approvalDenied'))
        }
      }

      // 执行更新
      projectService.update(project.id, updates)

      return {
        content: [{ type: 'text' as const, text: t('tool.shuvixProjectUpdated', { fields: Object.keys(updates).join(', ') }) }],
        details: { updatedFields: Object.keys(updates) }
      }
    }
  }
}
