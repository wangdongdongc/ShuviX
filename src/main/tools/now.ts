import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { t } from '../i18n'

const ParamsSchema = Type.Object({})

/** 获取当前时间工具（使用系统时区） */
export const nowTool: AgentTool<typeof ParamsSchema> = {
  name: 'now',
  label: t('tool.timeLabel'),
  description: t('tool.timeDesc'),
  parameters: ParamsSchema,
  execute: async () => {
    const now = new Date()
    const formatted = now.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
    const iso = now.toISOString()
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const text = `${t('tool.currentTime')}: ${formatted}\n${t('tool.timezone')}: ${tz}\nISO: ${iso}`
    return {
      content: [{ type: 'text', text }],
      details: { timezone: tz, formatted, iso }
    }
  }
}
