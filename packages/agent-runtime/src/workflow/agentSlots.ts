/**
 * 管线 workflow 声明的 **agent 槽位** —— 从它的 `shuvix-workflow-input` 里读出来。
 *
 * 约定：输入 schema 的 `properties.agents` 是一个 `type: object`，其 `required` 列出必填槽位，
 * `properties` 逐槽位给出 `description`（设置页当提示语用）。bot md 的 `shuvix-bot-agents`
 * 按槽位名填 agent；漏填必填槽位在 invoke 入参校验处被拦下（引擎沿 `properties` 递归查
 * `required`），不需要宿主再维护一份缺省表 —— 哪些槽位存在、哪些必填，管线文件说了算。
 *
 * 这里只是读法的单一出处：宿主的设置页与运行时读数都经它，免得两处各解一遍 schema。
 */
import type { ParsedWorkflowFile } from './workflowFile'

export interface PipelineAgentSlot {
  role: string
  required: boolean
  description?: string
}

/** 声明顺序 = `properties` 的键序；只在 `required` 里出现的槽位排在其后 */
export function agentSlotsOf(file: Pick<ParsedWorkflowFile, 'inputSchema'>): PipelineAgentSlot[] {
  const schema = file.inputSchema
  const props = schema?.properties
  if (typeof props !== 'object' || props === null) return []
  const agents = (props as Record<string, unknown>).agents
  if (typeof agents !== 'object' || agents === null) return []
  const { required, properties } = agents as { required?: unknown; properties?: unknown }
  const requiredSet = new Set(
    Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : []
  )
  const out: PipelineAgentSlot[] = []
  const seen = new Set<string>()
  if (typeof properties === 'object' && properties !== null) {
    for (const [role, def] of Object.entries(properties as Record<string, unknown>)) {
      const description =
        typeof def === 'object' &&
        def !== null &&
        typeof (def as { description?: unknown }).description === 'string'
          ? (def as { description: string }).description.trim() || undefined
          : undefined
      out.push({ role, required: requiredSet.has(role), ...(description ? { description } : {}) })
      seen.add(role)
    }
  }
  for (const role of requiredSet) {
    if (!seen.has(role)) out.push({ role, required: true })
  }
  return out
}
