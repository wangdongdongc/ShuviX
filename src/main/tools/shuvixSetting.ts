/**
 * ShuviX Setting 工具 — 让 AI 读取/修改系统全局设置
 * 写操作（action=set）必须经用户审批
 */

import { Type } from '@sinclair/typebox'
import { BrowserWindow } from 'electron'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ToolContext } from './types'
import { settingsService, getSettingKeyDescriptions } from '../services/settingsService'
import { changeLanguage, t } from '../i18n'

const ShuvixSettingParamsSchema = Type.Object({
  action: Type.Union([Type.Literal('get'), Type.Literal('set')], {
    description: 'Action to perform: "get" to read all settings, "set" to update a single setting (requires user approval)'
  }),
  key: Type.Optional(Type.String({
    description: `Setting key to update. Known keys: ${getSettingKeyDescriptions()}`
  })),
  value: Type.Optional(Type.String({
    description: 'New value for the setting key (always a string)'
  }))
})

/** 创建 shuvix-setting 工具实例 */
export function createShuvixSettingTool(ctx: ToolContext): AgentTool<typeof ShuvixSettingParamsSchema> {
  return {
    name: 'shuvix-setting',
    label: t('tool.shuvixSettingLabel'),
    description:
      'Read or update global application settings. Use action="get" to view all current settings as key-value pairs. Use action="set" with key and value to update a single setting (requires user approval). Call multiple times to update multiple settings.',
    parameters: ShuvixSettingParamsSchema,
    execute: async (
      toolCallId: string,
      params: {
        action: 'get' | 'set'
        key?: string
        value?: string
      }
    ) => {
      if (params.action === 'get') {
        // 读取全部设置（无需审批）
        const all = settingsService.getAll()
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(all, null, 2) }],
          details: all
        }
      }

      // action === 'set'：需要审批
      if (!params.key || params.value === undefined) {
        return {
          content: [{ type: 'text' as const, text: 'Both "key" and "value" are required when action is "set".' }],
          details: undefined
        }
      }

      // 构建可读预览文本用于审批弹窗
      const preview = `${params.key} = ${params.value}`

      if (ctx.requestApproval) {
        const approval = await ctx.requestApproval(toolCallId, preview)
        if (!approval.approved) {
          throw new Error(approval.reason || t('tool.approvalDenied'))
        }
      }

      // 执行设置
      settingsService.set(params.key, params.value)

      // 语言变更时同步主进程 i18n（与 settingsHandlers 逻辑保持一致）
      if (params.key === 'general.language') {
        changeLanguage(params.value)
      }

      // 广播通知所有窗口刷新（主题/字体等即时生效）
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('app:settings-changed')
      })

      return {
        content: [{ type: 'text' as const, text: `Setting updated: ${params.key} = ${params.value}` }],
        details: { key: params.key, value: params.value }
      }
    }
  }
}
