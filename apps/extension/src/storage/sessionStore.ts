/**
 * 浏览器会话存储 —— IndexedDB 持久化 + 内存缓存。
 * 实现 ChatApi.session 所需的最小子集（list / create / getById / updateModelConfig / updateTitle / delete）。
 */
import { v4 as uuid } from 'uuid'
import i18n from 'i18next'
import type { Session, SessionInfo, SessionSettings } from '@shuvix/chat-protocol/chatApi'
import { idb } from './idb'
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
    /** 绑定的 md 文件（相对项目根）；提供则创建笔记本会话 */
    notebookPath?: string
    title?: string
    /** 根 Agent 的档案名（按会话形态取默认档案，见 chatApiAdapter.defaultAgentProfile） */
    agentProfile?: string
  }): Promise<Session> {
    await ensureLoaded()
    const now = Date.now()
    const notebookPath = defaults.notebookPath
    const session: Session = {
      id: uuid(),
      // 默认「新对话」（首轮后由 generateTitle 覆盖）；笔记本会话取文件 basename
      title:
        defaults.title ??
        (notebookPath
          ? notebookPath.split('/').pop() || notebookPath
          : i18n.t('agent.defaultTitle')),
      projectId: defaults.projectId ?? null,
      // 子会话是桌面端形态（agent 经 session 工具自建）—— 扩展端不产生，恒为顶层
      parentId: null,
      // 不预写运行配置：provider / model / thinkingLevel / enabledTools 的唯一事实源是
      // 会话树（model_change / thinking_level_change / active_tools_change entry）
      // 指令文件不预写配置：留空即「未显式配置」，装配系统提示时按 AGENTS.md → CLAUDE.md 优先级自动选
      // 档案则相反：它在创建这一刻定型（调用方按会话形态解析后传入），之后归会话自己
      settings: {
        ...(notebookPath ? { notebookPath } : {}),
        ...(defaults.agentProfile ? { agentProfile: defaults.agentProfile } : {})
      },
      createdAt: now,
      updatedAt: now
    }
    persist(session)
    return session
  },

  /** 原始会话记录 */
  async get(id: string): Promise<Session | undefined> {
    await ensureLoaded()
    return cache.get(id)
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

  // 注：updateModelConfig / updateModelMetadata 已移除 —— 运行配置只写会话树。

  /** 合并补丁到会话 settings（镜像桌面 sessionDao.updateSettings 的 JSON patch 语义） */
  async updateSettings(id: string, patch: Partial<SessionSettings>): Promise<void> {
    await ensureLoaded()
    const s = cache.get(id)
    if (!s) return
    persist({ ...s, settings: { ...s.settings, ...patch }, updatedAt: Date.now() })
  },

  /** 同步读取会话 settings（运行时询问/注入需在工具执行链中直接取值，故走内存缓存） */
  getSettingsSync(id: string): SessionSettings {
    return cache.get(id)?.settings ?? {}
  },

  async delete(id: string): Promise<void> {
    await ensureLoaded()
    cache.delete(id)
    await idb.delete('sessions', id)
    const { deleteSessionFile } = await import('./sessionEntryStore')
    await deleteSessionFile(id)
    // 临时会话的 OPFS 工作目录连带清理（项目会话无此目录，best-effort 幂等）
    await deleteTempWorkspace(id)
  }
}
