/**
 * 工作区文件表 —— 前后端共用的纯数据工具（无任何运行时依赖，可在 leaf 包内）。
 *
 * `files.scan` 一次性把工作目录相对路径列表拉回前端，前端据此建 FileMap，
 * 供两处内存内过滤：笔记本 `[[ ]]` 双链补全、聊天输入框 `@` 文件引用补全。
 * 绝不每次击键回后端扫盘。
 */

/** 单个文件条目（token 在建表时一次性算好） */
export interface FileEntry {
  /** 原始大小写相对路径（如 `docs/Notes.md`） */
  rel: string
  /** 原始大小写文件名（含扩展名，如 `Notes.md`） */
  base: string
  /** 绝对路径 */
  abs: string
  /**
   * 可直接写进 `[[token]]` 且能被 lookupAbs 解析回本文件的「最短无歧义」token。
   * 优先级：.md 去扩展名的裸名 > 含扩展名文件名 > 相对路径（仅当更短形式会解析到别的文件时才回退）。
   */
  token: string
}

/** 项目文件名 → 绝对路径 的查表（按文件名全局匹配，类 Obsidian） */
export interface FileMap {
  root: string
  /** 小写文件名（含扩展名）→ 绝对路径，首个命中优先 */
  byBase: Map<string, string>
  /** 小写相对路径 → 绝对路径 */
  byRel: Map<string, string>
  /** 全部条目（保持 scan 顺序）；补全在此之上做内存内过滤，避免每次击键回后端 */
  entries: FileEntry[]
}

/** 用宿主机分隔符拼接 base 与相对路径（不引 node:path，兼容 win 反斜杠） */
export function joinHostPath(base: string, rel: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base.replace(/[/\\]+$/, '')}${sep}${rel.replace(/^[/\\]+/, '')}`
}

export function buildFileMap(root: string, paths: string[]): FileMap {
  const byBase = new Map<string, string>()
  const byRel = new Map<string, string>()
  for (const rel of paths) {
    const abs = joinHostPath(root, rel)
    byRel.set(rel.toLowerCase(), abs)
    const base = (rel.split(/[/\\]/).pop() ?? rel).toLowerCase()
    if (!byBase.has(base)) byBase.set(base, abs)
  }
  // byBase/byRel 填好后再算每个条目的最短 token（依赖 lookupAbs 判定唯一性）
  const map: FileMap = { root, byBase, byRel, entries: [] }
  map.entries = paths.map((rel) => {
    const abs = joinHostPath(root, rel)
    const base = rel.split(/[/\\]/).pop() ?? rel
    return { rel, base, abs, token: pickToken(map, rel, base, abs) }
  })
  return map
}

/**
 * 选出能解析回本文件的最短 token。逐个候选用 lookupAbs 校验「解析回来是否还是自己」，
 * 命中重名时更短形式会解析到别的文件 → 自动回退到相对路径（byRel 保证唯一）。
 */
function pickToken(map: FileMap, rel: string, base: string, abs: string): string {
  const candidates: string[] = []
  if (/\.md$/i.test(base)) candidates.push(base.slice(0, -3)) // 裸名（lookupAbs 会补 .md）
  candidates.push(base, rel)
  for (const c of candidates) {
    if (lookupAbs(map, c) === abs) return c
  }
  return rel
}

/** 解析 name 到绝对路径：相对路径 > 文件名 > 文件名补 .md */
export function lookupAbs(map: FileMap | null, name: string): string | null {
  if (!map) return null
  const n = name.trim().toLowerCase()
  return map.byRel.get(n) ?? map.byBase.get(n) ?? map.byBase.get(`${n}.md`) ?? null
}

/**
 * 判断一次 files.changed 事件是否「纯内容变更」——kind 为 edit/write 且涉及文件全部已在
 * 当前文件列表中，因而不可能改变列表成员关系。文件列表 / FileMap 消费者据此跳过整目录重扫
 * （最高频来源：笔记本自动保存落盘触发的 watcher 事件、agent 编辑已有文件）。
 *
 * 保守方向：delete / 未知 kind / 无 paths / 路径不在列表中（可能是新建）一律返回 false 照常重扫。
 * isKnownRel 收小写相对路径（正斜杠归一），实现方若以反斜杠存键需自行兼容——本函数会以两种
 * 分隔符各试一次。
 */
export function isContentOnlyFileChange(
  event: { root: string; paths?: string[]; kind?: 'write' | 'edit' | 'delete' },
  isKnownRel: (relLower: string) => boolean
): boolean {
  if (event.kind !== 'edit' && event.kind !== 'write') return false
  if (!event.paths?.length) return false
  return event.paths.every((p) => {
    const rel = relativizeLoose(event.root, p)
    if (!rel) return false
    const lower = rel.toLowerCase()
    return isKnownRel(lower) || isKnownRel(lower.replace(/\//g, '\\'))
  })
}

/**
 * 宽松相对化（正斜杠归一）：p 在 root 下 → 相对路径；p 是绝对路径但不在 root 下 → null；
 * 其余视作已是相对路径（如扩展端 UI 路径空间）。
 */
function relativizeLoose(root: string, p: string): string | null {
  const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const norm = p.replace(/\\/g, '/')
  if (norm === normRoot) return null
  if (norm.startsWith(`${normRoot}/`)) return norm.slice(normRoot.length + 1)
  if (norm.startsWith('/') || /^[a-zA-Z]:\//.test(norm)) return null
  return norm.replace(/^\.\//, '')
}

/** 自动补全的一条候选（token 直接写入文档，label/detail 仅用于下拉展示） */
export interface FileSuggestion {
  /** 插入的内容（[[token]] 或 @token） */
  token: string
  /** 下拉主文案（文件名） */
  label: string
  /** 下拉副文案（所在目录，仅嵌套文件才有；顶层文件与文件名重复故省略） */
  detail?: string
  /** 原始大小写相对路径（供 @ 引用展开 payload 用） */
  rel: string
  /** 绝对路径 */
  abs: string
}

/**
 * 在已建好的内存文件表内搜索匹配 query 的文件，供 `[[ ]]` / `@` 自动补全。
 *
 * 海量文件性能：只在内存里线性过滤 + 排序，绝不每次击键回后端扫盘（后端 scan 已一次性把
 * 至多 SCAN_LIMIT 条路径缓存进 FileMap，并随 files.changed 事件刷新）。单遍 O(n) 打分，
 * 命中子集再排序，20000 条量级下每次击键 < 几毫秒。
 *
 * 打分：文件名前缀 > 文件名子串 > 相对路径子串；同分按路径更短（层级更浅）、再按字典序。
 * 空 query 返回层级最浅的前 limit 条。
 */
export function searchFileMap(map: FileMap | null, query: string, limit = 12): FileSuggestion[] {
  if (!map) return []
  const q = query.trim().toLowerCase()
  const scored: { entry: FileEntry; score: number }[] = []
  for (const entry of map.entries) {
    const baseL = entry.base.toLowerCase()
    let score: number
    if (!q) score = 0
    else if (baseL.startsWith(q)) score = 3
    else if (baseL.includes(q)) score = 2
    else if (entry.rel.toLowerCase().includes(q)) score = 1
    else continue
    scored.push({ entry, score })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.rel.length - b.entry.rel.length ||
      (a.entry.rel < b.entry.rel ? -1 : a.entry.rel > b.entry.rel ? 1 : 0)
  )
  return scored.slice(0, limit).map(({ entry }) => {
    // 目录部分（顶层文件无目录 → 省略 detail，避免与文件名重复）
    const dir = entry.rel.slice(0, entry.rel.length - entry.base.length).replace(/[/\\]+$/, '')
    return {
      token: entry.token,
      label: entry.base,
      detail: dir || undefined,
      rel: entry.rel,
      abs: entry.abs
    }
  })
}
