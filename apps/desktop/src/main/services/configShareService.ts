import { app } from 'electron'
import { v7 as uuidv7 } from 'uuid'
import { providerDao } from '../dao/providerDao'
import { appEventBus } from '../utils/appEventBus'
import { mcpDao } from '../dao/mcpDao'
import { mcpService } from './mcpService'
import { createLogger } from '../logger'
import {
  type ConfigSharePayload,
  type ExportedMcpServer,
  type ExportedProvider,
  type ExportOptions,
  type ExportSnapshot,
  type ImportPlan,
  type ImportResult,
  type ImportSelection
} from '@shuvix/chat-protocol/types/configShare'
import {
  encodeConfigSharePayload,
  parseConfigSharePayload,
  planConfigImport
} from '@shuvix/chat-protocol/configShareCore'
import type { ApiProtocol } from '@shuvix/chat-protocol/types/provider'
import type { McpServer } from '../dao/types'

const log = createLogger('ConfigShare')

function safeJsonParse<T>(text: string | undefined | null, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function stripRecordValues<V>(record: Record<string, V>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(record)) out[key] = ''
  return out
}

/**
 * 配置分享服务 — 导出/导入 Provider + MCP 配置为可粘贴的字符串
 */
class ConfigShareService {
  /** 构建 Dialog 渲染用的"已开启候选集" */
  buildExportSnapshot(): ExportSnapshot {
    const enabledProviders = providerDao.findEnabled()
    const providers = enabledProviders.map((p) => {
      const enabledModels = providerDao.findEnabledModels(p.id)
      return {
        name: p.name,
        displayName: p.displayName || p.name,
        isBuiltin: p.isBuiltin === 1,
        models: enabledModels.map((m) => ({ modelId: m.modelId }))
      }
    })
    const mcpServers = mcpDao.findEnabled().map((s) => ({
      name: s.name,
      type: s.type as 'stdio' | 'http',
      isBuiltin: s.isBuiltin === 1
    }))
    return { providers, mcpServers }
  }

  /** 按用户勾选构建并编码 payload */
  buildExportPayload(options: ExportOptions): string {
    const providerSelections = new Map(options.providers.map((p) => [p.name, p]))
    const mcpSelections = new Map(options.mcpServers.map((s) => [s.name, s]))

    const exportedProviders: ExportedProvider[] = []
    for (const provider of providerDao.findEnabled()) {
      const sel = providerSelections.get(provider.name)
      if (!sel) continue

      const allModels = providerDao.findEnabledModels(provider.id)
      const modelIdSet = new Set(sel.modelIds)
      const pickedModels = allModels
        .filter((m) => modelIdSet.has(m.modelId))
        .map((m) => ({
          modelId: m.modelId,
          capabilities: safeJsonParse<Record<string, unknown> | null>(m.capabilities, null)
        }))

      exportedProviders.push({
        name: provider.name,
        displayName: provider.displayName,
        apiProtocol: provider.apiProtocol,
        baseUrl: provider.baseUrl || null,
        apiKey: sel.includeApiKey && provider.apiKey ? provider.apiKey : null,
        metadata: safeJsonParse<Record<string, unknown> | null>(provider.metadata, null),
        isBuiltin: provider.isBuiltin === 1,
        models: pickedModels
      })
    }

    const exportedMcpServers: ExportedMcpServer[] = []
    for (const server of mcpDao.findEnabled()) {
      const sel = mcpSelections.get(server.name)
      if (!sel) continue

      const envObj = safeJsonParse<Record<string, string>>(server.env, {})
      const headersObj = safeJsonParse<Record<string, string>>(server.headers, {})
      const sensitiveStripped = !sel.includeSensitive
      const isBuiltin = server.isBuiltin === 1

      if (isBuiltin) {
        // 内置 server 只导出 env（结构字段由接收端的同名内置项提供）
        exportedMcpServers.push({
          name: server.name,
          type: server.type as 'stdio' | 'http',
          command: null,
          args: null,
          env: sensitiveStripped ? stripRecordValues(envObj) : envObj,
          url: null,
          headers: null,
          metadata: null,
          sensitiveStripped,
          isBuiltin: true
        })
      } else {
        exportedMcpServers.push({
          name: server.name,
          type: server.type as 'stdio' | 'http',
          command: server.command || null,
          args: safeJsonParse<string[]>(server.args, []),
          env: sensitiveStripped ? stripRecordValues(envObj) : envObj,
          url: server.url || null,
          headers: sensitiveStripped ? stripRecordValues(headersObj) : headersObj,
          metadata: safeJsonParse<Record<string, unknown> | null>(server.metadata, null),
          sensitiveStripped,
          isBuiltin: false
        })
      }
    }

    const payload: ConfigSharePayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      providers: exportedProviders.length > 0 ? exportedProviders : undefined,
      mcpServers: exportedMcpServers.length > 0 ? exportedMcpServers : undefined
    }

    return encodeConfigSharePayload(payload)
  }

  /** 解码并校验 payload，失败抛带可读 message 的 Error（复用共享内核） */
  parseImportPayload(encoded: string): ConfigSharePayload {
    return parseConfigSharePayload(encoded)
  }

  /** 预计算每项将执行的动作（复用共享判定，注入本端 DAO 查询） */
  planImport(payload: ConfigSharePayload): ImportPlan {
    const providerByName = new Map(providerDao.findAll().map((p) => [p.name, p]))
    return planConfigImport(payload, {
      findProvider: (name) => {
        const p = providerByName.get(name)
        return p ? { isBuiltin: p.isBuiltin === 1 } : undefined
      },
      findMcp: (name) => {
        const s = mcpDao.findByName(name)
        return s ? { isBuiltin: s.isBuiltin === 1 } : undefined
      }
    })
  }

  /** 按用户勾选执行导入，逐项收集成败 */
  async applyImportPayload(
    payload: ConfigSharePayload,
    selection: ImportSelection
  ): Promise<ImportResult> {
    const providerNameSet = new Set(selection.providerNames)
    const modelKeySet = new Set(selection.modelKeys)
    const mcpNameSet = new Set(selection.mcpNames)

    const providerResults: ImportResult['providers'] = []
    for (const exported of payload.providers ?? []) {
      if (!providerNameSet.has(exported.name)) continue
      try {
        await this.applyProvider(exported, modelKeySet)
        providerResults.push({ name: exported.name, ok: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error(`import provider "${exported.name}" failed: ${msg}`)
        providerResults.push({ name: exported.name, ok: false, error: msg })
      }
    }

    const mcpResults: ImportResult['mcpServers'] = []
    for (const exported of payload.mcpServers ?? []) {
      if (!mcpNameSet.has(exported.name)) continue
      try {
        await this.applyMcpServer(exported)
        mcpResults.push({ name: exported.name, ok: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error(`import mcp "${exported.name}" failed: ${msg}`)
        mcpResults.push({ name: exported.name, ok: false, error: msg })
      }
    }

    // 导入直接写 providerDao（未走 providerService）→ 在此发布 providers.changed
    if (providerResults.length > 0) appEventBus.publish({ type: 'providers.changed' })
    return { providers: providerResults, mcpServers: mcpResults }
  }

  private async applyProvider(exported: ExportedProvider, modelKeySet: Set<string>): Promise<void> {
    const existing = providerDao.findAll().find((p) => p.name === exported.name)
    let providerId: string

    if (!existing) {
      providerId = uuidv7()
      providerDao.insert({
        id: providerId,
        name: exported.name,
        baseUrl: exported.baseUrl ?? '',
        apiKey: exported.apiKey ?? '',
        apiProtocol: exported.apiProtocol as ApiProtocol,
        metadata: JSON.stringify(exported.metadata ?? {})
      })
    } else if (existing.isBuiltin === 1) {
      providerId = existing.id
      if (exported.apiKey !== null) providerDao.updateApiKey(providerId, exported.apiKey)
      if (exported.baseUrl) providerDao.updateBaseUrl(providerId, exported.baseUrl)
    } else {
      providerId = existing.id
      if (exported.apiKey !== null) providerDao.updateApiKey(providerId, exported.apiKey)
      if (exported.baseUrl !== null) providerDao.updateBaseUrl(providerId, exported.baseUrl)
      providerDao.updateApiProtocol(providerId, exported.apiProtocol)
      if (exported.metadata !== null) {
        providerDao.updateMetadata(providerId, JSON.stringify(exported.metadata))
      }
    }

    // 确保 provider 本身启用
    providerDao.updateEnabled(providerId, true)

    // 处理选中的 models
    const existingModels = providerDao.findModelsByProvider(providerId)
    const modelByModelId = new Map(existingModels.map((m) => [m.modelId, m]))
    for (const model of exported.models) {
      const selectionKey = `${exported.name}::${model.modelId}`
      if (!modelKeySet.has(selectionKey)) continue
      let modelRow = modelByModelId.get(model.modelId)
      if (!modelRow) {
        providerDao.insertModel(providerId, model.modelId)
        modelRow = providerDao
          .findModelsByProvider(providerId)
          .find((m) => m.modelId === model.modelId)
      } else {
        providerDao.updateModelEnabled(modelRow.id, true)
      }
      if (modelRow && model.capabilities) {
        providerDao.patchCapabilities(modelRow.id, model.capabilities)
      }
    }
  }

  private async applyMcpServer(exported: ExportedMcpServer): Promise<void> {
    const existing = mcpDao.findByName(exported.name)

    // 1. 导出端标记为内置但本端不存在对应内置 → 跳过，避免以内置 payload 的残缺字段污染本端
    if (exported.isBuiltin && existing?.isBuiltin !== 1) {
      throw new Error(
        `Built-in "${exported.name}" is not available on this install — skipped to avoid corrupting config`
      )
    }

    // 2. 本端是内置 → 仅合并 env（只接受有值的 key，空值不覆盖已有 key），保留 url/command 等结构字段
    if (existing?.isBuiltin === 1) {
      const existingEnv = safeJsonParse<Record<string, string>>(existing.env, {})
      const merged: Record<string, string> = { ...existingEnv }
      const incomingEnv = exported.env ?? {}
      for (const [k, v] of Object.entries(incomingEnv)) {
        if (typeof v === 'string' && v.trim().length > 0) merged[k] = v
      }
      await mcpService.disconnect(existing.id)
      mcpDao.update(existing.id, {
        env: JSON.stringify(merged),
        isEnabled: 1
      })
      await mcpService.connect(existing.id)
      return
    }

    // 3. 非内置：create / overwrite（原有行为）
    const now = Date.now()
    const record: McpServer = {
      id: existing?.id ?? uuidv7(),
      name: exported.name,
      type: exported.type,
      command: exported.command ?? '',
      args: JSON.stringify(exported.args ?? []),
      env: JSON.stringify(exported.env ?? {}),
      url: exported.url ?? '',
      headers: JSON.stringify(exported.headers ?? {}),
      metadata: JSON.stringify(exported.metadata ?? {}),
      isEnabled: 1,
      isBuiltin: 0,
      cachedTools: '[]',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }

    if (existing) {
      await mcpService.disconnect(existing.id)
      mcpDao.update(existing.id, {
        name: record.name,
        type: record.type,
        command: record.command,
        args: record.args,
        env: record.env,
        url: record.url,
        headers: record.headers,
        isEnabled: 1
      })
    } else {
      mcpDao.insert(record)
    }

    await mcpService.connect(record.id)
  }
}

export const configShareService = new ConfigShareService()
