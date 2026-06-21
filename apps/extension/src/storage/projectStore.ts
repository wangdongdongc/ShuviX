/**
 * 浏览器项目存储 —— IndexedDB 持久化 + 内存缓存。
 *
 * 「项目」与桌面是同一个产品概念（用户打开的一个文件夹），仅存储不同：
 * 桌面 projects 表存 path 字符串；扩展存 FileSystemDirectoryHandle（IndexedDB 结构化克隆，
 * chrome.storage 存不了句柄）。文件工具（P3）通过 getHandle(id) 拿句柄访问目录。
 */
import { v4 as uuid } from 'uuid'
import type { Project } from '@shuvix/chat-protocol/chatApi'
import { idb } from './idb'

/** 内部记录：Project 元数据 + 目录句柄 */
interface ProjectRecord {
  id: string
  name: string
  handle: FileSystemDirectoryHandle
  createdAt: number
  updatedAt: number
  archivedAt: number
}

const cache = new Map<string, ProjectRecord>()
let loaded = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/** 内部记录 → chat-protocol Project（path 用文件夹名展示；扩展无真实路径） */
function toProject(r: ProjectRecord): Project {
  return {
    id: r.id,
    name: r.name,
    path: r.handle.name,
    promptSections: [],
    settings: {},
    archivedAt: r.archivedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

export const projectStore = {
  async loadState(): Promise<void> {
    if (loaded) return
    const rows = await idb.getAll<ProjectRecord>('projects')
    for (const r of rows) cache.set(r.id, r)
    loaded = true
  },

  /** 活动项目（未归档） */
  list(): Project[] {
    return [...cache.values()]
      .filter((r) => !r.archivedAt)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      .map(toProject)
  },

  /** 已归档项目 */
  listArchived(): Project[] {
    return [...cache.values()]
      .filter((r) => r.archivedAt)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      .map(toProject)
  },

  getById(id: string): Project | null {
    const r = cache.get(id)
    return r ? toProject(r) : null
  },

  async rename(id: string, name: string): Promise<void> {
    const r = cache.get(id)
    if (!r) return
    r.name = name
    r.updatedAt = Date.now()
    await idb.put('projects', r)
    emit()
  },

  async setArchived(id: string, archived: boolean): Promise<void> {
    const r = cache.get(id)
    if (!r) return
    r.archivedAt = archived ? Date.now() : 0
    r.updatedAt = Date.now()
    await idb.put('projects', r)
    emit()
  },

  /** 供文件工具（P3）按项目根句柄访问目录 */
  getHandle(id: string): FileSystemDirectoryHandle | undefined {
    return cache.get(id)?.handle
  },

  /** 从用户选中的目录句柄创建项目（名称取文件夹名） */
  async createFromHandle(handle: FileSystemDirectoryHandle): Promise<Project> {
    const now = Date.now()
    const rec: ProjectRecord = {
      id: `proj-${uuid()}`,
      name: handle.name,
      handle,
      createdAt: now,
      updatedAt: now,
      archivedAt: 0
    }
    cache.set(rec.id, rec)
    await idb.put('projects', rec)
    emit()
    return toProject(rec)
  },

  async delete(id: string): Promise<void> {
    cache.delete(id)
    await idb.delete('projects', id)
    emit()
  },

  onChanged(cb: () => void): () => void {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }
}
