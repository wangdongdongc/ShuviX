/**
 * 浏览器 MCP Server 存储 —— chrome.storage.local 持久化 + 内存缓存。
 *
 * 实现共享 McpManager 所需的同步 McpStore（findById/findEnabled/findAll/updateCachedTools），
 * 并提供 CRUD（add/update/delete）供 chatApiAdapter.mcp 调用。用户能加的只有 http 类型；
 * 另有一行随产品种下的内置能力服务器 `browser`（`type: 'inproc'`，见 BUILTIN_BROWSER_ROW）。
 *
 * **名字唯一**：名字是工具名前缀（`mcp__<name>__*`），两台同名 server 会产出同名工具，
 * 内置 server 的专属渲染也会认错人。桌面靠 `mcp_servers.name UNIQUE`，这里的数组没有约束，
 * 所以 add / update 自己查。
 */
import { v4 as uuid } from 'uuid'
import type {
  McpServer,
  McpServerAddParams,
  McpServerUpdateParams
} from '@shuvix/chat-protocol/types/mcp'

const KEY = 'mcpServers'

/** 内置能力服务器 browser 的行 id（与桌面 v27 迁移种下的同一个） */
export const BUILTIN_BROWSER_ID = 'builtin-mcp-browser'

let cache: McpServer[] = []
let loaded = false

/**
 * 内置 browser 那一行。扩展没有会话级勾选：所有已启用的 server 注入每个会话，于是它在这里
 * 恒开 —— 浏览器本来就是这个扩展存在的理由。用户仍可在 MCP 设置里整台停用。
 */
function builtinBrowserRow(now: number): McpServer {
  return {
    id: BUILTIN_BROWSER_ID,
    name: 'browser',
    type: 'inproc',
    command: '',
    args: '[]',
    env: '{}',
    url: '',
    headers: '{}',
    metadata: '{}',
    isEnabled: 1,
    isBuiltin: 1,
    cachedTools: '[]',
    createdAt: now,
    updatedAt: now
  }
}

/** 名字被别的行占着时，给占用者换一个不撞的名字（`<name>-custom`，再撞加序号） */
function freeNameFor(name: string): string {
  let candidate = `${name}-custom`
  for (let n = 2; cache.some((s) => s.name === candidate); n++) candidate = `${name}-custom-${n}`
  return candidate
}

/**
 * 缺了就种上内置行。名字 `browser` 若已被用户加的 server 占着，先给那一行改名 ——
 * 与桌面 v27 迁移同一条规则（有人会把 Playwright MCP 起名叫 browser）。
 */
function ensureBuiltinRows(): boolean {
  if (cache.some((s) => s.id === BUILTIN_BROWSER_ID)) return false
  const now = Date.now()
  const occupant = cache.find((s) => s.name === 'browser')
  if (occupant) {
    occupant.name = freeNameFor('browser')
    occupant.updatedAt = now
  }
  cache.unshift(builtinBrowserRow(now))
  return true
}

function persist(): void {
  void chrome.storage.local.set({ [KEY]: cache }).catch(() => {})
}

export const mcpStore = {
  async loadState(): Promise<void> {
    if (loaded) return
    const obj = await chrome.storage.local.get(KEY)
    cache = (obj[KEY] as McpServer[]) ?? []
    loaded = true
    if (ensureBuiltinRows()) persist()
  },

  // ─── 同步 McpStore（供 McpManager） ───
  findById(id: string): McpServer | undefined {
    return cache.find((s) => s.id === id)
  },
  findEnabled(): McpServer[] {
    return cache.filter((s) => s.isEnabled)
  },
  findAll(): McpServer[] {
    return [...cache]
  },
  updateCachedTools(id: string, toolsJson: string): void {
    const s = cache.find((x) => x.id === id)
    if (s) {
      s.cachedTools = toolsJson
      persist()
    }
  },

  // ─── CRUD（供 chatApiAdapter） ───

  /**
   * 名字有什么问题（没有 → undefined）。名字是工具名前缀 `mcp__<name>__<tool>`：必须唯一，
   * 也不能含 `__` —— 那会让拼接有两种读法，还能让一台自定义 server 的工具以 `mcp__browser__`
   * 开头、冒充内置浏览器。与桌面 mcp:add / mcp:update 同一条规则。
   */
  nameProblem(name: string, selfId?: string): string | undefined {
    const trimmed = name.trim()
    if (!trimmed) return 'An MCP server needs a name'
    if (trimmed.includes('__')) return 'An MCP server name cannot contain "__"'
    const taken = cache.some((s) => s.name === trimmed && s.id !== selfId)
    return taken ? `An MCP server named "${trimmed}" already exists` : undefined
  },

  /** 名字有问题（见 nameProblem）时返回 undefined（调用方回 success:false） */
  add(params: McpServerAddParams): McpServer | undefined {
    if (mcpStore.nameProblem(params.name)) return undefined
    const now = Date.now()
    const server: McpServer = {
      id: `mcp-${uuid()}`,
      name: params.name.trim(),
      type: 'http', // 扩展仅支持 http（浏览器无法跑本地子进程）
      command: '',
      args: '[]',
      env: JSON.stringify(params.env ?? {}),
      url: params.url ?? '',
      headers: JSON.stringify(params.headers ?? {}),
      metadata: '{}',
      isEnabled: 1,
      isBuiltin: 0,
      cachedTools: '[]',
      createdAt: now,
      updatedAt: now
    }
    cache.push(server)
    persist()
    return server
  },

  /** 行不存在、改名撞了别的行、或试图改内置行的配置时返回 undefined（只允许启停内置行） */
  update(params: McpServerUpdateParams): McpServer | undefined {
    const s = cache.find((x) => x.id === params.id)
    if (!s) return undefined
    if (params.name !== undefined && mcpStore.nameProblem(params.name, s.id)) return undefined
    // 只看真带了值的键：表单把没改的字段写成 undefined 送来，不算改内置行的配置
    const touched = Object.entries(params).filter(([, v]) => v !== undefined)
    if (s.isBuiltin === 1 && touched.some(([k]) => k !== 'id' && k !== 'isEnabled')) {
      return undefined
    }
    if (params.name !== undefined) s.name = params.name.trim()
    if (params.url !== undefined) s.url = params.url
    if (params.headers !== undefined) s.headers = JSON.stringify(params.headers)
    if (params.env !== undefined) s.env = JSON.stringify(params.env)
    if (params.isEnabled !== undefined) s.isEnabled = params.isEnabled ? 1 : 0
    s.updatedAt = Date.now()
    persist()
    return s
  },

  /** 内置行删不掉（返回 false）—— 不想要就停用 */
  delete(id: string): boolean {
    if (cache.some((s) => s.id === id && s.isBuiltin === 1)) return false
    cache = cache.filter((s) => s.id !== id)
    persist()
    return true
  }
}
