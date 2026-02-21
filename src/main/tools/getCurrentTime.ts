import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { t } from '../i18n'

const ParamsSchema = Type.Object({
  timezone: Type.Optional(Type.String({ description: t('tool.paramTimezone') }))
})

/** 获取当前时间工具 */
export const getCurrentTimeTool: AgentTool<typeof ParamsSchema> = {
  name: 'get_current_time',
  label: t('tool.timeLabel'),
  description: t('tool.timeDesc'),
  parameters: ParamsSchema,
  execute: async (_toolCallId, params) => {
    const now = new Date()
    let formatted: string
    try {
      formatted = now.toLocaleString(undefined, {
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
      formatted = now.toLocaleString()
    }
    const iso = now.toISOString()
    const text = params.timezone
      ? `${t('tool.currentTimeWithTz', { timezone: params.timezone })}: ${formatted}\nISO: ${iso}`
      : `${t('tool.currentTime')}: ${formatted}\nISO: ${iso}`
    return {
      content: [{ type: 'text', text }],
      details: { timezone: params.timezone || 'system', formatted, iso }
    }
  }
}
