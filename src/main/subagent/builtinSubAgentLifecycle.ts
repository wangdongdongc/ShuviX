/**
 * 内置子智能体生命周期
 *
 * 从代码定义（BUILTIN_SUB_AGENTS）加载内置 sub-agent，并根据用户在 settings 中
 * 保存的禁用列表决定是否注册到 registry。
 *
 * 与 customSubAgentLifecycle 的协作：
 * - 内置项定义在代码里，用户无法编辑 name/tools/systemPrompt 等字段，只能启用/禁用
 * - 用户禁用列表存 settings 表 key `subagent.builtinDisabled`（JSON string[]）
 * - 命名空间与自定义共享（SubAgentRegistry 同一个），两者 name 不可冲突
 */

import { settingsDao } from '../dao/settingsDao'
import { registerBuiltinTool, unregisterBuiltinTool } from '../services/toolRegistry'
import { subAgentRegistry } from './registry'
import { BuiltinSubAgentProvider } from './providers/BuiltinSubAgentProvider'
import { BUILTIN_SUB_AGENTS, type BuiltinSubAgentDef } from './builtins'
import { createLogger } from '../logger'

const log = createLogger('BuiltinSubAgent')

const DISABLED_SETTINGS_KEY = 'subagent.builtinDisabled'

/** 内置 sub-agent 的 Provider 实例缓存（按 name 索引，供 toggle/reload 使用） */
const providers = new Map<string, BuiltinSubAgentProvider>()

/** 读取用户禁用列表（不存在或解析失败返回空集合） */
function readDisabledSet(): Set<string> {
  const raw = settingsDao.findByKey(DISABLED_SETTINGS_KEY)
  if (!raw) return new Set()
  try {
    const arr = JSON.parse(raw) as unknown
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch {
    // 解析失败视为空
  }
  return new Set()
}

/** 将禁用列表写回 settings */
function writeDisabledSet(set: Set<string>): void {
  settingsDao.upsert(DISABLED_SETTINGS_KEY, JSON.stringify([...set]))
}

/** 注册单个内置 sub-agent 到 registry + 工具注册表 */
function registerOne(def: BuiltinSubAgentDef): void {
  let provider = providers.get(def.name)
  if (!provider) {
    provider = new BuiltinSubAgentProvider(def)
    providers.set(def.name, provider)
  }
  subAgentRegistry.register(provider)
  registerBuiltinTool({
    name: def.name,
    group: 'subagent',
    defaultEnabled: false,
    getLabel: () => provider!.displayName,
    getHint: () => provider!.shortDescription || provider!.displayName
  })
}

/** 注销单个内置 sub-agent（工具注册表 + registry，保留 provider 实例供重启用） */
function unregisterOne(name: string): void {
  subAgentRegistry.unregister(name)
  unregisterBuiltinTool(name)
}

/** 启动时加载：遍历所有内置定义，按禁用列表决定注册 */
export function loadBuiltinSubAgents(): void {
  const disabled = readDisabledSet()
  let enabledCount = 0
  for (const def of BUILTIN_SUB_AGENTS) {
    if (disabled.has(def.name)) continue
    registerOne(def)
    enabledCount++
  }
  log.info(
    `Loaded ${enabledCount} built-in sub-agent(s) (${disabled.size} disabled by user preference)`
  )
}

/** 列出所有内置 sub-agent（供 UI 展示，含禁用状态） */
export interface BuiltinSubAgentInfo {
  name: string
  displayName: string
  shortDescription: string
  description: string
  systemPrompt: string
  tools: readonly string[]
  maxTurns: number
  isEnabled: boolean
}

export function listBuiltinSubAgents(): BuiltinSubAgentInfo[] {
  const disabled = readDisabledSet()
  return BUILTIN_SUB_AGENTS.map((def) => {
    const provider = providers.get(def.name) ?? new BuiltinSubAgentProvider(def)
    // 未注册时也创建一份临时 provider 以获取 i18n 后的展示字段（不影响 registry）
    if (!providers.has(def.name)) providers.set(def.name, provider)
    return {
      name: def.name,
      displayName: provider.displayName,
      shortDescription: provider.shortDescription,
      description: provider.description,
      systemPrompt: def.systemPrompt,
      tools: def.tools,
      maxTurns: def.maxTurns,
      isEnabled: !disabled.has(def.name)
    }
  })
}

/** 切换内置 sub-agent 启用状态；写回 settings 并同步 registry */
export function setBuiltinSubAgentEnabled(name: string, enabled: boolean): boolean {
  const def = BUILTIN_SUB_AGENTS.find((d) => d.name === name)
  if (!def) return false
  const disabled = readDisabledSet()
  if (enabled) {
    if (!disabled.has(name)) return true
    disabled.delete(name)
    writeDisabledSet(disabled)
    registerOne(def)
  } else {
    if (disabled.has(name)) return true
    disabled.add(name)
    writeDisabledSet(disabled)
    unregisterOne(name)
  }
  return true
}

/** 查询某个 sub-agent 是否为内置（供 IPC 层分流 toggle / update / delete 请求） */
export function isBuiltinSubAgent(name: string): boolean {
  return BUILTIN_SUB_AGENTS.some((d) => d.name === name)
}
