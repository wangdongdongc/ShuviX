/**
 * 扩展配置分享存储 —— 对应桌面 configShareService 的浏览器实现。
 *
 * 复用 @shuvix/chat-protocol/configShareCore 的编解码 + 导入判定（与桌面同语义），
 * 读写真实数据走 settingsStore（provider/model，对应桌面 providerDao）+ mcpStore（http MCP）。
 * 扩展无内置 MCP，故导出端标记 builtin 的 MCP 项一律跳过（避免污染配置）。
 */
import {
  encodeConfigSharePayload,
  parseConfigSharePayload,
  planConfigImport
} from '@shuvix/chat-protocol/configShareCore'
import type {
  ConfigSharePayload,
  ExportedMcpServer,
  ExportedProvider,
  ExportOptions,
  ExportSnapshot,
  ImportPlan,
  ImportResult,
  ImportSelection
} from '@shuvix/chat-protocol/types/configShare'
import { settingsStore } from './settingsStore'
import { mcpStore } from './mcpStore'
import { mcpManager } from '../runtime/mcpRuntime'

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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function applyProvider(exported: ExportedProvider, modelKeySet: Set<string>): Promise<void> {
  const existing = settingsStore.listProviders().find((p) => p.name === exported.name)
  let providerId: string

  if (!existing) {
    // 本端无同名项 → 新建自定义 provider（内置 slug 恒在目录中，故此分支必为自定义）
    providerId = await settingsStore.addCustomProvider({
      name: exported.name,
      baseUrl: exported.baseUrl ?? '',
      apiKey: exported.apiKey ?? '',
      apiProtocol: exported.apiProtocol,
      metadata: JSON.stringify(exported.metadata ?? {})
    })
  } else if (existing.isBuiltin === 1) {
    // 内置 → 仅合并 apiKey（baseUrl 由目录决定，updateConfig 内部忽略内置 baseUrl）
    providerId = existing.id
    if (exported.apiKey !== null)
      await settingsStore.updateConfig(providerId, { apiKey: exported.apiKey })
  } else {
    // 自定义已存在 → 全量覆盖
    providerId = existing.id
    await settingsStore.updateConfig(providerId, {
      ...(exported.apiKey !== null ? { apiKey: exported.apiKey } : {}),
      ...(exported.baseUrl !== null ? { baseUrl: exported.baseUrl } : {}),
      apiProtocol: exported.apiProtocol,
      ...(exported.metadata !== null ? { metadata: JSON.stringify(exported.metadata) } : {})
    })
  }

  // 确保 provider 启用（内置启用会触发 syncBuiltinModels 补齐 pi-ai 模型）
  await settingsStore.toggleEnabled(providerId, true)

  // 处理选中的 models
  for (const model of exported.models) {
    if (!modelKeySet.has(`${exported.name}::${model.modelId}`)) continue
    await settingsStore.addModel(providerId, model.modelId)
    const composite = `${providerId}:${model.modelId}`
    await settingsStore.toggleModelEnabled(composite, true)
    if (model.capabilities) {
      await settingsStore.updateModelCapabilities(composite, model.capabilities)
    }
  }
}

async function applyMcpServer(exported: ExportedMcpServer): Promise<void> {
  // 扩展无内置 MCP：导出端标记 builtin 的项一律跳过，避免以残缺字段污染本端
  if (exported.isBuiltin) {
    throw new Error(`Built-in "${exported.name}" is not available in the extension — skipped`)
  }
  const existing = mcpStore.findAll().find((s) => s.name === exported.name)
  const fields = {
    name: exported.name,
    url: exported.url ?? '',
    env: exported.env ?? {},
    headers: exported.headers ?? {}
  }
  if (existing) {
    mcpStore.update({ id: existing.id, ...fields, isEnabled: true })
    await mcpManager.disconnect(existing.id)
    await mcpManager.connect(existing.id)
  } else {
    const created = mcpStore.add({ type: 'http', ...fields })
    await mcpManager.connect(created.id)
  }
}

export const configShareStore = {
  /** 构建 Dialog 渲染用的「已开启候选集」 */
  async buildExportSnapshot(): Promise<ExportSnapshot> {
    await settingsStore.loadState()
    await mcpStore.loadState()
    const providers = settingsStore
      .listProviders()
      .filter((p) => p.isEnabled)
      .map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
        isBuiltin: p.isBuiltin === 1,
        models: settingsStore
          .listModelsFor(p.id)
          .filter((m) => m.isEnabled)
          .map((m) => ({ modelId: m.modelId }))
      }))
    const mcpServers = mcpStore
      .findAll()
      .filter((s) => s.isEnabled)
      .map((s) => ({
        name: s.name,
        type: s.type as 'stdio' | 'http',
        isBuiltin: s.isBuiltin === 1
      }))
    return { providers, mcpServers }
  },

  /** 按用户勾选构建并编码 payload */
  async buildExportPayload(options: ExportOptions): Promise<string> {
    await settingsStore.loadState()
    await mcpStore.loadState()
    const providerSel = new Map(options.providers.map((p) => [p.name, p]))
    const mcpSel = new Map(options.mcpServers.map((s) => [s.name, s]))

    const exportedProviders: ExportedProvider[] = []
    for (const provider of settingsStore.listProviders().filter((p) => p.isEnabled)) {
      const sel = providerSel.get(provider.name)
      if (!sel) continue
      const modelIdSet = new Set(sel.modelIds)
      const pickedModels = settingsStore
        .listModelsFor(provider.id)
        .filter((m) => m.isEnabled && modelIdSet.has(m.modelId))
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
    for (const server of mcpStore.findAll().filter((s) => s.isEnabled)) {
      const sel = mcpSel.get(server.name)
      if (!sel) continue
      const envObj = safeJsonParse<Record<string, string>>(server.env, {})
      const headersObj = safeJsonParse<Record<string, string>>(server.headers, {})
      const sensitiveStripped = !sel.includeSensitive
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

    const payload: ConfigSharePayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: chrome.runtime.getManifest().version,
      providers: exportedProviders.length > 0 ? exportedProviders : undefined,
      mcpServers: exportedMcpServers.length > 0 ? exportedMcpServers : undefined
    }
    return encodeConfigSharePayload(payload)
  },

  /** 解码并校验粘贴的分享串（复用共享内核） */
  async parseImportPayload(encoded: string): Promise<ConfigSharePayload> {
    return parseConfigSharePayload(encoded)
  },

  /** 预计算每项将执行的动作（复用共享判定，注入本端查询） */
  async planImport(payload: ConfigSharePayload): Promise<ImportPlan> {
    await settingsStore.loadState()
    await mcpStore.loadState()
    const byName = new Map(settingsStore.listProviders().map((p) => [p.name, p]))
    return planConfigImport(payload, {
      findProvider: (name) => {
        const p = byName.get(name)
        return p ? { isBuiltin: p.isBuiltin === 1 } : undefined
      },
      findMcp: (name) => {
        const s = mcpStore.findAll().find((x) => x.name === name)
        return s ? { isBuiltin: s.isBuiltin === 1 } : undefined
      }
    })
  },

  /** 按用户勾选执行导入，逐项收集成败 */
  async applyImport(params: {
    payload: ConfigSharePayload
    selection: ImportSelection
  }): Promise<ImportResult> {
    await settingsStore.loadState()
    await mcpStore.loadState()
    const { payload, selection } = params
    const providerNameSet = new Set(selection.providerNames)
    const modelKeySet = new Set(selection.modelKeys)
    const mcpNameSet = new Set(selection.mcpNames)

    const providers: ImportResult['providers'] = []
    for (const exported of payload.providers ?? []) {
      if (!providerNameSet.has(exported.name)) continue
      try {
        await applyProvider(exported, modelKeySet)
        providers.push({ name: exported.name, ok: true })
      } catch (err) {
        providers.push({ name: exported.name, ok: false, error: errMsg(err) })
      }
    }

    const mcpServers: ImportResult['mcpServers'] = []
    for (const exported of payload.mcpServers ?? []) {
      if (!mcpNameSet.has(exported.name)) continue
      try {
        await applyMcpServer(exported)
        mcpServers.push({ name: exported.name, ok: true })
      } catch (err) {
        mcpServers.push({ name: exported.name, ok: false, error: errMsg(err) })
      }
    }

    return { providers, mcpServers }
  }
}
