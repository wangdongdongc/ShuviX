/**
 * lazyTree —— 文件树懒加载的纯逻辑（不依赖 React / @pierre/trees，便于单测）。
 *
 * 三块职责：
 *  1. deriveDirPaths —— 从路径列表推导全部目录（pierre 规范形式带尾斜杠）；
 *  2. LazyLoadTracker —— 目录加载请求去重（loaded / inflight；失败清 inflight 允许重试）；
 *  3. LoadedSlices —— FilesPanel 的「已加载分片」账本：每个已加载目录最近一次 scanDir
 *     返回的路径集合。scanDir 只扫一层，分片天然互不相交（每个路径至多属于一个分片），
 *     唯一的多来源是搜索注入：注入路径后来成为分片内容时归属转移给分片
 *     （removeInjected 不再清它）。
 *
 * 路径约定：相对工作目录、forward-slash；目录键（slice key）为 ''（根）或尾斜杠形式 'a/b/'。
 * 已知判定按小写键（兼容大小写不敏感文件系统），对外操作一律用原始大小写。
 */

/** 从路径列表推导全部目录（含显式目录条目自身、文件的各级祖先），尾斜杠形式 */
export function deriveDirPaths(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>()
  for (const raw of paths) {
    const p = raw.replace(/\\/g, '/')
    const isDir = p.endsWith('/')
    const segs = p.replace(/\/+$/, '').split('/')
    if (segs.length === 1 && segs[0] === '') continue
    // 文件：祖先目录为 1..n-1 层；显式目录条目：含自身为 1..n 层
    const end = isDir ? segs.length : segs.length - 1
    for (let i = 1; i <= end; i++) {
      dirs.add(`${segs.slice(0, i).join('/')}/`)
    }
  }
  return dirs
}

/** 文件路径的父目录键：'' = 根，否则尾斜杠形式 */
export function parentDirKey(rel: string): string {
  const segs = rel.replace(/\\/g, '/').split('/')
  return segs.length <= 1 ? '' : `${segs.slice(0, -1).join('/')}/`
}

/** scanDir 的 dir 参数 → slice 键（'' = 根，否则补尾斜杠） */
export function dirKeyOf(dir: string): string {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  return d ? `${d}/` : ''
}

/** slice 键 → scanDir 的 dir 参数（去尾斜杠） */
export function dirParamOf(key: string): string {
  return key.replace(/\/+$/, '')
}

/**
 * 目录加载请求去重。语义：
 *  - shouldRequest：未加载且未在途 → 标记在途并返回 true（同一目录并发展开只请求一次）；
 *  - markLoaded：请求成功 → 已加载（此后折叠再展开不重复请求）；
 *  - markFailed：请求失败 → 清在途但不标已加载（下次展开自动重试）。
 */
export class LazyLoadTracker {
  private readonly loaded = new Set<string>()
  private readonly inflight = new Set<string>()

  shouldRequest(dir: string): boolean {
    if (this.loaded.has(dir) || this.inflight.has(dir)) return false
    this.inflight.add(dir)
    return true
  }

  markLoaded(dir: string): void {
    this.inflight.delete(dir)
    this.loaded.add(dir)
  }

  markFailed(dir: string): void {
    this.inflight.delete(dir)
  }

  isLoaded(dir: string): boolean {
    return this.loaded.has(dir)
  }
}

export interface SliceOps {
  /** 需要 model.add 的路径（原始大小写） */
  add: string[]
  /** 需要 model.remove 的路径（原始大小写） */
  remove: string[]
}

const EMPTY_OPS: SliceOps = { add: [], remove: [] }

/** 已加载分片账本 —— 见文件头第 3 点 */
export class LoadedSlices {
  /** slice 键（'' / 'a/b/'）→ 该分片最近一次 scanDir 返回的路径集合（原始大小写）。分片互不相交 */
  private readonly slices = new Map<string, Set<string>>()
  /** 小写路径 → 原始大小写：全部分片的并集 */
  private readonly slicePaths = new Map<string, string>()
  /** 小写路径 → 原始大小写：纯搜索注入（不属任何分片；成为分片内容时移出） */
  private readonly injected = new Map<string, string>()

  /** 记录一次分片加载（含首次）。只更新账本，不产生操作 —— 注入由调用方（FilesTree）做 */
  load(dirKey: string, paths: string[]): void {
    const prev = this.slices.get(dirKey)
    if (prev) for (const p of prev) this.slicePaths.delete(p.toLowerCase())
    const next = new Set(paths)
    for (const p of next) {
      this.slicePaths.set(p.toLowerCase(), p)
      this.injected.delete(p.toLowerCase()) // 归属转移给分片
    }
    this.slices.set(dirKey, next)
  }

  isLoaded(dirKey: string): boolean {
    return this.slices.has(dirKey)
  }

  /** 小写相对路径是否已在模型中（供 isContentOnlyFileChange 判定） */
  isKnown(relLower: string): boolean {
    return this.slicePaths.has(relLower) || this.injected.has(relLower)
  }

  /** 已加载目录键快照（刷新用） */
  dirKeys(): string[] {
    return [...this.slices.keys()]
  }

  /**
   * files.changed 增量：
   *  - delete：已知路径 → 移除（从持有它的分片/注入中扣除）；
   *  - write/edit：未知路径且父目录已加载 → 新增；父目录未加载 → 忽略（展开时自然会扫到）；
   *  - 已知的 write/edit 是纯内容变更，不改变列表成员 → 不动。
   */
  planChange(rels: string[], kind: 'write' | 'edit' | 'delete'): SliceOps {
    const add: string[] = []
    const remove: string[] = []
    for (const rel of rels) {
      const lower = rel.toLowerCase()
      if (kind === 'delete') {
        const orig = this.slicePaths.get(lower) ?? this.injected.get(lower)
        if (!orig) continue
        this.dropEverywhere(lower, orig)
        remove.push(orig)
        continue
      }
      if (this.isKnown(lower)) continue
      const slice = this.slices.get(parentDirKey(rel))
      if (!slice) continue
      slice.add(rel)
      this.slicePaths.set(lower, rel)
      add.push(rel)
    }
    return add.length || remove.length ? { add, remove } : EMPTY_OPS
  }

  /**
   * 分片刷新 diff（聚焦重扫 / 手动刷新）：与最新 scanDir 结果对比，返回增删操作并更新账本。
   * 被移除的显式目录条目（尾斜杠）会级联丢弃其下已加载的子分片账本（pierre 移除目录
   * 时子树一并消失，子分片不再产生独立 remove 操作）。
   */
  planRefresh(dirKey: string, nextPaths: string[]): SliceOps {
    const prev = this.slices.get(dirKey) ?? new Set<string>()
    const next = new Set(nextPaths)
    const add: string[] = []
    const remove: string[] = []

    for (const p of next) {
      if (prev.has(p)) continue
      const lower = p.toLowerCase()
      // 已是搜索注入内容 → 模型里已有，只转移归属，不产生 add
      if (!this.isKnown(lower)) add.push(p)
      this.slicePaths.set(lower, p)
      this.injected.delete(lower)
    }
    for (const p of prev) {
      if (next.has(p)) continue
      this.slicePaths.delete(p.toLowerCase())
      remove.push(p)
      // 目录条目消失 → 其下已加载子分片的账本一并失效
      if (p.endsWith('/')) this.dropSubSlices(p)
    }
    this.slices.set(dirKey, next)
    return add.length || remove.length ? { add, remove } : EMPTY_OPS
  }

  /** 搜索注入：全量 scan 结果中尚未已知的路径记账为注入，返回需要 model.add 的 */
  addInjected(paths: string[]): string[] {
    const add: string[] = []
    for (const p of paths) {
      const lower = p.toLowerCase()
      if (this.isKnown(lower)) continue
      this.injected.set(lower, p)
      add.push(p)
    }
    return add
  }

  /** 搜索结束：清回仍是纯注入的路径（已成分片内容的早已转移归属），返回需要 model.remove 的 */
  removeInjected(): string[] {
    const remove = [...this.injected.values()]
    this.injected.clear()
    return remove
  }

  /** 从分片与注入中扣除某路径（删除事件用） */
  private dropEverywhere(lower: string, orig: string): void {
    for (const slice of this.slices.values()) slice.delete(orig)
    this.slicePaths.delete(lower)
    this.injected.delete(lower)
  }

  /** 目录条目被移除时，丢弃其下所有已加载子分片的账本（不产生 remove 操作） */
  private dropSubSlices(dirPrefix: string): void {
    for (const [key, slice] of [...this.slices]) {
      if (key === '' || !key.startsWith(dirPrefix)) continue
      for (const p of slice) this.slicePaths.delete(p.toLowerCase())
      this.slices.delete(key)
    }
  }
}
