/**
 * SubAgentRegistry — 子智能体 Provider 注册表
 *
 * 统一管理所有子智能体 Provider 的注册、查询、生命周期。
 * agentToolBuilder 通过 registry 遍历生成子智能体工具，无需硬编码每种类型。
 */

import type { SubAgentProvider } from './types'
import { createLogger } from '../logger'

const log = createLogger('SubAgentRegistry')

class SubAgentRegistry {
  private providers = new Map<string, SubAgentProvider>()

  /** 注册一个子智能体 Provider */
  register(provider: SubAgentProvider): void {
    if (this.providers.has(provider.name)) {
      log.warn(`Overwriting existing provider: ${provider.name}`)
    }
    this.providers.set(provider.name, provider)
    log.info(`Registered sub-agent provider: ${provider.name}`)
  }

  /** 按名称获取 Provider */
  get(name: string): SubAgentProvider | undefined {
    return this.providers.get(name)
  }

  /** 获取所有已注册的 Provider */
  getAll(): SubAgentProvider[] {
    return Array.from(this.providers.values())
  }

  /** 判断工具名是否为已注册的子智能体 */
  isSubAgent(toolName: string): boolean {
    return this.providers.has(toolName)
  }

  /** 销毁指定 session 的所有子智能体资源 */
  destroyAll(sessionId: string): void {
    for (const provider of this.providers.values()) {
      provider.destroy(sessionId)
    }
  }

  /** 中止指定 session 的所有活跃子智能体 */
  abortAll(sessionId: string): void {
    for (const provider of this.providers.values()) {
      provider.abortAll?.(sessionId)
    }
  }
}

export const subAgentRegistry = new SubAgentRegistry()
