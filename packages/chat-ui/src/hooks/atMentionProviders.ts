/**
 * @ 引用的多源 provider 体系 —— useAtMentions 的候选数据层（provider 无关化）。
 *
 * 每个源是一个 `AtMentionProvider`：自带模块级缓存（按 sessionId 分键）、一次性拉数建内存表、
 * 监听宿主的变更事件防抖重扫（节奏对齐 FilesPanel 的 200ms），搜索全在内存内完成，
 * 绝不每次击键回后端。useAtMentions 只管触发解析路由与候选合并；注册新源 = 实现接口 +
 * registerAtMentionProvider。
 *
 * 内置两个源：
 *   - file      —— 工作区文件（files.scan 建 FileMap，files.changed 重扫；原 useAtMentions
 *                  内联实现收编为 provider 内部状态）
 *   - knowledge —— 启用库知识条目（mentions.listKnowledgeEntries 一次拉全，knowledge.changed
 *                  重扫；session.configChanged 按载荷圈定该会话重拉 —— 启用库勾选不走 knowledge.changed）
 */
import {
  buildFileMap,
  isContentOnlyFileChange,
  searchFileMap,
  type FileMap
} from '@shuvix/chat-protocol/utils/fileMap'
import type { KnowledgeMentionEntry } from '@shuvix/chat-protocol/knowledge'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { AtMentionRef } from '@shuvix/chat-protocol/utils/inlineTokens'
import { getSessionChannelApi } from '../api/chatApi'

/** @ 弹层的一条候选（provider 无关的统一形态） */
export interface AtSuggestionItem {
  /** 来源名（注册用的源前缀，如 `file` / `knowledge`） */
  source: string
  /** 主文案（文件名 / 条目标题） */
  label: string
  /** 次文案（文件=所在目录；知识条目=所属库显示名） */
  detail?: string
  /**
   * 选中后写入 textarea 的明文（不含前导 @）。文件 = 文件名（与存量逐字一致）；
   * 知识条目 = `knowledge:<标题>` —— rebuildDraftFromContent 的 `@displayText` 回填因此天然正确。
   */
  displayText: string
  /**
   * 明文撞车（撞上已登记的另一目标）时的消歧后缀内容，选中时拼为 `displayText (suffix)`。
   * 只给天然会重名的源（知识条目标题）；文件源不给 —— 维持其现状行为。
   */
  disambiguator?: string
  /** 构造 token 所需的实体引用 */
  ref: AtMentionRef
}

export interface AtMentionProvider {
  /** 源名（`@源:query` 的路由前缀） */
  readonly source: string
  /** 该会话数据是否就绪（未就绪的源在合并弹层里不出分区） */
  ready(sessionId: string): boolean
  /** 确保该会话数据在加载（幂等；完成后经 subscribe 通知） */
  load(sessionId: string): void
  /** 内存内搜索（数据未就绪返回 []） */
  search(sessionId: string, query: string, limit?: number): AtSuggestionItem[]
  /** 订阅数据变化（hook 据此 bump 渲染；事件驱动重扫完成后也会触发） */
  subscribe(listener: () => void): () => void
}

/** 变更事件防抖间隔（对齐 FilesPanel / 原 files.changed 重扫节奏） */
const RESCAN_DEBOUNCE_MS = 200

/** 各 provider 的公共骨架：模块级缓存 + 监听器 + 懒订阅宿主事件流 */
abstract class BaseProvider implements AtMentionProvider {
  abstract readonly source: string
  protected readonly listeners = new Set<() => void>()
  private subscribed = false
  private rescanTimer: ReturnType<typeof setTimeout> | null = null

  abstract ready(sessionId: string): boolean
  abstract search(sessionId: string, query: string, limit?: number): AtSuggestionItem[]
  /** 拉数建表（实现方保证幂等；完成后调 notify） */
  protected abstract fetch(sessionId: string): Promise<void>
  /** 本 provider 关心的宿主事件 → 需要重扫的会话（event 无关 / 可跳过返回 []） */
  protected abstract sessionsToRescan(event: AppEvent): string[]

  load(sessionId: string): void {
    this.ensureSubscribed()
    void this.fetch(sessionId).catch(() => {
      /* 拉取失败：该源暂不就绪，输入与其余源不受影响 */
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected notify(): void {
    for (const l of this.listeners) l()
  }

  private ensureSubscribed(): void {
    if (this.subscribed) return
    this.subscribed = true
    getSessionChannelApi().events.subscribe((event) => {
      const sids = this.sessionsToRescan(event)
      if (sids.length === 0) return
      if (this.rescanTimer) clearTimeout(this.rescanTimer)
      this.rescanTimer = setTimeout(() => {
        this.rescanTimer = null
        for (const sid of sids) void this.fetch(sid).catch(() => {})
      }, RESCAN_DEBOUNCE_MS)
    })
  }
}

// ── file：工作区文件 ──

class FileProvider extends BaseProvider {
  readonly source = 'file'
  /** 原 useAtMentions 的模块级 FILE_MAPS 收编于此（按 sessionId 分键） */
  private readonly maps = new Map<string, FileMap>()

  ready(sessionId: string): boolean {
    return this.maps.has(sessionId)
  }

  search(sessionId: string, query: string, limit?: number): AtSuggestionItem[] {
    return searchFileMap(this.maps.get(sessionId) ?? null, query, limit).map((s) => ({
      source: this.source,
      label: s.label,
      detail: s.detail,
      displayText: s.label,
      ref: { kind: 'file', rel: s.rel, base: s.label }
    }))
  }

  protected async fetch(sessionId: string): Promise<void> {
    const r = await getSessionChannelApi().files.scan({ sessionId })
    if (!r.root) return
    this.maps.set(sessionId, buildFileMap(r.root, r.paths))
    this.notify()
  }

  protected sessionsToRescan(event: AppEvent): string[] {
    if (event.type !== 'files.changed') return []
    const out: string[] = []
    for (const [sid, map] of this.maps) {
      // 别的会话工作目录的变更与本表无关；纯内容变更不改变成员关系 → 跳过
      if (event.root !== map.root) continue
      if (isContentOnlyFileChange(event, (rel) => map.byRel.has(rel))) continue
      out.push(sid)
    }
    return out
  }
}

// ── knowledge：启用库知识条目 ──

/**
 * 知识条目的内存内搜索：标题前缀 > 标题子串 > 描述子串；同分按标题短者优先、再按条目 id
 * 字典序（确定性）。空 query 按 id 字典序取前 limit 条（该源没有文件的「层级浅」可言）。
 */
export function searchKnowledgeEntries(
  entries: readonly KnowledgeMentionEntry[],
  query: string,
  limit = 12
): KnowledgeMentionEntry[] {
  const q = query.trim().toLowerCase()
  // 空 query：没有可排名的信号，按条目 id 字典序取前 limit 条（确定性；该源没有文件的「层级浅」可言）
  if (!q) {
    return [...entries]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, limit)
  }
  const scored: { entry: KnowledgeMentionEntry; score: number }[] = []
  for (const entry of entries) {
    const titleL = entry.title.toLowerCase()
    let score: number
    if (titleL.startsWith(q)) score = 3
    else if (titleL.includes(q)) score = 2
    else if (entry.description.toLowerCase().includes(q)) score = 1
    else continue
    scored.push({ entry, score })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.title.length - b.entry.title.length ||
      (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0)
  )
  return scored.slice(0, limit).map(({ entry }) => entry)
}

class KnowledgeProvider extends BaseProvider {
  readonly source = 'knowledge'
  private readonly tables = new Map<string, KnowledgeMentionEntry[]>()

  ready(sessionId: string): boolean {
    return this.tables.has(sessionId)
  }

  search(sessionId: string, query: string, limit?: number): AtSuggestionItem[] {
    const entries = this.tables.get(sessionId)
    if (!entries) return []
    return searchKnowledgeEntries(entries, query, limit).map((e) => ({
      source: this.source,
      label: e.title,
      detail: e.bundleLabel,
      displayText: `knowledge:${e.title}`,
      // 标题天然跨库重名 → 明文撞车时以库显示名消歧
      disambiguator: e.bundleLabel,
      ref: {
        kind: 'knowledge',
        entryPath: e.path,
        baseName: e.baseName,
        bundlePath: e.bundlePath,
        title: e.title
      }
    }))
  }

  protected async fetch(sessionId: string): Promise<void> {
    const entries = await getSessionChannelApi().mentions.listKnowledgeEntries({ sessionId })
    this.tables.set(sessionId, entries)
    this.notify()
  }

  protected sessionsToRescan(event: AppEvent): string[] {
    // 信号事件不带载荷：凡有表的会话都重拉（启用库是每会话现查的，无法按事件过滤）
    if (event.type === 'knowledge.changed') return [...this.tables.keys()]
    // 会话配置变更（启用库勾选走 updateKnowledgeBases → session.configChanged 广播，不产生
    // knowledge.changed）：按事件载荷圈定 —— 只重拉**该会话**已有的表（没拉过的会话不预取，
    // 别的会话的启用选择没变、不重拉）。改完下一次打开弹层候选就是新的（AT-14 / AT-15）。
    if (event.type === 'session.configChanged') {
      return this.tables.has(event.sessionId) ? [event.sessionId] : []
    }
    return []
  }
}

// ── registry ──

const registry: AtMentionProvider[] = []

/** 注册一个 @ 引用源（`@源:query` 的前缀即其 source 名） */
export function registerAtMentionProvider(provider: AtMentionProvider): void {
  if (registry.some((p) => p.source === provider.source)) return
  registry.push(provider)
}

/** 全部已注册源（稳定引用，可直接进 React 依赖数组） */
export function getAtMentionProviders(): readonly AtMentionProvider[] {
  return registry
}

/** 已注册源名（findActiveAt 的 `@源:query` 路由表） */
export function getAtMentionSourceNames(): string[] {
  return registry.map((p) => p.source)
}

registerAtMentionProvider(new FileProvider())
registerAtMentionProvider(new KnowledgeProvider())
