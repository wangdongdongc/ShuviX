/**
 * 浏览器会话存储 —— IndexedDB 持久化 + 内存缓存。
 * 实现 ChatApi.session 所需的最小子集（list / create / getById / updateModelConfig / updateTitle / delete）。
 */
import { v4 as uuid } from 'uuid'
import i18n from 'i18next'
import type { Session, SessionInfo } from '@shuvix/chat-protocol/chatApi'
import { idb } from './idb'
import { messageStore } from './messageStore'
import { deleteTempWorkspace } from './opfsWorkspace'

const cache = new Map<string, Session>()
let loaded = false

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  const rows = await idb.getAll<Session>('sessions')
  for (const s of rows) cache.set(s.id, s)
  loaded = true
}

function persist(s: Session): void {
  cache.set(s.id, s)
  void idb.put('sessions', s).catch((e) => console.error('[shuvix] persist session failed', e))
}

export const sessionStore = {
  async list(): Promise<Session[]> {
    await ensureLoaded()
    return [...cache.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  },

  async create(defaults: {
    provider: string
    model: string
    projectId?: string | null
  }): Promise<Session> {
    await ensureLoaded()
    const now = Date.now()
    const session: Session = {
      id: uuid(),
      title: i18n.t('agent.defaultTitle'), // 默认「新对话」，与桌面一致；首轮后由 generateTitle 覆盖
      projectId: defaults.projectId ?? null,
      provider: defaults.provider,
      model: defaults.model,
      systemPrompt: '',
      modelMetadata: {},
      settings: {},
      createdAt: now,
      updatedAt: now
    }
    persist(session)
    return session
  },

  async getById(id: string): Promise<SessionInfo | null> {
    await ensureLoaded()
    const s = cache.get(id)
    if (!s) return null
    // 浏览器无项目工作目录概念；enabledTools 由扩展固定（ask + 已连接 MCP 工具）
    return { ...s, workingDirectory: null, enabledTools: [] }
  },

  async updateTitle(id: string, title: string): Promise<void> {
    await ensureLoaded()
    const s = cache.get(id)
    if (!s) return
    persist({ ...s, title, updatedAt: Date.now() })
  },

  async updateModelConfig(id: string, provider: string, model: string): Promise<void> {
    await ensureLoaded()
    const s = cache.get(id)
    if (!s) return
    persist({ ...s, provider, model, updatedAt: Date.now() })
  },

  async delete(id: string): Promise<void> {
    await ensureLoaded()
    cache.delete(id)
    await idb.delete('sessions', id)
    await messageStore.clear(id)
    // 临时会话的 OPFS 工作目录连带清理（项目会话无此目录，best-effort 幂等）
    await deleteTempWorkspace(id)
  }
}
