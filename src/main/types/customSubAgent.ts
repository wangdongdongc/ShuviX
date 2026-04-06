export type { CustomSubAgent, CustomSubAgentMetadata } from '../dao/types'

/** IPC: 添加自定义子智能体参数 */
export interface CustomSubAgentAddParams {
  name: string
  displayName: string
  description?: string
  systemPrompt?: string
  tools?: string[]
  maxTurns?: number
  metadata?: Record<string, unknown>
}

/** IPC: 更新自定义子智能体参数 */
export interface CustomSubAgentUpdateParams {
  id: string
  name?: string
  displayName?: string
  description?: string
  systemPrompt?: string
  tools?: string[]
  maxTurns?: number
  metadata?: Record<string, unknown>
}
