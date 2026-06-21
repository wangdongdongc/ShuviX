/**
 * 浏览器 MCP Server 存储 —— chrome.storage.local 持久化 + 内存缓存。
 *
 * 实现共享 McpManager 所需的同步 McpStore（findById/findEnabled/findAll/updateCachedTools），
 * 并提供 CRUD（add/update/delete）供 chatApiAdapter.mcp 调用。扩展仅支持 http 类型。
 */
import { v4 as uuid } from 'uuid'
import type {
  McpServer,
  McpServerAddParams,
  McpServerUpdateParams
} from '@shuvix/chat-protocol/types/mcp'

const KEY = 'mcpServers'

let cache: McpServer[] = []
let loaded = false

function persist(): void {
  void chrome.storage.local.set({ [KEY]: cache }).catch(() => {})
}

export const mcpStore = {
  async loadState(): Promise<void> {
    if (loaded) return
    const obj = await chrome.storage.local.get(KEY)
    cache = (obj[KEY] as McpServer[]) ?? []
    loaded = true
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
  add(params: McpServerAddParams): McpServer {
    const now = Date.now()
    const server: McpServer = {
      id: `mcp-${uuid()}`,
      name: params.name,
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

  update(params: McpServerUpdateParams): McpServer | undefined {
    const s = cache.find((x) => x.id === params.id)
    if (!s) return undefined
    if (params.name !== undefined) s.name = params.name
    if (params.url !== undefined) s.url = params.url
    if (params.headers !== undefined) s.headers = JSON.stringify(params.headers)
    if (params.env !== undefined) s.env = JSON.stringify(params.env)
    if (params.isEnabled !== undefined) s.isEnabled = params.isEnabled ? 1 : 0
    s.updatedAt = Date.now()
    persist()
    return s
  },

  delete(id: string): void {
    cache = cache.filter((s) => s.id !== id)
    persist()
  }
}
