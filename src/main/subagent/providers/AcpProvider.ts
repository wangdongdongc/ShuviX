/**
 * AcpProvider — ACP (Agent Client Protocol) 子智能体适配层
 *
 * 将 acpService 适配为 SubAgentProvider 接口。
 * 每个 AcpAgentConfig 对应一个 AcpProvider 实例。
 * acpService 内部的进程管理和 ACP 协议逻辑保持不动。
 */

import type { SubAgentProvider, SubAgentRunParams, SubAgentRunResult } from '../types'
import { acpService, type AcpAgentConfig } from '../../services/acpService'

export class AcpProvider implements SubAgentProvider {
  readonly name: string
  readonly displayName: string
  readonly description: string

  constructor(private config: AcpAgentConfig) {
    this.name = config.name
    this.displayName = config.displayName
    this.description = config.description
  }

  async runTask(params: SubAgentRunParams): Promise<SubAgentRunResult> {
    const { taskId, result } = await acpService.runTask({
      config: this.config,
      ctx: params.ctx,
      toolCallId: params.toolCallId,
      prompt: params.prompt,
      description: params.description,
      signal: params.signal,
      onEvent: params.onEvent
    })

    return { taskId, result }
  }

  destroy(sessionId: string): void {
    acpService.destroySession(sessionId, this.config.name)
  }

  abortAll(sessionId: string): void {
    acpService.destroyAllForSession(sessionId)
  }
}
