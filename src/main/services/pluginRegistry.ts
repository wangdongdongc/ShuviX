/**
 * PluginRegistry — 插件注册中心（单例）
 *
 * 管理插件注册、激活/停用生命周期、事件分发、purpose 汇总。
 */

import type { ShuviXPlugin, PluginContribution, PluginPurpose } from '../../plugin-api/types'
import type { SlashCommand } from '../../shared/types/slashCommand'
import type { HostEvent } from '../../plugin-api/hostEvents'
import { createPluginContext } from './pluginContextFactory'
import { createLogger } from '../logger'

const log = createLogger('PluginRegistry')

interface PluginEntry {
  plugin: ShuviXPlugin
  contribution: PluginContribution | null
}

class PluginRegistry {
  private plugins = new Map<string, PluginEntry>()

  /** 注册插件（仅注册，不激活） */
  register(plugin: ShuviXPlugin): void {
    if (this.plugins.has(plugin.id)) {
      log.warn(`Plugin "${plugin.id}" already registered, skipping`)
      return
    }
    this.plugins.set(plugin.id, { plugin, contribution: null })
    log.info(`Plugin registered: ${plugin.id} (${plugin.name} v${plugin.version})`)
  }

  /** 激活所有已注册插件 */
  async activateAll(): Promise<void> {
    for (const [id, entry] of this.plugins) {
      try {
        const ctx = createPluginContext(id)
        const contribution = await entry.plugin.activate(ctx)
        entry.contribution = contribution
        log.info(`Plugin activated: ${id}`)
      } catch (err) {
        log.error(`Failed to activate plugin "${id}":`, err)
      }
    }
  }

  /** 停用所有插件 */
  async deactivateAll(): Promise<void> {
    for (const [id, entry] of this.plugins) {
      try {
        await entry.plugin.deactivate?.()
        entry.contribution = null
        log.info(`Plugin deactivated: ${id}`)
      } catch (err) {
        log.error(`Failed to deactivate plugin "${id}":`, err)
      }
    }
  }

  /** 向所有已激活插件广播 HostEvent */
  dispatchEvent(event: HostEvent): void {
    log.info(`HostEvent → plugins: ${event.type}`, event)
    for (const [id, entry] of this.plugins) {
      if (entry.contribution?.onEvent) {
        try {
          entry.contribution.onEvent(event)
        } catch (err) {
          log.error(`Error dispatching event to plugin "${id}":`, err)
        }
      }
    }
  }

  /** 获取所有插件贡献的 purpose 列表 */
  getAllPurposes(): PluginPurpose[] {
    const purposes: PluginPurpose[] = []
    for (const entry of this.plugins.values()) {
      if (entry.contribution?.purpose) {
        purposes.push(entry.contribution.purpose)
      }
    }
    return purposes
  }

  /** 获取所有插件贡献的斜杠命令（按 enabledTools 过滤） */
  getAllCommands(enabledTools: string[]): SlashCommand[] {
    const enabledSet = new Set(enabledTools)
    return this.getActivatedEntries().flatMap(({ contribution }) =>
      (contribution.commands ?? [])
        .filter((cmd) => !cmd.requiredTools || cmd.requiredTools.every((t) => enabledSet.has(t)))
        .map((cmd) => ({ ...cmd, filePath: '(plugin)' }))
    )
  }

  /** 获取所有插件贡献的工具名列表 */
  getAllToolNames(): string[] {
    const names: string[] = []
    for (const entry of this.plugins.values()) {
      for (const tool of entry.contribution?.tools ?? []) {
        names.push(tool.name)
      }
    }
    return names
  }

  /** 获取指定插件的贡献 */
  getContribution(pluginId: string): PluginContribution | null {
    return this.plugins.get(pluginId)?.contribution ?? null
  }

  /** 获取所有已激活的插件条目 */
  getActivatedEntries(): Array<{ plugin: ShuviXPlugin; contribution: PluginContribution }> {
    const result: Array<{ plugin: ShuviXPlugin; contribution: PluginContribution }> = []
    for (const entry of this.plugins.values()) {
      if (entry.contribution) {
        result.push({ plugin: entry.plugin, contribution: entry.contribution })
      }
    }
    return result
  }
}

export const pluginRegistry = new PluginRegistry()
