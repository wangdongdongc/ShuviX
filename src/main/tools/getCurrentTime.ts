import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'

const ParamsSchema = Type.Object({
  timezone: Type.Optional(Type.String({ description: '时区，如 Asia/Shanghai、America/New_York。留空使用系统默认时区' }))
})

/** 获取当前时间工具 */
export const getCurrentTimeTool: AgentTool<typeof ParamsSchema> = {
  name: 'get_current_time',
  label: '获取当前时间',
  description: '获取当前系统时间，可指定时区',
  parameters: ParamsSchema,
  execute: async (_toolCallId, params) => {
    const now = new Date()
    let formatted: string
    try {
      formatted = now.toLocaleString('zh-CN', {
        timeZone: params.timezone || undefined,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      })
    } catch {
      formatted = now.toLocaleString('zh-CN')
    }
    const iso = now.toISOString()
    const text = params.timezone
      ? `当前时间（${params.timezone}）：${formatted}\nISO: ${iso}`
      : `当前时间：${formatted}\nISO: ${iso}`
    return {
      content: [{ type: 'text', text }],
      details: { timezone: params.timezone || 'system', formatted, iso }
    }
  }
}
