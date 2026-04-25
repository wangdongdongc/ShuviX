import type { ApiProtocol } from './provider'

/** 配置分享串魔法前缀，用于识别版本 */
export const CONFIG_SHARE_MAGIC = 'shvx1:'

/** 导出的 Provider 条目 */
export interface ExportedProvider {
  /** 匹配键（与本端 providers.name 对齐） */
  name: string
  displayName: string
  apiProtocol: ApiProtocol
  baseUrl: string | null
  /** null 表示未导出密钥；非 null 即明文 */
  apiKey: string | null
  metadata: Record<string, unknown> | null
  /** 仅作提示用；导入端不会把外来项提升为 builtin */
  isBuiltin: boolean
  /** 仅包含已开启且被勾选的模型 */
  models: Array<{ modelId: string; capabilities: Record<string, unknown> | null }>
}

/** 导出的 MCP Server 条目 */
export interface ExportedMcpServer {
  name: string
  type: 'stdio' | 'http'
  command: string | null
  args: string[] | null
  /** sensitiveStripped=true 时 value 为 "" */
  env: Record<string, string> | null
  url: string | null
  headers: Record<string, string> | null
  metadata: Record<string, unknown> | null
  /** true 表示 env/headers 的 value 已被置空，导入端需提示用户补填 */
  sensitiveStripped: boolean
  /**
   * true 表示导出端的 server 是内置项。导入端应仅将 env 合并进本端的同名内置 server，
   * 不得覆盖 url/command/args/headers/type 等结构字段；若本端未找到同名内置则跳过。
   */
  isBuiltin: boolean
}

/** 完整分享 payload */
export interface ConfigSharePayload {
  version: 1
  exportedAt: string
  appVersion: string
  providers?: ExportedProvider[]
  mcpServers?: ExportedMcpServer[]
}

/** 导出快照：仅返回"已开启"候选集供 Dialog 渲染勾选列表 */
export interface ExportSnapshot {
  providers: Array<{
    name: string
    displayName: string
    isBuiltin: boolean
    models: Array<{ modelId: string }>
  }>
  mcpServers: Array<{ name: string; type: 'stdio' | 'http'; isBuiltin: boolean }>
}

/** 导出选项：用户在 Dialog 里勾选后传回 main 构造 payload */
export interface ExportOptions {
  providers: Array<{ name: string; includeApiKey: boolean; modelIds: string[] }>
  mcpServers: Array<{ name: string; includeSensitive: boolean }>
}

/** 导入预计算：每一项即将执行的动作 */
export interface ImportPlan {
  providers: Array<{
    name: string
    action: 'create' | 'overwrite' | 'mergeBuiltin'
    modelIds: string[]
    missingApiKey: boolean
  }>
  mcpServers: Array<{
    name: string
    /**
     * - create: 本端无同名项，将新增
     * - overwrite: 本端有同名非内置项，将全量覆盖
     * - mergeBuiltin: 本端或导出端是内置项，仅合并 env（不改 url/command 等结构字段）
     * - skipMissingBuiltin: 导出端标记为内置但本端未找到同名内置，将跳过
     */
    action: 'create' | 'overwrite' | 'mergeBuiltin' | 'skipMissingBuiltin'
    missingSecrets: boolean
  }>
}

/** 导入选择：renderer 勾选后发回的执行集 */
export interface ImportSelection {
  providerNames: string[]
  /** 形如 "providerName::modelId" */
  modelKeys: string[]
  mcpNames: string[]
}

/** 导入结果：逐项成败 */
export interface ImportResult {
  providers: Array<{ name: string; ok: boolean; error?: string }>
  mcpServers: Array<{ name: string; ok: boolean; error?: string }>
}
